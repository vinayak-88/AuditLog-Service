import prisma from '../config/db';
import logger from '../config/logger';
import redis from '../config/redis';
import type { ActivityEntry } from '../types';

const MAX_ENTRIES = Number.parseInt(process.env.ACTIVITY_CACHE_MAX_ENTRIES || '50', 10);
const TTL_SECONDS = Number.parseInt(process.env.ACTIVITY_CACHE_TTL_SECONDS || '3600', 10);

function getCacheKey(appId: string, resourceId: string): string {
  return `activity:${appId}:${resourceId}`;
}

export async function cacheActivityEntry(appId: string, entry: ActivityEntry): Promise<void> {
  try {
    const key = getCacheKey(appId, entry.resourceId);
    const score = new Date(entry.createdAt).getTime();
    const member = JSON.stringify(entry);
    const pipeline = redis.pipeline();

    pipeline.zadd(key, score, member);
    pipeline.zremrangebyrank(key, 0, -(MAX_ENTRIES + 1));
    pipeline.expire(key, TTL_SECONDS);

    const results = await pipeline.exec();
    if (results) {
      results.forEach(([err], i) => {
        if (err) {
          logger.warn({
            message: 'Redis activity cache pipeline command failed',
            commandIndex: i,
            error: err.message
          });
        }
      });
    }
  } catch (err) {
    logger.warn({ message: 'Unable to update Redis activity cache', error: err });
  }
}

export async function getActivityFeed(
  appId: string,
  resourceId: string,
  limit = 20
): Promise<{ entries: ActivityEntry[]; source: 'cache' | 'database' }> {
  try {
    const key = getCacheKey(appId, resourceId);
    const members = await redis.zrevrange(key, 0, limit - 1);

    if (members.length > 0) {
      return {
        entries: members.flatMap((member) => {
          try {
            return [JSON.parse(member) as ActivityEntry];
          } catch {
            logger.warn({
              message: 'Malformed Redis activity cache entry - skipping',
              key,
              member
            });
            return [];
          }
        }),
        source: 'cache'
      };
    }
  } catch (err) {
    logger.warn({ message: 'Redis unavailable for activity cache; falling back to PostgreSQL', error: err });
  }

  const logs = await prisma.auditLog.findMany({
    where: { appId, resourceId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      actorId: true,
      actorType: true,
      action: true,
      resourceId: true,
      resourceType: true,
      metadata: true,
      createdAt: true
    }
  });

  const entries = logs.map((log) => ({
    id: log.id,
    actorId: log.actorId,
    actorType: log.actorType,
    action: log.action,
    resourceId: log.resourceId,
    resourceType: log.resourceType,
    metadata: log.metadata as Record<string, unknown> | null,
    createdAt: log.createdAt.toISOString()
  }));

  // Warm Redis cache from PostgreSQL result - best effort.
  Promise.all(entries.map((entry) => cacheActivityEntry(appId, entry))).catch((err) =>
    logger.warn({
      message: 'Failed to warm activity cache from PostgreSQL fallback',
      error: err
    })
  );

  return { entries, source: 'database' };
}

export async function clearActivityCache(appId: string, resourceId: string): Promise<void> {
  try {
    await redis.del(getCacheKey(appId, resourceId));
  } catch (err) {
    logger.warn({ message: 'Unable to clear Redis activity cache', error: err });
  }
}
