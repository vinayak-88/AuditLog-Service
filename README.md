# Audit Log Service

Tamper-evident audit trail service with an Express API, Prisma/PostgreSQL storage, Redis activity caching, HMAC-SHA256 hash chaining, and a Next.js dashboard.

## Single-Environment Operation

The project has one runtime configuration. Use the same `.env` contract locally
and in deployment; only the actual service URLs and secrets change.

For a local run:

```bash
copy .env.example .env
docker compose up -d
npm ci
npm run prisma:generate
npm run prisma:migrate
npm run api-keys:migrate
npm run build
npm start
```

Run `npm run api-keys:migrate` once during rollout if the database contains
applications created before API-key digest storage was enabled. It converts
legacy stored keys in memory and does not print or return them.

The API requires `DATABASE_URL`, `REDIS_HOST`, `REDIS_PORT`, `CORS_ORIGINS`,
`HASH_SECRET`, `GENESIS_HASH`, and `INTERNAL_API_KEY`.

API deployment commands:

```bash
npm ci
npm run prisma:generate
npm run prisma:migrate
npm run build
npm start
```

Dashboard deployment commands, run from `dashboard/`:

```bash
npm ci
npm run build
npm start
```

## Core API

- `POST /v1/apps` registers an app and returns an API key once.
- `POST /v1/events` ingests an audit event and appends it to the hash chain.
- `GET /v1/events` searches events without exposing internal hash fields.
- `GET /v1/events/activity/:resourceId` reads recent activity.
- `POST /v1/verify` starts chain verification; poll `GET /v1/verify/:jobId` for the result.
- `GET /v1/export?format=csv|json` exports filtered events.
- `GET /health` checks PostgreSQL and Redis.

## Operational Verification

```bash
npm run lint
npm run typecheck
npm run build
cd dashboard
npm run typecheck
npm run build
```

The integration test suite requires separately provisioned PostgreSQL and Redis services with credentials supplied by the test runner.
