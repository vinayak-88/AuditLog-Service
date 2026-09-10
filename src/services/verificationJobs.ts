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
const VERIFY_ACTIVE_TTL_SECONDS = Number.parseInt(process.env.VERIFY_ACTIVE_TTL_SECONDS || '3600', 10);

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
 *   1. No sentinel key exists           → SET with EX, return nil  (acquired)
 *   2. Sentinel exists, job is terminal  → overwrite sentinel       (stale recovery)
 *   3. Sentinel exists, job is active    → return existing jobId    (blocked)
 *   4. Sentinel exists, job data missing → return existing jobId    (concurrent request
 *      just acquired the sentinel but hasn't saved the job yet;
 *      or crash before saveVerifyJob — TTL will expire the sentinel)
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

export async function findActiveVerifyJobId(appId: string): Promise<string | null> {
  let cursor = '0';
  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `verify-job:${appId}:*`, 'COUNT', 20);
    cursor = nextCursor;

    for (const key of keys) {
      const raw = await redis.get(key);
      if (!raw) continue;

      try {
        const parsed = VerifyJobSchema.safeParse(JSON.parse(raw));
        if (parsed.success && (parsed.data.status === 'pending' || parsed.data.status === 'running')) {
          return parsed.data.jobId;
        }
      } catch {
        // Ignore malformed state while scanning for active jobs.
      }
    }
  } while (cursor !== '0');

  return null;
}
