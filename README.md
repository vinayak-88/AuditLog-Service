# Audit Log Service

A tamper-evident audit logging service that another application can use to record important actions, search them later, export them, and verify that the stored history has not been changed.

The project has two main parts:

- **Backend API:** Node.js + Express + TypeScript
- **Dashboard:** Next.js + NextAuth (GitHub OAuth)

The backend stores audit events in PostgreSQL, uses Redis for caching and verification-job coordination, and uses a separate BullMQ worker for on-demand hash-chain verification.

## Live Deployment

- **Dashboard:** https://audit-log-service-five.vercel.app
- **API health check:** https://3-108-124-176.nip.io/health

The dashboard requires GitHub sign-in.

---

## What problem does this solve?

Most applications eventually need to answer questions like:

- Who deleted this record?
- Who changed this account?
- What happened to this resource and when?
- Can we detect if someone changed an old audit record?
- Can we export the activity for an investigation or compliance review?

A normal log table can tell you what was stored, but it does not automatically make the history tamper-evident. Someone who can modify the database could potentially change an old row and leave a misleading history behind.

This project adds an integrity layer on top of normal audit logging.

---

## The main idea, in simple terms

Think of the audit log as a chain of connected pages.

Suppose an application records these events:

```text
1. user_101 logged in
2. user_101 updated profile
3. user_101 deleted a document
```

Each entry contains a hash that depends on:

1. the previous entry's hash
2. the current entry's important data

So the chain looks roughly like this:

```text
GENESIS
   ↓
Entry 1 → hash A
             ↓
Entry 2 → hash B
             ↓
Entry 3 → hash C
```

If someone changes Entry 2, its calculated hash no longer matches the stored hash. Entry 3 also points to the old hash of Entry 2, so the chain breaks.

When verification runs, the service recomputes the chain from the beginning and reports the first break it finds.

This is why the project is **tamper-evident**: it is designed to detect unauthorized changes to the protected audit history.

---

## How hashing works

The project uses **HMAC-SHA256**.

At a high level, an entry hash is calculated from:

```text
HMAC-SHA256(
    secret,
    previousHash + canonicalizedCurrentEntry
)
```

The important event fields are placed into a fixed hash payload, and metadata objects are canonicalized so that JSON key ordering does not change the result.

The first entry uses a configured `GENESIS_HASH` instead of a previous audit entry.

During verification, the service recalculates the expected hashes and compares them with the stored values.

---

## What the project can do

### 1. Register applications

A dashboard user can create an application and receive an API key.

```text
Create app
   ↓
Generate als_... API key
   ↓
Store only the key digest
   ↓
Show the raw key once
```

The raw API key is returned only when the key is created or rotated. It is not returned by normal application listing.

Applications can also be:

- viewed
- rotated to a new API key
- deactivated without deleting their audit history
- inspected through the App Details modal

### 2. Ingest audit events

A client application sends an event to:

```http
POST /v1/events
```

Example:

```json
{
  "actorId": "user_101",
  "actorType": "user",
  "action": "document.deleted",
  "resourceId": "document_123",
  "resourceType": "document",
  "metadata": {
    "reason": "user_request"
  }
}
```

The API authenticates the application's API key, validates the request, creates the next sequence number, calculates the hash, and stores the event in PostgreSQL.

The ingestion path uses **Serializable transactions** and an optional **idempotency key** so concurrent writes and retries can be handled safely.

### 3. Search audit events

Events can be searched by fields such as:

- actor
- action
- resource
- actor type
- resource type
- date range

The search endpoint is:

```http
GET /v1/events
```

The API intentionally does not expose the internal `entryHash` and `previousHash` fields in normal event search results.

### 4. Resource activity feed

For a particular resource, the service can return its recent activity:

```http
GET /v1/events/activity/:resourceId
```

Redis is used as a fast cache for this recent-activity feed, with PostgreSQL as the fallback source.

### 5. Verify the audit chain

Verification is intentionally asynchronous because checking a long chain can be expensive.

```text
POST /v1/verify
        ↓
Create verification job
        ↓
BullMQ queue
        ↓
Verification worker
        ↓
Read PostgreSQL chain
        ↓
Recalculate hashes
        ↓
Save result
```

The client then polls:

```http
GET /v1/verify/:jobId
```

A successful verification reports that the chain is valid.

If tampering is detected, the result reports `valid: false` and identifies the affected entry/sequence where the first break was found.

The project also prevents multiple verification jobs from running concurrently for the same application using a Redis active-job sentinel.

### 6. Export audit logs

Filtered audit data can be exported as:

```text
CSV
JSON
```

Endpoint:

```http
GET /v1/export?format=csv
GET /v1/export?format=json
```

CSV output includes protection against spreadsheet formula injection, while JSON exports have a configurable row limit.

### 7. Dashboard authentication

The dashboard uses **GitHub OAuth through NextAuth**.

The GitHub user ID becomes the owner identity for the applications created from that dashboard account.

The browser does not receive the backend's internal dashboard credential. Server-side dashboard code uses the internal credential when it calls protected backend routes.

---

## Architecture

The deployed system currently looks like this:

```text
                         ┌──────────────────────────────┐
                         │          Vercel              │
                         │                              │
                         │  Next.js Dashboard           │
                         │  + NextAuth / GitHub OAuth   │
                         └──────────────┬───────────────┘
                                        │
                                        │ HTTPS
                                        ▼
                         ┌──────────────────────────────┐
                         │          AWS EC2              │
                         │                              │
                         │  Caddy / HTTPS               │
                         │        │                     │
                         │        ▼                     │
                         │  Express API :3000           │
                         │      │          │             │
                         │      │          └─────────┐   │
                         │      ▼                    ▼   │
                         │  PostgreSQL             Redis │
                         │                           │   │
                         │                           ▼   │
                         │                    BullMQ worker│
                         └──────────────────────────────┘
```

For deployment, PostgreSQL, Redis, the API, and the verification worker run as separate Docker services on the EC2 instance.

The database and Redis ports are kept private to the Docker network. Caddy is responsible for HTTPS at the public edge and proxies requests to the API.

---

## Deployment

The current deployment uses a small, single-server setup:

- **Vercel:** hosts the Next.js dashboard.
- **AWS EC2:** hosts the Express API, BullMQ worker, PostgreSQL, and Redis as Docker services.
- **Caddy:** sits in front of the API and provides HTTPS.

The production containers communicate over the private Docker network. PostgreSQL and Redis are not exposed directly to the public internet.

The deployment does not require RDS, ElastiCache, ECS, Kubernetes, or a separate Vercel database. Those services could be introduced later if the system needed more scale or operational separation.

---

## Authentication model

There are two different credentials in the system.

### Client application API key

Used by applications that send or query audit events.

Format:

```text
Authorization: Bearer als_...
```

The raw key is not stored directly. The backend stores an HMAC-SHA256 digest of the key.

### Dashboard internal credential

Used only for server-to-server communication between the Next.js dashboard and the Express API.

The dashboard sends:

```text
Authorization: Bearer <INTERNAL_API_KEY>
x-owner-id: <GitHub user ID>
```

and, for app-scoped operations such as verification/export, also sends the application ID.

The internal credential is never meant to be exposed to the browser.

---

## API overview

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/health` | Check PostgreSQL and Redis connectivity |
| GET | `/v1/apps` | List active applications for the signed-in dashboard owner |
| POST | `/v1/apps` | Register an application and issue its API key once |
| POST | `/v1/apps/:id/rotate-key` | Rotate an application's API key |
| DELETE | `/v1/apps/:id` | Deactivate an application while preserving its history |
| POST | `/v1/events` | Create an audit event |
| GET | `/v1/events` | Search audit events |
| GET | `/v1/events/activity/:resourceId` | Read recent activity for a resource |
| POST | `/v1/verify` | Start asynchronous chain verification |
| GET | `/v1/verify/:jobId` | Poll a verification job |
| GET | `/v1/export` | Export filtered audit events as CSV or JSON |

---

## Technology stack

| Technology | Role |
|---|---|
| Node.js 20+ | Backend runtime |
| Express | REST API |
| TypeScript | Backend type safety |
| PostgreSQL 15 | Persistent data store |
| Prisma | Database access and migrations |
| Redis 7 | Cache, job state, and BullMQ backend |
| ioredis | Redis client |
| BullMQ | Durable verification queue |
| Zod | Runtime request validation |
| HMAC-SHA256 | Hash-chain integrity and API-key digests |
| Next.js | Dashboard frontend and server-side proxy routes |
| NextAuth | GitHub OAuth |
| Winston | Structured application logging |
| Jest + Supertest | Backend unit/integration testing |
| Docker + Docker Compose | Local and EC2 container orchestration |
| Caddy | HTTPS reverse proxy |
| GitHub Actions | CI validation |
| Vercel | Dashboard hosting |
| AWS EC2 | API, worker, PostgreSQL, and Redis host |

---

## Run locally

### Prerequisites

Install:

- Node.js 20 or newer
- Docker Desktop / Docker Engine
- Git

### 1. Clone the repository

```bash
git clone <YOUR_REPOSITORY_URL>
cd AuditLog-Service
```

### 2. Create the environment file

```bash
cp .env.example .env
```

Fill in the required values in `.env`.

At minimum, the backend requires:

```text
DATABASE_URL
REDIS_HOST
REDIS_PORT
CORS_ORIGINS
HASH_SECRET
GENESIS_HASH
INTERNAL_API_KEY
```

The dashboard also needs its NextAuth and GitHub OAuth configuration.

### 3. Start PostgreSQL, Redis, API, and worker

```bash
docker compose up -d --build
```

Check the services:

```bash
docker compose ps
```

### 4. Apply Prisma migrations

```bash
docker compose exec api npx prisma migrate deploy
```

### 5. Check the API

```bash
curl http://localhost:3000/health
```

Expected result:

```json
{
  "status": "ok",
  "dependencies": {
    "postgresql": "connected",
    "redis": "connected"
  }
}
```

### 6. Run the dashboard

Open a second terminal:

```bash
cd dashboard
npm ci
npm run dev
```

Then open the local dashboard URL shown by Next.js (the project normally uses port `3001`).


## Environment variables

The project uses environment variables for database access, Redis, cryptographic secrets, dashboard authentication, and deployment URLs. The repository's `.env.example` is the reference list; never commit a real `.env` file.

### Backend

The backend requires:

```text
DATABASE_URL
REDIS_HOST
REDIS_PORT
CORS_ORIGINS
HASH_SECRET
GENESIS_HASH
INTERNAL_API_KEY
```

Optional configuration covers rate limits, Redis cache TTLs, verification-job settings, JSON export limits, and Brevo alerting.

### Dashboard

The Next.js dashboard uses:

```text
API_URL
NEXT_PUBLIC_API_URL
INTERNAL_API_KEY
NEXTAUTH_URL
NEXTAUTH_SECRET
GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET
```

`API_URL` is used by server-side dashboard code. `NEXT_PUBLIC_API_URL` is safe to expose to browser-side code because it contains only the public API address. `INTERNAL_API_KEY` must remain server-side and should never be put in a `NEXT_PUBLIC_*` variable.

In the deployed setup, PostgreSQL and Redis remain on EC2; they are not separate Vercel services. Vercel hosts the Next.js dashboard and talks to the backend API.

---

## Useful local commands

### Start backend stack

```bash
docker compose up -d
```

### Rebuild backend containers

```bash
docker compose up -d --build
```

### Stop containers

```bash
docker compose down
```

### Stop containers and erase local PostgreSQL/Redis data

```bash
docker compose down -v --remove-orphans
```

> Use the `-v` version only when you intentionally want to delete the local database and Redis volumes.

### View logs

```bash
docker compose logs -f api

docker compose logs -f worker
```

### Start the verification worker manually

```bash
npm run worker
```

### Run backend tests

```bash
npm test -- --runInBand
```

### Backend validation

```bash
npm run lint
npm run typecheck
npm run build
```

### Dashboard validation

```bash
cd dashboard
npm run typecheck
npm run build
```

---

## Example: sending an audit event

Once you have an application API key:

```bash
curl -X POST http://localhost:3000/v1/events \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "actorId": "user_101",
    "actorType": "user",
    "action": "document.deleted",
    "resourceId": "document_123",
    "resourceType": "document",
    "metadata": {
      "reason": "user_request"
    }
  }'
```

A successful response includes the new entry ID, sequence number, entry hash, and creation timestamp.

For a client retry, provide an `idempotencyKey` so the same logical request can be recognized instead of creating another event.

---

## Example workflow

A typical user journey looks like this:

```text
1. Sign in with GitHub
          ↓
2. Create an application
          ↓
3. Copy the API key shown once
          ↓
4. Configure the client application to use the key
          ↓
5. POST audit events
          ↓
6. View/search events in the dashboard
          ↓
7. Start verification
          ↓
8. BullMQ worker verifies the chain
          ↓
9. See whether the chain is valid or tampered
          ↓
10. Export the audit history
```

---

## Project structure

```text
audit-log-service/
├── src/
│   ├── config/             # Database, Redis, logging, environment validation
│   ├── middleware/         # Authentication, validation, errors, rate limiting
│   ├── routes/             # Apps, events, search, verification, export, health
│   ├── services/           # Hash chain, activity cache, analytics, alerts
│   ├── types/              # TypeScript types and Zod schemas
│   └── app.ts              # Express application setup
│
├── dashboard/              # Next.js dashboard
│   ├── app/                # Pages and dashboard API proxy routes
│   └── components/         # Dashboard UI components
│
├── prisma/
│   ├── schema.prisma       # Database schema
│   └── migrations/         # Database migrations
│
├── tests/                  # Backend tests
├── mock/                   # Sample event producer
├── scripts/                # One-time migration helpers
├── Dockerfile              # Production API/worker image
├── docker-compose.yml      # Local multi-service stack
├── docker-compose.prod.yml # EC2 production stack
└── .github/workflows/      # CI workflow
```

---

## Security notes

- Raw application API keys are shown only once at creation/rotation.
- Stored application keys are HMAC digests rather than plaintext credentials.
- Dashboard internal credentials are server-side only.
- Protected dashboard operations are scoped to the signed-in GitHub owner and selected application.
- PostgreSQL rejects normal audit-log `UPDATE`/`DELETE` operations through an append-only trigger.
- API inputs are validated with Zod.
- Event ingestion uses idempotency support and Serializable transactions.
- PostgreSQL and Redis are private to the Docker network in the production Compose setup.
- The public API is placed behind HTTPS in the deployed environment.

A useful distinction: the system is **tamper-evident**, not a claim that a sufficiently privileged infrastructure operator can never bypass every layer of protection.

---

## Testing the tamper detection feature

The repository includes tests for hash-chain behavior, and the deployed system has also been manually tested by changing an audit entry in a controlled database test and running verification.

Conceptually:

```text
Create several audit entries
        ↓
Temporarily bypass the append-only trigger for a controlled test
        ↓
Change protected audit data
        ↓
Restore the trigger
        ↓
Run verification
        ↓
valid: false
        ↓
Identify the first broken entry
```

Do not perform this against data you need to preserve. The trigger bypass is only for controlled testing.

---

## License

Add the repository's chosen license here if/when one is selected.
