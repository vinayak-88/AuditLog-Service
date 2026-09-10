# Routes and execution flows

## Router registration

Express is initialized by createApp() in src/app.ts. The application mounts routes in this order:

1. GET /health through healthRouter, with no authentication.
2. /v1/apps through appsRouter, with route-local dashboard-owner authorization (no `apiKeyAuth`).
3. /v1/events through eventsRouter (`POST /`) and searchRouter (`GET /`, `GET /activity/:resourceId`), each behind `apiKeyAuth` (customer app key only).
4. /v1/verify through verifyRouter behind `dashboardOrApiKeyAuth` (customer key **or** `INTERNAL_API_KEY` + `x-owner-id` + `x-app-id`).
5. /v1/export through exportRouter behind `dashboardOrApiKeyAuth` (same dual credential).
6. A global JSON 404 handler and then errorHandler.

The shared event prefix is intentional: eventsRouter declares POST / while searchRouter declares GET / and GET /activity/:resourceId. There are no controller classes; each handler performs its own Prisma/service calls.

Every response created by a normal route uses a success boolean and data field. Error responses generally use success false and an error object containing message, code, and statusCode. The 404 and rate-limit responses follow that shape. After an export has started streaming, an exception cannot reliably be converted into a fresh JSON error because response headers/body may already have been written.

Global security and parsing middleware runs before these routes. Its exact order and behavior are in [MIDDLEWARE.md](MIDDLEWARE.md).

## Route map

| Method | Complete path | Router | Authentication |
|---|---|---|---|
| GET | /health | health.ts | None |
| GET | /v1/apps | apps.ts | `INTERNAL_API_KEY` + `x-owner-id`/`x-user-id` (route-local requireOwnerId) |
| POST | /v1/apps | apps.ts | Same dashboard authorization |
| POST | /v1/apps/:id/rotate-key | apps.ts | Same dashboard authorization + URL id must belong to that owner |
| DELETE | /v1/apps/:id | apps.ts | Same dashboard authorization + URL id must belong to that owner |
| POST | /v1/events | events.ts | Active application API key (`apiKeyAuth`) |
| GET | /v1/events | search.ts | Active application API key (`apiKeyAuth`) |
| GET | /v1/events/activity/:resourceId | search.ts | Active application API key (`apiKeyAuth`) |
| POST | /v1/verify | verify.ts | Active app key **or** dashboard `INTERNAL_API_KEY` + `x-owner-id` + `x-app-id` |
| GET | /v1/verify/:jobId | verify.ts | Same dual credential as POST; job additionally scoped to the authenticated app |
| GET | /v1/export | export.ts | Same dual credential as verify |

## Health route

### GET /health

**Why it exists:** exposes the current connectivity result for PostgreSQL and Redis. Used by the Dockerfile HEALTHCHECK and available to platform probes.

**Flow:** route -> asyncHandler -> PostgreSQL SELECT 1 and Redis PING, each raced against a three-second timeout -> response.

**Authentication and validation:** none.

**Storage/external operations:**

- Runs Prisma raw SELECT 1.
- Runs Redis PING.
- The two checks are independently attempted even if the first fails.

**Responses:**

- 200: status is ok; both dependency values remain connected.
- 503: status is degraded; a failed dependency contains an error message derived from the caught error.

Both responses include an ISO timestamp and a dependencies object with postgresql and redis keys. The timeout timer is not explicitly cleared after a successful operation.

**Error behavior:** route-level unexpected errors are forwarded by asyncHandler. The intended dependency failures are caught locally, so they normally become a 503 payload rather than a generic 500.

## Apps management routes

All app routes are mounted before any global auth middleware. They call requireOwnerId() inside their handlers. That helper calls getDashboardOwnerId() and throws AppError with 401 DASHBOARD_AUTH_REQUIRED when no owner can be derived.

A request is authorized when `Authorization: Bearer <INTERNAL_API_KEY>` is paired with `x-owner-id` or `x-user-id`; that header becomes the owner scope. The router does not accept an application API key. There is no separate User table; the owner id is the dashboard user's GitHub identity.

### GET /v1/apps

**Why it exists:** lists the authenticated owner's active applications.

**Handler chain:** appsRouter GET / -> asyncHandler -> requireOwnerId -> Prisma App.findMany -> JSON response.

**Route-specific middleware:** no rate limiter is applied to this GET route.

**Database operation:** reads App rows where ownerId equals the derived owner and isActive is true; orders newest createdAt first; includes related AuditLog count.

**Response:** 200 with data.apps. Every returned item has id, name, description, isActive, ISO createdAt, and _count containing auditLogs. API-key digests, raw keys, and owner IDs are not returned.

**Errors:** missing dashboard authorization reaches the central handler as 401. Database errors inside the async handler become generic 500 unless represented by AppError.

### POST /v1/apps

**Why it exists:** registers an application and issues a bearer API key.

**Handler chain:** appsRateLimiter -> validateBody(RegisterAppSchema) -> asyncHandler -> requireOwnerId -> createApiKey -> Prisma App.create -> 201 response.

**Request body:**

| Field | Rule |
|---|---|
| name | Required string, 1 to 100 characters |
| description | Optional string, maximum 500 characters |

Unknown body properties are removed by normal Zod object parsing rather than rejected.

**Database operation:** creates an App with derived ownerId, validated name, description or null, and the HMAC digest of a newly generated `als_` key (`hashApiKey`, keyed by `HASH_SECRET`).

**Response:** 201 with id, name, description, the raw apiKey, and ISO createdAt. The raw key is returned once; only its HMAC digest is stored in the database.

**Errors:** invalid body returns 400 VALIDATION_ERROR. The apps rate limiter can return 429 before validation/authorization. Missing owner authorization returns 401.

### POST /v1/apps/:id/rotate-key

**Why it exists:** replaces a registered app's API key while retaining the App and audit-log rows.

**Handler chain:** appsRateLimiter -> asyncHandler -> requireOwnerId -> Zod UUID path parse -> Prisma ownership lookup -> Prisma update -> Redis old-key deletion attempt -> response.

**Path parameter:** id is parsed as a UUID, matching the Prisma schema.

**Authorization:** the app lookup requires both the provided ID and current ownerId (`findFirst({ id, ownerId })`). An app owned by someone else is indistinguishable from a missing app.

**Database and Redis operations:**

1. Find the App by id and owner ID.
2. Update apiKey to the HMAC digest of a new random key.
3. Invalidate the old digest-based cache entry (`clearApiKeyCacheDigest`). Redis failure is logged but does not fail the rotation.

**Response:** 200 with data.newApiKey. The new raw key is returned once.

**Errors:** unknown/wrong-owner app yields 404 APP_NOT_FOUND. Bad path format throws a route-local ZodError, which central error handling maps to 400 VALIDATION_ERROR.

### DELETE /v1/apps/:id

**Why it exists:** removes an app from active use without deleting its audit history.

**Handler chain:** appsRateLimiter -> asyncHandler -> requireOwnerId -> UUID path parse -> ownership lookup -> Prisma update -> Redis old-key deletion attempt -> 204.

**Path parameter:** id is parsed as a UUID (same as rotation).

**Database operation:** updates isActive to false. It does not delete the App or its AuditLog rows (the foreign key is `ON DELETE RESTRICT` in any case).

**Redis operation:** attempts to delete the cache entry for the old digest. Failure only logs a warning; a previously cached active App can remain usable until its TTL expires.

**Response:** 204 with no body.

**Errors:** same path, authorization, rate, and not-found behavior as key rotation.

## Audit-event ingestion

### POST /v1/events

**Why it exists:** appends one event to the authenticated application's hash chain.

**Flow:** apiKeyAuth -> eventsRateLimiter -> validateBody(IngestEventSchema) -> asyncHandler -> createAuditLogEntry -> optional Redis activity write -> response.

~~~mermaid
sequenceDiagram
  participant C as Client
  participant A as apiKeyAuth
  participant R as events route
  participant P as PostgreSQL
  participant D as Redis
  C->>A: Bearer application API key
  A->>D: GET apikey:{digest} cache
  alt cache miss or cache failure
    A->>P: Find active App by digest
  end
  A->>R: req.auditApp
  R->>P: Optional idempotency lookup
  alt existing key
    R-->>C: 200 original entry response
  else no existing key
    R->>P: Serializable tail read + AuditLog create
    R->>D: non-awaited activity ZADD pipeline
    R-->>C: 201 new entry response
  end
~~~

**Request body:**

| Field | Requirement |
|---|---|
| actorId | Required string, 1 to 255 characters |
| actorType | Required open string, 1 to 100 characters |
| action | Required string, 1 to 255 characters |
| resourceId | Required string, 1 to 255 characters |
| resourceType | Required string, 1 to 100 characters |
| metadata | Optional object; JSON serialization must not exceed 10 KB |
| ipAddress | Optional Zod IP string |
| userAgent | Optional string, maximum 500 characters |
| idempotencyKey | Optional string, 1 to 255 characters |

**Database flow:**

1. When an idempotency key is present, find the existing row for current app ID/key. If present, use it without a transaction.
2. Otherwise start a Serializable transaction.
3. Find the latest current-app audit row by descending sequenceNumber.
4. Derive previousHash (`GENESIS_HASH` when empty) and sequenceNumber (latest + 1, starting at 1).
5. Build the canonical hash payload (`previousHash + JSON.stringify(payload)` HMAC-SHA256 with `HASH_SECRET`).
6. Create the AuditLog row with the same timestamp used for hashing.
7. Retry P2034 serialization failure while attempt is less than three.
8. On P2002 with an idempotency key, look up the row that won the unique-constraint race and use it.

**Redis operation:** only new rows cause a fire-and-forget cacheActivityEntry call into `activity:{appId}:{resourceId}`. Redis failures do not change the successful database response.

**Responses:** 201 for a newly inserted row and 200 for a duplicate idempotency key. Both return data.entryId, data.sequenceNumber, data.entryHash, and ISO data.createdAt.

**Errors:** authentication 401, rate limit 429, validation 400, and normal forwarded unexpected errors 500.

For the hash and transaction mechanics, see [ARCHITECTURE.md](ARCHITECTURE.md#audit-log-ingestion) and [DATA_STORAGE.md](DATA_STORAGE.md#database-readers-and-writers).

## Event search and activity

### GET /v1/events

**Why it exists:** returns a page of authenticated-app audit events without internal chain fields.

**Flow:** apiKeyAuth -> searchRateLimiter -> validateQuery(SearchEventsSchema) -> asyncHandler -> buildEventWhere -> Prisma transaction containing findMany and count -> JSON response.

**Supported query parameters:**

| Parameter | Behavior |
|---|---|
| actorId, actorType, action, resourceId, resourceType | Optional exact-match strings |
| startDate, endDate | Optional Zod datetime strings; converted to Date for createdAt gte/lte filter |
| page | Coerced positive integer; default 1; maximum 1000 |
| limit | Coerced integer 1 through 100; default 50 |

When both dates are present, end must not precede start and their range must be no more than 90 days. A one-sided date filter has no equivalent 90-day cap. Unknown query parameters are stripped by Zod parsing.

**Database operation:** runs findMany and count in a Prisma array transaction using the same app-scoped filter. Results are newest-first by createdAt and use OFFSET pagination. The selected event fields are id, actor/resource data, metadata, IP address, user agent, sequence number, and createdAt; entryHash, previousHash, and idempotencyKey are omitted.

**Response:** 200 with data.events and data.pagination containing page, limit, total, and totalPages.

**Errors:** rate limit 429; invalid query 400 VALIDATION_ERROR; authentication 401 (customer key only — dashboard internal credentials are not accepted here); database failures forwarded to the generic handler.

### GET /v1/events/activity/:resourceId

**Why it exists:** reads a recent resource activity feed, preferring Redis over PostgreSQL.

**Flow:** apiKeyAuth -> searchRateLimiter -> validateQuery(ActivityQuerySchema) -> asyncHandler -> local resourceId Zod parse -> getActivityFeed -> JSON response.

**Path/query input:**

- resourceId must be a string of 1 through 255 characters.
- limit is coerced to an integer from 1 through 50, default 20.

**Storage flow:** getActivityFeed reads `activity:<appId>:<resourceId>` with ZREVRANGE. A nonempty result becomes parsed entries with source cache. An empty result or Redis exception performs a PostgreSQL AuditLog.findMany ordered createdAt descending with the requested limit, starts a non-awaited bulk Redis warm, and returns source database.

**Response:** 200 with data.resourceId, data.source, and data.events.

**Errors:** malformed resource ID produces a route-local Zod 400; invalid limit produces validation-middleware 400; authentication/rate/database behavior follows the shared path.

## Verification routes

Both verification routes sit behind `dashboardOrApiKeyAuth`, so callers use
either a customer `Bearer <app key>` or `Bearer <INTERNAL_API_KEY>` with
`x-owner-id` + `x-app-id` (ownership verified per request). The dashboard
verify pages call backend verify endpoints through server-side proxy routes
that attach the internal credential for the logged-in GitHub owner.

### POST /v1/verify

**Why it exists:** persists and enqueues a durable chain verification for the authenticated application's entire audit history.

**Flow:** dashboardOrApiKeyAuth -> verifyRateLimiter -> asyncHandler -> atomic sentinel acquire -> pending job save -> BullMQ add -> 202.

**Request body/query:** none are read or validated.

**Redis/queue behavior:**

1. Atomically acquire `verify-active:{appId}` for a fresh UUID via Lua (see [DATA_STORAGE.md](DATA_STORAGE.md#verification-active-job-sentinel)).
2. If the slot is busy, return 409 `JOB_IN_PROGRESS` with the existing job ID and poll URL. Two simultaneous requests resolve to exactly one 202 and one 409.
3. Otherwise save a `pending`/`queued` VerifyJob at `verify-job:{appId}:{jobId}` (no TTL at this stage).
4. Enqueue `verify-chain { appId, jobId, appName }` on the BullMQ `verification` queue (durable; attempts 3, exponential backoff 500 ms). On enqueue failure, save `failed`, release the sentinel, and rethrow.
5. The worker (separate process) picks up the job, marks it `running`, heartbeats the sentinel, runs `verifyChain`, persists the terminal state with TTL, releases the sentinel, and alerts on tampering.

**Responses:**

- 202 success with data.jobId, data.status set to pending, data.startedAt, and relative data.pollUrl.
- 409 JOB_IN_PROGRESS with the existing job ID and poll URL under data when the sentinel is held.

**Errors:** verification-start rate limit 429 (POST only); authentication 401/403 per the dual credential; unexpected handler errors become generic 500.

### GET /v1/verify/:jobId

**Why it exists:** returns the persisted Redis state created by the start endpoint and updated by the worker.

**Flow:** dashboardOrApiKeyAuth -> asyncHandler -> UUID path parse -> namespaced Redis read (`readVerifyJob`) -> ownership check -> response.

**Path parameter:** jobId must be a UUID (route-local Zod parse → 400 on malformed).

**Ownership:** the key is namespaced by the authenticated app (`verify-job:{app.id}:{jobId}`), and the stored `job.appId` must equal the authenticated app id; any mismatch returns 404 `JOB_NOT_FOUND`. This is what stops one app (or one dashboard app scope) from polling another app's job, including the dashboard path where `x-app-id` selects the scope. The dashboard poll proxy additionally checks `result.data.appId === appId` and returns 404 on mismatch.

**Responses:**

- 200 with the complete stored job object for pending, running, complete, or failed jobs (running/retrying phases included).
- 404 JOB_NOT_FOUND when the app-scoped Redis key does not exist.
- 500 JOB_DATA_CORRUPT when the stored value fails VerifyJobSchema.

Polling has no route-level rate limiter.

## Export route

### GET /v1/export

**Why it exists:** downloads authenticated-app audit events using the search filters. Accepts the same dual credential as verify. The dashboard export page calls it through a server-side proxy that streams the backend response to the browser.

**Flow:** dashboardOrApiKeyAuth -> exportRateLimiter -> validateQuery(ExportEventsSchema) -> asyncHandler -> buildEventWhere -> cursor-batched Prisma reads -> HTTP stream.

**Query parameters:** it accepts the same actor/resource/date fields as GET /v1/events, plus format set to json or csv with default json. The inherited page and limit fields are validated/defaulted but are not used by export logic. Date-range validation has the same two-sided-only 90-day rule.

**CSV behavior:**

- Sets text/csv content type and attachment filename containing app ID.
- Writes a header followed by chronological createdAt-ascending rows in batches of 500.
- Selects only the event-public fields.
- Quotes CSV values, doubles embedded quotes, and prefixes a single quote when text starts with =, +, -, or @ to reduce spreadsheet formula interpretation.
- Has no configured total-row cap.

**JSON behavior:**

- Sets JSON content type and attachment filename containing app ID.
- Manually writes a JSON envelope and event array in chronological batches.
- Caps returned rows at JSON_EXPORT_MAX_ROWS, default 10,000.
- Fetches one look-ahead row to distinguish an exact cap from more data.
- Ends with data.truncated and data.totalFetched.

The handler calls response.write repeatedly but does not await a drain event when write returns false.

**Responses:** a streamed CSV download or a streamed JSON success object. Before streaming begins, authentication, rate-limit, validation, and database errors use their normal error contracts. After writing begins, error response behavior is constrained by the already-started stream.

## Cross-route relationships

- App registration creates the API key required by all per-app routes.
- Key rotation/deletion attempts to invalidate the cached credential used by apiKeyAuth.
- Event ingestion creates rows consumed by search, activity fallback/cache, export, and worker verification.
- Event ingestion also populates the activity cache read by the activity endpoint.
- Verification start creates the sentinel + Redis state consumed by verification polling and the worker lifecycle.
- Verification results can invoke the Brevo tamper-alert attempt.

For type-level request and response shapes, see [TYPES_AND_INTERFACES.md](TYPES_AND_INTERFACES.md).
