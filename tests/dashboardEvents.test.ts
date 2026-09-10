import request from 'supertest';
import app from '../src/app';
import prisma from '../src/config/db';
import { clearApiKeyCache } from '../src/middleware/auth';
import redis from '../src/config/redis';
import { hashApiKey } from '../src/services/apiKey';

describe('dashboard owner-scoped event reads', () => {
  const internalApiKey = process.env.INTERNAL_API_KEY!;
  const ownerA = 'dashboard-owner-a';
  const ownerB = 'dashboard-owner-b';
  const keyA = 'dashboard-events-key-a';
  const keyB = 'dashboard-events-key-b';
  let appA = '';
  let appB = '';

  function dashboardHeaders(ownerId: string, appId?: string) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${internalApiKey}`,
      'x-owner-id': ownerId
    };
    if (appId !== undefined) headers['x-app-id'] = appId;
    return headers;
  }

  beforeEach(async () => {
    await clearApiKeyCache(keyA);
    await clearApiKeyCache(keyB);
    await prisma.$executeRawUnsafe('ALTER TABLE audit_logs DISABLE TRIGGER audit_log_immutable').catch(() => undefined);
    await prisma.auditLog.deleteMany({});
    await prisma.app.deleteMany({});
    await prisma.$executeRawUnsafe('ALTER TABLE audit_logs ENABLE TRIGGER audit_log_immutable').catch(() => undefined);

    const createdA = await prisma.app.create({
      data: { name: 'Dashboard App A', ownerId: ownerA, apiKey: hashApiKey(keyA) }
    });
    const createdB = await prisma.app.create({
      data: { name: 'Dashboard App B', ownerId: ownerB, apiKey: hashApiKey(keyB) }
    });
    appA = createdA.id;
    appB = createdB.id;

    await request(app).post('/v1/events').set('Authorization', `Bearer ${keyA}`).send({
      actorId: 'alice', actorType: 'user', action: 'invoice.created',
      resourceId: 'invoice_1', resourceType: 'invoice'
    });
    await request(app).post('/v1/events').set('Authorization', `Bearer ${keyB}`).send({
      actorId: 'bob', actorType: 'user', action: 'invoice.deleted',
      resourceId: 'invoice_9', resourceType: 'invoice'
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await redis.quit();
  });

  it('lets owner A read events for owned app A', async () => {
    const response = await request(app)
      .get('/v1/events')
      .set(dashboardHeaders(ownerA, appA));

    expect(response.status).toBe(200);
    expect(response.body.data.events).toHaveLength(1);
    expect(response.body.data.events[0].actorId).toBe('alice');
    expect(response.body.data.pagination.total).toBe(1);
  });

  it('rejects owner A reading app B owned by owner B', async () => {
    const response = await request(app)
      .get('/v1/events')
      .set(dashboardHeaders(ownerA, appB));

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('APP_ACCESS_DENIED');
  });

  it('rejects a random app ID that the owner does not own', async () => {
    const response = await request(app)
      .get('/v1/events')
      .set(dashboardHeaders(ownerA, '00000000-0000-4000-8000-000000000000'));

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('APP_ACCESS_DENIED');
  });

  it('rejects dashboard credentials without an app context', async () => {
    const response = await request(app)
      .get('/v1/events')
      .set(dashboardHeaders(ownerA));

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('DASHBOARD_AUTH_REQUIRED');
  });

  it('keeps customer API-key reads working and isolated per app', async () => {
    const responseA = await request(app)
      .get('/v1/events')
      .set('Authorization', `Bearer ${keyA}`);

    expect(responseA.status).toBe(200);
    expect(responseA.body.data.events).toHaveLength(1);
    expect(responseA.body.data.events[0].actorId).toBe('alice');
  });

  it('applies search filters under dashboard credentials', async () => {
    const match = await request(app)
      .get('/v1/events?action=invoice.created')
      .set(dashboardHeaders(ownerA, appA));
    const miss = await request(app)
      .get('/v1/events?action=invoice.deleted')
      .set(dashboardHeaders(ownerA, appA));

    expect(match.status).toBe(200);
    expect(match.body.data.events).toHaveLength(1);
    expect(miss.status).toBe(200);
    expect(miss.body.data.events).toHaveLength(0);
  });

  it('serves the activity feed under dashboard credentials with the same ownership rules', async () => {
    const allowed = await request(app)
      .get('/v1/events/activity/invoice_1')
      .set(dashboardHeaders(ownerA, appA));
    const denied = await request(app)
      .get('/v1/events/activity/invoice_1')
      .set(dashboardHeaders(ownerB, appB));

    expect(allowed.status).toBe(200);
    expect(allowed.body.data.resourceId).toBe('invoice_1');
    // Same resource under another owner's app scope exposes nothing of app A.
    expect(denied.status).toBe(200);
    expect(denied.body.data.events).toHaveLength(0);
  });
});
