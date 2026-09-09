# Backend middleware

## Actual execution order

The global execution order is defined by createApp() in src/app.ts. Router-level and route-level middleware follows after that mounting point.

~~~mermaid
flowchart TD
  H[helmet] --> C[CORS]
  C --> R[requestId]
  R --> J[express.json 1 MB]
  J --> M[Morgan to Winston]
  M --> Health[/health router]
  Health --> Apps[/v1/apps router]
  Apps --> A[apiKeyAuth]
  A --> Events[/v1/events routers]
  Events --> Verify[/v1/verify router]
  Verify --> Export[/v1/export router]
  Export --> NF[global 404]
  NF --> EH[errorHandler]
~~~

A request matched by /health or /v1/apps does not pass apiKeyAuth because those routers are mounted before it. A request matched by the later protected routers does. The final 404 handler only runs when no router produced a response, and errorHandler only runs when an earlier handler calls next with an error.

## Built-in/global middleware

### helmet

- **Registration:** first global app.use call in app.ts.
- **Purpose:** applies Helmet's default security-oriented HTTP headers.
- **Request data:** no project-specific fields are read.
- **Response changes:** Helmet determines the headers; no project-specific Helm configuration overrides defaults.
- **Dependents:** every route because it executes first.
- **Error behavior:** no local project-specific handling.

The exact default header set is a third-party library behavior and is not configured further in current source.

### CORS

- **Registration:** immediately after Helmet in app.ts.
- **Purpose:** controls cross-origin browser requests.
- **Origin source:** required CORS_ORIGINS, split on commas.
- **Allowed methods:** GET, POST, DELETE, OPTIONS.
- **Allowed request headers:** Content-Type, Authorization, x-owner-id, x-user-id, x-request-id.
- **Exposed response headers:** x-request-id.
- **Credentials:** true.
- **Dependents:** browser clients that need bearer/internal headers or correlation ID access.

It does not contain endpoint authorization. Authentication is performed later by apiKeyAuth or requireOwnerId.

### requestId

- **File/function:** src/middleware/requestId.ts, requestId(req, res, next).
- **Registration:** global, after CORS and before JSON parsing/Morgan.
- **Purpose:** establishes one request correlation ID.
- **Reads:** req.headers["x-request-id"].
- **Mutates request:** sets req.requestId, req.id, and req.headers["x-request-id"].
- **Mutates response:** sets the x-request-id response header.
- **Success behavior:** uses the first header value when an array is supplied; otherwise uses the header value; otherwise generates crypto.randomUUID(); then calls next().
- **Error behavior:** no local error branch.
- **Dependents:** Morgan format and errorHandler logging use the correlation ID. Express declaration merging adds the request properties; see [TYPES_AND_INTERFACES.md](TYPES_AND_INTERFACES.md).

No format, length, or trust validation is applied to a supplied request-ID header.

### express.json

- **Registration:** global after requestId with body limit 1mb.
- **Purpose:** parses JSON request bodies before validation/route use.
- **Request mutation:** Express supplies req.body.
- **Dependents:** POST app/event validation and handlers.
- **Error behavior:** current source has no parser-specific error branch; errors that arrive at errorHandler are not recognized as ZodError or AppError unless they happen to have a statusCode property.

### Morgan and Winston stream

- **Registration:** global after JSON parsing.
- **Purpose:** logs access records through logger.info rather than directly to stdout.
- **Log content:** request x-request-id, remote address/user, date, method, URL, HTTP version, status, content length, referrer, and user agent.
- **Skip rule:** skips only requests whose req.path is exactly /health.
- **Dependents:** src/config/logger.ts determines console/file transports and formatting.

Morgan does not alter the HTTP response or authenticate a request.

## Authentication and authorization middleware

### apiKeyAuth

- **File/function:** src/middleware/auth.ts, apiKeyAuth(req, res, next).
- **Registration:** global after /health and /v1/apps, before events, search, verification, and export.
- **Purpose:** authenticates an active App by bearer API key and makes it available to protected routes.
- **Reads:** Authorization header; Redis; PostgreSQL App table; and API_KEY_CACHE_TTL_SECONDS.
- **Mutates request:** assigns a Prisma App-compatible value to req.auditApp on success.
- **Response behavior:** returns 401 MISSING_API_KEY if Authorization does not begin with Bearer followed by a space; returns 401 INVALID_API_KEY when PostgreSQL finds no active matching App.
- **Success behavior:** calls next() after setting req.auditApp.
- **Routes that depend on it:** every /v1/events, /v1/verify, and /v1/export route.

The detailed storage behavior is:

1. Remove the Bearer prefix and trim the raw key.
2. HMAC the raw key with HASH_SECRET to create apikey:<digest>.
3. Attempt Redis GET.
4. If cached JSON parses and contains id, ownerId, and isActive true, convert createdAt/updatedAt to Date and attach the non-secret data to req.auditApp.
5. If the cache is absent, malformed, inactive, or Redis fails, query Prisma App.findFirst where the HMAC digest matches and isActive is true.
6. Cache only non-secret app authorization data with expiry when possible.
7. Attach the database row and call next().

Redis read/write errors log warnings and fall back/continue. Database lookup failures are forwarded to Express error handling. Cache values never contain the raw API key; see [DATA_STORAGE.md](DATA_STORAGE.md#api-key-cache).

### Dashboard owner derivation

- **File/function:** src/middleware/auth.ts, getDashboardOwnerId(req).
- **Registration:** not an Express middleware registration. It is called by apps route authorization and the apps rate limiter.
- **Purpose:** derives the owner scope for dashboard-management operations.
- **Reads:** Authorization, INTERNAL_API_KEY, x-owner-id, and x-user-id.
- **Returns:** string owner ID or null; it does not modify the request.

A valid internal bearer key returns x-owner-id first, x-user-id second, and null when neither exists. A warning is logged for a valid internal key lacking both owner headers. It does not validate a session, cookie, JWT, or OAuth token.

### clearApiKeyCache

- **File/function:** src/middleware/auth.ts, clearApiKeyCache(apiKey) and clearApiKeyCacheDigest(apiKeyDigest).
- **Registration:** helper, not request middleware.
- **Callers:** app key rotation and soft deletion.
- **Purpose:** deletes the cache entry derived from a raw key or stored digest.
- **Failure behavior:** logs a warning and resolves rather than failing the route.

## Validation middleware

### validate

- **File/function:** src/middleware/validate.ts, validate(field, schema).
- **Kind:** higher-order middleware factory.
- **Parameters:** field is body or query; schema is a ZodSchema.
- **Returns:** a synchronous Express middleware.
- **Purpose:** centralizes Zod safeParse, error response, and replacement of parsed request data.
- **Reads:** req[field].
- **Mutates request:** assigns result.data to req.body or req.query through a local type assertion.
- **Failure response:** 400 with success false, code VALIDATION_ERROR, statusCode 400, and Zod flattened details.
- **Success behavior:** calls next().

Zod's normal object behavior removes unknown object properties unless a schema is strict. The factory does not log validation failures itself.

### validateBody

- **File/function:** src/middleware/validateBody.ts, validateBody(schema).
- **Purpose:** preserves a body-specific import API while delegating to validate("body", schema).
- **Routes:** POST /v1/apps and POST /v1/events.

### validateQuery

- **File/function:** src/middleware/validateQuery.ts, validateQuery(schema).
- **Purpose:** delegates to validate("query", schema).
- **Routes:** GET /v1/events, activity feed, and export.

Route-local Zod parsing is also used for apps IDs, activity resourceId, and verification jobId. Those thrown ZodErrors are handled by errorHandler rather than validation middleware.

## Rate limit middleware

src/middleware/rateLimiter.ts constructs five express-rate-limit middleware instances. No custom external store is supplied, so the implementation has no project-configured shared persistence for counters.

| Middleware | Mounted on | Window/default max | Key generator |
|---|---|---|---|
| eventsRateLimiter | POST /v1/events | 60,000 ms / 200 | req.auditApp.id, otherwise req.ip |
| verifyRateLimiter | POST /v1/verify | 300,000 ms / 1 | req.auditApp.id, otherwise req.ip |
| appsRateLimiter | POST /v1/apps, rotate, delete | 60,000 ms / 30 | getDashboardOwnerId(req), otherwise req.ip, otherwise unknown |
| searchRateLimiter | GET /v1/events and activity | 60,000 ms / 100 | req.auditApp.id, otherwise req.ip |
| exportRateLimiter | GET /v1/export | 60,000 ms / 10 | req.auditApp.id, otherwise req.ip |

All use standardHeaders true, legacyHeaders false, and a JSON 429 message whose text interpolates the current limit/window constants. Event/search/verification/export limiters run after apiKeyAuth, so a successful request normally keys on app ID. The apps limiter runs before route-local requireOwnerId, but it calls the same owner-derivation function.

GET /v1/apps and GET /v1/verify/:jobId have no route-level rate limiter.

## Async forwarding middleware

### asyncHandler

- **File/function:** src/middleware/asyncHandler.ts, asyncHandler(handler).
- **Kind:** higher-order function.
- **Parameter/return:** accepts AsyncHandler and returns another async function with the same request, response, next signature.
- **Purpose:** catches rejection/throw from asynchronous route handlers and calls next(err).
- **Callers:** all route handlers in apps, events, search, verify, export, and health routers.
- **Does not wrap:** apiKeyAuth or the rate-limit middleware.

This wrapper is why most Prisma/service failures in route handlers reach errorHandler.

## Final error middleware

### AppError

- **File/class:** src/middleware/errorHandler.ts, AppError.
- **Purpose:** operational error carrying message, statusCode, code, and isOperational=true.
- **Construction:** restores the Error prototype after super() and names itself AppError.
- **Current callers:** apps authorization/not-found branches and the unreachable final branch of createAuditLogEntry.

### errorHandler

- **File/function:** src/middleware/errorHandler.ts, errorHandler(err, req, res, next).
- **Registration:** final app.use after global 404.
- **Purpose:** logs and formats errors forwarded from prior middleware/routes.
- **Reads:** err, req.requestId, req.path, req.method.
- **Response behavior:**
  - ZodError: logs a warning and returns 400 VALIDATION_ERROR with flattened details.
  - Other errors: logs an error. Uses err.statusCode when present, otherwise 500. It exposes err.message only when err.isOperational is truthy; otherwise it sends Internal server error. It uses err.code when present, otherwise INTERNAL_ERROR.
- **Dependents:** asyncHandler and any middleware that calls next(err).

There is no dedicated Prisma-error mapping, JSON-parser-error mapping, or error response recovery after a stream has begun.

## Middleware relationship diagram

~~~mermaid
sequenceDiagram
  participant C as Client
  participant H as Helmet/CORS
  participant I as requestId
  participant J as JSON/Morgan
  participant A as apiKeyAuth
  participant L as Route limiter
  participant V as Zod middleware
  participant R as Async route
  participant E as errorHandler

  C->>H: Request
  H->>I: Security/CORS accepted request
  I->>J: Correlation ID on request and response
  alt protected route
    J->>A: Authenticate App
    A->>L: req.auditApp set
  else apps route
    J->>L: apps limiter if mutation
  end
  L->>V: Rate accepted
  V->>R: Parsed body/query
  R-->>C: Success response
  R->>E: next(error) on wrapped failure
  E-->>C: Standard error response
~~~

For endpoint-specific middleware sequences, see [ROUTES_AND_FLOW.md](ROUTES_AND_FLOW.md). For custom request fields and handler types, see [TYPES_AND_INTERFACES.md](TYPES_AND_INTERFACES.md).
