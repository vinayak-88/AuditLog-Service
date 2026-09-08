import { buildHashPayload, computeEntryHash, GENESIS_HASH, verifyChain } from '../src/services/hashChain';
import prisma from '../src/config/db';
import { randomUUID } from 'crypto';
import { hashApiKey } from '../src/services/apiKey';

describe('hash chain service', () => {
  const appId = randomUUID();

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('computes the same hash for the same input', () => {
    const payload = buildHashPayload({
      appId,
      sequenceNumber: 1,
      actorId: 'user_123',
      actorType: 'user',
      action: 'invoice.deleted',
      resourceId: 'invoice_456',
      resourceType: 'invoice',
      metadata: { reason: 'duplicate' },
      createdAt: new Date('2026-04-24T10:00:00.000Z')
    });

    expect(computeEntryHash(GENESIS_HASH, payload)).toBe(computeEntryHash(GENESIS_HASH, payload));
  });

  it('changes the hash when the previous hash changes', () => {
    const payload = buildHashPayload({
      appId,
      sequenceNumber: 1,
      actorId: 'user_123',
      actorType: 'user',
      action: 'invoice.deleted',
      resourceId: 'invoice_456',
      resourceType: 'invoice',
      metadata: null,
      createdAt: new Date('2026-04-24T10:00:00.000Z')
    });

    expect(computeEntryHash('previous-a', payload)).not.toBe(computeEntryHash('previous-b', payload));
  });

  describe('database verification', () => {
    async function createFiveEntryChain() {
      await prisma.app.create({
        data: { id: appId, name: 'Hash Test App', ownerId: 'owner_1', apiKey: hashApiKey('hash-test-key') }
      });

      let previousHash = GENESIS_HASH;

      for (let sequenceNumber = 1; sequenceNumber <= 5; sequenceNumber += 1) {
        const createdAt = new Date(`2026-04-24T10:00:0${sequenceNumber}.000Z`);
        const metadata = { amount: sequenceNumber * 100 };
        const payload = buildHashPayload({
          appId,
          sequenceNumber,
          actorId: `user_${sequenceNumber}`,
          actorType: 'user',
          action: 'invoice.updated',
          resourceId: `invoice_${sequenceNumber}`,
          resourceType: 'invoice',
          metadata,
          createdAt
        });
        const entryHash = computeEntryHash(previousHash, payload);

        await prisma.auditLog.create({
          data: {
            appId,
            actorId: `user_${sequenceNumber}`,
            actorType: 'user',
            action: 'invoice.updated',
            resourceId: `invoice_${sequenceNumber}`,
            resourceType: 'invoice',
            metadata,
            previousHash,
            entryHash,
            sequenceNumber,
            createdAt
          }
        });

        previousHash = entryHash;
      }
    }

    async function withDisabledImmutability(update: () => Promise<unknown>) {
      await prisma.$executeRawUnsafe('ALTER TABLE audit_logs DISABLE TRIGGER audit_log_immutable');
      try {
        await update();
      } finally {
        await prisma.$executeRawUnsafe('ALTER TABLE audit_logs ENABLE TRIGGER audit_log_immutable');
      }
    }

    beforeEach(async () => {
      await prisma.$executeRawUnsafe('ALTER TABLE audit_logs DISABLE TRIGGER audit_log_immutable').catch(() => undefined);
      await prisma.auditLog.deleteMany({});
      await prisma.app.deleteMany({});
      await prisma.$executeRawUnsafe('ALTER TABLE audit_logs ENABLE TRIGGER audit_log_immutable').catch(() => undefined);
    });

    it('returns valid for an empty chain', async () => {
      await prisma.app.create({
        data: { id: appId, name: 'Hash Test App', ownerId: 'owner_1', apiKey: hashApiKey('hash-test-key') }
      });

      await expect(verifyChain(appId)).resolves.toMatchObject({ valid: true, entriesChecked: 0 });
    });

    it('returns valid for a chain with 5 entries', async () => {
      await createFiveEntryChain();

      await expect(verifyChain(appId)).resolves.toMatchObject({
        valid: true,
        entriesChecked: 5
      });
    });

    it('returns valid when metadata contains objects nested inside arrays', async () => {
      await prisma.app.create({
        data: { id: appId, name: 'Hash Test App', ownerId: 'owner_1', apiKey: hashApiKey('hash-test-key') }
      });

      const createdAt = new Date('2026-04-24T10:00:01.000Z');
      const metadata = { items: [{ b: 1, a: 2 }] };
      const payload = buildHashPayload({
        appId,
        sequenceNumber: 1,
        actorId: 'user_1',
        actorType: 'user',
        action: 'invoice.updated',
        resourceId: 'invoice_1',
        resourceType: 'invoice',
        metadata,
        createdAt
      });
      const entryHash = computeEntryHash(GENESIS_HASH, payload);

      await prisma.auditLog.create({
        data: {
          appId,
          actorId: 'user_1',
          actorType: 'user',
          action: 'invoice.updated',
          resourceId: 'invoice_1',
          resourceType: 'invoice',
          metadata,
          previousHash: GENESIS_HASH,
          entryHash,
          sequenceNumber: 1,
          createdAt
        }
      });

      await expect(verifyChain(appId)).resolves.toMatchObject({
        valid: true,
        entriesChecked: 1
      });
    });

    it('detects a tampered entry 3 of 5 and reports the sequence number', async () => {
      await createFiveEntryChain();

      await withDisabledImmutability(() =>
        prisma.auditLog.updateMany({
          where: { appId, sequenceNumber: 3 },
          data: { action: 'invoice.deleted' }
        })
      );

      await expect(verifyChain(appId)).resolves.toMatchObject({
        valid: false,
        entriesChecked: 3,
        tamperedAt: { sequenceNumber: 3 }
      });
    });

    it('detects a tampered previousHash field', async () => {
      await createFiveEntryChain();

      await withDisabledImmutability(() =>
        prisma.auditLog.updateMany({
          where: { appId, sequenceNumber: 3 },
          data: { previousHash: 'tampered-previous-hash' }
        })
      );

      await expect(verifyChain(appId)).resolves.toMatchObject({
        valid: false,
        entriesChecked: 3,
        tamperedAt: { sequenceNumber: 3 }
      });
    });

    it('detects a tampered metadata field', async () => {
      await createFiveEntryChain();

      await withDisabledImmutability(() =>
        prisma.auditLog.updateMany({
          where: { appId, sequenceNumber: 3 },
          data: { metadata: { amount: 999 } }
        })
      );

      await expect(verifyChain(appId)).resolves.toMatchObject({
        valid: false,
        entriesChecked: 3,
        tamperedAt: { sequenceNumber: 3 }
      });
    });
  });
});
