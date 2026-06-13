# Audit Log Service

Tamper-evident audit trail service with an Express API, Prisma/PostgreSQL storage, Redis activity caching, HMAC-SHA256 hash chaining, and a Next.js dashboard.

## Local Setup

```bash
npm install
cd dashboard && npm install
cd ..
cp .env.example .env
docker compose up -d
npx prisma generate
npx prisma migrate deploy
npm run dev
```

Dashboard:

```bash
cd dashboard
npm run dev
```

API runs on `http://localhost:3000`. Dashboard runs on `http://localhost:3001`.

## Core API

- `POST /apps` registers an app and returns an API key once.
- `POST /events` ingests an audit event and appends it to the hash chain.
- `GET /events` searches events without exposing internal hash fields.
- `GET /events/activity/:resourceId` reads recent activity from Redis with PostgreSQL fallback.
- `GET /verify` recomputes the chain and reports the first tampered sequence.
- `GET /export?format=csv|json` exports filtered events.
- `GET /health` checks PostgreSQL and Redis.

## Verification

```bash
npm run build
cd dashboard && npm run build
```

Integration tests require PostgreSQL running on the `DATABASE_URL` from `.env.example` and migrations applied.
