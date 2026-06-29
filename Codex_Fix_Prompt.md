# Codex Fix Prompt — Round 4

Two fixes. Apply exactly as described. Do not touch any other file or any other part of the two files below.

---

## Fix 1 — `src/middleware/rateLimiter.ts`: `appsRateLimiter` keys on the wrong thing

**Problem:** `appsRateLimiter`'s `keyGenerator` is copy-pasted from `eventsRateLimiter`/`verifyRateLimiter`:

```typescript
keyGenerator: (req) => (req as any).auditApp?.id || req.ip,
```

This works for `eventsRateLimiter` and `verifyRateLimiter` because `apiKeyAuth` runs before those routes, so `req.auditApp` is always populated. It does not work for `appsRateLimiter`, because in `app.ts`, `/v1/apps` is mounted *before* `apiKeyAuth`:

```typescript
app.use('/v1/apps', appsRouter);
app.use(apiKeyAuth);
```

`req.auditApp` is never set for any `/v1/apps` route. `appsRateLimiter` always falls through to `req.ip`. Since every legitimate request to `/v1/apps` comes from the same backend server using one shared `INTERNAL_API_KEY`, every dashboard user shares the same originating IP and therefore the same rate limit bucket. One user's activity can throttle a completely unrelated user.

**What to do:**

Find the `getDashboardOwnerId` export, it's in `src/middleware/auth.ts`. Import it into `rateLimiter.ts`:

```typescript
import { getDashboardOwnerId } from './auth';
```

Replace `appsRateLimiter`'s `keyGenerator` from:

```typescript
keyGenerator: (req) => (req as any).auditApp?.id || req.ip,
```

to:

```typescript
keyGenerator: (req) => getDashboardOwnerId(req) || req.ip,
```

Do not change the `keyGenerator` for `eventsRateLimiter`, `verifyRateLimiter`, `searchRateLimiter`, or `exportRateLimiter`, those are all correct as-is since their routes run after `apiKeyAuth`.

If importing `auth.ts` into `rateLimiter.ts` creates a circular import (check by running the build/typecheck after this change), instead move `getDashboardOwnerId`'s implementation, or a minimal duplicate of just its header-reading logic, into `rateLimiter.ts` directly. Only do this if the circular import is real and confirmed by the build failing, don't restructure preemptively.

---

## Fix 2 — `src/services/analyticsService.ts`: `getTopActors` orders by a field that wasn't selected

**Problem:**

```typescript
_count: { _all: true },
orderBy: { _count: { id: 'desc' } },
take: 10
```

The aggregate selects `_count: { _all: true }` but orders by `_count: { id: 'desc' }`, a field not present in that selection. This may or may not be valid depending on Prisma's validation strictness for `groupBy`, and it should not ship without resolving the ambiguity rather than leaving it as a question mark.

**What to do:**

Replace:

```typescript
orderBy: { _count: { id: 'desc' } },
```

with:

```typescript
orderBy: { _count: { _all: 'desc' } },
```

This matches the `_count: { _all: true }` selection exactly, removing any ambiguity about whether the query is valid. Do not change the `by: ['actorId', 'actorType']` grouping, the `_count: { _all: true }` selection itself, or anything in `getActionBreakdown`, `getEventVolumeByDay`, `getEventsLast24Hours`, or `getTotalEventCount`.

**After making this change, run the actual function once** (a quick script, an existing test, or hitting whatever route calls `getTopActors`) to confirm it returns data without throwing. Don't just trust that the type-check passes, Prisma's `groupBy` validation for this can surface at runtime, not just at compile time.

---

## What NOT to change

- Do not touch `eventsRateLimiter`, `verifyRateLimiter`, `searchRateLimiter`, or `exportRateLimiter` in `rateLimiter.ts`.
- Do not touch `getActionBreakdown`, `getEventVolumeByDay`, `getEventsLast24Hours`, or `getTotalEventCount` in `analyticsService.ts`.
- Do not touch `apps.ts`, `export.ts`, `search.ts`, `index.ts` (types), `.env.example`, or `schema.prisma`. All confirmed correct in the previous round.

---

## Verification checklist

- [ ] `appsRateLimiter`'s `keyGenerator` uses `getDashboardOwnerId(req) || req.ip`, not `req.auditApp?.id`
- [ ] The other four rate limiters are untouched
- [ ] `getTopActors`'s `orderBy` reads `_count: { _all: 'desc' }`
- [ ] `getTopActors` was actually run once after the change and returned data without a Prisma validation error