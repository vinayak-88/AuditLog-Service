import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import prisma from '../config/db';
import redis from '../config/redis';

const router = Router();

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const dependencies = {
      postgresql: 'connected',
      redis: 'connected'
    };

    let healthy = true;

    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch (err) {
      healthy = false;
      dependencies.postgresql = `error: ${err instanceof Error ? err.message : 'unknown'}`;
    }

    try {
      await redis.ping();
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
