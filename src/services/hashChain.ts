import { createHmac, timingSafeEqual } from 'crypto';
import prisma from '../config/db';
import type { HashPayload, VerificationResult } from '../types';

if (!process.env.HASH_SECRET) {
  const env = process.env.NODE_ENV;
  if (env !== 'development' && env !== 'test') {
    throw new Error(`HASH_SECRET environment variable must be set (current NODE_ENV: ${env ?? 'undefined'})`);
  }
}

const HASH_SECRET = process.env.HASH_SECRET || 'development-only-hash-secret';
export const GENESIS_HASH = process.env.GENESIS_HASH || 'audit-log-genesis';
const VERIFY_CHAIN_BATCH_SIZE = Number.parseInt(process.env.VERIFY_CHAIN_BATCH_SIZE || '500', 10);

export function computeEntryHash(previousHash: string, payload: HashPayload): string {
  const input = previousHash + JSON.stringify(payload);
  return createHmac('sha256', HASH_SECRET).update(input).digest('hex');
}

export function buildHashPayload(entry: {
  appId: string;
  sequenceNumber: number;
  actorId: string;
  actorType: string;
  action: string;
  resourceId: string;
  resourceType: string;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}): HashPayload {
  return {
    appId: entry.appId,
    sequenceNumber: entry.sequenceNumber,
    actorId: entry.actorId,
    actorType: entry.actorType,
    action: entry.action,
    resourceId: entry.resourceId,
    resourceType: entry.resourceType,
    metadata: entry.metadata,
    createdAt: entry.createdAt.toISOString()
  };
}

/**
 * UNSAFE outside a serializable transaction.
 * Do not call directly. Exported for testing and controlled maintenance only.
 */
export async function getLatestHashForApp(appId: string): Promise<string> {
  const latest = await prisma.auditLog.findFirst({
    where: { appId },
    orderBy: { sequenceNumber: 'desc' },
    select: { entryHash: true }
  });

  return latest?.entryHash ?? GENESIS_HASH;
}

/**
 * UNSAFE outside a serializable transaction.
 * Do not call directly. Exported for testing and controlled maintenance only.
 */
export async function getNextSequenceNumber(appId: string): Promise<number> {
  const latest = await prisma.auditLog.findFirst({
    where: { appId },
    orderBy: { sequenceNumber: 'desc' },
    select: { sequenceNumber: true }
  });

  return (latest?.sequenceNumber ?? 0) + 1;
}

export async function verifyChain(appId: string): Promise<VerificationResult> {
  const startTime = Date.now();
  let previousHash = GENESIS_HASH;
  let entriesChecked = 0;
  let cursor: string | undefined;

  while (true) {
    const entries = await prisma.auditLog.findMany({
      where: { appId },
      orderBy: { sequenceNumber: 'asc' },
      take: VERIFY_CHAIN_BATCH_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {})
    });

    if (entries.length === 0) break;

    for (const entry of entries) {
      entriesChecked += 1;

      const payload = buildHashPayload({
        appId: entry.appId,
        sequenceNumber: entry.sequenceNumber,
        actorId: entry.actorId,
        actorType: entry.actorType,
        action: entry.action,
        resourceId: entry.resourceId,
        resourceType: entry.resourceType,
        metadata: entry.metadata as Record<string, unknown> | null,
        createdAt: entry.createdAt
      });

      const expectedHash = computeEntryHash(previousHash, payload);
      const expectedBuffer = Buffer.from(expectedHash, 'hex');
      const storedBuffer = Buffer.from(entry.entryHash, 'hex');
      const prevExpected = Buffer.from(previousHash);
      const prevStored = Buffer.from(entry.previousHash);
      const previousHashMatches =
        prevExpected.length === prevStored.length && timingSafeEqual(prevExpected, prevStored);
      const entryHashMatches =
        expectedBuffer.length === storedBuffer.length && timingSafeEqual(expectedBuffer, storedBuffer);

      if (!previousHashMatches || !entryHashMatches) {
        return {
          valid: false,
          entriesChecked,
          durationMs: Date.now() - startTime,
          tamperedAt: {
            sequenceNumber: entry.sequenceNumber,
            entryId: entry.id
          }
        };
      }

      previousHash = entry.entryHash;
    }

    cursor = entries[entries.length - 1].id;
    if (entries.length < VERIFY_CHAIN_BATCH_SIZE) break;
  }

  return {
    valid: true,
    entriesChecked,
    durationMs: Date.now() - startTime
  };
}
