import { Prisma } from '@prisma/client';
import { Router } from 'express';
import { cacheActivityEntry } from '../services/activityCache';
import { buildHashPayload, computeEntryHash, GENESIS_HASH } from '../services/hashChain';
import { eventsRateLimiter } from '../middleware/rateLimiter';
import { asyncHandler } from '../middleware/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { validateBody } from '../middleware/validateBody';
import prisma from '../config/db';
import logger from '../config/logger';
import { IngestEventSchema, type IngestEventInput } from '../types';

const router = Router();
const SERIALIZATION_RETRIES = 3;

/*
 * CHANGED: createAuditLogEntry now returns { entry, created } instead of just entry.
 *
 * The `created` boolean tells the route handler whether this was a new insert
 * (HTTP 201) or a duplicate that was deduplicated (HTTP 200). Returning 200
 * for a duplicate is the standard idempotency convention — it signals "I already
 * did this" rather than "I just did this."
 *
 * The function now has three phases:
 *
 *   Phase 1 — Idempotency pre-check (NEW):
 *     If the caller provided an idempotencyKey, query for an existing entry
 *     with that key for this app before doing any transaction work. If found,
 *     return it immediately. This is the fast path for retries.
 *
 *   Phase 2 — Serializable transaction (UNCHANGED):
 *     The original hash-chain insert logic is untouched. Serializable isolation
 *     is still required to prevent two concurrent requests from reading the same
 *     "latest hash" and producing two entries with identical previousHashes,
 *     which would permanently break the chain. P2034 retries are still in place
 *     for transaction conflicts.
 *
 *   Phase 3 — P2002 race condition handler (NEW):
 *     Two concurrent requests with the same idempotencyKey can both pass Phase 1
 *     (neither finds an existing row) and proceed to Phase 2. The DB's composite
 *     unique index on (appId, idempotencyKey) means only one INSERT can commit.
 *     The second gets a P2002 (unique constraint violation). We catch that,
 *     fetch the row that won the race, and return it as a deduplicated result.
 *     This makes the idempotency guarantee airtight under concurrent load.
 */
async function createAuditLogEntry(
  appId: string,
  input: IngestEventInput
): Promise<{ entry: Awaited<ReturnType<typeof prisma.auditLog.create>>; created: boolean }> {
  /*
   * Phase 1: Idempotency pre-check.
   *
   * This runs OUTSIDE the serializable transaction intentionally. The transaction
   * is expensive (it takes a row-level lock on the latest entry to safely read
   * the tail of the hash chain). We don't want to pay that cost for a retry that
   * we can detect with a simple point-lookup.
   *
   * The pre-check is best-effort: it handles the common case (sequential retries
   * separated by time). The race condition case (two concurrent requests, same key)
   * is handled in Phase 3 via the unique constraint.
   */
  if (input.idempotencyKey) {
    const existing = await prisma.auditLog.findFirst({
      where: { appId, idempotencyKey: input.idempotencyKey }
    });

    if (existing) {
      logger.info({
        message: 'Idempotent request detected; returning existing audit log entry',
        appId,
        idempotencyKey: input.idempotencyKey,
        existingEntryId: existing.id
      });
      return { entry: existing, created: false };
    }
  }

  /*
   * Phase 2: Serializable transaction — unchanged from original.
   *
   * WHY Serializable isolation:
   *   The hash chain requires that entry N's previousHash equals entry N-1's
   *   entryHash — no gaps, no duplicates. Under concurrent writes with a lower
   *   isolation level (e.g. Read Committed), two transactions can both read the
   *   same "latest" row, compute their hashes using the same previousHash, and
   *   both commit successfully. The chain now has two entries claiming the same
   *   predecessor. Verification will fail at that point and you'll get a tamper
   *   alert for a bug, not an actual attack. Serializable makes concurrent
   *   transactions behave as if they ran one-at-a-time, eliminating the race.
   *
   * WHY retry on P2034:
   *   Serializable isolation prevents the logical conflict by aborting one of
   *   the conflicting transactions with a serialization failure error (Prisma
   *   maps this to P2034). The retry loop turns that abort into a brief delay
   *   and re-attempt rather than an error bubble to the client. Three retries
   *   is enough for realistic burst traffic; a persistent failure after three
   *   attempts is a sign of something genuinely wrong and should propagate.
  */

  for (let attempt = 1; attempt <= SERIALIZATION_RETRIES; attempt += 1) {
    try {
      const entry = await prisma.$transaction(
        async (tx) => {
          const latest = await tx.auditLog.findFirst({
            where: { appId },
            orderBy: { sequenceNumber: 'desc' },
            select: { entryHash: true, sequenceNumber: true }
          });

          const previousHash = latest?.entryHash ?? GENESIS_HASH;
          const sequenceNumber = (latest?.sequenceNumber ?? 0) + 1;
          const createdAt = new Date();
          const metadata = input.metadata ?? null;

          const payload = buildHashPayload({
            appId,
            sequenceNumber,
            actorId: input.actorId,
            actorType: input.actorType,
            action: input.action,
            resourceId: input.resourceId,
            resourceType: input.resourceType,
            metadata,
            createdAt
          });

          const entryHash = computeEntryHash(previousHash, payload);

          return tx.auditLog.create({
            data: {
              appId,
              actorId: input.actorId,
              actorType: input.actorType,
              action: input.action,
              resourceId: input.resourceId,
              resourceType: input.resourceType,
              metadata: metadata as Prisma.InputJsonValue | undefined,
              ipAddress: input.ipAddress ?? null,
              userAgent: input.userAgent ?? null,
              idempotencyKey: input.idempotencyKey ?? null,
              entryHash,
              previousHash,
              sequenceNumber,
              createdAt
            }
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );

      return { entry, created: true };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError) {
        /*
         * P2034 = serialization failure. Safe to retry — the transaction was
         * rolled back cleanly. The chain is still consistent.
         */
        if (err.code === 'P2034' && attempt < SERIALIZATION_RETRIES) {
          logger.warn({ message: 'Serializable transaction conflict; retrying audit entry insert', attempt });
          continue;
        }

        /*
         * Phase 3: P2002 = unique constraint violation on (appId, idempotencyKey).
         *
         * This means two requests with the same idempotencyKey hit Phase 2 at the
         * same time, both passed the Phase 1 pre-check (no existing row yet), and
         * one of them won the INSERT race. We are the loser. Fetch the winner's row
         * and return it as a deduplicated result. The caller gets back the same
         * data they would have gotten if they had arrived first.
         *
         * We only do this fallback if an idempotencyKey was actually provided —
         * a P2002 on any other unique column (e.g. a future constraint) should
         * still propagate as an error.
        */
        if (err.code === 'P2002' && input.idempotencyKey) {
          logger.info({
            message: 'Idempotency key race resolved via unique constraint; fetching winning entry',
            appId,
            idempotencyKey: input.idempotencyKey
          });

          const existing = await prisma.auditLog.findFirst({
            where: { appId, idempotencyKey: input.idempotencyKey }
          });

          if (existing) {
            return { entry: existing, created: false };
          }
        }
      }

      throw err;
    }
  }

  throw new AppError(
    'High write contention - entry could not be committed after 3 attempts. Retry with exponential backoff.',
    503,
    'SERVICE_BUSY'
  );
}

router.post(
  '/',
  eventsRateLimiter,
  validateBody(IngestEventSchema),
  asyncHandler(async (req, res) => {
    const app = req.auditApp!;

    /*
     * CHANGED: destructure `created` from the result and use it to set the
     * HTTP status code.
     *
     * 201 Created   — a new audit log entry was inserted.
     * 200 OK        — the request was deduplicated; existing entry returned.
     *
     * This distinction matters for clients implementing retry logic: a 200 on a
     * retry confirms "you already sent this and it was recorded" without ambiguity.
     */
    const { entry, created } = await createAuditLogEntry(app.id, req.body as IngestEventInput);

    /*
     * Only populate the activity cache for genuinely new entries. Replaying the
     * cache write for a deduplicated entry is harmless (the sorted set deduplicates
     * by member value via ZADD), but it wastes a Redis round-trip and adds noise
     * to the logs.
     */
    if (created) {
      void cacheActivityEntry(app.id, {
        id: entry.id,
        actorId: entry.actorId,
        actorType: entry.actorType,
        action: entry.action,
        resourceId: entry.resourceId,
        resourceType: entry.resourceType,
        metadata: entry.metadata as Record<string, unknown> | null,
        createdAt: entry.createdAt.toISOString()
      });
    }

    return res.status(created ? 201 : 200).json({
      success: true,
      data: {
        entryId: entry.id,
        sequenceNumber: entry.sequenceNumber,
        entryHash: entry.entryHash,
        createdAt: entry.createdAt.toISOString()
      }
    });
  })
);

export default router;
