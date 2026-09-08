# Production Readiness Audit

**Audit date:** 2026-09-08

## Deployment Status

**NOT READY**

The project compiles and the frontend/backend production builds complete, but production deployment is blocked by broken dashboard/API integration, missing dashboard access control, insecure credential handling, migration drift, missing Docker build isolation, incomplete CI validation, and unavailable integration infrastructure.

This document records the audit findings before the follow-up remediation.

## Follow-up Status

The API-key security findings in this historical audit were subsequently
implemented: new and rotated keys are stored as HMAC-SHA256 digests, Redis
cache values omit credentials, authentication hashes incoming bearer keys, and
rotation/deactivation invalidate digest-based cache entries. Focused lifecycle
tests and the full backend suite pass. Existing databases must run
`npm run api-keys:migrate` during rollout to convert legacy plaintext rows.

## 1. Executive Summary

### Critical blockers

- The dashboard calls unversioned API paths while the backend serves protected routes under `/v1`; dashboard pages therefore receive 404 or unauthorized responses.
- NextAuth is configured but the dashboard has no middleware or server-session checks. Dashboard pages are publicly reachable.
- The dashboard sends a fixed internal API key and caller-supplied owner ID from server-side code. OAuth identity is not connected to authorization.
- API keys are stored and cached in plaintext. A database or Redis compromise exposes active credentials.
- API-key revocation is not immediate because cache hits do not verify `isActive` and invalidation is best effort.
- The Docker build has no `.dockerignore`; `COPY . .` can copy the local `.env`, dependencies, logs, tests, and other sensitive/build-only files into the builder context.
- Prisma schema and the initial migration disagree: Prisma declares UUID columns while the migration creates `TEXT` IDs. The migration directory also lacks `migration_lock.toml`.
- App IDs are generated as UUIDs, but rotate/delete routes validate IDs as CUIDs, making those valid management operations fail.

### High-priority blockers

- Verification is an in-process `setImmediate` job with Redis-only state and is lost or becomes unpollable across restarts.
- API-key authentication is an async Express middleware mounted without `asyncHandler`; database failures are not reliably forwarded to the error handler.
- CI does not run tests, migrations, or a database/Redis integration environment.
- The dashboard build is not validated with real deployment configuration and its OAuth/API variables are not validated at startup.
- Production dependency audits report vulnerable backend and frontend packages.
- Compose uses fixed credentials, published database ports, no healthchecks, and is not suitable as production infrastructure.

## 2. Project Structure and Entry Points

- **Backend:** `src/app.ts`, Express API, Prisma/PostgreSQL, Redis, Winston logging.
- **Frontend:** `dashboard/`, Next.js App Router dashboard and NextAuth route.
- **Database:** `prisma/schema.prisma` and four checked-in migrations.
- **Smoke-test producer:** `mock/producer.ts`, invoked by `npm run producer`.
- **Infrastructure:** `Dockerfile` for the API; `docker-compose.yml` only provisions PostgreSQL and Redis.
- **CI:** `.github/workflows/ci.yml` performs static validation/builds only.
- **Workers/cron:** none. Verification work runs inside the API process with `setImmediate`.
- **Cloud configuration:** no Vercel, AWS, Azure, GCP, Railway, Render, Kubernetes, Nginx, or Cloudflare deployment configuration is present.

Production entry points:

```text
API build:       npm run build
API migration:   npm run prisma:migrate
API start:       npm start                  # node dist/app.js
Dashboard build: cd dashboard && npm run build
Dashboard start: cd dashboard && npm start  # next start -p 3001
```

The Docker API entry point is `npx prisma migrate deploy && node dist/app.js` in `Dockerfile`.

## 3. Frontend Findings

### CRITICAL: dashboard requests use incorrect API paths

- **Files:** `dashboard/lib/api.ts`, `dashboard/app/dashboard/page.tsx`, `dashboard/app/dashboard/events/page.tsx`, `dashboard/app/dashboard/apps/page.tsx`, `dashboard/app/dashboard/export/page.tsx`, `dashboard/components/VerificationResult.tsx`, `src/app.ts`
- **Evidence:** backend mounts `/v1/events`, `/v1/apps`, `/v1/verify`, and `/v1/export`; dashboard requests `/events`, `/apps`, `/verify`, and `/export`.
- **Impact:** Overview, events, apps, export, and verification functionality does not communicate with the deployed API.
- **Required fix:** centralize versioned API paths and align all dashboard calls with the actual backend contract.

### CRITICAL: dashboard authentication is not enforced

- **Files:** `dashboard/app/api/auth/[...nextauth]/route.ts`, `dashboard/app/dashboard/layout.tsx`
- **Evidence:** NextAuth exists, but there is no `middleware.ts`, `getServerSession`, `auth()` check, or route guard around dashboard pages.
- **Impact:** unauthenticated users can open dashboard pages. Server-side requests can use the configured internal credential and owner scope without proving the visitor's identity.
- **Required fix:** require and validate a session before rendering dashboard pages and derive authorization from the authenticated identity.

### CRITICAL: OAuth identity is not connected to owner authorization

- **Files:** `src/middleware/auth.ts`, `dashboard/lib/api.ts`
- **Evidence:** backend accepts one shared `INTERNAL_API_KEY` plus `x-owner-id`; dashboard sends `DASHBOARD_OWNER_ID` from configuration. The owner is not derived from the GitHub session.
- **Impact:** authorization is a shared-secret/static-owner model, not user authorization. Any compromise of the internal key or server-side request path can expose the configured owner's applications.
- **Required fix:** map authenticated OAuth subjects to owner records and avoid trusting arbitrary caller-supplied owner headers.

### CRITICAL: verification UI uses the wrong endpoint and response contract

- **File:** `dashboard/components/VerificationResult.tsx`
- **Evidence:** calls `/verify` and expects `body.data.valid` immediately. The backend starts `POST /v1/verify` with `202` and requires polling `GET /v1/verify/:jobId`; the result is under `data.result`.
- **Impact:** verification cannot work from the dashboard.
- **Required fix:** start the job, poll the returned URL, handle pending/failed states, and surface HTTP/network errors.

### HIGH: export UI uses the wrong endpoint and has weak error handling

- **File:** `dashboard/app/dashboard/export/page.tsx`
- **Evidence:** calls `/export` instead of `/v1/export`; it assumes every response is a successful blob and has no `try/finally` or user-facing error handling.
- **Impact:** export fails silently or leaves the loading state stuck after network/API errors.
- **Required fix:** use the versioned endpoint and handle non-2xx responses, aborts, and loading cleanup.

### HIGH: event pages have no configured application API key

- **Files:** `dashboard/lib/api.ts`, `dashboard/app/dashboard/page.tsx`, `dashboard/app/dashboard/events/page.tsx`, `.env.example`
- **Evidence:** `apiFetch` reads optional `DASHBOARD_APP_API_KEY`, but the shared environment template does not define it and the pages do not pass an API key.
- **Impact:** event overview/search requests send no bearer key and receive `401 MISSING_API_KEY` even after route paths are corrected.
- **Required fix:** use authenticated server-side application access or implement an explicit user/app selection flow; do not rely on an undocumented static key.

### HIGH: dashboard runtime configuration is not validated

- **Files:** `dashboard/app/api/auth/[...nextauth]/route.ts`, `dashboard/lib/api.ts`, `.env.example`
- **Impact:** missing OAuth/API values become empty or invalid values; failures occur at runtime rather than deployment/startup validation.
- **Required fix:** fail fast for required dashboard variables and distinguish server-only variables from `NEXT_PUBLIC_*` build-time variables.

### MEDIUM: public client requests expose bearer API keys to the browser

- **Files:** `dashboard/app/dashboard/export/page.tsx`, `dashboard/components/VerificationResult.tsx`
- **Impact:** users type long-lived application credentials into a browser page, where they are exposed to browser extensions, XSS, history/autocomplete behavior, and client-side compromise.
- **Required fix:** route these actions through authenticated server-side dashboard handlers or use a properly scoped short-lived credential.

### MEDIUM: frontend production behavior is not covered by tests

- There are no frontend unit, integration, route, authentication, or API-contract tests. A successful Next.js build does not prove dashboard/API communication works.

## 4. Backend Findings

### CRITICAL: plaintext API-key storage and cache

- **Files:** `src/routes/apps.ts`, `src/middleware/auth.ts`, `prisma/schema.prisma`, `DATA_STORAGE.md`
- **Evidence:** `App.apiKey` stores the full bearer key; Redis caches the complete app object including `apiKey`.
- **Impact:** database or Redis read access immediately yields usable credentials.
- **Required fix:** store a one-way keyed hash/peppered digest, return the plaintext only once, and compare hashes during authentication. Remove plaintext values from cache.

### HIGH: revoked/deactivated keys can remain valid in Redis

- **File:** `src/middleware/auth.ts`
- **Evidence:** a valid cache entry is accepted without checking `isActive`; delete/rotate invalidation is best effort and the cache TTL defaults to 600 seconds.
- **Impact:** a deleted or rotated application key can continue authenticating until cache expiry or successful invalidation.
- **Required fix:** include active-state enforcement in cache validation and make revocation invalidation reliable, or use a revocation/version strategy.

### HIGH: async API-key auth errors are not safely forwarded

- **Files:** `src/app.ts`, `src/middleware/auth.ts`
- **Evidence:** `app.use(apiKeyAuth)` mounts an async Express 4 middleware directly; the Prisma lookup is not inside `asyncHandler` or a local `try/catch`.
- **Impact:** database failures can become unhandled promise/request failures instead of controlled 5xx responses.
- **Required fix:** wrap the middleware with `asyncHandler` or add explicit rejection forwarding.

### CRITICAL: valid UUID application IDs fail CUID validation

- **Files:** `prisma/schema.prisma`, `src/routes/apps.ts`
- **Evidence:** `App.id` uses `@default(uuid(7)) @db.Uuid`, while rotate/delete parse `req.params.id` with `z.string().cuid()`.
- **Impact:** valid app IDs generated by the service are rejected for key rotation and deletion.
- **Required fix:** validate UUIDs consistently or change the schema and migrations to use CUIDs consistently.

### HIGH: verification jobs are not durable

- **File:** `src/routes/verify.ts`
- **Evidence:** state is in Redis and execution is scheduled with `setImmediate` in the API process.
- **Impact:** process restart, deployment, crash, or Redis failure can lose work or leave clients unable to poll results.
- **Required fix:** use a durable queue/worker and durable job state, or explicitly constrain and document the availability model.

### MEDIUM: unauthenticated health endpoint leaks dependency errors

- **File:** `src/routes/health.ts`
- **Evidence:** caught database and Redis exception messages are returned in the public response.
- **Impact:** internal connection/topology/error details may be disclosed.
- **Required fix:** return generic dependency status publicly and log detailed errors server-side; optionally provide an authenticated/internal diagnostic endpoint.

### MEDIUM: in-memory rate limiting is not distributed

- **File:** `src/middleware/rateLimiter.ts`
- **Evidence:** `express-rate-limit` uses its default process-local store.
- **Impact:** limits reset on restart and are bypassed across multiple API replicas.
- **Required fix:** use a shared Redis-backed store and configure proxy trust correctly for client IP handling.

### MEDIUM: no explicit database/Redis connection timeout and pool policy

- **Files:** `src/config/db.ts`, `src/config/redis.ts`
- **Impact:** deployment behavior under unavailable dependencies and connection pressure is not explicitly bounded or tuned.
- **Required fix:** define production connection/pool/timeouts appropriate to the hosting platform and load profile.

## 5. Database Findings

### CRITICAL: Prisma schema and initial migration disagree

- **Files:** `prisma/schema.prisma`, `prisma/migrations/20260424115900_init_schema/migration.sql`
- **Evidence:** Prisma declares `App.id`, `AuditLog.id`, and `AuditLog.appId` as PostgreSQL UUID fields; the initial migration creates all of these columns as `TEXT`.
- **Impact:** fresh production databases can differ from the generated Prisma contract, causing runtime/query/type drift and unsafe future migrations.
- **Required fix:** reconcile the schema and migration history with a tested migration strategy. Do not edit an already-applied migration in deployed environments; add a verified corrective migration if required.

### HIGH: migration metadata is incomplete

- **Evidence:** `prisma/migrations/migration_lock.toml` is absent. `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --script` failed because the connector could not be determined.
- **Impact:** migration validation and deployment behavior are not trustworthy from a clean checkout.
- **Required fix:** restore/generate the correct migration lock metadata and validate `prisma migrate deploy` against a fresh database.

### HIGH: production runtime role and migration role are not separated

- **Files:** `Dockerfile`, Prisma migrations, deployment configuration absence
- **Impact:** the application startup process needs migration privileges. A compromised runtime credential may be able to run DDL, alter triggers, or bypass append-only protections.
- **Required fix:** run migrations as a separate controlled release step with a migration role; run the API with a restricted runtime role.

### MEDIUM: append-only protection is not sufficient by itself

- **File:** `prisma/migrations/20260424120000_add_immutability_trigger/migration.sql`
- **Impact:** table triggers do not protect against privileged users disabling triggers or changing schema. Production PostgreSQL roles and ownership must enforce separation.

### MEDIUM: fresh-database deployment is unverified

- `prisma migrate status` could not connect to PostgreSQL at `localhost:5432`, and the migration-diff command could not determine the connector due missing migration metadata. A fresh production database has not been successfully migrated and queried in this audit.

## 6. Environment and Secrets

### CRITICAL: Docker build context can include `.env`

- **Files:** `Dockerfile`, absence of `.dockerignore`, `.env` exists locally but is ignored by Git.
- **Evidence:** Docker uses `COPY . .`; `.gitignore` does not control Docker build context.
- **Impact:** local secrets can be copied into the builder image/layers and potentially leak through image inspection or registry access.
- **Required fix:** add a strict `.dockerignore` excluding `.env*`, `node_modules`, `dist`, `.next`, logs, coverage, tests, and other non-runtime content; use explicit `COPY` lists where possible.

### HIGH: local/Compose credentials are unsafe for production

- **Files:** `.env.example`, `docker-compose.yml`
- **Evidence:** fixed database username/password and localhost endpoints are included for local operation.
- **Impact:** these values must never be reused in production; Compose is not a production deployment definition.
- **Required fix:** keep local placeholders clearly non-production and document secret injection/rotation for deployment.

### HIGH: API only validates a subset of required runtime configuration

- **File:** `src/config/validateEnv.ts`
- **Impact:** malformed numeric ports/limits, weak placeholder secrets, and dashboard OAuth/API variables are not rejected at startup.
- **Required fix:** validate types, ranges, secret minimums, and dashboard configuration as part of deployment validation.

### LOW: `NEXT_PUBLIC_API_URL` is intentionally public but build-time

- **Files:** `dashboard/app/dashboard/export/page.tsx`, `dashboard/components/VerificationResult.tsx`, `.env.example`
- **Impact:** changing the frontend API URL requires a dashboard rebuild; this is acceptable only if deployment explicitly supplies the value at build time.
- **Required fix:** document build-time/runtime behavior or use a server-side proxy/configuration mechanism.

## 7. Docker and Infrastructure

### CRITICAL: no production frontend container/deployment definition

- **Evidence:** `Dockerfile` builds only the API. The dashboard has no Dockerfile or hosting configuration.
- **Impact:** the repository does not define how the frontend is deployed, networked to the API, or configured with OAuth/API variables.
- **Required fix:** provide and validate the chosen dashboard deployment configuration, including domain, HTTPS, environment variables, and API connectivity.

### HIGH: API container runs migrations during application startup

- **File:** `Dockerfile`
- **Impact:** every replica needs migration privileges; concurrent replicas can contend; a migration failure prevents the API from starting; rollback coordination is undefined.
- **Required fix:** run migrations as an explicit release job before application rollout.

### MEDIUM: Compose is not production-safe

- **File:** `docker-compose.yml`
- **Evidence:** fixed credentials, published database ports, no healthchecks, no resource limits, and no production network/secrets policy.
- **Impact:** acceptable as a local dependency stack, not as production infrastructure.

### MEDIUM: API image runs as root and has no healthcheck

- **File:** `Dockerfile`
- **Impact:** larger blast radius for container compromise and no container-level readiness signal.
- **Required fix:** add a non-root runtime user and a healthcheck/readiness strategy appropriate to the orchestrator.

## 8. CI/CD and Hosting

### HIGH: CI does not run tests or migrations

- **File:** `.github/workflows/ci.yml`
- **Evidence:** workflow installs, generates Prisma, lints, typechecks, and builds; it does not run `npm test`, provision PostgreSQL/Redis, run `prisma migrate deploy`, or perform API contract checks.
- **Impact:** the current route, migration, and integration failures can pass CI.
- **Required fix:** add service-backed integration validation and fresh-database migration checks.

### HIGH: no deployment pipeline exists

- **File:** `.github/workflows/ci.yml`
- **Impact:** there is no automated image publication, migration release step, frontend deployment, environment promotion, rollback, or health verification.
- **Required fix:** define the target hosting platform and add an explicit deployment/release workflow.

### MEDIUM: CI dashboard build lacks production environment validation

- **File:** `.github/workflows/ci.yml`
- **Impact:** the build does not prove real API URL, OAuth, owner, or secret configuration is present and valid.
- **Required fix:** validate non-secret configuration in CI and validate secrets/configuration at deployment time.

## 9. Dependency Findings

`npm audit --omit=dev --audit-level=moderate` results:

- **Backend:** 3 vulnerabilities reported: body-parser, morgan, and qs; low/moderate severity.
- **Dashboard:** 5 vulnerabilities reported: 1 critical, 3 high, and 1 moderate, involving next-auth, Next.js, nanoid, postcss, and uuid.
- npm reports that the broad frontend remediation requires a breaking Next.js upgrade. This needs a planned compatibility upgrade, not an unreviewed `--force` update.

Production dependency installation/build checks passed, but passing a build does not make vulnerable dependencies acceptable for deployment.

## 10. Security Status

Positive controls observed:

- Helmet is enabled.
- Zod validates request bodies and query parameters.
- Prisma parameterizes database access.
- CORS origins are configured rather than wildcarded by default.
- API and dashboard secrets are not tracked by Git according to `git ls-files`; `.env` is ignored.
- Graceful shutdown handlers exist for SIGTERM/SIGINT and uncaught process failures.
- API rate limiting exists, though it is process-local.

Security concerns requiring resolution are listed above: dashboard access control, shared owner authorization, plaintext API keys, stale revocation cache, Docker secret exposure, health detail disclosure, dependency vulnerabilities, and privileged runtime database access.

## 11. Performance and Reliability

- Search uses pagination and has page/limit bounds.
- JSON export is capped; CSV export streams in batches.
- Redis activity caching and API-key caching are best effort.
- Verification is process-local and non-durable.
- Rate limits are process-local.
- There is no queue/worker, distributed lock, external error reporting, metrics, tracing, or alerting integration beyond optional Brevo email attempts.
- Health checks query both PostgreSQL and Redis but return dependency errors publicly and do not have container/orchestrator health configuration.

## 12. Testing and Build Results

Passed:

- `npm run prisma:generate`
- `npm run build`
- `npm run typecheck`
- `npm run lint`
- `cd dashboard && npm run typecheck`
- `cd dashboard && npm run build` with explicit deployment-shaped variables
- `git diff --check`

Failed or blocked:

- `npm test -- --runInBand`: integration tests could not connect to PostgreSQL at `localhost:5432`; Redis also emitted connection failures.
- `npx prisma migrate status`: blocked by PostgreSQL being unavailable.
- `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --script`: failed because `migration_lock.toml` is missing and the connector could not be determined.
- `docker version`: Docker CLI is installed, but the Docker daemon was unavailable during verification.
- `npm audit --omit=dev`: reported the vulnerabilities listed above.

No frontend automated tests are present.

## 13. Required Production Environment Variables

Backend required by startup validation:

- `DATABASE_URL`
- `REDIS_HOST`
- `REDIS_PORT`
- `CORS_ORIGINS`
- `HASH_SECRET`
- `GENESIS_HASH`
- `INTERNAL_API_KEY`

Backend optional/operational:

- `PORT`
- `REDIS_PASSWORD`
- `API_KEY_CACHE_TTL_SECONDS`
- `RATE_LIMIT_EVENTS_WINDOW_MS`, `RATE_LIMIT_EVENTS_MAX`
- `RATE_LIMIT_VERIFY_WINDOW_MS`, `RATE_LIMIT_VERIFY_MAX`
- `RATE_LIMIT_APPS_WINDOW_MS`, `RATE_LIMIT_APPS_MAX`
- `RATE_LIMIT_SEARCH_WINDOW_MS`, `RATE_LIMIT_SEARCH_MAX`
- `RATE_LIMIT_EXPORT_WINDOW_MS`, `RATE_LIMIT_EXPORT_MAX`
- `ACTIVITY_CACHE_MAX_ENTRIES`, `ACTIVITY_CACHE_TTL_SECONDS`
- `VERIFY_CHAIN_BATCH_SIZE`, `VERIFY_JOB_TTL_SECONDS`, `JSON_EXPORT_MAX_ROWS`
- `BREVO_API_KEY`, `ALERT_EMAIL_FROM`, `ALERT_EMAIL_TO`

Dashboard configuration used by code:

- `API_URL`
- `NEXT_PUBLIC_API_URL` (build-time public URL)
- `DASHBOARD_OWNER_ID`
- `DASHBOARD_APP_API_KEY` (currently expected by event pages but absent from `.env.example`)
- `NEXTAUTH_URL`
- `NEXTAUTH_SECRET`
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`

The dashboard variables are not currently validated at startup, and the authentication design does not safely connect them to user identity.

## 14. Recommended Deployment Sequence

This sequence is conditional on resolving the blockers above:

1. Reconcile Prisma schema, migrations, and migration metadata.
2. Create separate restricted migration and runtime database roles.
3. Resolve API-key hashing, revocation, dashboard authorization, and route contracts.
4. Upgrade/remediate vulnerable dependencies and rerun audits.
5. Add `.dockerignore`, build a non-root API image, and separate migration execution from app startup.
6. Define the frontend hosting/deployment target and configure HTTPS, OAuth callbacks, API URL, and CORS.
7. Provision PostgreSQL and Redis with private networking, backups, TLS, credentials, and monitoring.
8. Run migrations against a disposable fresh database and a production-like staging database.
9. Run backend integration tests with PostgreSQL and Redis services.
10. Build and publish the API and dashboard artifacts.
11. Run the migration release job before rolling out the API.
12. Deploy the API and dashboard, then verify `/health`, OAuth login, dashboard API calls, event ingestion, verification polling, and export.
13. Confirm logs, alerts, backups, rollback, and key rotation procedures.

## 15. Final Recommendation

Do not deploy this repository to production in its current state. Treat the dashboard/API integration and authentication issues, API-key storage/revocation, migration consistency, Docker secret exposure, and missing integration validation as release blockers. The successful builds demonstrate compilation only; they do not demonstrate a secure, correctly connected, recoverable production deployment.
