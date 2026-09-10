import { Queue } from 'bullmq';

export const VERIFICATION_QUEUE_NAME = 'verification';

export type VerificationJobData = {
  appId: string;
  jobId: string;
  appName: string;
};

const connection = {
  host: process.env.REDIS_HOST!,
  port: Number.parseInt(process.env.REDIS_PORT!, 10),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null
};

export const verificationQueue = new Queue<VerificationJobData>(VERIFICATION_QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 500 },
    removeOnComplete: true,
    removeOnFail: true
  }
});

export async function closeVerificationQueue(): Promise<void> {
  await verificationQueue.close();
}
