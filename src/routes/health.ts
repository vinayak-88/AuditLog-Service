import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import prisma from '../config/db';
import redis from '../config/redis';

const router = Router();
const HEALTH_TIMEOUT_MS = 3000;

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} health check timed out after ${HEALTH_TIMEOUT_MS}ms`)), HEALTH_TIMEOUT_MS)
    )
  ]);
}

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const dependencies: Record<string, string> = {
      postgresql: 'connected',
      redis: 'connected'
    };

    let healthy = true;

    try {
      await withTimeout(prisma.$queryRaw`SELECT 1`, 'PostgreSQL');
    } catch (err) {
      healthy = false;
      dependencies.postgresql = `error: ${err instanceof Error ? err.message : 'unknown'}`;
    }

    try {
      await withTimeout(redis.ping(), 'Redis');
    } catch (err) {
      healthy = false;
      dependencies.redis = `error: ${err instanceof Error ? err.message : 'unknown'}`;
    }

    return res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      dependencies
    });
  })
);

export default router;
