import { createHash } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import prisma from '../config/db';
import logger from '../config/logger';
import redis from '../config/redis';

const API_KEY_CACHE_TTL_SECONDS = Number.parseInt(process.env.API_KEY_CACHE_TTL_SECONDS || '600', 10);

function hashKeyForCache(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

function getApiKeyCacheKey(apiKey: string): string {
  return `apikey:${hashKeyForCache(apiKey)}`;
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

  const app = await prisma.app.findFirst({
    where: { apiKey, isActive: true }
  });

  if (!app) {
    return res.status(401).json({
      success: false,
      error: { message: 'Invalid API key', code: 'INVALID_API_KEY', statusCode: 401 }
    });
  }

  try {
    await redis.set(cacheKey, JSON.stringify(app), 'EX', API_KEY_CACHE_TTL_SECONDS);
  } catch (err) {
    logger.warn({ message: 'Unable to write Redis API key cache', error: err });
  }

  req.auditApp = app;
  return next();
}

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
    const ownerId = req.header('x-owner-id') ?? req.header('x-user-id') ?? null;
    if (!ownerId) {
      logger.warn({
        message: 'INTERNAL_API_KEY authenticated request missing x-owner-id and x-user-id headers - rejecting'
      });
    }
    return ownerId;
  }

  return null;
}
