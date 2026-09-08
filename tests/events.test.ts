import request from 'supertest';
import app from '../src/app';
import prisma from '../src/config/db';
import { GENESIS_HASH } from '../src/services/hashChain';
import { clearApiKeyCache } from '../src/middleware/auth';
import redis from '../src/config/redis';
import { hashApiKey } from '../src/services/apiKey';

describe('POST /events', () => {
  const apiKey = 'events-test-key';

  beforeEach(async () => {
    await clearApiKeyCache(apiKey);
    await prisma.$executeRawUnsafe('ALTER TABLE audit_logs DISABLE TRIGGER audit_log_immutable').catch(() => undefined);
    await prisma.auditLog.deleteMany({});
    await prisma.app.deleteMany({});
    await prisma.$executeRawUnsafe('ALTER TABLE audit_logs ENABLE TRIGGER audit_log_immutable').catch(() => undefined);
    await prisma.app.create({
      data: { name: 'Events Test App', ownerId: 'owner_1', apiKey: hashApiKey(apiKey) }
    });
  });

  afterAll(async () => {
  await prisma.$disconnect();
  await redis.quit();
});

  it('accepts a valid event and creates the first chain link', async () => {
    const response = await request(app)
      .post('/v1/events')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({
        actorId: 'user_123',
        actorType: 'user',
        action: 'invoice.deleted',
        resourceId: 'invoice_456',
        resourceType: 'invoice',
        metadata: { reason: 'duplicate' },
        ipAddress: '192.168.1.1'
      });

    expect(response.status).toBe(201);
    expect(response.body.data.sequenceNumber).toBe(1);

    const entry = await prisma.auditLog.findFirstOrThrow();
    expect(entry.previousHash).toBe(GENESIS_HASH);
  });

  it('rejects missing API keys', async () => {
    const response = await request(app).post('/v1/events').send({});

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('MISSING_API_KEY');
  });

  it('rejects invalid payloads', async () => {
    const response = await request(app)
      .post('/v1/events')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ actorId: 'user_123' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('increments sequence numbers per app', async () => {
    const payload = {
      actorId: 'user_123',
      actorType: 'user',
      action: 'invoice.updated',
      resourceId: 'invoice_456',
      resourceType: 'invoice'
    };

    await request(app).post('/v1/events').set('Authorization', `Bearer ${apiKey}`).send(payload);
    const response = await request(app).post('/v1/events').set('Authorization', `Bearer ${apiKey}`).send(payload);

    expect(response.status).toBe(201);
    expect(response.body.data.sequenceNumber).toBe(2);
  });
});
