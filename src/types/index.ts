import type { App } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';

/*
 * CHANGED: IngestEventSchema — added optional idempotencyKey field.
 *
 * WHY idempotency matters for an audit log service:
 *   Clients POST to /events over HTTP. Networks are unreliable. A client that
 *   sends an event and gets no response (timeout, connection reset, 502 from a
 *   load balancer) cannot tell whether the server processed the request or not.
 *   The safe choice for the client is to retry. Without idempotency, every retry
 *   creates a new audit log entry — identical data, different sequence number,
 *   different hash. The audit trail now contains phantom duplicate events that
 *   never actually happened. For a system that sells "tamper-proof, accurate
 *   audit trails", that is a correctness failure.
 *
 *   With an idempotency key, the client generates a UUID before sending and
 *   includes it in every retry of the same logical event. The server checks
 *   whether it has already processed that key for that app. If it has, it returns
 *   the original entry's data without inserting again. The client gets a 200 back
 *   and knows the event is recorded exactly once.
 *
 * WHY optional:
 *   Making it required is a breaking change for all existing clients. It stays
 *   optional so existing integrations continue to work. Clients that care about
 *   exactly-once semantics can opt in.
 *
 * KEY DESIGN DECISIONS:
 *   - max(255): keeps it inside a standard indexed VARCHAR column.
 *   - The key is scoped to (appId, idempotencyKey) at the DB level via a
 *     composite unique index. Two different apps can use the same key string
 *     without collision. See prisma/schema.prisma for the index definition.
 *   - We do not expose the idempotencyKey in API responses. It is an internal
 *     deduplication token, not meaningful data for the consumer.
 *
 * REQUIRED PRISMA SCHEMA CHANGE (prisma/schema.prisma):
 *   Add to the AuditLog model:
 *
 *     idempotencyKey String?
 *     @@unique([appId, idempotencyKey], name: "unique_app_idempotency_key")
 *
 *   Then run: npx prisma migrate dev --name add_idempotency_key
 *
 *   The @@unique constraint is what makes the race condition safe: even if two
 *   concurrent requests with the same key both pass the application-level check,
 *   only one INSERT will succeed. The second will get a P2002 (unique constraint
 *   violation) which events.ts catches and turns into a lookup of the winning row.
 */
export const IngestEventSchema = z.object({
  actorId: z.string().min(1).max(255),
  /*
   * CHANGED: actorType is now an open validated string instead of a closed enum.
   *
   * The database and hash payload already treat actorType as a plain string, and
   * integrations may need values such as device, webhook, or bot without waiting
   * for a service redeploy. min/max validation still prevents empty or oversized
   * values while keeping the API extensible.
   */
  actorType: z.string().min(1).max(100),
  action: z.string().min(1).max(255),
  resourceId: z.string().min(1).max(255),
  resourceType: z.string().min(1).max(100),
  metadata: z
    .record(z.unknown())
    .optional()
    .refine((v) => !v || Buffer.byteLength(JSON.stringify(v), 'utf8') <= 10_000, {
      message: 'metadata exceeds the 10KB limit'
    }),
  ipAddress: z.string().ip().optional(),
  userAgent: z.string().max(500).optional(),
  idempotencyKey: z.string().min(1).max(255).optional()
});

export const SearchEventsSchema = z.object({
  actorId: z.string().optional(),
  actorType: z.string().optional(),
  action: z.string().optional(),
  resourceId: z.string().optional(),
  resourceType: z.string().optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

export const ExportEventsSchema = SearchEventsSchema.extend({
  format: z.enum(['json', 'csv']).default('json')
});

export const RegisterAppSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional()
});

export type IngestEventInput = z.infer<typeof IngestEventSchema>;
export type SearchEventsInput = z.infer<typeof SearchEventsSchema>;
export type ExportEventsInput = z.infer<typeof ExportEventsSchema>;
export type RegisterAppInput = z.infer<typeof RegisterAppSchema>;

export interface HashPayload {
  appId: string;
  sequenceNumber: number;
  actorId: string;
  actorType: string;
  action: string;
  resourceId: string;
  resourceType: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export type VerificationResult =
  | { valid: true; entriesChecked: number; durationMs: number }
  | {
      valid: false;
      entriesChecked: number;
      durationMs: number;
      tamperedAt: { sequenceNumber: number; entryId: string };
    };

export interface ApiSuccess<T> {
  success: true;
  data: T;
}

export interface ApiError {
  success: false;
  error: {
    message: string;
    code: string;
    statusCode: number;
    details?: unknown;
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

export interface ActivityEntry {
  id: string;
  actorId: string;
  actorType: string;
  action: string;
  resourceId: string;
  resourceType: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export type AuthenticatedRequest = Request & { auditApp: App };
export type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;
