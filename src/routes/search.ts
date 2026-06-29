import type { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';
import { searchRateLimiter } from '../middleware/rateLimiter';
import { validateQuery } from '../middleware/validateQuery';
import { getActivityFeed } from '../services/activityCache';
import prisma from '../config/db';
import { SearchEventsSchema, type ExportEventsInput, type SearchEventsInput } from '../types';

const router = Router();

/*
 * CHANGED: the activity endpoint now has a route-local Zod query schema.
 *
 * This keeps the validation rules close to the only route that uses them and
 * replaces the old ad-hoc parseInt fallback with the same validation middleware
 * pattern used by the rest of the service.
 */
const ActivityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20)
});

/*
 * CHANGED: buildEventWhere now accepts the Zod-inferred search/export query
 * types instead of an arbitrary Record.
 *
 * validateQuery already coerces and validates these shapes before this helper is
 * called, so the duplicate typeof guards were removed and TypeScript can now
 * catch callers that pass the wrong query object.
 */
export function buildEventWhere(
  appId: string,
  query: SearchEventsInput | ExportEventsInput
): Prisma.AuditLogWhereInput {
  const where: Prisma.AuditLogWhereInput = { appId };

  if (query.actorId !== undefined) where.actorId = query.actorId;
  if (query.actorType !== undefined) where.actorType = query.actorType;
  if (query.action !== undefined) where.action = query.action;
  if (query.resourceId !== undefined) where.resourceId = query.resourceId;
  if (query.resourceType !== undefined) where.resourceType = query.resourceType;

  if (query.startDate !== undefined || query.endDate !== undefined) {
    where.createdAt = {};
    if (query.startDate !== undefined) where.createdAt.gte = new Date(query.startDate);
    if (query.endDate !== undefined) where.createdAt.lte = new Date(query.endDate);
  }

  return where;
}

export const eventPublicSelect = {
  id: true,
  actorId: true,
  actorType: true,
  action: true,
  resourceId: true,
  resourceType: true,
  metadata: true,
  ipAddress: true,
  userAgent: true,
  sequenceNumber: true,
  createdAt: true
} satisfies Prisma.AuditLogSelect;

router.get(
  '/',
  searchRateLimiter,
  validateQuery(SearchEventsSchema),
  asyncHandler(async (req, res) => {
    const app = req.auditApp!;
    /*
     * CHANGED: use the Zod-inferred query type after validateQuery has coerced
     * req.query, so buildEventWhere receives a typed object instead of a loose
     * Record with redundant runtime type checks.
     */
    const query = req.query as SearchEventsInput & typeof req.query;
    const page = query.page;
    const limit = query.limit;
    const skip = (page - 1) * limit;
    const where = buildEventWhere(app.id, query);

    const [events, total] = await prisma.$transaction([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: eventPublicSelect
      }),
      prisma.auditLog.count({ where })
    ]);

    return res.json({
      success: true,
      data: {
        events: events.map((event) => ({ ...event, createdAt: event.createdAt.toISOString() })),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit)
        }
      }
    });
  })
);

router.get(
  '/activity/:resourceId',
  searchRateLimiter,
  validateQuery(ActivityQuerySchema),
  asyncHandler(async (req, res) => {
    const app = req.auditApp!;
    /*
     * CHANGED: activity route input now uses Zod instead of ad-hoc parsing.
     *
     * The limit value has already been coerced by validateQuery, and resourceId
     * is parsed inline because it comes from route params rather than req.query.
     */
    const { limit } = req.query as z.infer<typeof ActivityQuerySchema> & typeof req.query;
    const resourceId = z.string().min(1).max(255).parse(req.params.resourceId);
    const result = await getActivityFeed(app.id, resourceId, limit);

    return res.json({
      success: true,
      data: {
        resourceId,
        source: result.source,
        events: result.entries
      }
    });
  })
);

export default router;
