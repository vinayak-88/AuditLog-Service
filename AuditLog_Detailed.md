# Audit Log Service — Detailed Project Brief

> Status: implementation brief. Storage layouts, middleware, routes, and types
> are specified in DATA_STORAGE.md, MIDDLEWARE.md, ROUTES_AND_FLOW.md, and
> TYPES_AND_INTERFACES.md. This file explains the idea, the current design, and
> what is (and is not) built yet. The code is the source of truth.

---

## What Is This? (Explain Like I'm 5)

Imagine you have a diary that records everything that happens in your house. Who opened the fridge, who turned on the TV, who deleted files from the computer. Every action, written down, with the person's name and time.

Now imagine that diary is magic — if anyone tears out a page or scribbles over something they wrote, you can immediately tell. Not because you were watching, but because every page is connected to the page before it with a secret code. Change one page, the code breaks, and you know exactly which page was tampered with.

That's this project.

Every action in any app — "user A deleted record B," "admin C changed password for user D" — is logged, permanently, in a chain where tampering is mathematically detectable. The project is a service that any app can plug into. You send it events, it stores them tamper-proof, and you can search, export, and verify them anytime.

Real world: banks need this to prove no one manipulated transaction records. SaaS companies need this for SOC2 compliance. Hospitals need this to track who accessed patient files. Every serious app above a certain size either buys this (Datadog, Papertrail) or builds it.

---

## The Problem It Solves

Without audit logs:
- "Who deleted that user account?" → Nobody knows
- "Can we prove our records haven't been modified?" → No
- "We need 6 months of activity for a compliance audit" → Painful, manual, unreliable
- "Did someone access sensitive data they shouldn't have?" → No visibility

With this service:
- Every action is logged automatically via one API call from your app
- Logs are cryptographically chained — tampering is detectable
- DB-level append-only enforcement rejects rewrites
- Search by actor, action, resource, date range
- Export for compliance in one click
- Durable worker-based chain verification on demand

---

## Tech Stack — Role of Every Single Thing

### Node.js + Express + TypeScript

The API server. Receives log events, serves search/export/verification, manages
apps and keys. TypeScript + Zod enforce payload shapes from HTTP through hashing
to storage. Current versions: Node `>=20`, Express 4.x, TypeScript 5.x, Zod 3.x.

### PostgreSQL + Prisma

The system of record (PostgreSQL 15, Prisma 5.22.0):

**One — the audit_logs table stores every event.** Each row has event data, the
entry hash, the previous hash, and the per-app sequence number. The hash chain
lives here, partitioned by `appId`.

**Two — a trigger makes the table append-only.** Migration
`20260908202916_add_immutability_trigger` installs
`prevent_audit_log_modification()` + `audit_log_immutable` (`BEFORE UPDATE OR
DELETE`), which rejects rewrites at the engine level — including raw SQL.

**Three — indexes for search performance.** Composite `(appId, createdAt)` for
chronological reads, plus `(appId, actorId/resourceId/action)` for filters and
unique `(appId, sequenceNumber)` / `(appId, idempotencyKey)` for chain and
deduplication integrity.

### Redis + BullMQ

Redis 7 does five jobs: API-key cache (`apikey:*`, 600 s), activity feed sets
(`activity:*`, 50 entries, 1 h), verification job state (`verify-job:*`,
terminal TTL 1 h), the duplicate-prevention sentinel (`verify-active:*`, TTL 1
h with heartbeat renewal), and the BullMQ queue backend.

BullMQ 6.3.4 (required, not optional) is the durable verification queue:
`POST /v1/verify` persists state and enqueues; a separate worker
process/container (`npm run worker`) consumes with `attempts: 3` and
exponential backoff, so verification survives API restarts and never blocks
HTTP workers.

### HMAC-SHA256 + timingSafeEqual

Each entry's hash = `HMAC-SHA256(HASH_SECRET, previous_hash +
JSON.stringify(canonical_payload))` (hex). Metadata keys are recursively
sorted first so JSONB round-trips don't perturb hashes. Verification recomputes
the chain and compares both `previousHash` and `entryHash` with
`timingSafeEqual`. The same `HASH_SECRET` also digests stored app API keys
(raw `als_` keys are returned only at creation/rotation).

Note: `ipAddress`, `userAgent`, and `idempotencyKey` are stored but not hashed;
the append-only trigger is their ordinary-write protection.

### Next.js App Router + GitHub OAuth via NextAuth

Next.js 14 dashboard: event search, activity feed, verification trigger/polling,
CSV/JSON export, app listing plus create/rotate/deactivate management.
GitHub OAuth identifies the dashboard owner (`token.sub` → `session.user.id`
→ `App.ownerId`); there is no `User` table. Server-only helpers attach
`INTERNAL_API_KEY` + `x-owner-id` + `x-app-id` for event reads, verify, and
export, and `INTERNAL_API_KEY` + owner headers for app management; event
ingestion stays customer-key-only. Overview/Events resolve an explicit
selected app from the owner's own list (no unscoped owner-wide read), and the
fetch helper throws on non-2xx so failures surface instead of rendering
silently empty. Browsers never receive the internal key; dashboard proxy
routes validate UUIDs and enforce app scoping on polls and management calls.
Raw keys appear only in transient one-time panels, wiped on close.

### Brevo (email)

Best-effort tamper alerts (`sendTamperAlert`) after an invalid worker result;
anomaly alerts exist but are unwired. Skipped without env config; no retries.

---

## Core Features

1. **App Registration** — Register your application (dashboard owner identity), get an `als_` API key (raw value shown once; digest stored), start sending events
2. **Event Ingestion** — `POST /v1/events` with actor, action, resource, metadata (+ optional idempotency key; 201 new / 200 duplicate, Serializable chain insert)
3. **Hash Chain** — Every entry cryptographically linked to the previous one (canonical payload, genesis hash, sequence numbers)
4. **Tamper Detection** — `POST /v1/verify` enqueues a durable BullMQ job; `GET /v1/verify/:jobId` polls persisted state; one active job per app via atomic sentinel + heartbeat; tampering reported as `valid: false` with the exact sequence/entry
5. **Append-only Enforcement** — PostgreSQL trigger rejects UPDATE and DELETE at engine level
6. **Event Search** — Filter by actor, action, resource type, date range, with pagination
7. **Activity Feed** — Recent events per resource, served from Redis with PostgreSQL fallback
8. **Export** — Streaming filtered CSV (uncapped, formula-safe) or JSON (10k cap with truncation flags) for compliance
9. **App Management** — Dashboard create/rotate/deactivate flows with per-row confirms and one-time key display; rotation replaces the digest and clears cache; deactivation soft-deletes and preserves logs
10. **Analytics helpers** — Volume/top-actor/action-breakdown queries exist with Redis cache-aside but are currently unwired to routes

---

## How Long Will This Realistically Take?

Kept from the original planning brief; the build below reflects what was
actually implemented (worker-based verification, dual auth, Docker api+worker,
CI with backend and dashboard jobs, dashboard management UI).

### Understanding Phase (before writing any code)

| Concept | Time to Understand |
|---|---|
| HMAC hash chain — how it works, why it's tamper-proof | 1 day (you already know HMAC, this is just applying it differently) |
| PostgreSQL triggers — syntax, when they fire, why they matter | 1–2 days |
| PostgreSQL indexes — B-tree vs GIN, composite indexes, EXPLAIN ANALYZE | 2 days |
| Redis sorted sets — ZADD, ZRANGE, trim, EXPIRE for activity cache | 1 day |
| Redis Lua + BullMQ — atomic sentinel, durable queue, worker lifecycle | 2–3 days |
| Next.js App Router — server vs client components, API routes | 3–4 days if new to you |
| TypeScript for this project — discriminated unions, Zod validation | 2 days |

### Building Phase

| Component | Time |
|---|---|
| PostgreSQL schema + trigger | 2–3 days |
| Hash chain logic + worker verification endpoint | 4–5 days |
| Event ingestion API (idempotent, serializable) | 2–3 days |
| Redis activity cache integration | 1–2 days |
| Search + export endpoints | 2–3 days |
| Dual auth (app keys + server-only dashboard credentials) | 2 days |
| Next.js dashboard UI + proxies + app management | 5–6 days |
| Docker api/worker + CI (backend + dashboard jobs) | 2–3 days |
| Integration testing (38/38 across 8 suites) | 2–3 days |
| Deployment (Railway + Vercel — planned, not done) | 1–2 days |

---

## Prerequisites — What You Need to Learn Before Starting

### Things You Already Know (Zero Learning Time)

- Node.js + Express
- HMAC-SHA256 + timingSafeEqual
- BullMQ basics
- Docker + GitHub Actions
- Jest testing

### Things You Need to Learn

**PostgreSQL basics:** CREATE TABLE, types, keys, INSERT/SELECT/JOIN/GROUP BY,
indexes, EXPLAIN ANALYZE. (5–7 days from MongoDB-only.)

**PostgreSQL triggers specifically:** CREATE FUNCTION RETURNS trigger, BEFORE
vs AFTER, NEW/OLD references. One trigger for this project. (1–2 days.)

**Prisma ORM:** schema DSL, migrate, generate, CRUD. The trigger stays raw SQL
in a migration. (2–3 days.) Note the production `binaryTargets` +
OpenSSL requirement.

**Next.js App Router:** routing, layouts, server vs client components, route
handlers, `server-only` data fetching, NextAuth GitHub. (4–5 days.)

**TypeScript fundamentals:** types, interfaces, unions, generics, Zod runtime
validation. (3–4 days.)

**Redis sorted sets + Lua + BullMQ:** ZADD/ZREVRANGE/trim/EXPIRE, atomic
sentinel scripts, queue attempts/backoff, worker lifecycle and graceful close.
(2–3 days.)

---

## Role of AI in This Project

**Where AI helps you (appropriate use):** boilerplate routes/schema/pages,
trigger and Lua syntax, component structure, Jest/Supertest scaffolding.

**Where AI cannot replace your understanding:** hash input design (fields,
order, genesis, canonicalization, exclusions), why the trigger beats
application checks, sentinel ownership/heartbeat reasoning, serializable
ingestion + idempotency races, index strategy, and the dashboard/API security
boundary (server-only internal key, owner/app scoping).

**Honest guideline:** AI builds 70% of the code. You design 100% of the
decisions — hash format, trigger logic, index strategy, Redis keys/TTLs,
sentinel protocol, auth boundaries — and can justify each.

---

## Does It Fill the Gaps?

| Gap from Strategy Doc | Filled? | How |
|---|---|---|
| TypeScript | Yes | Entire codebase — typed event schema, Zod validation, discriminated unions |
| PostgreSQL / SQL | Yes | Relational schema, triggers, composite indexes, aggregation queries |
| Redis as cache + queue backend | Yes | Sorted-set activity cache, key cache, job state, sentinel, BullMQ |
| Durable queues | Yes | BullMQ verification queue + standalone worker (stronger than planned) |
| OAuth | Yes | GitHub OAuth via NextAuth; id is the owner identity (no User table) |
| Next.js App Router | Yes | Dashboard, server components, proxy API routes, app management UI |
| AI integration | Optional | Anomaly detection helper exists but is unwired |
| Live deployment | Planned, not done | Vercel (frontend) + Railway (API/worker/DB/Redis); no CD in CI |
| Integration testing | Yes | Supertest on ingestion, search, cache, API keys, verification + worker (38/38) |

**Gaps it does NOT fill:**
- No real-time features (WebSockets)
- Analytics helpers unwired; no incremental verification checkpoints yet
- No production deploy automation

---

## Final Verdict

Same strengths as originally assessed — HMAC chain plus engine-level
append-only plus (now) a genuinely durable verification worker — with a sharper
security story (digest-stored keys, server-only dashboard credentials, per-app
scoping on event reads, verify, and export). The main remaining risk is
operational, not conceptual: deployment targets are planned but CI provably
stops at build/test, so "deployed" must not be claimed until Railway/Vercel
automation exists.
