# Backend data storage

## Storage boundaries

The backend uses three runtime storage classes.

1. PostgreSQL through Prisma holds applications and audit-log rows. It is the persistent system of record.
2. Redis through ioredis holds cache data and verification-job state with expiry. It is not the source of record for audit logs.
3. Process memory holds module constants and process-local rate-limit state.

Endpoint use of these stores is detailed in [ROUTES_AND_FLOW.md](ROUTES_AND_FLOW.md), and end-to-end lifecycles are summarized in [ARCHITECTURE.md](ARCHITECTURE.md).

## PostgreSQL and Prisma

### Prisma configuration

src/config/db.ts creates one PrismaClient with error-level logging.

The datasource is PostgreSQL and reads DATABASE_URL. The backend creates no explicit database-pool settings; Prisma owns its connection behavior.

### App model

App represents one client application whose activity is audited.

| Field | Current Prisma definition | Meaning and lifecycle |
|---|---|---|
| id | Required primary-key String; default uuid(7); database UUID | Application identifier. |
| name | Required string | Supplied during app registration. |
| description | Nullable string | Optional registration description; missing input is persisted as null. |
| apiKey | Required unique string | HMAC-SHA256 digest of the raw `als_` bearer credential. The raw key is returned only once at creation or rotation. |
| ownerId | Required indexed string | Owner scope used by the apps router. |
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
| metadata | Nullable JSON | Optional arbitrary object, validated to a serialized 10 KB maximum. |
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
| Unique App.apiKey | Prevents two applications from sharing a bearer key. |
| Unique AuditLog(appId, sequenceNumber) | Prevents duplicate sequence numbers within one chain. |
| Unique AuditLog(appId, idempotencyKey) | Resolves concurrent idempotent inserts. PostgreSQL permits multiple NULLs, so keyless requests are not deduplicated. |
| Index App.ownerId | Supports owner-scoped app listing. |
| Index AuditLog(appId, createdAt) | Supports app-scoped chronological reads. |
| Index AuditLog(appId, actorId) | Supports exact actor filtering. |
| Index AuditLog(appId, resourceId) | Supports resource filtering and activity fallback. |
| Index AuditLog(appId, action) | Supports action filtering. |

### Integrity and physical-schema state

Migrations create tables named apps and audit_logs, with quoted camel-case columns such as "appId" and "createdAt". The migration also installs prevent_audit_log_modification() and the audit_log_immutable trigger. The trigger runs before every audit_logs UPDATE or DELETE and raises an exception.

The current source has a material migration conflict. prisma/schema.prisma declares UUID v7 defaults and UUID columns for App.id, AuditLog.id, and AuditLog.appId. The checked-in initial migration creates TEXT IDs, and no checked-in migration changes them. A fresh database created solely by the migrations uses the SQL migration definition. The exact schema of an existing database is **not determinable from the current codebase**. The apps router also validates mutation IDs as CUID strings rather than UUID strings.

The trigger protects ordinary writes. The database roles that can disable, alter, or bypass that trigger are **not determinable from the current codebase**.

### Database readers and writers

| Storage action | Current code path |
|---|---|
| Create App | apps.ts registration route |
| Read or update App | API-key authentication; app listing; key rotation; soft deletion |
| Create AuditLog | events.ts inside a Serializable transaction |
| Read AuditLog | Search, activity-cache fallback, export, verification, and analytics functions |
| Update or delete AuditLog | No normal backend route; the trigger rejects ordinary changes |

createAuditLogEntry() uses Serializable isolation. It reads the tail for one app, derives a sequence/hash, and creates the audit row in the same transaction. Its exact concurrency behavior is described in [ARCHITECTURE.md](ARCHITECTURE.md#concurrency-and-consistency).

## Redis

src/config/redis.ts creates one ioredis client with configured host, port, and optional password. It uses a retry strategy that grows from 100 ms to at most 3 seconds and sets maxRetriesPerRequest to three. In test mode it is lazy-connected. Connection, error, and close events are logged through Winston.

### API-key cache

| Property | Current behavior |
|---|---|
| Key | apikey:<HMAC-SHA256 digest of raw API key> |
| Value | JSON serialization of non-secret app authorization data: id, name, description, owner, active flag, and timestamps |
| TTL | API_KEY_CACHE_TTL_SECONDS; default 600 seconds |
| Writer | apiKeyAuth after a successful PostgreSQL lookup |
| Reader | apiKeyAuth before the PostgreSQL lookup |
| Deleter | digest-based cache invalidation after key rotation and soft deletion |
| Miss or failure | A miss, malformed value, or Redis error falls back to PostgreSQL; write/delete failures log warnings |

The cache reader requires cached id, ownerId, and `isActive: true`, recreates timestamps as Date values, and assigns the non-secret authorization data to req.auditApp. Rotation and soft deletion invalidate the cache using the stored digest. Redis failures fall back to PostgreSQL authentication.

### Activity-feed cache

| Property | Current behavior |
|---|---|
| Key | activity:<appId>:<resourceId> |
| Redis type | Sorted set |
| Member | JSON ActivityEntry: ID, actor ID/type, action, resource ID/type, metadata, ISO timestamp; no IP/user-agent fields |
| Score | Milliseconds from entry.createdAt |
| TTL | ACTIVITY_CACHE_TTL_SECONDS; default 3,600 seconds; reset on each write/warm |
| Maximum | ACTIVITY_CACHE_MAX_ENTRIES; default 50 |
| Writers | New-event ingestion and PostgreSQL fallback warm |
| Reader | Activity endpoint through ZREVRANGE |
| Explicit deleter | clearActivityCache() exists but no current route calls it |

Single-entry writes pipeline ZADD, ZREMRANGEBYRANK, and EXPIRE. Bulk warming pipelines one ZADD per entry followed by one trim and expiry. Pipeline errors are logged; activity caching is best-effort.

### Verification-job state

| Property | Current behavior |
|---|---|
| Key | verify-job:<appId>:<jobId> |
| Value | JSON object containing job ID, app ID, status, timestamps, optional result, and optional error |
| TTL | VERIFY_JOB_TTL_SECONDS; default 3,600 seconds, reset when a job is saved |
| Writers | Verification start writes pending; runVerifyJob writes complete or failed |
| Reader | GET /v1/verify/:jobId, scoped to the authenticated app |
| Discovery | Verification start SCANs verify-job:<appId>:* and parses candidates for pending status |
| Deletion | No explicit deletion; Redis expiry removes the key |

Redis is not a durable queue. If it is unavailable, POST /v1/verify still schedules work but a client may be unable to poll any state.

### Analytics cache

analyticsService.ts uses cache-aside Redis keys named analytics:volume:<appId>, analytics:top-actors:<appId>, and analytics:action-breakdown:<appId>. Each stores JSON for ANALYTICS_CACHE_TTL_SECONDS, default 60 seconds. No current backend route invokes these functions. The volume query uses snake-case column names that conflict with the checked-in camel-case migration columns; see [the source reference](SRC_CODE_REFERENCE.md#srcservicesanalyticsservicets).

## In-memory state and singleton lifetime

| State | Lifetime and sharing |
|---|---|
| Prisma singleton | One client per process; assigned to globalThis only outside production; lost on restart |
| Redis singleton | One ioredis client per process; lost/reconnected on restart |
| Logger singleton | One Winston logger per process |
| Rate-limit stores | No custom external store is passed; express-rate-limit default state is process-local and lost on restart |
| Module constants | Environment-derived TTLs, limits, batch sizes, and retry count are read when modules load and persist until restart |
| Verification work | setImmediate retains a closure only until it runs; no process-local job registry exists |

## Runtime filesystem usage

src/config/logger.ts writes structured logs to the process console. No backend route writes audit rows, exports, or temporary files to the filesystem; exports stream directly to HTTP responses.

## Storage configuration and lifecycle

DATABASE_URL controls persistent database access. REDIS_HOST, REDIS_PORT, and REDIS_PASSWORD configure temporary Redis data. HASH_SECRET, GENESIS_HASH, INTERNAL_API_KEY, and CORS_ORIGINS are required on direct server startup and determine hash-chain verification, dashboard authorization, and browser access. The full configuration map is in [ARCHITECTURE.md](ARCHITECTURE.md#configuration-map).

Important lifecycles are:

- New audit event: HTTP JSON -> Zod validation -> Serializable Prisma transaction -> AuditLog row -> non-awaited Redis activity write -> response.
- Activity read: authenticated request -> Redis sorted-set read; otherwise PostgreSQL query -> response plus asynchronous Redis warm.
- Verification: authenticated request -> Redis pending state -> process-local PostgreSQL scan -> Redis complete/failed state -> polling response.

~~~mermaid
flowchart TB
  Apps[(apps)] -->|one-to-many| Logs[(audit_logs)]
  Auth[API-key authentication] --> KeyCache[(Redis apikey cache)]
  Ingest[Event ingestion] --> Logs
  Ingest --> Activity[(Redis activity sorted sets)]
  ActivityRead[Activity read] --> Activity
  ActivityRead --> Logs
  Verify[Verification] --> Logs
  Verify --> Jobs[(Redis verification jobs)]
  Analytics[Unwired analytics functions] --> Logs
  Analytics --> AnalyticsCache[(Redis analytics cache)]
~~~

