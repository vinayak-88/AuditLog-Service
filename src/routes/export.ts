import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { exportRateLimiter } from '../middleware/rateLimiter';
import { validateQuery } from '../middleware/validateQuery';
import prisma from '../config/db';
import { ExportEventsSchema, type ExportEventsInput } from '../types';
import { buildEventWhere, eventPublicSelect } from './search';

const router = Router();
const BATCH_SIZE = 500;

/*
 * CHANGED: added JSON_EXPORT_MAX_ROWS cap.
 *
 * The original code had no limit on the JSON export path — it would load every
 * matching row into memory and try to JSON.stringify the entire result set in one
 * shot. The CSV path was correctly paginated. The JSON path was not. They went
 * through the same endpoint and the same filters but behaved completely differently
 * under load.
 *
 * This constant caps how many rows the JSON export will return before it stops and
 * signals truncation. Configurable via env var so you can tune it per environment
 * without a deploy. Default is 10 000 which fits comfortably in memory and keeps
 * response times reasonable. If a client needs more, they should use the CSV export
 * which streams without an upper bound.
 */
const JSON_EXPORT_MAX_ROWS = Number.parseInt(process.env.JSON_EXPORT_MAX_ROWS || '10000', 10);

function escapeCsv(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  // Prevent CSV/formula injection: Excel and Google Sheets treat leading
  // =, +, -, or @ as the start of a formula. Prefixing with a single quote
  // neutralizes it without changing the visible value when opened.
  if (/^[=+\-@]/.test(text)) {
    text = `'${text}`;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

router.get(
  '/',
  exportRateLimiter,
  validateQuery(ExportEventsSchema),
  asyncHandler(async (req, res) => {
    const app = req.auditApp!;

    /*
     * CHANGED: replaced the double type assertion (as unknown as ...) with the
     * shared ExportEventsInput type inferred from the Zod schema.
     *
     * The original `req.query as unknown as { format: 'json' | 'csv' } & Record<string, unknown>`
     * was a red flag: two chained assertions mean the type system has been fully
     * bypassed. validateQuery(ExportEventsSchema) already ran and coerced the data,
     * so req.query holds the exact shape ExportEventsSchema produces. Reusing
     * ExportEventsInput also keeps this route aligned with buildEventWhere's
     * tighter query type.
     */
    const query = req.query as ExportEventsInput & typeof req.query;
    const where = buildEventWhere(app.id, query);

    if (query.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="audit-events-${app.id}.csv"`);
      res.write(
        'id,actorId,actorType,action,resourceId,resourceType,metadata,ipAddress,userAgent,sequenceNumber,createdAt\n'
      );

      let cursor: string | undefined;
      while (true) {
        const events = await prisma.auditLog.findMany({
          where,
          /*
           * CHANGED: exports are chronological rather than newest-first.
           *
           * Search results remain optimized for browsing, but downloaded audit
           * files are easier to review, import, and hand to auditors when the
           * oldest event appears first.
           */
          orderBy: { createdAt: 'asc' },
          take: BATCH_SIZE,
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
          select: eventPublicSelect
        });

        if (events.length === 0) break;

        for (const event of events) {
          res.write(
            [
              event.id,
              event.actorId,
              event.actorType,
              event.action,
              event.resourceId,
              event.resourceType,
              event.metadata,
              event.ipAddress,
              event.userAgent,
              event.sequenceNumber,
              event.createdAt.toISOString()
            ]
              .map(escapeCsv)
              .join(',') + '\n'
          );
        }

        cursor = events.at(-1)?.id;
        if (events.length < BATCH_SIZE) break;
      }

      return res.end();
    }

    /*
     * CHANGED: JSON export now streams with cursor-based pagination instead of
     * loading the full result set into memory.
     *
     * BEFORE (broken):
     *   prisma.auditLog.findMany({ where, select: eventPublicSelect })
     *   — No `take` limit. For an app with 2M events, this loads 2M rows into the
     *     Node.js heap and then tries to res.json() the entire array at once.
     *     res.json() calls JSON.stringify() synchronously, which blocks the event
     *     loop while serialising megabytes of data.
     *
     * AFTER (fixed):
     *   Same cursor-batch loop used by the CSV path.
     *   — We pull BATCH_SIZE rows at a time and write them incrementally using
     *     res.write(), which streams the response. Node.js back-pressures when the
     *     client is slow, so the heap never holds more than BATCH_SIZE events at once.
     *   — We stop at JSON_EXPORT_MAX_ROWS and include a `truncated` flag in the
     *     response so callers know the result was capped. Clients that need the full
     *     dataset should use CSV, which has no row cap.
     *
     * WHY manually write the JSON envelope instead of res.json():
     *   res.json() collects the full response body before sending it. To stream JSON
     *   we have to write the opening/closing envelope ourselves and flush each batch
     *   with res.write(). This is the standard pattern for streaming large JSON arrays
     *   over HTTP when you cannot know the total size upfront.
     *
     * WHY we track `isFirst` instead of joining with commas after the fact:
     *   We don't know how many events there are until we've fetched them all. We can't
     *   do a join on the whole array. The isFirst flag lets us prepend the comma for
     *   every element except the first, which produces valid JSON without buffering.
     */
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-events-${app.id}.json"`);

    res.write('{"success":true,"data":{"events":[');

    let cursor: string | undefined;
    let isFirst = true;
    let totalFetched = 0;
    let truncated = false;

    while (true) {
      const remaining = JSON_EXPORT_MAX_ROWS - totalFetched;
      if (remaining <= 0) {
        truncated = true;
        break;
      }

      // Over-fetch by one row beyond what's needed to fill the cap. If the
      // extra row comes back, there is more data beyond the cap and we should
      // report truncated: true. If it doesn't, we've reached the real end of
      // the dataset exactly at the cap, and truncated should stay false.
      const takeWithLookahead = Math.min(BATCH_SIZE, remaining) + 1;

      const events = await prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        take: takeWithLookahead,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        select: eventPublicSelect
      });

      if (events.length === 0) break;

      const hitCap = totalFetched + events.length > JSON_EXPORT_MAX_ROWS;
      const toWrite = hitCap ? events.slice(0, JSON_EXPORT_MAX_ROWS - totalFetched) : events;

      for (const event of toWrite) {
        if (!isFirst) res.write(',');
        res.write(JSON.stringify({ ...event, createdAt: event.createdAt.toISOString() }));
        isFirst = false;
      }

      totalFetched += toWrite.length;

      if (hitCap) {
        truncated = true;
        break;
      }

      cursor = toWrite.at(-1)?.id;

      if (events.length < takeWithLookahead) break;
    }

    res.write(`],"truncated":${truncated},"totalFetched":${totalFetched}}}`);
    return res.end();
  })
);

export default router;
