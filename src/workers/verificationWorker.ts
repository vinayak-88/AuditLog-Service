import 'dotenv/config';
import { Job, Worker } from 'bullmq';
import { sendTamperAlert } from '../services/alertService';
import { verifyChain } from '../services/hashChain';
import logger from '../config/logger';
import {
  saveVerifyJob,
  getVerifyJob,
  releaseVerifySlot,
  type VerifyJob
} from '../services/verificationJobs';
import {
  VERIFICATION_QUEUE_NAME,
  type VerificationJobData
} from '../queues/verificationQueue';

const connection = {
  host: process.env.REDIS_HOST!,
  port: Number.parseInt(process.env.REDIS_PORT!, 10),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null
};

export function createVerificationWorker(): Worker<VerificationJobData> {
  return new Worker<VerificationJobData>(
    VERIFICATION_QUEUE_NAME,
    async (job) => processVerificationJob(job),
    { connection, concurrency: 1 }
  );
}

async function processVerificationJob(job: Job<VerificationJobData>): Promise<void> {
  const currentJob = await getVerifyJob(job.data.appId, job.data.jobId);
  if (!currentJob) {
    logger.warn({ message: 'Verification job state missing; acknowledging queue job', jobId: job.data.jobId });
    await releaseVerifySlot(job.data.appId, job.data.jobId);
    return;
  }

  if (currentJob.status === 'complete' || currentJob.status === 'failed') {
    return;
  }

  const attemptsMade = job.attemptsMade + 1;
  const maxAttempts = job.opts.attempts ?? 1;
  const runningJob: VerifyJob = {
    ...currentJob,
    status: 'running',
    phase: 'running',
    attemptsMade
  };
  await saveVerifyJob(runningJob);

  try {
    const result = await verifyChain(job.data.appId);
    const completedJob: VerifyJob = {
      ...runningJob,
      status: 'complete',
      phase: undefined,
      completedAt: new Date().toISOString(),
      result,
      error: undefined
    };
    await saveVerifyJob(completedJob);
    await releaseVerifySlot(job.data.appId, job.data.jobId);

    if (!result.valid) {
      try {
        await sendTamperAlert(job.data.appId, job.data.appName, result.tamperedAt.sequenceNumber);
      } catch (err) {
        logger.error({ message: 'Unable to send tamper alert', jobId: job.data.jobId, error: err });
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : 'unknown';
    const finalAttempt = attemptsMade >= maxAttempts;
    const failedOrRetryingJob: VerifyJob = {
      ...runningJob,
      status: finalAttempt ? 'failed' : 'pending',
      phase: finalAttempt ? undefined : 'retrying',
      completedAt: finalAttempt ? new Date().toISOString() : undefined,
      error
    };
    await saveVerifyJob(failedOrRetryingJob);
    if (finalAttempt) {
      await releaseVerifySlot(job.data.appId, job.data.jobId);
    }
    logger.error({ message: finalAttempt ? 'Verification job failed' : 'Verification job will retry', jobId: job.data.jobId, error });
    throw err;
  }
}

if (require.main === module) {
  const worker = createVerificationWorker();
  worker.on('completed', (job) => logger.info({ message: 'Verification job completed', jobId: job?.id }));
  worker.on('failed', (job, err) => logger.error({ message: 'Verification queue job failed', jobId: job?.id, error: err }));
  worker.on('error', (err) => logger.error({ message: 'Verification worker error', error: err }));

  const shutdown = async (signal: string) => {
    logger.info({ message: 'Verification worker shutting down', signal });
    await worker.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
