# Routes and execution flows

## Router registration

Express is initialized by createApp() in src/app.ts. The application mounts routes in this order:

1. GET /health through healthRouter, before per-app authentication.
2. /v1/apps through appsRouter, before per-app authentication.
3. apiKeyAuth globally for every router below it.
4. /v1/events through eventsRouter, then searchRouter.
5. /v1/verify through verifyRouter.
6. /v1/export through exportRouter.
7. A global JSON 404 handler and then errorHandler.

The shared event prefix is intentional: eventsRouter declares POST / while searchRouter declares GET / and GET /activity/:resourceId. There are no controller classes; each handler performs its own Prisma/service calls.

Every response created by a normal route uses a success boolean and data field. Error responses generally use success false and an error object containing message, code, and statusCode. The 404 and rate-limit responses follow that shape. After an export has started streaming, an exception cannot reliably be converted into a fresh JSON error because response headers/body may already have been written.

Global security and parsing middleware runs before these routes. Its exact order and behavior are in [MIDDLEWARE.md](MIDDLEWARE.md).

## Route map

| Method | Complete path | Router | Authentication |
|---|---|---|---|
| GET | /health | health.ts | None |
| GET | /v1/apps | apps.ts | Internal API key plus owner header |
| POST | /v1/apps | apps.ts | Same dashboard authorization |
| POST | /v1/apps/:id/rotate-key | apps.ts | Same dashboard authorization |
| DELETE | /v1/apps/:id | apps.ts | Same dashboard authorization |
| POST | /v1/events | events.ts | Active application API key |
| GET | /v1/events | search.ts | Active application API key |
| GET | /v1/events/activity/:resourceId | search.ts | Active application API key |
| POST | /v1/verify | verify.ts | Active application API key |
| GET | /v1/verify/:jobId | verify.ts | Active application API key |
| GET | /v1/export | export.ts | Active application API key |

## Health route

### GET /health

**Why it exists:** exposes the current connectivity result for PostgreSQL and Redis.

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

All app routes are mounted before apiKeyAuth. They call requireOwnerId() inside their handlers. That helper calls getDashboardOwnerId() and throws AppError with 401 DASHBOARD_AUTH_REQUIRED when no owner can be derived.

A request is authorized when either:

- Authorization is Bearer followed by exactly INTERNAL_API_KEY and it supplies x-owner-id or x-user-id; that header becomes the owner scope.

The router does not authenticate with an application API key.

### GET /v1/apps

**Why it exists:** lists the authenticated owner's active applications.

**Handler chain:** appsRouter GET / -> asyncHandler -> requireOwnerId -> Prisma App.findMany -> JSON response.

**Route-specific middleware:** no apps rate limiter is applied to this GET route.

**Database operation:** reads App rows where ownerId equals the derived owner and isActive is true; orders newest createdAt first; includes related AuditLog count.

**Response:** 200 with data.apps. Every returned item has id, name, description, isActive, ISO createdAt, and _count containing auditLogs. API keys and owner IDs are not returned.

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

**Database operation:** creates an App with derived ownerId, validated name, description or null, and a newly generated API key digest. createApiKey produces the raw `als_` key; its HMAC digest is stored.

**Response:** 201 with id, name, description, the raw apiKey, and ISO createdAt. The raw key is returned once; only its HMAC digest is stored in the database.

**Errors:** invalid body returns 400 VALIDATION_ERROR. The apps rate limiter can return 429 before validation/authorization. Missing owner authorization returns 401.

### POST /v1/apps/:id/rotate-key

**Why it exists:** replaces a registered app's API key while retaining the App and audit-log rows.

**Handler chain:** appsRateLimiter -> asyncHandler -> requireOwnerId -> Zod path parse -> Prisma ownership lookup -> Prisma update -> Redis old-key deletion attempt -> response.

**Path parameter:** id is parsed as a UUID, matching the Prisma schema.

**Authorization:** the app lookup requires both the provided ID and current ownerId. An app owned by someone else is indistinguishable from a missing app.

**Database and Redis operations:**

1. Find the App by id and owner ID.
2. Update apiKey to the HMAC digest of a new random key.
3. Invalidate the old digest-based cache entry. Redis failure is logged but does not fail the rotation.

**Response:** 200 with data.newApiKey.

**Errors:** unknown/wrong-owner app yields 404 APP_NOT_FOUND. Bad path format throws a route-local ZodError, which central error handling maps to 400 VALIDATION_ERROR.

### DELETE /v1/apps/:id

**Why it exists:** removes an app from active use without deleting its audit history.

**Handler chain:** appsRateLimiter -> asyncHandler -> requireOwnerId -> CUID path parse -> ownership lookup -> Prisma update -> Redis old-key deletion attempt -> 204.

**Database operation:** updates isActive to false. It does not delete the App or its AuditLog rows.

**Redis operation:** attempts to delete the cache entry for the old key. Failure only logs a warning; a previously cached active App can remain usable until its TTL expires because cache-hit validation does not recheck isActive.

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
  A->>D: GET hashed key cache
  alt cache miss or cache failure
    A->>P: Find active App by plaintext key
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
4. Derive previousHash and sequenceNumber.
5. Build a hash payload, recursively canonicalizing metadata object keys.
6. Compute entryHash and create the AuditLog row.
7. Retry P2034 serialization failure while attempt is less than three.
8. On P2002 with an idempotency key, look up the row that won the unique-constraint race and use it.

**Redis operation:** only new rows cause a fire-and-forget cacheActivityEntry call. It stores the activity representation in the app/resource sorted set. Redis failures do not change the successful database response.

**Responses:** 201 for a newly inserted row and 200 for a duplicate idempotency key. Both return data.entryId, data.sequenceNumber, data.entryHash, and ISO data.createdAt.

**Errors:** authentication 401, rate limit 429, validation 400, and normal forwarded unexpected errors 500. After two retries, the third P2034 is rethrown rather than returning the source's later unreachable SERVICE_BUSY AppError.

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

**Errors:** rate limit 429; invalid query 400 VALIDATION_ERROR; authentication 401; database failures forwarded to the generic handler.

### GET /v1/events/activity/:resourceId

**Why it exists:** reads a recent resource activity feed, preferring Redis over PostgreSQL.

**Flow:** apiKeyAuth -> searchRateLimiter -> validateQuery(ActivityQuerySchema) -> asyncHandler -> local resourceId Zod parse -> getActivityFeed -> JSON response.

**Path/query input:**

- resourceId must be a string of 1 through 255 characters.
- limit is coerced to an integer from 1 through 50, default 20.

**Storage flow:** getActivityFeed reads activity:<appId>:<resourceId> with ZREVRANGE. A nonempty result becomes parsed entries with source cache. An empty result or Redis exception performs a PostgreSQL AuditLog.findMany ordered createdAt descending with the requested limit, starts a non-awaited bulk Redis warm, and returns source database.

**Response:** 200 with data.resourceId, data.source, and data.events.

**Errors:** malformed resource ID produces a route-local Zod 400; invalid limit produces validation-middleware 400; authentication/rate/database behavior follows the shared path.

## Verification routes

### POST /v1/verify

**Why it exists:** starts an asynchronous chain verification for the authenticated application's entire audit history.

**Flow:** apiKeyAuth -> verifyRateLimiter -> asyncHandler -> Redis pending-job scan -> optional pending job save -> setImmediate(runVerifyJob) -> 202.

**Request body/query:** none are read or validated.

**Redis and background behavior:**

1. SCAN keys matching verify-job:<appId>:* in pages of 20.
2. GET and JSON-parse keys to find a job whose status is pending.
3. If a pending job is found, return conflict without creating a new job.
4. Otherwise create a UUID job ID and a pending object with startedAt.
5. Try to SET that object with the configured TTL. Failure logs a warning but does not stop processing.
6. Schedule runVerifyJob in the same Node process with setImmediate.
7. runVerifyJob calls verifyChain, attempts to save complete/failed state, and starts a non-awaited tamper alert on an invalid result.

The SCAN/check/create sequence is not a Redis atomic lock. No queue, persistent worker, or retry mechanism exists.

**Responses:**

- 202 success with data.jobId, data.status set to pending, data.startedAt, and relative data.pollUrl.
- 409 JOB_IN_PROGRESS with the existing job ID and poll URL under data when a pending job was discovered.

**Errors:** verification-start rate limit 429; authentication 401; a Redis scan failure only logs and allows a job to start; unexpected handler errors become generic 500.

### GET /v1/verify/:jobId

**Why it exists:** returns the Redis state created by the start endpoint.

**Flow:** apiKeyAuth -> asyncHandler -> UUID path parse -> Redis GET using authenticated app ID -> JSON parsing and VerifyJobSchema validation -> response.

**Path parameter:** jobId must be a UUID.

**Responses:**

- 200 with the complete stored job object for pending, complete, or failed jobs.
- 404 JOB_NOT_FOUND when the app-scoped Redis key does not exist.
- 500 JOB_DATA_CORRUPT when parsed JSON is valid JSON but fails VerifyJobSchema.

If stored Redis content is not valid JSON, JSON.parse throws before safeParse; it reaches the central handler as a generic 500 rather than JOB_DATA_CORRUPT.

Polling has no route-level rate limiter.

## Export route

### GET /v1/export

**Why it exists:** downloads authenticated-app audit events using the search filters.

**Flow:** apiKeyAuth -> exportRateLimiter -> validateQuery(ExportEventsSchema) -> asyncHandler -> buildEventWhere -> cursor-batched Prisma reads -> HTTP stream.

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
- Event ingestion creates rows consumed by search, activity fallback/cache, export, and verification.
- Event ingestion also populates the activity cache read by the activity endpoint.
- Verification start creates Redis state consumed by verification polling.
- Verification results can invoke the Brevo tamper-alert attempt.

For type-level request and response shapes, see [TYPES_AND_INTERFACES.md](TYPES_AND_INTERFACES.md).
