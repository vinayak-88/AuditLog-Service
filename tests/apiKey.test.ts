import request from 'supertest';
import app from '../src/app';
import prisma from '../src/config/db';
import redis from '../src/config/redis';
import { clearApiKeyCache, getApiKeyCacheKey } from '../src/middleware/auth';
import { hashApiKey } from '../src/services/apiKey';

const internalApiKey = process.env.INTERNAL_API_KEY!;
const ownerId = 'api-key-test-owner';

const eventPayload = {
  actorId: 'user_1',
  actorType: 'user',
  action: 'invoice.created',
  resourceId: 'invoice_1',
  resourceType: 'invoice'
};

describe('API-key security', () => {
  beforeEach(async () => {
    await prisma.$executeRawUnsafe('ALTER TABLE audit_logs DISABLE TRIGGER audit_log_immutable').catch(() => undefined);
    await prisma.auditLog.deleteMany({});
    await prisma.app.deleteMany({});
    await prisma.$executeRawUnsafe('ALTER TABLE audit_logs ENABLE TRIGGER audit_log_immutable').catch(() => undefined);
  });

  afterAll(async () => {
    await redis.quit();
    await prisma.$disconnect();
  });

  it('stores only a digest and authenticates a created key through the cache', async () => {
    const createResponse = await request(app)
      .post('/v1/apps')
      .set('Authorization', `Bearer ${internalApiKey}`)
      .set('x-owner-id', ownerId)
      .send({ name: 'Secure API Key App' });

    expect(createResponse.status).toBe(201);
    const rawApiKey = createResponse.body.data.apiKey as string;
    const appId = createResponse.body.data.id as string;
    const storedApp = await prisma.app.findUniqueOrThrow({ where: { id: appId } });

    expect(storedApp.apiKey).toBe(hashApiKey(rawApiKey));
    expect(storedApp.apiKey).not.toBe(rawApiKey);

    const eventResponse = await request(app)
      .post('/v1/events')
      .set('Authorization', `Bearer ${rawApiKey}`)
      .send(eventPayload);

    expect(eventResponse.status).toBe(201);

    const cached = await redis.get(getApiKeyCacheKey(rawApiKey));
    expect(cached).not.toBeNull();
    expect(cached).not.toContain(rawApiKey);
    expect(JSON.parse(cached!)).toMatchObject({ id: appId, ownerId, isActive: true });
    expect(JSON.parse(cached!)).not.toHaveProperty('apiKey');

    const cacheHitResponse = await request(app)
      .post('/v1/events')
      .set('Authorization', `Bearer ${rawApiKey}`)
      .send({ ...eventPayload, action: 'invoice.updated' });

    expect(cacheHitResponse.status).toBe(201);
  });

  it('rejects invalid API keys with the existing 401 contract', async () => {
    const response = await request(app)
      .post('/v1/events')
      .set('Authorization', 'Bearer invalid-key')
      .send(eventPayload);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('INVALID_API_KEY');
  });

  it('invalidates old keys on rotation and active keys on deactivation', async () => {
    const createResponse = await request(app)
      .post('/v1/apps')
      .set('Authorization', `Bearer ${internalApiKey}`)
      .set('x-owner-id', ownerId)
      .send({ name: 'Lifecycle API Key App' });

    const appId = createResponse.body.data.id as string;
    const originalApiKey = createResponse.body.data.apiKey as string;

    expect(
      (await request(app)
        .post('/v1/events')
        .set('Authorization', `Bearer ${originalApiKey}`)
        .send(eventPayload)).status
    ).toBe(201);

    const rotateResponse = await request(app)
      .post(`/v1/apps/${appId}/rotate-key`)
      .set('Authorization', `Bearer ${internalApiKey}`)
      .set('x-owner-id', ownerId);

    expect(rotateResponse.status).toBe(200);
    const rotatedApiKey = rotateResponse.body.data.newApiKey as string;
    expect(rotatedApiKey).not.toBe(originalApiKey);

    expect(
      (await request(app)
        .post('/v1/events')
        .set('Authorization', `Bearer ${originalApiKey}`)
        .send(eventPayload)).status
    ).toBe(401);

    expect(
      (await request(app)
        .post('/v1/events')
        .set('Authorization', `Bearer ${rotatedApiKey}`)
        .send({ ...eventPayload, action: 'invoice.rotated' })).status
    ).toBe(201);

    const deleteResponse = await request(app)
      .delete(`/v1/apps/${appId}`)
      .set('Authorization', `Bearer ${internalApiKey}`)
      .set('x-owner-id', ownerId);

    expect(deleteResponse.status).toBe(204);
    expect(
      (await request(app)
        .post('/v1/events')
        .set('Authorization', `Bearer ${rotatedApiKey}`)
        .send({ ...eventPayload, action: 'invoice.revoked' })).status
    ).toBe(401);
    expect(await redis.get(getApiKeyCacheKey(rotatedApiKey))).toBeNull();
  });
});
