import { cacheActivityEntry, getActivityFeed } from '../src/services/activityCache';
import prisma from '../src/config/db';
import redis from '../src/config/redis';

describe('activity cache', () => {
  afterAll(async () => {
    redis.disconnect();
    await prisma.$disconnect();
  });

  it('can cache and retrieve recent activity from Redis when available', async () => {
    try {
      await redis.ping();
    } catch {
      return;
    }

    await cacheActivityEntry('app_cache_test', {
      id: 'entry_1',
      actorId: 'user_1',
      actorType: 'user',
      action: 'invoice.viewed',
      resourceId: 'invoice_1',
      resourceType: 'invoice',
      metadata: null,
      createdAt: new Date().toISOString()
    });

    const result = await getActivityFeed('app_cache_test', 'invoice_1', 10);

    expect(result.source).toBe('cache');
    expect(result.entries[0].id).toBe('entry_1');
  });
});
