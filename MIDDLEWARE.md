# Backend middleware

## Actual execution order

The global execution order is defined by createApp() in src/app.ts. Router-level and route-level middleware follows after that mounting point.

~~~mermaid
flowchart TD
  H[helmet] --> C[CORS]
  C --> R[requestId]
  R --> J[express.json 1 MB]
  J --> M[Morgan to Winston - skip /health]
  M --> Health[/health router - no auth]
  Health --> Apps[/v1/apps router - requireOwnerId]
  Apps --> Events[/v1/events + apiKeyAuth]
  Events --> Verify[/v1/verify + dashboardOrApiKeyAuth]
  Verify --> Export[/v1/export + dashboardOrApiKeyAuth]
  Export --> NF[global 404]
  NF --> EH[errorHandler]
~~~

`/health` has no auth. `/v1/apps` uses route-local dashboard-owner
authorization. `/v1/events` (both routers) requires `apiKeyAuth`.
`/v1/verify` and `/v1/export` accept either dashboard credentials or an app API
key via `dashboardOrApiKeyAuth`. The final 404 handler only runs when no router
produced a response, and errorHandler only runs when an earlier handler calls
next with an error.

## Built-in/global middleware

### helmet

- **What:** applies Helmet's default security-oriented HTTP headers.
- **Where:** first global app.use call in app.ts; affects every route.
- **Data:** no project-specific fields are read or added.
- **Failures:** none project-specific.
- **Downstream:** every route inherits the headers.

The exact default header set is a third-party library behavior and is not configured further in current source.

### CORS

- **What:** controls cross-origin browser requests.
- **Where:** immediately after Helmet in app.ts; affects every route including preflight.
- **Data checked:** `CORS_ORIGINS` (required, comma-separated).
- **Adds:** allowed methods `GET, POST, DELETE, OPTIONS`; allowed request headers `Content-Type, Authorization, x-owner-id, x-user-id, x-app-id, x-request-id`; exposed response header `x-request-id`; `credentials: true`.
- **Failures:** disallowed origins/headers fail at the browser preflight layer, not as JSON errors.
- **Downstream:** lets browser clients send bearer/internal/owner/app/correlation headers and read `x-request-id`. It performs no endpoint authorization.

`x-app-id` is required because dashboard-owned verify/export calls send it; `x-request-id` is allowed/exposed for correlation.

### requestId

- **File/function:** src/middleware/requestId.ts, requestId(req, res, next).
- **Where:** global, after CORS and before JSON parsing/Morgan.
- **What:** establishes one request correlation ID.
- **Reads:** `req.headers["x-request-id"]` (first value if an array).
- **Adds:** sets `req.requestId`, `req.id`, `req.headers["x-request-id"]`, and the `x-request-id` response header (generated `crypto.randomUUID()` when absent).
- **Failures:** none; no format/length/trust validation of a supplied value.
- **Downstream:** Morgan format and errorHandler logging use the correlation ID. Express declaration merging adds the request properties; see [TYPES_AND_INTERFACES.md](TYPES_AND_INTERFACES.md).

### express.json

- **Where:** global after requestId with body limit 1mb.
- **What:** parses JSON request bodies before validation/route use.
- **Adds:** Express supplies req.body.
- **Failures:** malformed JSON or over-limit bodies throw parser errors; current source has no parser-specific error branch, so they reach errorHandler as generic 500 unless they carry a statusCode property.
- **Downstream:** POST app/event validation and handlers.

### Morgan and Winston stream

- **Where:** global after JSON parsing.
- **What:** logs access records through `logger.info` (Winston console transport, JSON format) rather than directly to stdout.
- **Data:** request x-request-id, remote address/user, date, method, URL, HTTP version, status, content length, referrer, and user agent.
- **Skip rule:** skips only requests whose req.path is exactly /health.
- **Failures/mutation:** does not alter the HTTP response or authenticate a request.
- **Downstream:** src/config/logger.ts determines transports and formatting.

## Authentication and authorization middleware

### apiKeyAuth

- **File/function:** src/middleware/auth.ts, apiKeyAuth(req, res, next).
- **Where:** per-route guard on `/v1/events` (both routers); fallback inside `dashboardOrApiKeyAuth` for verify/export.
- **What:** authenticates an active App by customer bearer API key and makes it available to protected routes.
- **Checks:** `Authorization: Bearer <raw als_ key>` → `hashApiKey` (HMAC-SHA256 with `HASH_SECRET`) → Redis `apikey:{digest}` → PostgreSQL `App.findFirst({ apiKey: digest, isActive: true })` on miss/failure.
- **Adds:** assigns non-secret app data (`Omit<App,'apiKey'>`) to `req.auditApp` on success; writes the cache entry with `API_KEY_CACHE_TTL_SECONDS` (default 600 s).
- **Failures:** 401 `MISSING_API_KEY` if the header does not begin with `Bearer `; 401 `INVALID_API_KEY` when no active matching App exists. Corrupt/inactive cached values are evicted and retried via PostgreSQL. Redis read/write errors log warnings and fall back/continue. Database lookup failures are forwarded via `next(err)`.
- **Downstream:** every `/v1/events` handler and (via fallback) verify/export handlers rely on `req.auditApp`.

Cache values never contain the raw API key; see [DATA_STORAGE.md](DATA_STORAGE.md#api-key-cache).

### dashboardOrApiKeyAuth

- **File/function:** src/middleware/auth.ts, dashboardOrApiKeyAuth(req, res, next).
- **Where:** guard on `/v1/verify` and `/v1/export` (mounted in app.ts).
- **What:** accepts either server-to-server dashboard credentials or a customer app key for the same route.
- **Dashboard path checks:** `Authorization: Bearer INTERNAL_API_KEY` (exact match) **plus** `x-owner-id` **and** `x-app-id` headers → `prisma.app.findFirst({ id: appId, ownerId, isActive: true })`.
- **Adds:** sets `req.auditApp` to the owned app on the dashboard path; otherwise delegates to `apiKeyAuth` (which sets it from the customer key).
- **Failures:** 403 `DASHBOARD_AUTH_REQUIRED` when the internal key is presented without both headers; 403 `APP_ACCESS_DENIED` when the app is missing, inactive, or owned by someone else; otherwise the `apiKeyAuth` 401 contract. Prisma failures are forwarded via `next(err)`.
- **Downstream:** verify/export handlers work identically afterwards (`req.auditApp!`); polling authorization (`job.appId !== app.id` → 404) enforces the same app scope regardless of which credential was used.
- **Security note:** unlike the apps-router helper, this path requires `x-app-id` (not `x-user-id`) and verifies ownership against the database per request.

### getDashboardOwnerId / requireOwnerId

- **File/function:** src/middleware/auth.ts, getDashboardOwnerId(req); requireOwnerId(req) is local to src/routes/apps.ts.
- **Where:** not an Express middleware registration. Called by apps-route authorization and the apps rate limiter.
- **What:** derives the owner scope for app-management operations.
- **Checks:** valid `INTERNAL_API_KEY` Bearer token → returns `x-owner-id` first, `x-user-id` second, else null (warning logged). It does not validate sessions, cookies, JWTs, or OAuth tokens.
- **Failures:** `requireOwnerId()` throws `AppError` 401 `DASHBOARD_AUTH_REQUIRED` when null; the apps limiter falls back to IP/`unknown` for keying when null.
- **Downstream:** GET/POST/rotate/delete on `/v1/apps` scope all database access by the returned owner.

### clearApiKeyCache / clearApiKeyCacheDigest

- **File/function:** src/middleware/auth.ts.
- **Where:** helpers, not request middleware.
- **What:** delete the `apikey:{digest}` entry derived from a raw key or stored digest.
- **Callers:** key rotation and soft deletion (digest variant).
- **Failures:** logs a warning and resolves rather than failing the route. Note a previously cached active App can remain usable until TTL expiry if the delete fails.

## Validation middleware

### validate

- **File/function:** src/middleware/validate.ts, validate(field, schema).
- **Kind:** higher-order middleware factory (`body` or `query` + ZodSchema → sync middleware).
- **What:** centralizes Zod safeParse, error response, and replacement of parsed request data.
- **Checks/adds:** parses `req[field]`; on success assigns `result.data` back to `req.body`/`req.query`.
- **Failures:** 400 `VALIDATION_ERROR` with flattened Zod details.
- **Downstream:** all body/query-validated routes. Zod's default object behavior strips unknown keys. It does not log failures itself.

### validateBody

- **File/function:** src/middleware/validateBody.ts, validateBody(schema).
- **What:** preserves a body-specific import API while delegating to validate("body", schema).
- **Where:** POST /v1/apps (RegisterAppSchema), POST /v1/events (IngestEventSchema).

### validateQuery

- **File/function:** src/middleware/validateQuery.ts, validateQuery(schema).
- **What:** delegates to validate("query", schema).
- **Where:** GET /v1/events (SearchEventsSchema), activity feed (ActivityQuerySchema), export (ExportEventsSchema).

Route-local Zod parsing is also used for app IDs, activity resourceId, and verification jobId. Those thrown ZodErrors are handled by errorHandler rather than validation middleware.

## Rate limit middleware

src/middleware/rateLimiter.ts constructs five express-rate-limit middleware instances. No custom external store is supplied, so counters are process-local (API and worker do not share them; two API replicas do not share them).

| Middleware | Mounted on | Window/default max | Key generator |
|---|---|---|---|
| eventsRateLimiter | POST /v1/events | 60,000 ms / 200 | req.auditApp.id, otherwise req.ip |
| verifyRateLimiter | POST /v1/verify only | 300,000 ms / 1 | req.auditApp.id, otherwise req.ip |
| appsRateLimiter | POST /v1/apps, rotate, delete | 60,000 ms / 30 | getDashboardOwnerId(req), otherwise req.ip, otherwise unknown |
| searchRateLimiter | GET /v1/events and activity | 60,000 ms / 100 | req.auditApp.id, otherwise req.ip |
| exportRateLimiter | GET /v1/export | 60,000 ms / 10 | req.auditApp.id, otherwise req.ip |

All use standardHeaders true, legacyHeaders false, and a JSON 429 payload (`RATE_LIMIT_EXCEEDED`) whose text interpolates the current limit/window constants. Event/search/verification/export limiters run after auth, so a successful request normally keys on app ID. The apps limiter runs before route-local requireOwnerId but calls the same owner-derivation function.

GET /v1/apps and GET /v1/verify/:jobId have no route-level rate limiter. Polling is intentionally unlimited.

## Async forwarding middleware

### asyncHandler

- **File/function:** src/middleware/asyncHandler.ts, asyncHandler(handler).
- **Kind:** higher-order function (AsyncHandler → AsyncHandler).
- **What:** catches rejection/throw from asynchronous route handlers and calls next(err).
- **Callers:** all route handlers in apps, events, search, verify, export, and health routers.
- **Does not wrap:** apiKeyAuth/dashboardOrApiKeyAuth or the rate-limit middleware (those handle their own errors).
- **Downstream:** this wrapper is why most Prisma/service failures in route handlers reach errorHandler.

## Request-ID, logging, and security interaction summary

Helmet/CORS run before auth so preflight and headers are handled uniformly.
requestId runs before Morgan so every access line carries the correlation ID.
express.json runs before validation so schemas see parsed bodies. Auth runs
before rate limiting on protected routes so limits key on the authenticated app
(except apps mutations, which key on the derived owner). asyncHandler forwards
route failures to errorHandler, which logs with the request ID.

## Final error middleware

### AppError

- **File/class:** src/middleware/errorHandler.ts, AppError.
- **What:** operational error carrying message, statusCode, code, and isOperational=true.
- **Current callers:** apps authorization/not-found branches and the post-retry branch of createAuditLogEntry.

### errorHandler

- **File/function:** src/middleware/errorHandler.ts, errorHandler(err, req, res, next).
- **Where:** final app.use after global 404.
- **What:** logs and formats errors forwarded from prior middleware/routes.
- **Reads:** err, req.requestId, req.path, req.method.
- **Failures/responses:**
  - ZodError: logs a warning and returns 400 VALIDATION_ERROR with flattened details (covers route-local param parsing).
  - Other errors: logs an error. Uses err.statusCode when present, otherwise 500. Exposes err.message only when err.isOperational is truthy; otherwise sends Internal server error. Uses err.code when present, otherwise INTERNAL_ERROR.
- **Downstream:** terminal; no recovery after a stream has begun (export).

There is no dedicated Prisma-error mapping or JSON-parser-error mapping.

## Middleware relationship diagram

~~~mermaid
sequenceDiagram
  participant C as Client
  participant H as Helmet/CORS
  participant I as requestId
  participant J as JSON/Morgan
  participant A as Auth guard
  participant L as Route limiter
  participant V as Zod middleware
  participant R as Async route
  participant E as errorHandler

  C->>H: Request
  H->>I: Security/CORS accepted request
  I->>J: Correlation ID on request and response
  alt /v1/events
    J->>A: apiKeyAuth
    A->>L: req.auditApp set
  else /v1/verify or /v1/export
    J->>A: dashboardOrApiKeyAuth
    A->>L: req.auditApp set (either credential)
  else /v1/apps mutation
    J->>L: apps limiter (owner key)
  else /health or GET /v1/apps
    J->>R: no limiter
  end
  L->>V: Rate accepted
  V->>R: Parsed body/query
  R-->>C: Success response
  R->>E: next(error) on wrapped failure
  E-->>C: Standard error response
~~~

For endpoint-specific middleware sequences, see [ROUTES_AND_FLOW.md](ROUTES_AND_FLOW.md). For custom request fields and handler types, see [TYPES_AND_INTERFACES.md](TYPES_AND_INTERFACES.md).
