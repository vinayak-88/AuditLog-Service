# Backend data storage

## Storage boundaries

The backend uses three runtime storage classes.

1. PostgreSQL through Prisma holds applications and audit-log rows. It is the persistent system of record.
2. Redis through ioredis/BullMQ holds cache data, verification-job state, the verification active-job sentinel, and the BullMQ queue backend. It is not the source of record for audit logs.
3. Process memory holds module constants and process-local rate-limit state. The API and worker are separate processes with separate memory.

Endpoint use of these stores is detailed in [ROUTES_AND_FLOW.md](ROUTES_AND_FLOW.md), and end-to-end lifecycles are summarized in [ARCHITECTURE.md](ARCHITECTURE.md).

## PostgreSQL and Prisma

PostgreSQL 15 (Compose and CI images). Prisma `^5.22.0` (`@prisma/client` and
`prisma` CLI). `prisma/schema.prisma` uses `binaryTargets = ["native",
"debian-openssl-3.0.x"]` so the production image (Debian OpenSSL 3) can load
the client; the Dockerfile installs `openssl` in both stages for this reason.

src/config/db.ts creates one PrismaClient with JSON logging over console. The
datasource is PostgreSQL and reads `DATABASE_URL`. The backend creates no
explicit database-pool settings; Prisma owns its connection behavior.

### App model

App represents one client application whose activity is audited. There is no
separate `User` table; `ownerId` is the dashboard owner's GitHub identity
(NextAuth `token.sub`, sent as `x-owner-id` with `INTERNAL_API_KEY`).

| Field | Current Prisma definition | Meaning and lifecycle |
|---|---|---|
| id | Required primary-key String; default uuid(7); database UUID | Application identifier (UUID string; route params validated as UUID). |
| name | Required string | Supplied during app registration. |
| description | Nullable string | Optional registration description; missing input is persisted as null. |
| apiKey | Required unique string | HMAC-SHA256 digest of the raw `als_` bearer credential (`hashApiKey`, keyed by `HASH_SECRET`). The raw key is returned only once at creation or rotation. |
| ownerId | Required indexed string | GitHub owner scope used by the apps router and dashboard-owned verify/export path. |
| isActive | Required boolean; default true | Soft-deletion flag. API-key database lookup requires true. |
| createdAt | Required DateTime; default now() | Creation timestamp. |
| updatedAt | Required DateTime; updatedAt | Prisma-managed update timestamp. |
| auditLogs | One-to-many relation | AuditLog records linked through AuditLog.appId. |

POST /v1/apps writes an App. GET /v1/apps reads active apps for one owner and includes the count of related audit rows. Key rotation updates apiKey; deletion updates isActive. No backend route permanently deletes an App.

### AuditLog model

AuditLog is one audit-event record in a particular application chain.

| Field | Current Prisma definition | Meaning and use |
|---|---|---|
| id | Required primary-key String; default uuid(7); database UUID | Row identifier used by cursors, API responses, and verification results. |
| appId | Required UUID string; foreign key to App.id | Tenant boundary and chain partition. |
| actorId | Required string | Identifier of the actor responsible for the event. |
| actorType | Required string | Open actor classification; validation permits a nonempty bounded string. |
| action | Required string | Recorded action label. |
| resourceId | Required string | Identifier of the affected resource. |
| resourceType | Required string | Resource classification. |
| metadata | Nullable JSON (JSONB) | Optional arbitrary object, validated to a serialized 10 KB maximum. |
| ipAddress | Nullable string | Optional validated IP address; stored but not part of the hash payload. |
| userAgent | Nullable string | Optional 500-character user-agent string; stored but not part of the hash payload. |
| idempotencyKey | Nullable string | Optional retry token; stored but not part of the hash payload. |
| entryHash | Required string | Hex HMAC calculated for this row's defined hash payload. |
| previousHash | Required string | Prior row entryHash, or GENESIS_HASH for sequence one. |
| sequenceNumber | Required integer | Per-app logical ordering for chain creation and verification. |
| createdAt | Required DateTime; default now() | Timestamp included in the hash payload; ingestion supplies it explicitly. |
| app | Required relation | Parent App relation. |

The initial migration makes AuditLog.appId reference apps.id with ON DELETE RESTRICT and ON UPDATE CASCADE. Soft deletion of an App therefore preserves audit rows.

### Constraints and indexes

| Constraint or index | Purpose |
|---|---|
| Primary key on each model ID | Identifies an App or audit row. |
| Unique App.apiKey (`apps_apiKey_key`) | Prevents two applications from sharing a bearer-key digest. |
| Unique AuditLog(appId, sequenceNumber) (`audit_logs_appId_sequenceNumber_key`) | Prevents duplicate sequence numbers within one chain. There is no separate plain index on `(appId, sequenceNumber)`. |
| Unique AuditLog(appId, idempotencyKey) (schema name `unique_app_idempotency_key`) | Resolves concurrent idempotent inserts. PostgreSQL permits multiple NULLs, so keyless requests are not deduplicated. |
| Index App.ownerId (`apps_ownerId_idx`) | Supports owner-scoped app listing. |
| Index AuditLog(appId, createdAt) | Supports app-scoped chronological reads. |
| Index AuditLog(appId, actorId) | Supports exact actor filtering. |
| Index AuditLog(appId, resourceId) | Supports resource filtering and activity fallback. |
| Index AuditLog(appId, action) | Supports action filtering. |

### Integrity and physical-schema state

Migrations create tables named apps and audit_logs with quoted camel-case
columns such as "appId" and "createdAt". Two migrations exist (see below); both
must be applied with `npm run prisma:migrate`.

The trigger migration installs `prevent_audit_log_modification()` and the
`audit_log_immutable` trigger (`BEFORE UPDATE OR DELETE ON audit_logs FOR EACH
ROW`). The trigger runs before every audit_logs UPDATE or DELETE and raises an
exception, so ordinary application code and raw SQL writes cannot mutate
history. Tests temporarily disable/enable this trigger to simulate tampering.

The trigger protects ordinary writes. The database roles that can disable,
alter, or bypass that trigger are **not determinable from the current
codebase**. Do not invent production guarantees beyond the trigger itself.

### Migration history

| Migration | Contents |
|---|---|
| `20260908202915_init` | Creates `apps` and `audit_logs` (UUID columns), unique `apps("apiKey")`, indexes on `apps("ownerId")` and `audit_logs(appId, createdAt/actorId/resourceId/action)`, unique `(appId, sequenceNumber)` and `(appId, idempotencyKey)`, and the `audit_logs → apps` foreign key (`ON DELETE RESTRICT`, `ON UPDATE CASCADE`). |
| `20260908202916_add_immutability_trigger` | Creates `prevent_audit_log_modification()` and the `audit_log_immutable` trigger. |

There are no other checked-in migrations. Do not invent tables, fields,
indexes, or relationships beyond this history and `schema.prisma`.

### Database readers and writers

| Storage action | Current code path |
|---|---|
| Create App | apps.ts registration route |
| Read or update App | API-key authentication; dashboard-owned verify/export lookup; app listing; key rotation; soft deletion |
| Create AuditLog | events.ts inside a Serializable transaction |
| Read AuditLog | Search, activity-cache fallback, export, worker `verifyChain`, and analytics functions |
| Update or delete AuditLog | No normal backend route; the trigger rejects ordinary changes |

createAuditLogEntry() uses Serializable isolation. It reads the tail for one app, derives a sequence/hash, and creates the audit row in the same transaction. Its exact concurrency behavior is described in [ARCHITECTURE.md](ARCHITECTURE.md#concurrency-and-consistency). Search pagination consistency uses a Prisma array transaction (`findMany` + `count` with the same filter).

## Redis

src/config/redis.ts creates one ioredis client with configured host, port, and
optional password. It uses a retry strategy that grows from 100 ms to at most 3
seconds and sets maxRetriesPerRequest to three. Connection, error, and close
events are logged through Winston. The BullMQ queue and worker use their own
connections with `maxRetriesPerRequest: null`, as BullMQ requires.

### API-key cache

| Property | Current behavior |
|---|---|
| Key | `apikey:<HMAC-SHA256 digest of raw API key>` |
| Value | JSON serialization of non-secret app authorization data (`Omit<App,'apiKey'>`: id, name, description, ownerId, isActive, timestamps) |
| TTL | `API_KEY_CACHE_TTL_SECONDS`; default 600 seconds |
| Writer | apiKeyAuth after a successful PostgreSQL lookup |
| Reader | apiKeyAuth before the PostgreSQL lookup |
| Deleter | digest-based cache invalidation (`clearApiKeyCacheDigest`) after key rotation and soft deletion |
| Miss or failure | A miss, malformed/inactive value (evicted), or Redis error falls back to PostgreSQL; write/delete failures log warnings |

The cache reader requires cached id, ownerId, and `isActive: true`, recreates timestamps as Date values, and assigns the non-secret authorization data to req.auditApp. Redis failures fall back to PostgreSQL authentication.

### Activity-feed cache

| Property | Current behavior |
|---|---|
| Key | `activity:<appId>:<resourceId>` |
| Redis type | Sorted set |
| Member | JSON ActivityEntry: id, actorId/type, action, resourceId/type, metadata, ISO timestamp; no IP/user-agent/hash fields |
| Score | Milliseconds from entry.createdAt |
| TTL | `ACTIVITY_CACHE_TTL_SECONDS`; default 3,600 seconds; reset on each write/warm |
| Maximum | `ACTIVITY_CACHE_MAX_ENTRIES`; default 50 |
| Writers | New-event ingestion (`cacheActivityEntry`, fire-and-forget) and PostgreSQL fallback warm (`bulkCacheActivityEntries`, non-awaited) |
| Reader | Activity endpoint through ZREVRANGE |
| Explicit deleter | clearActivityCache() exists but no current route calls it |

Single-entry writes pipeline ZADD, ZREMRANGEBYRANK, and EXPIRE. Bulk warming pipelines one ZADD per entry followed by one trim and expiry. Pipeline errors are logged; activity caching is best-effort.

### Verification-job state

| Property | Current behavior |
|---|---|
| Key | `verify-job:<appId>:<jobId>` |
| Value | JSON VerifyJob: jobId (UUID), appId, status (`pending`/`running`/`complete`/`failed`), optional phase (`queued`/`running`/`retrying`), startedAt, optional completedAt/attemptsMade/result/error |
| TTL | `VERIFY_JOB_TTL_SECONDS` (default 3,600 s), set **only when a terminal state is saved** (`complete`/`failed`). Non-terminal saves (`pending`/`running`/`retrying`) are written with no expiry; the record gains its TTL when the worker or API writes the terminal state. |
| Writers | Verify route writes `pending`/`queued` at start (and `failed` on enqueue failure); worker writes `running`, `pending`/`retrying`, `complete`, `failed` |
| Reader | GET /v1/verify/:jobId, namespaced by the authenticated app (`readVerifyJob`); stored `appId` must also match, else 404 |
| Validation | `VerifyJobSchema.safeParse`; schema failure yields 500 `JOB_DATA_CORRUPT`; unparseable JSON also fails (throws before safeParse) |
| Deletion | No explicit deletion; Redis expiry removes terminal records |

### Verification active-job sentinel

| Property | Current behavior |
|---|---|
| Key | `verify-active:<appId>` |
| Value | Owning `jobId` string |
| TTL | `VERIFY_ACTIVE_TTL_SECONDS`; default 3,600 seconds |
| Acquire | Atomic Lua: absent → set + return acquired; present with terminal referenced job → overwrite (stale recovery); present with active/missing/corrupt referenced job → return existing jobId (blocked, relies on TTL for crash recovery) |
| Release | Atomic Lua conditional DEL: only deletes when the stored value still equals the caller's `jobId`. Called on terminal worker states and on enqueue failure. |
| Renewal | Atomic Lua conditional EXPIRE (`renewVerifySlot`); worker heartbeat (`startVerifyHeartbeat`) renews every TTL/3 (minimum 1 s) while `verifyChain()` runs; renewal by a non-owner returns false |
| Readers | Only the acquire/release/renew scripts; no route lists sentinels |

### BullMQ queue backend

The `verification` queue persists its jobs in Redis (BullMQ-managed keys).
Queue default options: `attempts: 3`, exponential backoff `delay: 500`,
`removeOnComplete: true`, `removeOnFail: true`. BullMQ records are removed on
settlement; the observable job record is the `verify-job:*` key above, not the
BullMQ internals.

### Analytics cache

analyticsService.ts uses cache-aside Redis keys named `analytics:volume:<appId>`,
`analytics:top-actors:<appId>`, and `analytics:action-breakdown:<appId>`. Each
stores JSON for `ANALYTICS_CACHE_TTL_SECONDS`, default 60 seconds. No current
backend route invokes these functions.

## In-memory state and singleton lifetime

| State | Lifetime and sharing |
|---|---|
| Prisma singleton | One client per process (API and worker each have one); assigned to globalThis only outside production; lost on restart |
| Redis singleton | One ioredis client per API process; worker/queue use BullMQ connections; lost/reconnected on restart |
| Logger singleton | One Winston logger per process (console transport) |
| Rate-limit stores | No custom external store is passed; express-rate-limit default state is process-local and lost on restart |
| Module constants | Environment-derived TTLs, limits, batch sizes, and retry counts are read when modules load and persist until restart |
| Verification work | Lives in Redis + BullMQ, not process memory; either process can restart without losing queued jobs (BullMQ redelivers) |

## Runtime filesystem usage

src/config/logger.ts writes structured JSON logs to the process console. No
backend route writes audit rows, exports, or temporary files to the filesystem;
exports stream directly to HTTP responses.

## Storage configuration and lifecycle

`DATABASE_URL` controls persistent database access. `REDIS_HOST`, `REDIS_PORT`,
and `REDIS_PASSWORD` configure Redis. `HASH_SECRET`, `GENESIS_HASH`,
`INTERNAL_API_KEY`, and `CORS_ORIGINS` are required on direct server startup
and determine hash-chain verification, dashboard authorization, and browser
access. The full configuration map is in [ARCHITECTURE.md](ARCHITECTURE.md#configuration-map).

Important lifecycles are:

- New audit event: HTTP JSON -> Zod validation -> Serializable Prisma transaction -> AuditLog row -> non-awaited Redis activity write -> response.
- Activity read: authenticated request -> Redis sorted-set read; otherwise PostgreSQL query -> response plus asynchronous Redis warm.
- Verification: authenticated request -> atomic sentinel acquire -> Redis pending state -> BullMQ enqueue -> worker scan (`verifyChain`) with heartbeat -> Redis terminal state + sentinel release -> polling response.

~~~mermaid
flowchart TB
  Apps[(apps)] -->|one-to-many| Logs[(audit_logs)]
  Auth[API-key / dashboard auth] --> KeyCache[(Redis apikey cache)]
  Ingest[Event ingestion] --> Logs
  Ingest --> Activity[(Redis activity sorted sets)]
  ActivityRead[Activity read] --> Activity
  ActivityRead --> Logs
  VerifyReq[Verify request] --> Sentinel[(Redis verify-active sentinel)]
  VerifyReq --> Jobs[(Redis verification jobs)]
  VerifyReq --> BullQ[(BullMQ verification queue)]
  BullQ --> WorkerJob[Worker verifyChain] --> Logs
  WorkerJob --> Jobs
  WorkerJob --> Sentinel
  Analytics[Unwired analytics functions] --> Logs
  Analytics --> AnalyticsCache[(Redis analytics cache)]
~~~
