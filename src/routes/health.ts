import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import prisma from '../config/db';
import logger from '../config/logger';
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
      // Public responses carry only a generic status. Raw messages can
      // contain hostnames, ports, and connection details, so they stay in
      // server-side logs.
      logger.error({
        message: 'PostgreSQL health check failed',
        error: err instanceof Error ? err.message : err
      });
      dependencies.postgresql = 'unavailable';
    }

    try {
      await withTimeout(redis.ping(), 'Redis');
    } catch (err) {
      healthy = false;
      logger.error({
        message: 'Redis health check failed',
        error: err instanceof Error ? err.message : err
      });
      dependencies.redis = 'unavailable';
    }

    return res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      dependencies
    });
  })
);

export default router;
