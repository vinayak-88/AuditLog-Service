import { randomUUID } from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';
import { verifyRateLimiter } from '../middleware/rateLimiter';
import { verificationQueue } from '../queues/verificationQueue';
import { acquireVerifySlot, readVerifyJob, releaseVerifySlot, saveVerifyJob, type VerifyJob } from '../services/verificationJobs';

const router = Router();

router.post(
  '/',
  verifyRateLimiter,
  asyncHandler(async (req, res) => {
    const app = req.auditApp!;
    const jobId = randomUUID();

    const slot = await acquireVerifySlot(app.id, jobId);

    if (!slot.acquired) {
      return res.status(409).json({
        success: false,
        error: {
          message: 'A verification job is already running for this app.',
          code: 'JOB_IN_PROGRESS',
          statusCode: 409
        },
        data: {
          jobId: slot.existingJobId,
          pollUrl: `/v1/verify/${slot.existingJobId}`
        }
      });
    }

    const job: VerifyJob = {
      jobId,
      appId: app.id,
      status: 'pending',
      phase: 'queued',
      startedAt: new Date().toISOString()
    };

    await saveVerifyJob(job);
    try {
      await verificationQueue.add('verify-chain', { appId: app.id, jobId, appName: app.name }, { jobId });
    } catch (error) {
      await saveVerifyJob({
        ...job,
        status: 'failed',
        phase: undefined,
        completedAt: new Date().toISOString(),
        error: 'Unable to enqueue verification job'
      });
      await releaseVerifySlot(app.id, jobId);
      throw error;
    }

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
    const state = await readVerifyJob(app.id, jobId);

    if (state.corrupt) {
      return res.status(500).json({
        success: false,
        error: {
          message: 'Verification job data is corrupt. Please start a new job.',
          code: 'JOB_DATA_CORRUPT',
          statusCode: 500
        }
      });
    }

    const job = state.job;

    if (!job) {
      return res.status(404).json({
        success: false,
        error: {
          message: 'Verification job not found',
          code: 'JOB_NOT_FOUND',
          statusCode: 404
        }
      });
    }

    if (job.appId !== app.id) {
      return res.status(404).json({
        success: false,
        error: {
          message: 'Verification job not found',
          code: 'JOB_NOT_FOUND',
          statusCode: 404
        }
      });
    }

    return res.json({ success: true, data: job });
  })
);

export default router;
