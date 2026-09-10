jest.mock('../src/services/hashChain', () => ({
  ...jest.requireActual('../src/services/hashChain'),
  verifyChain: jest.fn()
}));

import { randomUUID } from 'crypto';
import { verificationQueue } from '../src/queues/verificationQueue';
import redis from '../src/config/redis';
import { createVerificationWorker } from '../src/workers/verificationWorker';
import {
  acquireVerifySlot,
  getVerifyActiveKey,
  getVerifyJob,
  renewVerifySlot,
  saveVerifyJob,
  startVerifyHeartbeat,
  type VerifyJob
} from '../src/services/verificationJobs';
import { verifyChain } from '../src/services/hashChain';
import type { VerificationResult } from '../src/types';

const mockedVerifyChain = verifyChain as jest.MockedFunction<typeof verifyChain>;

async function waitForJob(appId: string, jobId: string): Promise<VerifyJob> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = await getVerifyJob(appId, jobId);
    if (job?.status === 'complete' || job?.status === 'failed') return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error('Verification worker job did not reach a terminal state.');
}

describe('verification worker', () => {
  const appId = 'worker-test-app';
  let worker: ReturnType<typeof createVerificationWorker>;

beforeAll(async () => {
  await verificationQueue.obliterate({ force: true });

  worker = createVerificationWorker();
  await worker.waitUntilReady();
});

  beforeEach(async () => {
    mockedVerifyChain.mockReset();
  });

  afterAll(async () => {
    await worker.close();
    await verificationQueue.close();
    await redis.quit();
  });

  it('retries a transient verification failure and completes', async () => {
    mockedVerifyChain
      .mockRejectedValueOnce(new Error('temporary database failure'))
      .mockResolvedValueOnce({ valid: true, entriesChecked: 0, durationMs: 1 });

    const jobId = randomUUID();
    await saveVerifyJob({ jobId, appId, status: 'pending', phase: 'queued', startedAt: new Date().toISOString() });
    await verificationQueue.add(
      'verify-chain',
      { appId, jobId, appName: 'Worker Test App' },
      { jobId, attempts: 2, backoff: { type: 'fixed', delay: 10 } }
    );

    const job = await waitForJob(appId, jobId);
    expect(job.status).toBe('complete');
    expect(job.attemptsMade).toBe(2);
    expect(mockedVerifyChain).toHaveBeenCalledTimes(2);
  });

  it('persists a terminal failed state after retries are exhausted', async () => {
    mockedVerifyChain.mockRejectedValue(new Error('permanent verification failure'));

    const jobId = randomUUID();
    await saveVerifyJob({ jobId, appId, status: 'pending', phase: 'queued', startedAt: new Date().toISOString() });
    await verificationQueue.add(
      'verify-chain',
      { appId, jobId, appName: 'Worker Test App' },
      { jobId, attempts: 2, backoff: { type: 'fixed', delay: 10 } }
    );

    const job = await waitForJob(appId, jobId);
    expect(job.status).toBe('failed');
    expect(job.error).toBe('permanent verification failure');
    expect(job.attemptsMade).toBe(2);
    expect(mockedVerifyChain).toHaveBeenCalledTimes(2);
  });

  it('heartbeat renews the sentinel while the verification is running', async () => {
  const jobId = randomUUID();
  const activeKey = getVerifyActiveKey(appId);

  await redis.set(activeKey, jobId, 'EX', 2);

  const stopHeartbeat = startVerifyHeartbeat(appId, jobId, 500);

  try {
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const sentinelOwner = await redis.get(activeKey);
    expect(sentinelOwner).toBe(jobId);

    const ttl = await redis.ttl(activeKey);
    expect(ttl).toBeGreaterThan(0);
  } finally {
    stopHeartbeat();
    await redis.del(activeKey);
  }
}, 10000);

  it('renewVerifySlot does not extend the TTL when a different job owns the sentinel', async () => {
    const ownerJobId = randomUUID();
    const otherJobId = randomUUID();
    const activeKey = getVerifyActiveKey(appId);

    await redis.set(activeKey, ownerJobId, 'EX', 5);

    // Attempting to renew with a non-matching jobId must return false.
    const renewed = await renewVerifySlot(appId, otherJobId);
    expect(renewed).toBe(false);

    // The original sentinel must still belong to ownerJobId.
    const currentOwner = await redis.get(activeKey);
    expect(currentOwner).toBe(ownerJobId);

    await redis.del(activeKey);
  });
});
