import { randomUUID } from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';
import { verifyRateLimiter } from '../middleware/rateLimiter';
import { sendTamperAlert } from '../services/alertService';
import { verifyChain } from '../services/hashChain';
import redis from '../config/redis';
import logger from '../config/logger';
import type { VerificationResult } from '../types';

const router = Router();
const VERIFY_JOB_TTL_SECONDS = Number.parseInt(process.env.VERIFY_JOB_TTL_SECONDS || '3600', 10);

type VerifyJobStatus = 'pending' | 'complete' | 'failed';

interface VerifyJob {
  jobId: string;
  appId: string;
  status: VerifyJobStatus;
  startedAt: string;
  completedAt?: string;
  result?: VerificationResult;
  error?: string;
}

function getVerifyJobKey(appId: string, jobId: string): string {
  return `verify-job:${appId}:${jobId}`;
}

async function saveVerifyJob(job: VerifyJob): Promise<void> {
  /*
   * CHANGED: verification job state is stored in Redis with a TTL.
   *
   * The verification scan can be long-running, so the HTTP request now returns
   * immediately while clients poll Redis-backed job state for completion.
   */
  await redis.set(getVerifyJobKey(job.appId, job.jobId), JSON.stringify(job), 'EX', VERIFY_JOB_TTL_SECONDS);
}

async function runVerifyJob(appName: string, job: VerifyJob): Promise<void> {
  try {
    const result = await verifyChain(job.appId);
    const completedJob: VerifyJob = {
      ...job,
      status: 'complete',
      completedAt: new Date().toISOString(),
      result
    };

    try {
      await saveVerifyJob(completedJob);
    } catch (err) {
      logger.warn({ message: 'Unable to persist completed verification job', jobId: job.jobId, error: err });
    }

    if (!result.valid) {
      sendTamperAlert(job.appId, appName, result.tamperedAt.sequenceNumber).catch((err) => {
        logger.error({ message: 'Unable to send tamper alert', jobId: job.jobId, error: err });
      });
    }
  } catch (err) {
    const failedJob: VerifyJob = {
      ...job,
      status: 'failed',
      completedAt: new Date().toISOString(),
      error: err instanceof Error ? err.message : 'unknown'
    };

    logger.error({ message: 'Verification job failed', jobId: job.jobId, error: err });

    try {
      await saveVerifyJob(failedJob);
    } catch (redisErr) {
      logger.warn({ message: 'Unable to persist failed verification job', jobId: job.jobId, error: redisErr });
    }
  }
}

router.post(
  '/',
  verifyRateLimiter,
  asyncHandler(async (req, res) => {
    const app = req.auditApp!;
    const jobId = randomUUID();
    const job: VerifyJob = {
      jobId,
      appId: app.id,
      status: 'pending',
      startedAt: new Date().toISOString()
    };

    /*
     * CHANGED: POST /v1/verify now starts an async verification job instead of
     * running verifyChain in the request cycle.
     *
     * Persisting the pending state before responding lets clients immediately
     * poll by jobId. If Redis is unavailable, the scan still runs, but polling
     * cannot observe the job state until Redis is healthy again.
     */
    try {
      await saveVerifyJob(job);
    } catch (err) {
      logger.warn({ message: 'Unable to persist pending verification job', jobId, error: err });
    }

    setImmediate(() => {
      /*
       * CHANGED: defer the expensive O(n) chain verification until after the
       * current response tick. The catch handler prevents background failures
       * from becoming unhandled promise rejections.
       */
      try {
        void runVerifyJob(app.name, job).catch((err) => {
          logger.error({ message: 'Unhandled verification job error', jobId, error: err });
        });
      } catch (err) {
        logger.error({ message: 'Unable to schedule verification job', jobId, error: err });
      }
    });

    return res.status(202).json({
      success: true,
      data: {
        jobId,
        status: 'pending',
        startedAt: job.startedAt,
        pollUrl: `/v1/verify/${jobId}`
      }
    });
  })
);

router.get(
  '/:jobId',
  asyncHandler(async (req, res) => {
    /*
     * CHANGED: verification polling validates jobId as a UUID before reading
     * Redis so malformed IDs follow the same Zod-powered 400 path as other
     * validated request inputs.
     */
    const app = req.auditApp!;
    const jobId = z.string().uuid().parse(req.params.jobId);
    const rawJob = await redis.get(getVerifyJobKey(app.id, jobId));

    if (!rawJob) {
      return res.status(404).json({
        success: false,
        error: {
          message: 'Verification job not found',
          code: 'JOB_NOT_FOUND',
          statusCode: 404
        }
      });
    }

    return res.json({
      success: true,
      data: JSON.parse(rawJob) as VerifyJob
    });
  })
);

export default router;
