import { z } from 'zod';
import redis from '../config/redis';

export const VerificationResultSchema = z.object({
  valid: z.boolean(),
  entriesChecked: z.number(),
  durationMs: z.number(),
  tamperedAt: z
    .object({
      sequenceNumber: z.number(),
      entryId: z.string()
    })
    .optional()
});

export const VerifyJobSchema = z.object({
  jobId: z.string().uuid(),
  appId: z.string(),
  status: z.enum(['pending', 'running', 'complete', 'failed']),
  phase: z.enum(['queued', 'running', 'retrying']).optional(),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  attemptsMade: z.number().int().nonnegative().optional(),
  result: VerificationResultSchema.optional(),
  error: z.string().optional()
});

export type VerifyJob = z.infer<typeof VerifyJobSchema>;

const VERIFY_JOB_TTL_SECONDS = Number.parseInt(process.env.VERIFY_JOB_TTL_SECONDS || '3600', 10);
const VERIFY_ACTIVE_TTL_SECONDS = Number.parseInt(
  process.env.VERIFY_ACTIVE_TTL_SECONDS || '3600',
  10
);

export function getVerifyJobKey(appId: string, jobId: string): string {
  return `verify-job:${appId}:${jobId}`;
}

export function getVerifyActiveKey(appId: string): string {
  return `verify-active:${appId}`;
}

/*
 * Lua script executed atomically in Redis to acquire the verification slot
 * for an app.  It handles these scenarios in a single round-trip:
 *
 *   1. No sentinel key exists             → SET with EX, return nil  (acquired)
 *   2. Sentinel exists, job is terminal   → overwrite sentinel        (stale recovery)
 *   3. Sentinel exists, job is active     → return existing jobId     (blocked)
 *   4. Sentinel exists, job data missing  → return existing jobId     (blocked)
 *      This covers two sub-cases:
 *      a. A concurrent request just acquired the sentinel but has not yet
 *         called saveVerifyJob().  Treating it as stale would re-introduce
 *         the race condition we fixed.
 *      b. The API process crashed after acquiring the sentinel but before
 *         saving the job record.  The sentinel TTL handles expiry.
 *   5. Sentinel exists, job data corrupt  → return existing jobId     (blocked)
 *      Same reasoning as (4): we cannot confirm the referenced job is truly
 *      done, so we conservatively block and rely on TTL for expiry.
 *
 * KEYS[1] = verify-active:{appId}
 * ARGV[1] = new jobId
 * ARGV[2] = TTL in seconds
 * ARGV[3] = job-key prefix  "verify-job:{appId}:"
 */
const ACQUIRE_LUA = `
local existing = redis.call('GET', KEYS[1])
if not existing then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[2]))
  return nil
end

local jobData = redis.call('GET', ARGV[3] .. existing)
if not jobData then
  return existing
end

local ok, job = pcall(cjson.decode, jobData)
if ok and (job.status == 'complete' or job.status == 'failed') then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[2]))
  return nil
end

return existing
`;

/*
 * Lua script that conditionally deletes the sentinel only when its value
 * still matches the caller's jobId.  This prevents a finishing worker from
 * accidentally removing a sentinel that was already claimed by a newer job.
 *
 * KEYS[1] = verify-active:{appId}
 * ARGV[1] = jobId that owns the sentinel
 */
const RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/*
 * Lua script that renews the sentinel TTL only when its value still matches
 * the caller's jobId.  Called periodically by the heartbeat while verifyChain()
 * is running.  Returns 1 if renewed, 0 if the sentinel is gone or belongs to
 * a different job (which means another request acquired the slot — do not
 * extend).
 *
 * KEYS[1] = verify-active:{appId}
 * ARGV[1] = jobId that owns the sentinel
 * ARGV[2] = new TTL in seconds
 */
const RENEW_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
end
return 0
`;

export type AcquireResult =
  | { acquired: true }
  | { acquired: false; existingJobId: string };

export async function acquireVerifySlot(appId: string, jobId: string): Promise<AcquireResult> {
  const activeKey = getVerifyActiveKey(appId);
  const jobKeyPrefix = `verify-job:${appId}:`;

  const result = await redis.eval(
    ACQUIRE_LUA,
    1,           // number of KEYS
    activeKey,   // KEYS[1]
    jobId,       // ARGV[1]
    String(VERIFY_ACTIVE_TTL_SECONDS), // ARGV[2]
    jobKeyPrefix // ARGV[3]
  ) as string | null;

  if (result === null) {
    return { acquired: true };
  }

  return { acquired: false, existingJobId: result };
}

export async function releaseVerifySlot(appId: string, jobId: string): Promise<void> {
  const activeKey = getVerifyActiveKey(appId);
  await redis.eval(RELEASE_LUA, 1, activeKey, jobId);
}

/**
 * Extends the sentinel TTL only if verify-active:{appId} still holds jobId.
 * Returns true when the TTL was refreshed, false when the sentinel is gone or
 * belongs to a different job (the caller should stop heartbeating).
 */
export async function renewVerifySlot(appId: string, jobId: string): Promise<boolean> {
  const activeKey = getVerifyActiveKey(appId);
  const renewed = await redis.eval(
    RENEW_LUA,
    1,
    activeKey,
    jobId,
    String(VERIFY_ACTIVE_TTL_SECONDS)
  ) as number;
  return renewed === 1;
}

/**
 * Starts a periodic heartbeat that renews the sentinel TTL while verifyChain()
 * is running.  The interval is set to one-third of the configured TTL so that
 * the sentinel is refreshed well before it would expire even if one tick is
 * slightly delayed.
 *
 * Returns a stop function that cancels the interval.  Always call stop() in a
 * finally block regardless of whether verifyChain() succeeds or throws.
 */
export function startVerifyHeartbeat(
  appId: string,
  jobId: string,
  intervalMs = Math.max(
    1000,
    Math.floor((VERIFY_ACTIVE_TTL_SECONDS * 1000) / 3)
  )
): () => void {
  const handle = setInterval(() => {
    renewVerifySlot(appId, jobId).catch(() => {
      // Renewal failures are non-fatal.
    });
  }, intervalMs);

  return () => clearInterval(handle);
}

export async function saveVerifyJob(job: VerifyJob): Promise<void> {
  const serialized = JSON.stringify(job);

  if (job.status === 'complete' || job.status === 'failed') {
    await redis.set(getVerifyJobKey(job.appId, job.jobId), serialized, 'EX', VERIFY_JOB_TTL_SECONDS);
    return;
  }

  await redis.set(getVerifyJobKey(job.appId, job.jobId), serialized);
}

export async function getVerifyJob(appId: string, jobId: string): Promise<VerifyJob | null> {
  const state = await readVerifyJob(appId, jobId);
  return state.job;
}

export async function readVerifyJob(
  appId: string,
  jobId: string
): Promise<{ job: VerifyJob | null; corrupt: boolean }> {
  const rawJob = await redis.get(getVerifyJobKey(appId, jobId));
  if (!rawJob) return { job: null, corrupt: false };

  try {
    const parsed = VerifyJobSchema.safeParse(JSON.parse(rawJob));
    return parsed.success ? { job: parsed.data, corrupt: false } : { job: null, corrupt: true };
  } catch {
    return { job: null, corrupt: true };
  }
}
