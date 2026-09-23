# Audit Log Service — Master AI Context File

> This file is the single source of truth for the Audit Log Service project.
> Feed this entire file as context to any AI assistant before asking for help with any part of the codebase.
> Every architectural decision, schema definition, API contract, and implementation detail is documented here.
>
> Last updated: after dashboard owner-scoped event reads, app create/rotate/deactivate management UI, hardened /health statuses, numeric/secret startup validation, dashboard CI job, and non-breaking dependency fixes.

---

## Project Identity

**Name:** Audit Log Service
**Type:** Full-stack SaaS-style developer tool
**Purpose:** A tamper-proof audit trail service any application can plug into via API. Every user action in a client app is logged, cryptographically chained, and verifiable. Tampering with any log entry breaks the chain and is mathematically detectable.
**Target users:** Developers who need compliance-ready, immutable activity logs for their applications.
**Real-world equivalents:** Papertrail, Datadog Audit Logs, AWS CloudTrail — but self-built.

---

## Tech Stack — Complete List

| Layer | Technology | Version | Purpose |
|---|---|---|---|
| Runtime | Node.js | 20+ LTS (`>=20`, `node:20-bookworm-slim` images) | Server-side JavaScript |
| Framework | Express.js | 4.x | REST API routing and middleware |
| Language | TypeScript | 5.x | Type safety across entire codebase |
| Frontend framework | Next.js | 14+ (App Router) | Dashboard UI + API routes |
| Database | PostgreSQL | 15+ | Primary data store — events, apps |
| ORM | Prisma | 5.22.0 (`@prisma/client` + `prisma`) | Database schema, migrations, query client |
| Cache + jobs | Redis | 7+ | API-key cache, activity cache, verify job state, active-job sentinel, BullMQ backend |
| Redis client | ioredis | 5.x | Redis connection and commands |
| Durable queue | BullMQ | 6.3.4 | Durable verification queue consumed by a separate worker |
| Auth | NextAuth.js | 4.x | GitHub OAuth provider (dashboard); GitHub user id is the owner identity |
| Schema validation | Zod | 3.x | Runtime validation of all API inputs |
| Cryptography | Node.js built-in `crypto` | — | HMAC-SHA256, timingSafeEqual, randomUUID/randomBytes |
| Email | Brevo (Sendinblue) | API v3 | Alert emails (chain verification failure, anomalies) |
| Logging | Winston | 3.x | Structured JSON logging to console |
| Testing | Jest + Supertest | — | Unit + integration tests |
| Containerisation | Docker + Docker Compose | — | Local multi-service orchestration (postgres, redis, api, worker) |
| CI | GitHub Actions | — | Automated typecheck/lint/migrate/test/build on push + PR (no deploy step) |
| Deployment — API | Railway (planned) | — | Persistent Node.js process — not yet automated |
| Deployment — Frontend | Vercel (planned) | — | Next.js dashboard — not yet automated |
| Deployment — DB | Railway PostgreSQL (planned) | — | Managed PostgreSQL |
| Deployment — Redis | Railway Redis (planned) | — | Managed Redis |

There is no `User` table. `App.ownerId` is the GitHub user id (`token.sub` → `session.user.id`). There is no AWS/Terraform/CD pipeline in the codebase.

---

## Project Structure — Every File and Folder

```
audit-log-service/
├── src/                          # Express API server + queue + worker
│   ├── config/
│   │   ├── db.ts                 # Prisma client singleton
│   │   ├── redis.ts              # ioredis client singleton (API process)
│   │   ├── logger.ts             # Winston JSON console logger
│   │   └── validateEnv.ts        # Required-env validation at startup
│   ├── middleware/
│   │   ├── asyncHandler.ts       # Wraps async route handlers, forwards errors to next()
│   │   ├── auth.ts               # apiKeyAuth + dashboardOrApiKeyAuth + getDashboardOwnerId + cache clear
│   │   ├── errorHandler.ts       # Centralised error handler + AppError class
│   │   ├── rateLimiter.ts        # express-rate-limit configs (events/verify/apps/search/export)
│   │   ├── requestId.ts          # Correlation ID middleware
│   │   ├── validate.ts           # Shared validation factory (body or query)
│   │   ├── validateBody.ts       # Thin wrapper: validate('body', schema)
│   │   └── validateQuery.ts      # Thin wrapper: validate('query', schema)
│   ├── routes/
│   │   ├── events.ts             # POST /v1/events — log ingestion with idempotency
│   │   ├── search.ts             # GET /v1/events — search/filter + activity feed
│   │   ├── verify.ts             # POST /v1/verify (enqueue) + GET /v1/verify/:jobId (poll)
│   │   ├── export.ts             # GET /v1/export — streaming CSV/JSON export
│   │   ├── apps.ts               # App registration and API key management
│   │   └── health.ts             # GET /health — dependency status (unversioned)
│   ├── services/
│   │   ├── hashChain.ts          # HMAC hash chain logic — core cryptographic integrity
│   │   ├── activityCache.ts      # Redis sorted set cache with PostgreSQL fallback
│   │   ├── analyticsService.ts   # API analytics queries (implemented, no route calls them)
│   │   ├── alertService.ts       # Brevo email alerts for tamper detection
│   │   ├── apiKey.ts             # hashApiKey HMAC-SHA256 digest helper
│   │   └── verificationJobs.ts   # VerifyJob schemas, job keys, sentinel Lua, heartbeat
│   ├── queues/
│   │   └── verificationQueue.ts  # BullMQ verification queue handle + closeVerificationQueue
│   ├── workers/
│   │   └── verificationWorker.ts # Standalone BullMQ worker (verifyChain + lifecycle)
│   ├── types/
│   │   ├── index.ts              # All shared TypeScript types and Zod schemas
│   │   └── express.d.ts          # Express Request augmentation (auditApp without apiKey, id)
│   └── app.ts                    # Express app factory, middleware, route mounting, shutdown
├── dashboard/                    # Next.js App Router frontend
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx               # Session-aware redirect to /login or /dashboard
│   │   ├── login/page.tsx         # GitHub sign-in page
│   │   ├── api/auth/[...nextauth]/route.ts
│   │   ├── api/dashboard/verify/route.ts          # Server proxy: start verification
│   │   ├── api/dashboard/verify/[jobId]/route.ts  # Server proxy: poll verification
│   │   ├── api/dashboard/export/route.ts          # Server proxy: stream export
│   │   ├── api/dashboard/apps/route.ts            # Server proxy: create app (raw key once)
│   │   ├── api/dashboard/apps/[id]/route.ts       # Server proxy: deactivate app (204)
│   │   ├── api/dashboard/apps/[id]/rotate-key/route.ts  # Server proxy: rotate key (new key once)
│   │   └── dashboard/
│   │       ├── page.tsx          # Overview — selected-app event volume, recent activity
│   │       ├── events/page.tsx   # Event search and filter UI for the selected app
│   │       ├── verify/page.tsx   # Verification trigger, job polling, result display
│   │       ├── export/page.tsx   # Export UI with filter options
│   │       └── apps/page.tsx     # Active-app listing + create/rotate/deactivate management
│   ├── lib/
│   │   ├── api.ts                # Server-only dashboard fetch helpers (INTERNAL_API_KEY, owner/app headers); throws on non-2xx
│   │   ├── api-url.ts            # Configured API URL builder with /v1 normalization
│   │   ├── app-selection.ts      # OwnerAppSummary + resolveSelectedAppId (explicit per-app context)
│   │   └── auth.ts               # Shared NextAuth GitHub provider configuration
│   ├── scripts/
│   │   ├── load-env.cjs          # Loads repository-root .env for dashboard start
│   │   └── validate-env.cjs      # Fail-fast dashboard config validation (called by next.config.mjs)
│   ├── next.config.mjs           # Loads root .env, then validates dashboard config at build/start
│   └── components/
│       ├── AuthControls.tsx      # GitHub sign-in and NextAuth sign-out controls
│       ├── EventTable.tsx
│       ├── SearchFilters.tsx     # Filter form; preserves the selected appId across searches
│       ├── AppSelector.tsx       # Per-app context switcher for multi-app owners
│       ├── CreateAppForm.tsx     # Create-app form + one-time key success view
│       ├── AppActions.tsx        # Per-row rotate/deactivate confirms + one-time key view
│       ├── OneTimeKeyPanel.tsx   # Shared one-time raw-key display (state-only, never persisted)
│       ├── ActivityFeed.tsx
│       ├── VerificationResult.tsx
│       └── StatsCards.tsx
├── prisma/
│   ├── schema.prisma             # App + AuditLog models, UUID v7, debian-openssl binary target
│   └── migrations/
│       ├── 20260908202915_init/                       # Tables, indexes, FK
│       └── 20260908202916_add_immutability_trigger/   # Append-only trigger
├── tests/
│   ├── hashChain.test.ts
│   ├── apiKey.test.ts
│   ├── events.test.ts
│   ├── verify.test.ts
│   ├── verificationWorker.test.ts
│   ├── dashboardEvents.test.ts   # Owner-scoped event reads (own/cross-owner/random-ID/customer-key)
│   ├── search.test.ts
│   └── activityCache.test.ts
├── mock/
│   └── producer.ts               # Mock script that sends sample events
├── scripts/
│   └── hash-existing-api-keys.ts # One-time migration helper for stored keys
├── docker-compose.yml            # postgres + redis + api + worker
├── Dockerfile                    # Multi-stage Node 20 build, non-root production image
├── .env.example
└── .github/workflows/ci.yml      # Test & build only; no deploy
```

---

## package.json Scripts

```json
{
  "scripts": {
    "build": "tsc",
    "start": "node dist/app.js",
    "worker": "node dist/workers/verificationWorker.js",
    "producer": "tsx mock/producer.ts",
    "test": "jest --forceExit --detectOpenHandles",
    "lint": "eslint src tests --ext .ts",
    "prisma:migrate": "prisma migrate deploy",
    "prisma:generate": "prisma generate",
    "api-keys:migrate": "tsx scripts/hash-existing-api-keys.ts",
    "typecheck": "tsc --noEmit"
  }
}
```

`npm run worker` starts the standalone verification worker. The Compose
`worker` service runs `node dist/workers/verificationWorker.js` from the same
production image as the API.

---

## Config Files

### src/config/db.ts — Prisma Singleton

Plain `new PrismaClient({ log: ['error'] })` singleton. There is no globalThis
cache, no pool tuning, and no per-environment log switching. `DATABASE_URL`
selects the database.

### src/config/redis.ts — ioredis Singleton (API process)

Host/port from `REDIS_HOST`/`REDIS_PORT` (required), optional `REDIS_PASSWORD`,
`maxRetriesPerRequest: 3`, retry strategy capped at 3 s. Connection/error/close
events logged via Winston. BullMQ queue/worker connections are separate and use
`maxRetriesPerRequest: null` as BullMQ requires.

### src/config/logger.ts — Winston Config

Console-only transport, `info` level, JSON format with timestamp and error
stacks. There are no file transports in the current implementation.

### src/config/validateEnv.ts

Requires `DATABASE_URL`, `REDIS_HOST`, `REDIS_PORT`, `CORS_ORIGINS`,
`HASH_SECRET`, `GENESIS_HASH`, `INTERNAL_API_KEY` when the server starts
directly, and additionally rejects malformed numerics for all 23 consumed
numeric settings (ports 1–65535, counts/TTLs positive integers; unset still
means "use default"), a non-PostgreSQL `DATABASE_URL` scheme, and an empty
`CORS_ORIGINS` list. `HASH_SECRET`/`INTERNAL_API_KEY` under 32 characters
are fatal under `NODE_ENV=production` and warnings elsewhere (so compose
defaults and CI keep working). Called by both the API and the worker
entrypoints; exits 1 with itemized `[FATAL]` lines on any problem.

---

## app.ts — Complete Express Setup

Mounting order:

1. `helmet()`, `cors()` (allows `Content-Type, Authorization, x-owner-id, x-user-id, x-app-id, x-request-id`; exposes `x-request-id`), `requestId`, `express.json({ limit: '1mb' })`, Morgan (skip `/health`, includes `x-request-id`).
2. `/health` — no auth.
3. `/v1/apps` — dashboard-owner authorization (route-local, `INTERNAL_API_KEY` + owner headers). Not behind `apiKeyAuth`.
4. `/v1/events` — read router (`searchRouter`: `GET /`, `GET /activity/:resourceId`)
   behind `dashboardOrApiKeyAuth` mounted FIRST, then ingestion (`eventsRouter`:
   `POST /`) behind `apiKeyAuth`. Order is load-bearing: a customer-only gate
   mounted first would reject dashboard reads before they reach the search
   router. `POST /` still falls through to `apiKeyAuth`.
5. `/v1/verify` — `dashboardOrApiKeyAuth` (customer key **or** internal + `x-owner-id` + `x-app-id`).
6. `/v1/export` — `dashboardOrApiKeyAuth` (same dual credential).
7. Global JSON 404 handler, then `errorHandler`.

Shutdown (`SIGTERM`/`SIGINT`/`unhandledRejection`/`uncaughtException`): close
HTTP connections, `closeVerificationQueue()` (closes the local BullMQ handle —
does not delete queued jobs), `prisma.$disconnect()`, `redis.disconnect()`,
exit. The worker process shuts down via `worker.close()`.

**Why /health is not versioned:** platform probes (Docker HEALTHCHECK, Railway
healthcheck, load balancers) are configured once and don't follow API
versioning.

---

## TypeScript Types — Complete Definitions

### src/types/express.d.ts

`req.id` / `req.requestId` (correlation ID), `req.auditApp?: Omit<App,
'apiKey'>` — authenticated app data never carries the stored digest.

### src/types/index.ts

Zod schemas: `IngestEventSchema` (open `actorType` string, 10 KB metadata cap,
optional `idempotencyKey`), `SearchEventsSchema` (page max 1000, 90-day
two-sided date rule), `ExportEventsSchema` (+ `format: json|csv`),
`RegisterAppSchema`. Inferred aliases: `IngestEventInput`,
`SearchEventsInput`, `ExportEventsInput`, `RegisterAppInput`.

`HashPayload` field order is fixed (`appId, sequenceNumber, actorId, actorType,
action, resourceId, resourceType, metadata, createdAt`) — `JSON.stringify`
order is hash input. `ipAddress`/`userAgent`/`idempotencyKey` are excluded.

`VerificationResult` discriminated union (`valid: true` vs `valid: false` +
`tamperedAt`). `ApiSuccess`/`ApiError`/`ApiResponse` envelopes.
`ActivityEntry` Redis/endpoint subset. `AuthenticatedRequest`/`AsyncHandler`
aliases.

### src/services/verificationJobs.ts (single source of truth for jobs)

`VerificationResultSchema` + `VerifyJobSchema` (status
`pending|running|complete|failed`, phase `queued|running|retrying`,
`attemptsMade`), inferred `VerifyJob`, `AcquireResult`, key helpers
(`verify-job:{appId}:{jobId}`, `verify-active:{appId}`), atomic Lua
acquire/release/renew, `startVerifyHeartbeat`, `saveVerifyJob` (TTL only on
terminal states), `readVerifyJob`/`getVerifyJob`.

### src/queues/verificationQueue.ts

`VERIFICATION_QUEUE_NAME = 'verification'`, `VerificationJobData { appId,
jobId, appName }`, default job options `attempts: 3`, exponential backoff 500
ms, `removeOnComplete/removeOnFail: true`.

---

## Database Schema — Complete Prisma Definition

Prisma `^5.22.0`, PostgreSQL provider, `binaryTargets = ["native",
"debian-openssl-3.0.x"]`. Two models, no `User` table:

- `App`: UUID v7 `id`, `name`, `description?`, unique `apiKey` (HMAC digest),
  indexed `ownerId` (GitHub user id), `isActive` default true, timestamps,
  `auditLogs` relation, `@@map("apps")`.
- `AuditLog`: UUID v7 `id`, UUID `appId` FK (`ON DELETE RESTRICT`, `ON UPDATE
  CASCADE`), `actorId/actorType/action/resourceId/resourceType`, `metadata`
  JSONB, `ipAddress?/userAgent?/idempotencyKey?`, `entryHash`, `previousHash`,
  `sequenceNumber`, `createdAt`, `@@unique([appId, sequenceNumber])`,
  `@@unique([appId, idempotencyKey], name: "unique_app_idempotency_key")`,
  indexes on `(appId, createdAt/actorId/resourceId/action)`,
  `@@map("audit_logs")`.

Migration history (only these two):

- `20260908202915_init` — tables, UUID columns, unique/index definitions, FK.
- `20260908202916_add_immutability_trigger` — `prevent_audit_log_modification()`
  + `audit_log_immutable` trigger (`BEFORE UPDATE OR DELETE`, raises).

Deploy with `npm run prisma:migrate`; do not invent tables, fields, indexes, or
relationships.

---

## Middleware

### Validation

Shared `validate(field, schema)` factory (`validateBody`/`validateQuery` thin
wrappers). 400 `VALIDATION_ERROR` with flattened details; Zod strips unknown
keys. Route-local Zod param parsing (app UUIDs, resourceId, verify jobId UUID)
throws `ZodError`, mapped by `errorHandler` to the same 400 contract.

### Authentication

**apiKeyAuth** (ingestion `POST /v1/events`; fallback for event reads, verify, export): `Authorization:
Bearer <raw als_ key>` → HMAC digest (`HASH_SECRET`) → Redis
`apikey:{digest}` (non-secret data, 600 s TTL) → PostgreSQL active-App lookup on
miss/failure → `req.auditApp`. 401 `MISSING_API_KEY`/`INVALID_API_KEY`.

**dashboardOrApiKeyAuth** (`GET /v1/events` reads, `/v1/verify`, `/v1/export`):
valid `INTERNAL_API_KEY` + `x-owner-id` + `x-app-id` → owned active-app lookup
(403 `DASHBOARD_AUTH_REQUIRED`/`APP_ACCESS_DENIED`) → `req.auditApp`;
otherwise delegates to `apiKeyAuth`. `POST /v1/events` stays on `apiKeyAuth`
(customer keys only). `INTERNAL_API_KEY` is server-only; browsers never
receive it.

**getDashboardOwnerId/requireOwnerId** (`/v1/apps`): valid internal key +
`x-owner-id` (else `x-user-id`) → owner scope; missing → 401
`DASHBOARD_AUTH_REQUIRED`. No app key accepted here.

### errorHandler

`ZodError` → 400; `AppError` (operational) → its status/message; everything else
→ generic 500 (never leaks internals).

### Rate limiting

Process-local express-rate-limit, five instances: events 200/min, verify-start
1/5 min (POST only; polls unlimited), apps mutations 30/min (owner-keyed), search
100/min, export 10/min. Keys are app id (or derived owner) else IP. 429
`RATE_LIMIT_EXCEEDED`. GET `/v1/apps` and `GET /v1/verify/:jobId` have no
limiter.

---

## Analytics Queries

`analyticsService.ts` keeps the `$queryRaw` `DATE_TRUNC` volume aggregation
(database groups; 30 rows returned; `COUNT()` BigInt → `Number()`), plus
top-actors/action-breakdown helpers behind a 60 s cache-aside layer
(`analytics:*`). No backend route currently calls these functions.

---

## Activity Cache Service

Keys `activity:{appId}:{resourceId}` (sorted set, score = ms timestamp, 50
entries, 1 h TTL). Single writes pipeline ZADD+trim+expire; fallback warms via
one bulk pipeline; `getActivityFeed` returns `{ entries, source:
'cache'|'database' }` with PostgreSQL fallback and non-awaited warm.
`clearActivityCache` exists but no route calls it.

---

## Core Logic — Hash Chain

### CRITICAL implementation rules

1. **Never reorder HashPayload fields.** `JSON.stringify` is hash input.
2. **Always use Serializable isolation for chain writes** (plus unique
   `(appId, sequenceNumber)`), with P2034 retry (3 attempts).
3. **Handle P2002 for idempotency** — concurrent same-key inserts resolve via
   the unique constraint; fetch the winner and return it (200, not 201).
4. **Idempotency pre-check stays outside the transaction** (cheap point lookup;
   constraint covers the race).
5. **`ipAddress`/`userAgent`/`idempotencyKey` are not hashed** — the trigger is
   their ordinary-write protection.
6. **Canonicalize metadata** (recursive key sort; arrays keep order) before hashing.
7. **Compare with timingSafeEqual** for both `previousHash` and `entryHash`.

`computeEntryHash = HMAC-SHA256(HASH_SECRET, previousHash +
JSON.stringify(payload))` (hex). `verifyChain` scans in `sequenceNumber` order
in `VERIFY_CHAIN_BATCH_SIZE` (500) batches and stops at the first mismatch.

---

## Verification — Durable BullMQ Job Pattern

Chain verification is O(n); it runs in a separate worker process, not in the
request cycle and not via in-process `setImmediate` (that design is removed).

`POST /v1/verify` (dual credential + verify limiter):

1. Generates a UUID `jobId`.
2. Atomically acquires `verify-active:{appId}` via Lua (absent → set with
   `VERIFY_ACTIVE_TTL_SECONDS`, default 3600 s; terminal reference → overwrite;
   otherwise blocked). Simultaneous requests resolve to one 202 + one 409.
3. Saves `pending`/`queued` VerifyJob at `verify-job:{appId}:{jobId}` (no TTL yet).
4. Adds a durable BullMQ `verify-chain` job (`attempts: 3`, exponential backoff
   500 ms). Enqueue failure → save `failed` (TTL), release sentinel, rethrow.
5. Returns 202 `{ jobId, status: 'pending', startedAt, pollUrl }`; busy → 409
   `JOB_IN_PROGRESS` with existing `jobId`/`pollUrl`.

Worker (`npm run worker`, `concurrency: 1`):

- Loads the persisted job; missing → warn + release sentinel + ack; already
  terminal → ack.
- Saves `running` with `attemptsMade = job.attemptsMade + 1`, starts the
  heartbeat (renew every TTL/3, minimum 1 s; ownership-checked Lua EXPIRE).
- Runs `verifyChain(appId)`: success → save `complete` (TTL
  `VERIFY_JOB_TTL_SECONDS`, 3600 s) + release sentinel (ownership-checked Lua
  DEL) + best-effort `sendTamperAlert` when invalid; error with retries left →
  save `pending`/`retrying` (no TTL, no release) + rethrow for BullMQ retry;
  error exhausted → save `failed` (TTL) + release + rethrow.
- Shutdown via `worker.close()`; BullMQ records use `removeOnComplete/ Fail:
  true` (the observable record is the Redis `verify-job:*` key).

`GET /v1/verify/:jobId` (dual credential, no limiter): UUID-parse the param,
`readVerifyJob` in the authenticated app's namespace, enforce stored
`appId` match (else 404 `JOB_NOT_FOUND`), schema-validate (else 500
`JOB_DATA_CORRUPT`), return the full job (`pending/running/complete/failed`).
A tampered chain is 200 `valid: false`, not an HTTP error.

---

## Dashboard Authentication and API Client

NextAuth GitHub (`dashboard/lib/auth.ts`); `session.user.id = token.sub` is the
owner identity. Pages/layouts use `getServerSession`; unauthenticated users go
to `/login` (`signIn('github')`, `signOut` in the sidebar).

Backend access is server-side only: `dashboard/lib/api.ts` (`server-only`) uses
`API_URL` + `INTERNAL_API_KEY` + `x-owner-id` (GitHub id) + `x-app-id`, with
`cache: 'no-store'`. `dashboardFetch` throws on non-2xx (with status plus the
backend message) instead of returning null, so failures surface as error
cards rather than silent empty data. The public `NEXT_PUBLIC_API_URL` is only
for browser-safe URL building. Dashboard proxy routes
(`app/api/dashboard/...`: verify start/poll, export stream, app
create/rotate-key/deactivate) require a session (401 otherwise), validate
UUID `appId` (400 otherwise), forward with the internal credential, map
400/401/403/404/429 faithfully (deactivate preserves the backend 204 with no
JSON parsing), and (for polls) reject `appId` mismatches with 404. The
browser never sees `INTERNAL_API_KEY`; raw app keys appear only in
transient one-time success panels (`OneTimeKeyPanel`, state-only, wiped on
Done) and never in lists, URLs, storage, or logs.

Overview/Events pages resolve an explicit selected app from the owner's own
app list (`dashboard/lib/app-selection.ts` `resolveSelectedAppId`,
`AppSelector.tsx` switcher for multi-app owners, `SearchFilters` preserves
`appId`); there is no unscoped owner-wide event read. The Apps page adds
create (`CreateAppForm`), per-row rotate/deactivate confirms
(`AppActions.tsx`), and empty/error states.

`dashboard/lib/api-url.ts` normalizes to `/v1` and requires a configured base.

---

## API Routes — Complete Specification

All routes except `/health` are mounted under `/v1/`.

### POST /v1/events

**Authentication:** `Authorization: Bearer <app api-key>` only.
**Rate limit:** 200/min (app-keyed).

Body: `actorId/actorType/action/resourceId/resourceType` (bounded strings,
open `actorType`), optional `metadata` object (10 KB cap), `ipAddress`,
`userAgent` (500), `idempotencyKey`. **201** new entry
`{ entryId, sequenceNumber, entryHash, createdAt }`; **200** same shape for
idempotent duplicates. 400/401/429/500.

### GET /v1/events

**Authentication:** app key **or** dashboard internal + owner/app headers
(same dual credential as verify/export; `searchRouter` is mounted first so
dashboard reads reach it). Filters: exact `actorId/actorType/action/
resourceId/resourceType`, `startDate/endDate` (90-day two-sided rule), `page`
(default 1, max 1000), `limit` (default 50, max 100). Newest-first OFFSET
paging via one Prisma transaction (`findMany` + `count`). Omits
`entryHash/previousHash/idempotencyKey`. 200 `{ events, pagination }`.
Dashboard calls always carry an explicit `x-app-id` from the owner's own
list; there is no unscoped owner-wide read.

### GET /v1/events/activity/:resourceId

**Authentication:** same dual credential as search. Query `limit` (default
20, max 50). Redis-first (`source: cache`), PostgreSQL fallback + async warm
(`source: database`).

### POST /v1/verify — Enqueue verification job

**Authentication:** app key **or** dashboard internal + owner/app headers.
**Rate limit:** 1/5 min (POST only). **202** `{ jobId, status: 'pending',
startedAt, pollUrl }`; **409** `JOB_IN_PROGRESS` with existing `jobId/pollUrl`.
Job/sentinel TTLs above; BullMQ durable.

### GET /v1/verify/:jobId — Poll verification result

**Authentication:** same dual credential; app-scoped namespace + stored
`appId` check. **200** full job (`pending/running/complete/failed`, invalid
chains as `valid: false`); **400** malformed UUID; **404** `JOB_NOT_FOUND`;
**500** `JOB_DATA_CORRUPT`. No rate limit.

### GET /v1/export

**Authentication:** same dual credential as verify. Query: search filters +
`format=json|csv` (default json; page/limit validated but unused). Streams
chronologically ascending in 500-row cursor batches. CSV uncapped with formula
protection; JSON capped at `JSON_EXPORT_MAX_ROWS` (10,000) with
`truncated/totalFetched`. Attachment filenames include the app id.

### GET /v1/apps

**Authentication:** `Bearer <INTERNAL_API_KEY>` + `x-owner-id`/`x-user-id`. No
limiter. Returns only active apps with audit counts; no keys/owner ids.

### POST /v1/apps

Internal dashboard auth + 30/min limiter. Validated `name/description`.
Creates the app for that owner, stores only the key digest, returns the raw
`als_` key once (201).

### POST /v1/apps/:id/rotate-key

Internal auth + limiter; UUID id scoped to owner (`APP_NOT_FOUND` otherwise).
Stores the new digest, clears the old digest cache entry, returns
`newApiKey` once (200).

### DELETE /v1/apps/:id

Internal auth + limiter; UUID id scoped to owner. Soft-deletes
(`isActive: false`), clears the digest cache entry, preserves audit logs, 204.

### GET /health (unversioned)

No auth. 200 `ok` / 503 `degraded` with generic per-dependency
(`postgresql`, `redis`) `connected`/`unavailable` statuses and ISO timestamp
(3 s per-check timeout). Raw dependency error messages stay in server-side
logs and never appear in the public response.

Dashboard proxies for the same operations: `POST
/api/dashboard/apps/[id]/rotate-key` (session + UUID; forwards backend 200
JSON with `newApiKey`; 400/401/403/404/429 mapped, else generic 502) and
`DELETE /api/dashboard/apps/[id]` (session + UUID; preserves backend 204
with no JSON parsing; same error mapping). App creation proxy `POST
/api/dashboard/apps` validates `name` (1–100) / `description` (≤500) and
returns the backend 201 JSON.

---

## Environment Variables — Complete List

```env
# Server
PORT=3000
NODE_ENV=development

# PostgreSQL
DATABASE_URL="postgresql://user:password@localhost:5432/auditlog?schema=public"

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

# Security
HASH_SECRET="your-256-bit-secret-here"   # HMAC chain + API-key digest key. Set ONCE. Never change after first entry.
GENESIS_HASH="audit-log-genesis"          # previousHash for the first entry per app.

# Internal API key — shared secret between Next.js dashboard (server-only) and Express API.
# Sent as Bearer with x-owner-id (+ x-app-id for verify/export). Never sent to browsers.
INTERNAL_API_KEY="your-internal-api-key-here"

# NextAuth (dashboard OAuth)
NEXTAUTH_URL="http://localhost:3001"
NEXTAUTH_SECRET="your-nextauth-secret"
GITHUB_CLIENT_ID="your-github-oauth-app-client-id"
GITHUB_CLIENT_SECRET="your-github-oauth-app-client-secret"

# Brevo (email alerts)
BREVO_API_KEY="your-brevo-api-key"
ALERT_EMAIL_FROM="alerts@yourdomain.com"
ALERT_EMAIL_TO="you@yourdomain.com"

# Rate limiting
CORS_ORIGINS="http://localhost:3001"
RATE_LIMIT_EVENTS_WINDOW_MS=60000
RATE_LIMIT_EVENTS_MAX=200
RATE_LIMIT_VERIFY_WINDOW_MS=300000
RATE_LIMIT_VERIFY_MAX=1
RATE_LIMIT_APPS_WINDOW_MS=60000
RATE_LIMIT_APPS_MAX=30
RATE_LIMIT_SEARCH_WINDOW_MS=60000
RATE_LIMIT_SEARCH_MAX=100
RATE_LIMIT_EXPORT_WINDOW_MS=60000
RATE_LIMIT_EXPORT_MAX=10

# Redis cache config
API_KEY_CACHE_TTL_SECONDS=600
ACTIVITY_CACHE_MAX_ENTRIES=50
ACTIVITY_CACHE_TTL_SECONDS=3600
MOCK_API_KEY="api-key-used-by-mock-producer"

# Verify job config
VERIFY_JOB_TTL_SECONDS=3600          # Terminal job-state TTL
VERIFY_ACTIVE_TTL_SECONDS=3600       # Sentinel TTL + heartbeat basis (code default; absent from .env.example)

# Export config
JSON_EXPORT_MAX_ROWS=10000

# Hash chain verification batch size
VERIFY_CHAIN_BATCH_SIZE=500

# Dashboard (Vercel planned)
NEXT_PUBLIC_API_URL="https://your-railway-api-url.railway.app"
API_URL="https://your-railway-api-url.railway.app"
```

The API and worker entrypoints run `validateEnv()` on startup: the 7 required
variables above, plus numeric validation for all consumed settings, plus a
32-character floor for `HASH_SECRET`/`INTERNAL_API_KEY` under
`NODE_ENV=production` (warning only elsewhere). `DASHBOARD_OWNER_ID`,
`ALLOW_DASHBOARD_DEV_AUTH`, and `ENABLE_API_KEY_CACHE_IN_TESTS` are not used
and must not be documented as behavior. CI uses deterministic
`HASH_SECRET`/`INTERNAL_API_KEY` values. Dashboard boot validates its own
config (`dashboard/scripts/validate-env.cjs` via `next.config.mjs`):
`INTERNAL_API_KEY`, `NEXTAUTH_SECRET` (≥32), `GITHUB_*`, and at least one of
`API_URL`/`NEXT_PUBLIC_API_URL` with valid http(s) shape.

---

## Transaction Safety — The Race Condition Problem

**The problem:** two concurrent ingestions for one app can both read the same
tail hash, compute the same `previousHash`, and insert — breaking the chain.

**The solution:** Serializable isolation + retry loop (3 attempts) + unique
`(appId, sequenceNumber)` + idempotent P2002 handling, exactly as implemented
in `src/routes/events.ts`. The idempotency pre-check stays outside the
transaction; the constraint covers the concurrent race.

---

## Testing Strategy

Jest + Supertest against real PostgreSQL and Redis:

* `hashChain.test.ts`: determinism, ordering, clean/tampered/empty chains.
* `apiKey.test.ts`: HMAC digest storage, cache behavior, invalid keys, rotation, deactivation.
* `events.test.ts`: ingestion and API-key authorization contracts.
* `search.test.ts`: search/filter behavior.
* `activityCache.test.ts`: activity cache and database fallback.
* `verify.test.ts`: BullMQ enqueue, polling, 409/dedup under concurrency, dashboard owner/app scoping, tamper detection (uses a live worker; pauses it for contention tests).
* `verificationWorker.test.ts`: retry-then-complete, terminal failure, heartbeat renewal, sentinel ownership.
* `dashboardEvents.test.ts`: dashboard owner-scoped event reads (own app 200, cross-owner/random-ID 403, missing app context 403, customer-key reads, filtered search, activity isolation).

Run with `npm test` (`--runInBand` in CI); currently 38/38 across 8 suites.
Dashboard validation uses its separate `typecheck`/`build`; there is no
dashboard Jest suite.

---

## Deployment Architecture

```
[Vercel — planned, not automated]
  └── Next.js dashboard (NextAuth GitHub)
      ├── Server proxies attach INTERNAL_API_KEY + owner/app headers
      └── Calls Railway API at /v1/* for all data

[Railway — planned, not automated]
  ├── Express API (Node 20, non-root production image, /health check)
  │     ├── GET  /health
  │     ├── GET/POST /v1/apps (+ rotate/delete)
  │     ├── POST /v1/events, GET /v1/events(+activity)
  │     ├── POST /v1/verify, GET /v1/verify/:jobId (BullMQ enqueue + poll)
  │     └── GET  /v1/export
  ├── Verification worker (same image, worker command, concurrency 1)
  ├── PostgreSQL (apps + audit_logs + append-only trigger)
  └── Redis (apikey:*, activity:*, verify-job:*, verify-active:*, BullMQ keys)
```

**Local (implemented):** `docker-compose.yml` runs `postgres` (15, healthy),
`redis` (7-alpine append-only, healthy), `api` (production image, port 3000,
healthy dependencies), and `worker` (production image, worker command,
healthcheck disabled). `Dockerfile` is a two-stage Node 20 bookworm-slim build
(OpenSSL in both stages, Prisma generate + `tsc`, `npm ci --omit=dev`,
non-root `node` user, `/health` HEALTHCHECK, default `node dist/app.js`).

---

## GitHub Actions CI

Workflow `CI`, triggers `push`/`pull_request` on `main`/`master`, with two
jobs: `Test & Build` (backend: `ubuntu-latest` with `postgres:15` and
`redis:7-alpine` services; deterministic CI-only secrets; steps checkout →
Node 20 → `npm ci` → `prisma generate` → `typecheck` → `lint` →
`prisma migrate deploy` → `jest --runInBand` → production `build` →
`git diff --check`) and `Dashboard typecheck & build` (lockfile-pinned
`npm ci`, `typecheck`, `build` with non-secret deployment-shaped config).
There is no deploy step — CI validates; it does not ship.

---

## Key Interview Questions and Exact Answers

**Q: Why is the audit log tamper-proof?**
A: Every entry's HMAC covers the previous entry's hash plus the current payload. Changing any hashed field changes that entry's hash, invalidating every later link. Verification recomputes the whole chain and reports the first break. Un-hashed columns rely on the append-only trigger.

**Q: Why a PostgreSQL trigger instead of application checks?**
A: Application code can have bugs or be bypassed; raw SQL with DB credentials bypasses it entirely. The trigger fires at the engine level for every UPDATE/DELETE.

**Q: Why timingSafeEqual instead of ===?**
A: `===` short-circuits on the first differing byte, leaking timing information. timingSafeEqual compares in constant time for equal-length inputs.

**Q: Why Redis sorted sets for the activity cache?**
A: Timestamp scores give the N most recent entries in one ZREVRANGE; ZREMRANGEBYRANK trims in one command. Correct structure for a capped recency feed.

**Q: Why Serializable isolation?**
A: Concurrent writers would otherwise read the same tail and fork the chain. Serializable forces an effective sequential order (loser gets P2034 and retries).

**Q: What happens if Redis goes down?**
A: Caches degrade gracefully (API-key/activity/analytics fall back to PostgreSQL). Verification polling needs Redis; BullMQ delivery stalls until Redis returns.

**Q: What happens on a POST /v1/events retry?**
A: With an `idempotencyKey`, the server returns the original entry (200). Without one, retries insert duplicates. The unique constraint makes even concurrent retries safe.

**Q: Why is verification asynchronous and worker-based?**
A: Verification is O(n) and must not block HTTP workers. The API persists state and enqueues durably; a separate worker scans with heartbeated sentinel ownership, retries with backoff, and survives API restarts. The 1/5-min start limiter plus the atomic sentinel prevent abuse and duplicates.

**Q: How would you scale for very high event volume?**
A: Shard chains by appId (independent), partition `audit_logs` by app, and add incremental verification checkpoints (verify only new entries since the last checkpoint).

**Q: Why is actorType a free string?**
A: Any client app must be able to log its own actor kinds without a service redeploy; DB/hash already treat it as a string.

---

## Common Mistakes to Avoid

1. **Never change HashPayload field order** — JSON order is hash input.
2. **Keep NextAuth and backend credentials separate** — GitHub sessions guard dashboard pages/proxies; backend calls still need internal or app keys.
3. **Never expose INTERNAL_API_KEY to browsers** — dashboard use stays in `server-only` code with `API_URL`.
4. **Never change HASH_SECRET after the first entry** — chains and stored digests both break.
5. **Always use $queryRaw for date aggregations** — no full-table fetch into Node memory.
6. **Test the trigger and tampering end-to-end** — disable trigger, mutate, re-enable, verify `valid: false` at the right sequence.
7. **Use `cache: 'no-store'` in dashboard server fetches** — audit data is real-time.
8. **Provide idempotencyKey on retried ingestion** — else retries duplicate.
9. **Never delete BullMQ state in API shutdown** — close the handle only; the worker owns consumption.
10. **Always release/renew the sentinel by owner jobId** — unconditional DEL/EXPIRE would steal another job's slot.

---

## Resume Bullet Points

```
Audit Log Service | Node.js, TypeScript, PostgreSQL, Redis, BullMQ, Next.js
- Tamper-evident audit API with HMAC hash chains, Serializable ingestion, and DB-level append-only enforcement.
- Durable BullMQ verification worker with atomic Redis sentinel, heartbeating, retries, and tamper alerts.
- Dual auth: HMAC-digest app API keys plus server-only dashboard credentials scoped by GitHub owner identity.
- Dockerized api/worker/postgres/redis with non-root production image; CI-gated typecheck/lint/tests/build.
```
