import prisma from '../config/db';

export async function getTotalEventCount(appId: string): Promise<number> {
  return prisma.auditLog.count({ where: { appId } });
}

/*
 * CHANGED: getEventVolumeByDay
 *
 * BEFORE (broken):
 *   prisma.auditLog.findMany({ select: { createdAt: true } })
 *   — This fetched every row from the last 30 days into Node.js memory,
 *     then iterated over them in JS to build a Map<date, count>.
 *     An app with 500k events/month loads 500k rows on every dashboard refresh.
 *     Node.js holds all of them in the heap. This will OOM your Railway dyno
 *     silently — the process just dies, Railway restarts it, it dies again.
 *
 * AFTER (fixed):
 *   prisma.$queryRaw with DATE_TRUNC + GROUP BY
 *   — The database does one sequential scan of the relevant rows, groups them,
 *     and returns exactly 30 rows (one per day). Your Node.js process receives
 *     30 small objects. The heap impact is negligible regardless of event volume.
 *
 * WHY $queryRaw and not prisma.auditLog.groupBy():
 *   Prisma's groupBy() does not support arbitrary SQL date functions like
 *   DATE_TRUNC or DATE(). You can only group by actual model fields. To group
 *   by day from a timestamp column, you must drop to raw SQL. Prisma's tagged
 *   template literal syntax ($queryRaw`...`) is parameterised — the ${appId}
 *   interpolation is sent as a prepared statement parameter, NOT string-concatenated.
 *   It is safe from SQL injection.
 *
 * WHY ::text on the date cast:
 *   PostgreSQL DATE_TRUNC returns a TIMESTAMP. Casting to ::date then ::text gives
 *   us the 'YYYY-MM-DD' string the function signature promises. Without the cast,
 *   the Prisma driver would return a JavaScript Date object and the caller would
 *   need to know to call .toISOString().slice(0, 10) — that leaks an internal
 *   detail. The cast keeps the contract clean.
 *
 * WHY Number(row.count):
 *   PostgreSQL COUNT(*) returns a BIGINT. The node-postgres driver maps BIGINT
 *   to JavaScript BigInt (not number) to avoid losing precision on very large
 *   counts. Our return type is number, so we convert explicitly. If you ever
 *   have more than Number.MAX_SAFE_INTEGER (9 quadrillion) events per day,
 *   you have bigger problems than this line.
 */
export async function getEventVolumeByDay(appId: string): Promise<{ date: string; count: number }[]> {
  const rows = await prisma.$queryRaw<Array<{ date: string; count: bigint }>>`
    SELECT
      DATE_TRUNC('day', created_at)::date::text AS date,
      COUNT(*)                                   AS count
    FROM audit_logs
    WHERE app_id   = ${appId}
      AND created_at >= NOW() - INTERVAL '30 days'
    GROUP BY DATE_TRUNC('day', created_at)
    ORDER BY DATE_TRUNC('day', created_at) ASC
  `;

  /*
   * BigInt -> number conversion here rather than in the template so the public
   * return type stays as { date: string; count: number }[] without any change
   * to callers.
   */
  return rows.map((row) => ({
    date: row.date,
    count: Number(row.count)
  }));
}

export async function getTopActors(appId: string): Promise<{ actorId: string; actorType: string; count: number }[]> {
  const grouped = await prisma.auditLog.groupBy({
    by: ['actorId', 'actorType'],
    where: { appId, createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
    _count: { _all: true },
    orderBy: { _count: { actorId: 'desc' } },
    take: 10
  });

  return grouped.map((row) => ({
    actorId: row.actorId,
    actorType: row.actorType,
    count: row._count._all
  }));
}

export async function getActionBreakdown(appId: string): Promise<{ action: string; count: number }[]> {
  const grouped = await prisma.auditLog.groupBy({
    by: ['action'],
    where: { appId, createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
    _count: { _all: true },
    orderBy: { _count: { action: 'desc' } },
    take: 20
  });

  return grouped.map((row) => ({ action: row.action, count: row._count._all }));
}

export async function getEventsLast24Hours(appId: string): Promise<number> {
  return prisma.auditLog.count({
    where: {
      appId,
      createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
    }
  });
}