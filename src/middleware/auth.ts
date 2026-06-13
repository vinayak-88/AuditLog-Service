import type { NextFunction, Request, Response } from 'express';
import prisma from '../config/db';
import logger from '../config/logger';
import redis from '../config/redis';

const API_KEY_CACHE_TTL_SECONDS = Number.parseInt(process.env.API_KEY_CACHE_TTL_SECONDS || '600', 10);
const SHOULD_USE_API_KEY_CACHE =
  process.env.NODE_ENV !== 'test' || process.env.ENABLE_API_KEY_CACHE_IN_TESTS === 'true';

function getApiKeyCacheKey(apiKey: string): string {
  return `apikey:${apiKey}`;
}

export async function clearApiKeyCache(apiKey: string): Promise<void> {
  try {
    await redis.del(getApiKeyCacheKey(apiKey));
  } catch (err) {
    logger.warn({ message: 'Unable to clear Redis API key cache', error: err });
  }
}

export async function apiKeyAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;

  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      error: { message: 'Missing API key', code: 'MISSING_API_KEY', statusCode: 401 }
    });
  }

  const apiKey = header.slice('Bearer '.length).trim();
  const cacheKey = getApiKeyCacheKey(apiKey);

  if (SHOULD_USE_API_KEY_CACHE) {
    try {
      const cached = await redis.get(cacheKey);

      if (cached) {
        const app = JSON.parse(cached);
        if (!app?.id || !app?.apiKey || !app?.ownerId) {
          logger.warn({
            message: 'Corrupt or incomplete API key cache entry - evicting and falling back to PostgreSQL',
            cacheKey
          });
          await redis.del(cacheKey).catch(() => {});
        } else {
          req.auditApp = {
            ...app,
            createdAt: new Date(app.createdAt),
            updatedAt: new Date(app.updatedAt)
          };
          return next();
        }
      }
    } catch (err) {
      logger.warn({ message: 'Unable to read Redis API key cache; falling back to PostgreSQL', error: err });
    }
  }

  const app = await prisma.app.findFirst({
    where: { apiKey, isActive: true }
  });

  if (!app) {
    return res.status(401).json({
      success: false,
      error: { message: 'Invalid API key', code: 'INVALID_API_KEY', statusCode: 401 }
    });
  }

  if (SHOULD_USE_API_KEY_CACHE) {
    try {
      await redis.set(cacheKey, JSON.stringify(app), 'EX', API_KEY_CACHE_TTL_SECONDS);
    } catch (err) {
      logger.warn({ message: 'Unable to write Redis API key cache', error: err });
    }
  }

  req.auditApp = app;
  return next();
}

/*
 * CHANGED: getDashboardOwnerId — removed the implicit non-production backdoor.
 *
 * BEFORE (broken):
 *   if (process.env.NODE_ENV !== 'production') {
 *     return 'dashboard-dev-user';
 *   }
 *
 *   This meant: any environment that is not explicitly NODE_ENV=production gives
 *   unauthenticated callers full dashboard access. In practice that includes:
 *     - Staging (NODE_ENV=staging or NODE_ENV=development)
 *     - Any Railway service where NODE_ENV was never set (defaults to undefined)
 *     - Any local dev clone that forgot to set NODE_ENV=production before an
 *       accidental deploy
 *
 *   The condition "not production" is not the same as "safe to open up". The
 *   correct mental model is: "have I explicitly opted into dev access?" not
 *   "have I not explicitly opted into production mode?"
 *
 * AFTER (fixed):
 *   Two conditions must BOTH be true for the dev fallback to activate:
 *     1. ALLOW_DASHBOARD_DEV_AUTH=true must be set in the environment.
 *        This is an explicit, conscious action — a missing env var defaults to
 *        "closed", not "open".
 *     2. NODE_ENV must not be 'production', as a second line of defence.
 *        If both flags are somehow set in production, we still deny.
 *
 *   This is defence in depth. A staging deploy that forgets ALLOW_DASHBOARD_DEV_AUTH
 *   fails closed. A staging deploy that sets NODE_ENV=production but forgets
 *   ALLOW_DASHBOARD_DEV_AUTH also fails closed. Both flags have to be wrong
 *   simultaneously for the backdoor to open, which is much harder to do by accident.
 *
 * WHAT TO ADD TO .env.example:
 *   # Set to 'true' only in local development to bypass dashboard auth.
 *   # NEVER set this in staging or production.
 *   # ALLOW_DASHBOARD_DEV_AUTH=true
 *
 * The internal API key path (first branch) is unchanged — it was already correct.
 */
export function getDashboardOwnerId(req: Request): string | null {
  const header = req.headers.authorization;
  const internalKey = process.env.INTERNAL_API_KEY;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : null;

  /*
   * First priority: a valid INTERNAL_API_KEY was presented.
   * This is the production path — the Next.js dashboard sends this key.
   * The x-owner-id / x-user-id headers identify which user's apps to scope to.
   */
  if (internalKey && token === internalKey) {
    return req.header('x-owner-id') ?? req.header('x-user-id') ?? 'dashboard-dev-user';
  }

  /*
   * Second priority: explicit dev-only opt-in.
   *
   * Both conditions must be true. If either is missing or wrong, we fall through
   * and return null (which causes requireOwnerId() in apps.ts to throw 401).
   *
   * ALLOW_DASHBOARD_DEV_AUTH is intentionally not prefixed with NEXT_PUBLIC_
   * because it must never appear in client-side bundles.
   */
  const devAuthEnabled = process.env.ALLOW_DASHBOARD_DEV_AUTH === 'true';
  const isNonProduction = process.env.NODE_ENV !== 'production';

  if (devAuthEnabled && isNonProduction) {
    logger.warn({
      message: 'Dashboard dev auth bypass active — ALLOW_DASHBOARD_DEV_AUTH=true should never be set in production'
    });
    return 'dashboard-dev-user';
  }

  return null;
}
