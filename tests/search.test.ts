import request from 'supertest';
import app from '../src/app';
import prisma from '../src/config/db';
import { clearApiKeyCache } from '../src/middleware/auth';
import redis from '../src/config/redis';
import { hashApiKey } from '../src/services/apiKey';

describe('GET /events', () => {
  const apiKey = 'search-test-key';

  beforeEach(async () => {
    await clearApiKeyCache(apiKey);
    await prisma.$executeRawUnsafe('ALTER TABLE audit_logs DISABLE TRIGGER audit_log_immutable').catch(() => undefined);
    await prisma.auditLog.deleteMany({});
    await prisma.app.deleteMany({});
    await prisma.$executeRawUnsafe('ALTER TABLE audit_logs ENABLE TRIGGER audit_log_immutable').catch(() => undefined);
    await prisma.app.create({
      data: { name: 'Search Test App', ownerId: 'owner_1', apiKey: hashApiKey(apiKey) }
    });
  });

  afterAll(async () => {
  await prisma.$disconnect();
  await redis.quit();
});

  it('returns filtered events without hash fields', async () => {
    await request(app).post('/v1/events').set('Authorization', `Bearer ${apiKey}`).send({
      actorId: 'user_123',
      actorType: 'user',
      action: 'invoice.deleted',
      resourceId: 'invoice_456',
      resourceType: 'invoice'
    });

    const response = await request(app)
      .get('/v1/events')
      .query({ actorId: 'user_123' })
      .set('Authorization', `Bearer ${apiKey}`);

    expect(response.status).toBe(200);
    expect(response.body.data.events).toHaveLength(1);
    expect(response.body.data.events[0].entryHash).toBeUndefined();
    expect(response.body.data.events[0].previousHash).toBeUndefined();
  });
});
