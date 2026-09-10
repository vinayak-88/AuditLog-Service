# Production Readiness Audit

**Audit date:** 2026-09-10 (status update; prior 2026-09-08 findings retained below only where still relevant)

## Deployment Status

**READY TO BEGIN DEPLOYMENT**

The current codebase is deployable. There are no known MUST-FIX codebase
blockers remaining: dashboard event-read authorization and app selection (A1),
public `/health` error disclosure (B3), dashboard CI validation (B4), and
backend/dashboard environment validation (B6) are complete and verified, along
with all earlier API-key, verification, migration, Docker, dependency, and
documentation work (see Resolved section).

The remaining items are deliberately deferred risk and deployment procedure:
the Next.js 14/PostCSS advisories (no non-breaking fix; internal/OAuth-gated
use only until the separate 14→16 migration) and migration release / database
role separation (handled as part of deployment, not code).

## 1. Resolved (verified against current code; kept for traceability)

- **API-key hashing:** `App.apiKey` stores an HMAC-SHA256 digest
  (`src/services/apiKey.ts`, keyed by `HASH_SECRET`); raw `als_` keys are
  returned only at creation/rotation (`src/routes/apps.ts`). Redis cache holds
  only non-secret `Omit<App,'apiKey'>` data (`src/middleware/auth.ts`).
- **Revocation/invalidation:** cache validation requires `isActive: true` and
  evicts corrupt entries; rotation/soft-delete clear the digest cache entry.
  Stale-cache window is bounded by `API_KEY_CACHE_TTL_SECONDS` and logged.
- **UUID validation:** rotate/delete parse `req.params.id` as UUID
  (`src/routes/apps.ts`), matching `@default(uuid(7)) @db.Uuid`. No CUID usage
  remains in `src/`.
- **Durable verification:** BullMQ `verification` queue + standalone worker
  (`src/queues/verificationQueue.ts`, `src/workers/verificationWorker.ts`,
  attempts 3 / exponential backoff), atomic Redis sentinel
  (`verify-active:{appId}`, Lua acquire/release/renew), heartbeat renewal,
  terminal-state release, `worker.close()` shutdown, queue-only close on API
  shutdown. The `setImmediate` design is gone.
- **Async auth errors:** `apiKeyAuth`/`dashboardOrApiKeyAuth` forward Prisma
  failures via `next(err)`; route handlers use `asyncHandler`.
- **Migration consistency:** init migration creates UUID columns matching the
  schema; `prisma migrate diff --from-migrations --to-schema` is empty;
  `migration_lock.toml` (`provider = "postgresql"`) exists; fresh-database
  `migrate deploy` + trigger enforcement verified end to end.
- **Docker:** `.dockerignore` is strict (excludes `.env*`, `node_modules`,
  `dist`, `tests`, `logs`, `dashboard`, git metadata); production image runs as
  non-root `node` with a `/health` HEALTHCHECK; Compose runs
  postgres/redis/api/worker with dependency healthchecks. The image does **not**
  run migrations at startup; migrations run via explicit
  `npm run prisma:migrate`.
- **CI:** provisions PostgreSQL 15 + Redis 7 services, runs generate →
  typecheck → lint → `migrate deploy` → `jest --runInBand` → build →
  `git diff --check`; plus an independent dashboard job (`npm ci`,
  typecheck, build with non-secret deployment-shaped config). No deploy/CD
  behavior in CI by design.
- **Dashboard auth:** layout enforces `getServerSession` with redirect to
  `/login` (`dashboard/app/dashboard/layout.tsx`); owner id comes from GitHub
  `token.sub`; `dashboard/lib/api.ts` is `server-only`, sends
  `INTERNAL_API_KEY` + `x-owner-id` (+ `x-app-id` for scoped reads); browsers
  never receive the internal key (verified absent from client bundles).
  Verify/export go through session-guarded proxy routes with UUID validation
  and appId-match checks; the verify UI starts jobs, polls to completion, and
  surfaces errors; export has try/finally error handling. `/v1` path
  normalization via `buildApiUrl`.
- **A1 dashboard event reads (resolved):** read-only event/search/activity
  routes accept dashboard owner/app credentials through the existing
  ownership-verified `dashboardOrApiKeyAuth` model (`src/app.ts`;
  ingestion stays customer-key-only). Overview/Events pages resolve an
  explicit selected app from the owner's app list (`dashboard/lib/
  app-selection.ts`, `AppSelector.tsx`), send it as `x-app-id` server-side,
  preserve it across searches, show the existing empty state only when the
  owner truly has no apps, and render error cards instead of silent empty
  data (`dashboardFetch` throws on non-2xx). Covered by
  `tests/dashboardEvents.test.ts` plus a live 12-point authz matrix
  (owner/cross-owner/random-ID/no-context/customer-key/search/activity).
- **B3 health disclosure (resolved):** `/health` returns only generic
  `connected`/`unavailable` per dependency publicly (`src/routes/health.ts`);
  raw messages stay in server-side Winston logs. 200/503 semantics unchanged;
  verified live for healthy and degraded paths.
- **B6 environment validation (resolved):** backend `validateEnv`
  (`src/config/validateEnv.ts`, also invoked by the worker entrypoint)
  rejects malformed numerics for all 23 consumed settings (ports 1–65535,
  counts/TTLs positive integers; unset still means "use default"), malformed
  `DATABASE_URL`/`CORS_ORIGINS`, missing secrets, and weak
  `HASH_SECRET`/`INTERNAL_API_KEY` in production (warning only elsewhere, so
  compose defaults and CI keep working). Dashboard validates required config
  at build/start via `dashboard/scripts/validate-env.cjs` (called from
  `next.config.mjs`): required keys, http(s) URL shapes, `NEXTAUTH_SECRET`
  length; server-only values never reach the browser.
- **Dependencies (non-breaking):** root audit is clean (`morgan` 1.12.0,
  `body-parser` 1.20.8, `qs` 6.16.0 via `overrides`); dashboard `next-auth`
  4.24.15, `nanoid` 3.3.18, `uuid` 11.1.1 resolved. Remaining: Next.js/postcss
  (deferred risk, §2).
- **Documentation:** all seven project documents describe the current
  implementation (BullMQ verification, dual auth, migrations, Docker/CI).
- **Secrets hygiene:** no tracked `.env`; no hardcoded credentials found;
  Winston logs to console only.

## 2. Known Risks / Deferred Work (no MUST-FIX items remain)

### Deferred security risk: Next.js 14 / PostCSS vulnerabilities

- **Files:** `dashboard/package.json` (`next@14.2.35`), transitive
  `postcss@8.4.31` pinned under it.
- **State:** `npm audit --omit=dev` still reports the Next.js critical
  cluster and postcss highs. They are **not fixed**; patched releases exist
  only on the 15/16 lines.
- **Exposure (current code):** no `next/image`, rewrites, `remotePatterns`,
  or i18n routing in use; dashboard is OAuth-gated (only `/login` public);
  target is Vercel/Linux. Residual exposure is generic RSC/cache/DoS vectors
  on an internal tool.
- **Decision:** deliberately deferred for the initial internal/OAuth-gated
  deployment. Next.js 14→16 is a **separate breaking migration** (React 19
  peer, `next-auth` v5 compatibility work, full regression) and is **not**
  part of this deployment. The dashboard must **not** be treated as broadly
  public until that framework upgrade is completed; record the acceptance and
  schedule the upgrade as follow-up work.

### Deployment concern: B5 migration release / database role separation

- **State:** primarily deployment procedure now, not a code blocker. The
  image intentionally does not migrate at startup (avoids replica races).
- **Action at deploy time:** run `prisma migrate deploy` explicitly as the
  migration/release step before the API rollout, then verify
  `migrate status`.
- **Hardening:** separate migration and runtime database roles per what the
  hosting platform supports (least-privilege runtime that cannot alter
  triggers/schema); can be handled according to the platform.

### C. SAFE TO DEFER (known tradeoffs, still accurate)

- **C1. Process-local rate limiting** (`src/middleware/rateLimiter.ts`): correct
  for single-replica API; add a Redis-backed store only if horizontally scaled.
- **C2. Default DB pool/connection timeouts** (`src/config/db.ts`,
  `src/config/redis.ts`): Prisma/ioredis defaults are acceptable at current
  scale; tune with production load data. Health checks already bound
  dependency probes (3 s).
- **C3. No frontend tests:** unit/integration coverage is backend-only by
  design decision; Next.js builds + typecheck gate the dashboard.
- **C4. Unwired helpers:** analytics service and anomaly alerts are
  implemented but uncalled; no dead-route risk.
- **C5. Client poll caps** (`VerificationResult.tsx`: 60 × 500 ms): long
  verifications surface a retryable timeout; acceptable UX tradeoff.
- **C6. Compose is local-only** (published ports, fixed creds, no resource
  limits): documented local stack, not production infrastructure.
- **C7. `VERIFY_ACTIVE_TTL_SECONDS`** has a code default (3600 s) but is absent
  from `.env.example`: cosmetic; add when touching env docs.

## 3. Verified Areas (no action)

Authn/z (digest keys, rotation/deactivation, owner+app scoping, IDOR polling
checks, session guards, server-only internal key, owner-scoped event reads);
verification lifecycle (sentinel atomicity, heartbeat, retries, terminal
release, shutdown semantics); data integrity (trigger, idempotency incl. P2002
race path, Serializable ingestion, no destructive queries in `src/`);
reliability (async handling, validation incl. startup env checks, shutdown,
request IDs, JSON logging, generic health statuses); secrets/Docker hygiene;
Prisma generate/migrate/status/diff; full test suite green (see §4).

## 4. Validation Results (2026-09-10)

- `npm run prisma:generate` — pass
- `npm run typecheck` — pass
- `npm run lint` — pass
- `npm test -- --runInBand` — 38/38 pass, 8/8 suites (isolated test DB; Compose
  worker paused during verification suites to avoid shared-queue contention,
  then restarted healthy)
- `npm run build` — pass
- `cd dashboard && npm run typecheck` — pass
- `cd dashboard && npm run build` — pass (all routes compiled)
- Root `npm audit --omit=dev` — 0 vulnerabilities; dashboard audit — only the
  deferred Next.js/postcss items above
- `git diff --check` — clean

## 5. Deployment Sequence

1. Provision production PostgreSQL + Redis.
2. Configure production API/worker environment variables.
3. Run `prisma migrate deploy` as the migration/release step.
4. Deploy API + verification worker.
5. Configure and deploy dashboard.
6. Configure GitHub OAuth callback/domain.
7. Configure CORS/API URLs.
8. Run end-to-end production smoke tests.
9. Verify logs, alerts, backups/restore, and API-key rotation.
10. Record the Next.js risk acceptance and schedule the later framework upgrade.
