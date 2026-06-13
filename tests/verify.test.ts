import request from 'supertest';
import app from '../src/app';
import prisma from '../src/config/db';

describe('GET /verify', () => {
  const apiKey = 'verify-test-key';

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('ALTER TABLE audit_logs DISABLE TRIGGER audit_log_immutable').catch(() => undefined);
    await prisma.auditLog.deleteMany({});
    await prisma.app.deleteMany({});
    await prisma.$executeRawUnsafe('ALTER TABLE audit_logs ENABLE TRIGGER audit_log_immutable').catch(() => undefined);
    await prisma.app.create({
      data: { name: 'Verify Test App', ownerId: 'owner_1', apiKey }
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('returns valid for an unmodified chain', async () => {
    const eventResponse = await request(app).post('/events').set('Authorization', `Bearer ${apiKey}`).send({
      actorId: 'admin_1',
      actorType: 'admin',
      action: 'user.disabled',
      resourceId: 'user_1',
      resourceType: 'user'
    });
    expect(eventResponse.status).toBe(201);

    const response = await request(app).get('/verify').set('Authorization', `Bearer ${apiKey}`);

    expect(response.status).toBe(200);
    expect(response.body.data.valid).toBe(true);
    expect(response.body.data.entriesChecked).toBe(1);
  });

  it('returns 401 for invalid API keys', async () => {
    const response = await request(app).get('/verify').set('Authorization', 'Bearer nope');

    expect(response.status).toBe(401);
  });

  it('detects tampering after events are changed through raw SQL', async () => {
    const payloads = [1, 2, 3].map((sequence) => ({
      actorId: `admin_${sequence}`,
      actorType: 'admin',
      action: 'user.updated',
      resourceId: `user_${sequence}`,
      resourceType: 'user',
      metadata: { sequence }
    }));

    for (const payload of payloads) {
      const response = await request(app).post('/events').set('Authorization', `Bearer ${apiKey}`).send(payload);
      expect(response.status).toBe(201);
    }

    await prisma.$executeRawUnsafe('ALTER TABLE audit_logs DISABLE TRIGGER audit_log_immutable');
    try {
      await prisma.auditLog.updateMany({
        where: { sequenceNumber: 2 },
        data: { metadata: { sequence: 200 } }
      });
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE audit_logs ENABLE TRIGGER audit_log_immutable');
    }

    const response = await request(app).get('/verify').set('Authorization', `Bearer ${apiKey}`);

    expect(response.status).toBe(200);
    expect(response.body.data.valid).toBe(false);
    expect(response.body.data.entriesChecked).toBe(2);
    expect(response.body.data.tamperedAt.sequenceNumber).toBe(2);
  });
});
