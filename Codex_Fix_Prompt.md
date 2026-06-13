# Codex Fix Prompt — Audit Log Service

You are working on a Node.js/TypeScript backend service called the Audit Log Service. It uses Express, Prisma (PostgreSQL), Redis (ioredis), Zod, and Winston. Apply the fixes below exactly as described. Do not refactor anything that is not listed. Do not change file structure, naming conventions, or any behavior not covered by these fixes. Preserve all existing comments unless a fix explicitly replaces them.

---

## Fix 1 — `src/services/hashChain.ts`: Canonicalize metadata before hashing

**Problem:** `buildHashPayload` passes `entry.metadata` directly into the hash payload. `JSON.stringify` serializes object keys in insertion order. PostgreSQL JSONB does not preserve insertion order, so the same metadata read back from the database may serialize differently, producing a different hash. This causes `verifyChain` to report tamper on clean entries.

**What to do:**

Add a `canonicalizeJson` helper above `buildHashPayload`. Sort object keys recursively before they enter the hash payload.

```typescript
function canonicalizeJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  return Object.keys(record)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = canonicalizeJson(record[key]);
      return acc;
    }, {});
}
```

In `buildHashPayload`, change the `metadata` line from:
```typescript
metadata: entry.metadata,
```
to:
```typescript
metadata: canonicalizeJson(entry.metadata) as Record<string, unknown> | null,
```

Do not touch `computeEntryHash` or `verifyChain`.

---

## Fix 2 — `src/services/hashChain.ts`: Move env validation to a dedicated startup validator (partial)

**Problem:** `HASH_SECRET` is validated at module load in `hashChain.ts` but other critical variables (`DATABASE_URL`, `INTERNAL_API_KEY`, `GENESIS_HASH`) have no guard. A missing `INTERNAL_API_KEY` in production silently breaks all `/v1/apps` routes without crashing or logging at startup.

**What to do:**

Create a new file `src/config/validateEnv.ts`:

```typescript
const REQUIRED_ENV_VARS: Array<{ key: string; devOnly?: boolean }> = [
  { key: 'DATABASE_URL' },
  { key: 'HASH_SECRET' },
  { key: 'GENESIS_HASH' },
  { key: 'INTERNAL_API_KEY' },
];

export function validateEnv(): void {
  const env = process.env.NODE_ENV;
  const isDev = env === 'development' || env === 'test';

  const missing = REQUIRED_ENV_VARS
    .filter(({ devOnly }) => !isDev || devOnly !== true)
    .filter(({ key }) => !process.env[key]);

  if (missing.length > 0) {
    console.error(
      `[FATAL] Missing required environment variables: ${missing.map((v) => v.key).join(', ')}`
    );
    console.error(`[FATAL] NODE_ENV is "${env ?? 'undefined'}". Set these variables before starting.`);
    process.exit(1);
  }
}
```

In `src/app.ts`, import and call `validateEnv()` as the very first line of the `if (require.main === module)` block, before `app.listen`:

```typescript
import { validateEnv } from './config/validateEnv';

// Inside if (require.main === module):
validateEnv();
const server = app.listen(PORT, () => { ... });
```

Remove the existing `HASH_SECRET` check at the top of `hashChain.ts` entirely — `validateEnv` now owns all startup validation.

---

## Fix 3 — `src/routes/events.ts`: P2034 exhaustion must throw `AppError` with 503, not plain `Error`

**Problem:** After all serialization retries fail, the code throws `new Error('Unable to create audit log entry after retries')`. This is a plain `Error`, so `errorHandler` masks the message and returns a generic 500 with "Internal server error". Clients cannot distinguish this from a server crash and don't know to retry.

**What to do:**

Import `AppError` at the top of `events.ts`:
```typescript
import { AppError } from '../middleware/errorHandler';
```

Replace the final throw at the end of `createAuditLogEntry` (after the retry loop):
```typescript
// BEFORE:
throw new Error('Unable to create audit log entry after retries');

// AFTER:
throw new AppError(
  'High write contention — entry could not be committed after 3 attempts. Retry with exponential backoff.',
  503,
  'SERVICE_BUSY'
);
```

Do not change any other logic in the retry loop or the P2002 handler.

---

## Fix 4 — `src/middleware/auth.ts`: Remove hardcoded fallback in `getDashboardOwnerId`

**Problem:** When a valid `INTERNAL_API_KEY` is presented but neither `x-owner-id` nor `x-user-id` header is sent, the function returns the hardcoded string `'dashboard-dev-user'` instead of `null`. This causes `requireOwnerId` in `apps.ts` to proceed with a phantom owner ID instead of returning 401.

**What to do:**

In `getDashboardOwnerId`, change the internal key branch from:
```typescript
if (internalKey && token === internalKey) {
  return req.header('x-owner-id') ?? req.header('x-user-id') ?? 'dashboard-dev-user';
}
```
to:
```typescript
if (internalKey && token === internalKey) {
  const ownerId = req.header('x-owner-id') ?? req.header('x-user-id') ?? null;
  if (!ownerId) {
    logger.warn({
      message: 'INTERNAL_API_KEY authenticated request missing x-owner-id and x-user-id headers — rejecting'
    });
  }
  return ownerId;
}
```

Do not touch the dev auth bypass branch below it.

---

## Fix 5 — `src/routes/health.ts`: Add timeout to DB and Redis probes

**Problem:** `prisma.$queryRaw` and `redis.ping()` have no timeout. If the DB or Redis is slow, the health check hangs, causing Railway to mark the service unhealthy and restart it — potentially making the problem worse.

**What to do:**

Replace the entire health route handler body with this implementation:

```typescript
const HEALTH_TIMEOUT_MS = 3000;

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} health check timed out after ${HEALTH_TIMEOUT_MS}ms`)), HEALTH_TIMEOUT_MS)
    )
  ]);
}

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const dependencies: Record<string, string> = {
      postgresql: 'connected',
      redis: 'connected'
    };

    let healthy = true;

    try {
      await withTimeout(prisma.$queryRaw`SELECT 1`, 'PostgreSQL');
    } catch (err) {
      healthy = false;
      dependencies.postgresql = `error: ${err instanceof Error ? err.message : 'unknown'}`;
    }

    try {
      await withTimeout(redis.ping(), 'Redis');
    } catch (err) {
      healthy = false;
      dependencies.redis = `error: ${err instanceof Error ? err.message : 'unknown'}`;
    }

    return res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      dependencies
    });
  })
);
```

---

## Fix 6 — `src/app.ts`: Add `unhandledRejection` and `uncaughtException` handlers

**Problem:** Unhandled promise rejections crash the process in Node 18+ without going through the graceful shutdown path. Prisma and Redis connections are not closed cleanly.

**What to do:**

Inside the `if (require.main === module)` block, add these handlers immediately after the `SIGTERM` and `SIGINT` handlers:

```typescript
process.on('unhandledRejection', (reason: unknown) => {
  logger.error({ message: 'Unhandled promise rejection — shutting down', reason });
  void shutdown('unhandledRejection');
});

process.on('uncaughtException', (err: Error) => {
  logger.error({ message: 'Uncaught exception — shutting down', error: err.message, stack: err.stack });
  void shutdown('uncaughtException');
});
```

---

## Fix 7 — `src/app.ts`: Move `helmet()` before `cors()`

**Problem:** `cors()` is mounted before `helmet()`. CORS preflight responses (HTTP OPTIONS) are returned by the `cors()` middleware and bypass Helmet entirely, so they go out without security headers.

**What to do:**

Reorder middleware in `createApp()` so the first four lines are:

```typescript
app.use(helmet());
app.use(cors({ ... }));   // keep existing cors config unchanged
app.use(requestId);
app.use(express.json({ limit: '1mb' }));
```

Move only the `helmet()` call. Do not change the `cors()` configuration.

---

## Fix 8 — `src/app.ts`: Support multiple CORS origins via environment variable

**Problem:** `origin: [process.env.NEXTAUTH_URL || 'http://localhost:3001']` only allows one origin. Adding a staging or secondary domain requires a code change.

**What to do:**

Replace the `origin` value with:

```typescript
origin: (process.env.CORS_ORIGINS ?? process.env.NEXTAUTH_URL ?? 'http://localhost:3001')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean),
```

This keeps backward compatibility — if `CORS_ORIGINS` is not set, it falls back to `NEXTAUTH_URL` and then to the dev default. Multiple origins are comma-separated in `CORS_ORIGINS`.

Add `CORS_ORIGINS=` (commented out) to `.env.example` with a note:
```
# Comma-separated list of allowed CORS origins. Defaults to NEXTAUTH_URL if not set.
# CORS_ORIGINS=https://dashboard.example.com,https://staging.example.com
```

---

## Fix 9 — `src/middleware/auth.ts`: Use SHA-256 hash of API key as Redis cache key

**Problem:** The Redis cache key is `apikey:{rawApiKey}`. The raw API key is exposed in Redis `MONITOR` output, memory dumps, and logs. It should never appear outside of the request cycle.

**What to do:**

Add this import at the top of `auth.ts`:
```typescript
import { createHash } from 'crypto';
```

Add this helper:
```typescript
function hashKeyForCache(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}
```

Replace `getApiKeyCacheKey`:
```typescript
function getApiKeyCacheKey(apiKey: string): string {
  return `apikey:${hashKeyForCache(apiKey)}`;
}
```

The function signature of `getApiKeyCacheKey` and `clearApiKeyCache` stay the same — callers pass the raw key and the hashing is internal. No changes needed in `apps.ts`.

---

## Fix 10 — `src/routes/verify.ts`: Check for in-flight job before starting a new one

**Problem:** Multiple concurrent `POST /v1/verify` requests can start multiple O(n) full-chain scans simultaneously. The rate limiter is not perfectly atomic.

**What to do:**

In the `POST /` handler, before `saveVerifyJob(job)`, add a check using Redis `SCAN` to look for any existing pending job for this app:

```typescript
// Check for an already-running job for this app
let cursor = '0';
let existingPendingJobId: string | null = null;

do {
  const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `verify-job:${app.id}:*`, 'COUNT', 20);
  cursor = nextCursor;

  for (const key of keys) {
    const raw = await redis.get(key);
    if (raw) {
      try {
        const existing = JSON.parse(raw) as VerifyJob;
        if (existing.status === 'pending') {
          existingPendingJobId = existing.jobId;
          break;
        }
      } catch {
        // malformed entry — ignore
      }
    }
    if (existingPendingJobId) break;
  }
} while (cursor !== '0' && !existingPendingJobId);

if (existingPendingJobId) {
  return res.status(409).json({
    success: false,
    error: {
      message: 'A verification job is already running for this app.',
      code: 'JOB_IN_PROGRESS',
      statusCode: 409,
    },
    data: {
      jobId: existingPendingJobId,
      pollUrl: `/v1/verify/${existingPendingJobId}`
    }
  });
}
```

Place this block after `const app = req.auditApp!;` and before the `jobId` creation.

---

## Fix 11 — `src/routes/verify.ts`: Validate Redis job data through Zod on read

**Problem:** `JSON.parse(rawJob) as VerifyJob` is a TypeScript-only cast with no runtime validation. A stale or malformed Redis entry is served as-is.

**What to do:**

Add a `VerifyJobSchema` Zod object in `verify.ts` (near the `VerifyJob` interface):

```typescript
import { z } from 'zod'; // already imported

const VerificationResultSchema = z.object({
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

const VerifyJobSchema = z.object({
  jobId: z.string().uuid(),
  appId: z.string(),
  status: z.enum(['pending', 'complete', 'failed']),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  result: VerificationResultSchema.optional(),
  error: z.string().optional()
});
```

In the `GET /:jobId` handler, replace:
```typescript
return res.json({
  success: true,
  data: JSON.parse(rawJob) as VerifyJob
});
```
with:
```typescript
const parsed = VerifyJobSchema.safeParse(JSON.parse(rawJob));
if (!parsed.success) {
  logger.error({ message: 'Corrupt verify job in Redis', jobId, details: parsed.error.flatten() });
  return res.status(500).json({
    success: false,
    error: { message: 'Verification job data is corrupt. Please start a new job.', code: 'JOB_DATA_CORRUPT', statusCode: 500 }
  });
}
return res.json({ success: true, data: parsed.data });
```

Remove the `VerifyJob` interface — `VerifyJobSchema` is now the source of truth. Derive the type from the schema:
```typescript
type VerifyJob = z.infer<typeof VerifyJobSchema>;
```

---

## Fix 12 — `src/services/activityCache.ts`: Replace N individual pipelines with one batch pipeline for cache warm

**Problem:** The DB fallback path in `getActivityFeed` warms the cache by calling `cacheActivityEntry` once per entry. Each call creates its own Redis pipeline, meaning N entries = N separate round-trips.

**What to do:**

Add a new `bulkCacheActivityEntries` function in `activityCache.ts`:

```typescript
export async function bulkCacheActivityEntries(
  appId: string,
  resourceId: string,
  entries: ActivityEntry[]
): Promise<void> {
  if (entries.length === 0) return;

  try {
    const key = getCacheKey(appId, resourceId);
    const pipeline = redis.pipeline();

    for (const entry of entries) {
      const score = new Date(entry.createdAt).getTime();
      const member = JSON.stringify(entry);
      pipeline.zadd(key, score, member);
    }

    // Trim to MAX_ENTRIES and reset TTL once after all ZADDs
    pipeline.zremrangebyrank(key, 0, -(MAX_ENTRIES + 1));
    pipeline.expire(key, TTL_SECONDS);

    const results = await pipeline.exec();
    if (results) {
      results.forEach(([err], i) => {
        if (err) {
          logger.warn({
            message: 'Redis bulk activity cache pipeline command failed',
            commandIndex: i,
            error: err.message
          });
        }
      });
    }
  } catch (err) {
    logger.warn({ message: 'Unable to bulk-warm Redis activity cache', error: err });
  }
}
```

In `getActivityFeed`, replace the existing cache warm:
```typescript
// BEFORE:
Promise.all(entries.map((entry) => cacheActivityEntry(appId, entry))).catch((err) =>
  logger.warn({ message: 'Failed to warm activity cache from PostgreSQL fallback', error: err })
);

// AFTER:
void bulkCacheActivityEntries(appId, resourceId, entries);
```

Keep `cacheActivityEntry` (the per-entry version) — it is still used in `events.ts` for single-entry inserts.

---

## Fix 13 — `src/types/index.ts`: Add date range validation to search schema

**Problem:** `SearchEventsSchema` accepts any `startDate`/`endDate` combination, including `endDate < startDate` and unbounded date ranges that cause full table scans.

**What to do:**

Find `SearchEventsSchema` in `src/types/index.ts`. Add a `.refine()` call after the `z.object({...})` definition:

```typescript
.refine(
  (data) => {
    if (data.startDate && data.endDate) {
      const start = new Date(data.startDate);
      const end = new Date(data.endDate);
      if (end < start) return false;
      const MAX_RANGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
      if (end.getTime() - start.getTime() > MAX_RANGE_MS) return false;
    }
    return true;
  },
  {
    message: 'endDate must be after startDate and the date range must not exceed 90 days'
  }
)
```

---

## What NOT to change

- Do not touch `prisma/schema.prisma`. The `apiKey String @unique` plaintext storage is a documented portfolio simplification — the comment in `apps.ts` covers it.
- Do not implement BullMQ for verification. The `setImmediate` approach is a documented trade-off.
- Do not add audit self-logging for `/v1/apps` mutations. This is a future feature, not a bug.
- Do not change the 30-day analytics window — `analyticsService.ts` was not provided for review.
- Do not change any test files unless a fix directly requires a new test for the fixed behavior.
- Do not add any new dependencies. All fixes use libraries already present (`crypto`, `zod`, `ioredis`, `express`).

---

## Verification checklist

After applying all fixes, confirm:

- [ ] `buildHashPayload` calls `canonicalizeJson` on `metadata` before returning
- [ ] `validateEnv` is the first call inside `if (require.main === module)` in `app.ts`
- [ ] The old `HASH_SECRET` guard at the top of `hashChain.ts` is removed
- [ ] P2034 exhaustion in `events.ts` throws `AppError` with status 503 and code `SERVICE_BUSY`
- [ ] `getDashboardOwnerId` returns `null` (not `'dashboard-dev-user'`) when internal key is valid but owner headers are absent
- [ ] Health check probes both wrap in `withTimeout` with 3-second limit
- [ ] `unhandledRejection` and `uncaughtException` handlers are registered in `app.ts`
- [ ] `helmet()` is the first `app.use()` call inside `createApp()`
- [ ] CORS `origin` reads from `CORS_ORIGINS` env var (comma-split), falls back to `NEXTAUTH_URL`
- [ ] `getApiKeyCacheKey` uses `sha256(rawKey)` as the Redis key suffix, not the raw key
- [ ] `POST /v1/verify` scans for an existing pending job and returns 409 if found
- [ ] `GET /v1/verify/:jobId` parses the Redis value through `VerifyJobSchema.safeParse` before responding
- [ ] `bulkCacheActivityEntries` exists in `activityCache.ts` and is used for the DB fallback warm
- [ ] `SearchEventsSchema` has a `.refine()` that rejects invalid/unbounded date ranges
