# Production Readiness Audit

**Audit date:** 2026-09-10 (re-audit; supersedes the 2026-09-08 findings below where marked resolved)

## Deployment Status

**CONDITIONAL GO — API ready; dashboard partially ready (see A1)**

The Express API, BullMQ verification worker, PostgreSQL/Prisma layer, Docker
images, and CI integration are verified and deployable. Nearly all 2026-09-08
blockers are resolved (see Resolved section). Two pre-launch items remain:
dashboard Overview/Events pages cannot read events with current credentials
(A1 — must resolve by fix or explicit descoping), and unpatched Next.js 14
framework advisories with no non-breaking fix (B1 — plan upgrade or document
risk acceptance for internal-only use).

No application code was changed for this status update; findings were verified
against the current implementation, not carried forward from the prior audit.

## 1. Resolved Since 2026-09-08 (verified against current code)

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
  run migrations at startup (prior audit §2/§7 claim otherwise was incorrect);
  migrations run via explicit `npm run prisma:migrate`.
- **CI:** provisions PostgreSQL 15 + Redis 7 services, runs generate →
  typecheck → lint → `migrate deploy` → `jest --runInBand` → build →
  `git diff --check`. (Dashboard typecheck/build still not in CI — see B4.)
- **Dashboard auth:** layout enforces `getServerSession` with redirect to
  `/login` (`dashboard/app/dashboard/layout.tsx`); owner id comes from GitHub
  `token.sub`; `dashboard/lib/api.ts` is `server-only`, sends
  `INTERNAL_API_KEY` + `x-owner-id` (+ `x-app-id` for verify/export); browsers
  never receive the internal key. Verify/export go through session-guarded
  proxy routes with UUID validation and appId-match checks; the verify UI
  starts jobs, polls to completion, and surfaces errors; export has
  try/finally error handling. `/v1` path normalization via `buildApiUrl`.
- **Dependencies:** root audit is clean (`morgan` 1.12.0, `body-parser` 1.20.8,
  `qs` 6.16.0 via `overrides`); dashboard `next-auth` 4.24.15, `nanoid`
  3.3.18, `uuid` 11.1.1 resolved. Remaining: Next.js/postcss (B1/B2).
- **Secrets hygiene:** no tracked `.env`; no hardcoded credentials found;
  Winston logs to console only.

## 2. Outstanding Issues (classified)

### A. MUST FIX BEFORE DEPLOYMENT

#### A1. Dashboard Overview/Events pages cannot read events (silent empty UI)

- **Files:** `dashboard/app/dashboard/page.tsx`, `dashboard/app/dashboard/events/page.tsx`, `dashboard/lib/api.ts`, `src/app.ts`, `src/middleware/auth.ts`, `src/routes/search.ts`
- **Problem:** both pages call `GET /v1/events` through `dashboardRequest`,
  which always presents `INTERNAL_API_KEY`. The backend mounts event/search
  routers behind `apiKeyAuth` **only** (no `dashboardOrApiKeyAuth` fallback),
  so the digest lookup fails → 401 → `dashboardFetch` returns `null` → pages
  render zeros/empty tables with no error.
- **Impact:** two core dashboard pages are non-functional at launch; the
  silent-`null` pattern hides the failure from operators and users.
- **Action:** choose one before dashboard launch: (a) extend owner-scoped
  reads to event search (backend decision + app-picker UX, since one owner may
  own many apps), or (b) descope/hide these pages until (a) lands. Also make
  `dashboardFetch` surface non-OK states instead of bare `null`.

### B. SHOULD FIX BEFORE DEPLOYMENT

#### B1. Next.js 14 has unpatched critical advisories; only fix is breaking 14→16

- **Files:** `dashboard/package.json` (`next@14.2.35`), `dashboard/package-lock.json`
- **Problem:** `npm audit --omit=dev` reports critical Next.js advisories
  (RCE/SSRF/cache-poisoning/DoS cluster); patched releases exist only on the
  15/16 lines (`next@16.3.4`, breaking).
- **Exposure analysis (current code):** no `next/image`, rewrites,
  `remotePatterns`, or i18n routing in use (`next.config.mjs` sets only
  `reactStrictMode`); dashboard is OAuth-gated (only `/login` is public);
  deployment target is Vercel/Linux (not the windows-only RCE vector).
  Residual exposure is generic RSC/cache/DoS vectors on an internal tool.
- **Action:** schedule the 14→16 upgrade (+ React 19 peer, `next-auth` v5
  migration, full regression). For an internal-only launch, documented risk
  acceptance is defensible; do not expose the dashboard publicly without the
  upgrade.

#### B2. postcss high advisories (same root cause as B1)

- **Files:** transitive `postcss@8.4.31` pinned under `next@14.2.35`
- **Problem:** XSS/file-read/traversal advisories, fixable only via the same
  breaking Next upgrade. No dashboard code invokes postcss directly.
- **Action:** resolved by the B1 upgrade; track together.

#### B3. `/health` returns raw dependency error strings publicly

- **Files:** `src/routes/health.ts`
- **Problem:** caught PostgreSQL/Redis messages (hosts, ports, connection
  details) are embedded in the unauthenticated response.
- **Impact:** low-sensitivity topology disclosure; useful to operators.
- **Action:** return generic `unavailable` per dependency publicly, keep
  details in server logs (small, unambiguous change).

#### B4. CI does not typecheck/build the dashboard

- **Files:** `.github/workflows/ci.yml`
- **Problem:** one job covers the root API only; dashboard `typecheck`/`build`
  are validated manually. A dashboard-only breakage passes CI.
- **Action:** add a dashboard job (install, typecheck, build with
  non-secret config).

#### B5. No migration release step / single database role

- **Files:** `Dockerfile`, `docker-compose.yml`, absence of hosting config
- **Problem:** migrations run manually via `npm run prisma:migrate` with the
  same credential the runtime uses (DDL-capable; could alter triggers).
- **Action:** define the Railway release step (`migrate deploy` before API
  rollout) and, if the platform supports it, separate migration and runtime
  roles.

#### B6. Environment validation is presence-only

- **Files:** `src/config/validateEnv.ts`
- **Problem:** no numeric/range checks (`PORT`, TTLs, limits, batch sizes) and
  no secret-strength checks; malformed numbers degrade at first use, not at
  startup. Dashboard required vars throw at first request, not at boot.
- **Action:** validate types/ranges/minimums at startup (API) and boot
  (dashboard); small change.

### C. SAFE TO DEFER (known tradeoffs)

- **C1. Process-local rate limiting** (`src/middleware/rateLimiter.ts`): correct
  for single-replica API; add a Redis store only if horizontally scaled.
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
checks, session guards, server-only internal key); verification lifecycle
(sentinel atomicity, heartbeat, retries, terminal release, shutdown semantics);
data integrity (trigger, idempotency incl. P2002 race path, Serializable
ingestion, no destructive queries in `src/`); reliability (async handling,
validation, shutdown, request IDs, JSON logging); secrets/Docker hygiene;
Prisma generate/migrate/status/diff; full test suite green (see §5).

## 4. Validation Results (2026-09-10)

- `npm run prisma:generate` — pass
- `npm run typecheck` — pass
- `npm run lint` — pass
- `npm test -- --runInBand` — 31/31 pass, 7/7 suites (isolated test DB; Compose
  worker paused during verification suites to avoid shared-queue contention,
  then restarted healthy)
- `npm run build` — pass
- `cd dashboard && npm run typecheck` — pass
- `cd dashboard && npm run build` — pass (all routes compiled)
- `git diff --check` — clean

## 5. Deployment Sequence

1. Resolve A1 (fix or descope dashboard event pages); record B1 risk decision.
2. Provision Railway PostgreSQL/Redis (private networking, backups) + Vercel
   dashboard; configure OAuth callback, `API_URL`/`NEXT_PUBLIC_API_URL`,
   `CORS_ORIGINS`, and production secrets (never reuse Compose/CI values).
3. Run `npm run prisma:migrate` as the release step (B5), verify
   `migrate status`.
4. Deploy API + worker (same image, worker command), then dashboard; verify
   `/health`, login, apps, events (per A1), verify poll, export.
5. Confirm log access, tamper-alert mail path, backup/restore, and key
  rotation procedures.
