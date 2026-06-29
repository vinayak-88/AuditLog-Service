import { randomBytes } from 'crypto';
import type { Request } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';
import { clearApiKeyCache, getDashboardOwnerId } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { appsRateLimiter } from '../middleware/rateLimiter';
import { validateBody } from '../middleware/validateBody';
import prisma from '../config/db';
import { RegisterAppSchema } from '../types';

const router = Router();

function createApiKey(): string {
  return `als_${randomBytes(32).toString('hex')}`;
}

function requireOwnerId(req: Request): string {
  const ownerId = getDashboardOwnerId(req);
  if (!ownerId) {
    throw new AppError('Dashboard authentication required', 401, 'DASHBOARD_AUTH_REQUIRED');
  }
  return ownerId;
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const ownerId = requireOwnerId(req);
    const apps = await prisma.app.findMany({
      /*
       * CHANGED: hide soft-deleted apps from the dashboard list.
       *
       * DELETE marks an app inactive instead of removing it so existing audit log
       * foreign keys stay intact. Listing should therefore filter to active apps
       * or users will continue seeing apps they already removed.
       */
      where: { ownerId, isActive: true },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { auditLogs: true } } }
    });

    return res.json({
      success: true,
      data: {
        apps: apps.map((app) => ({
          id: app.id,
          name: app.name,
          description: app.description,
          isActive: app.isActive,
          createdAt: app.createdAt.toISOString(),
          _count: app._count
        }))
      }
    });
  })
);

router.post(
  '/',
  appsRateLimiter,
  validateBody(RegisterAppSchema),
  asyncHandler(async (req, res) => {
    const ownerId = requireOwnerId(req);
    const app = await prisma.app.create({
      data: {
        ownerId,
        name: req.body.name,
        description: req.body.description ?? null,
        apiKey: createApiKey()
      }
    });

    return res.status(201).json({
      success: true,
      data: {
        id: app.id,
        name: app.name,
        description: app.description,
        // PORTFOLIO SIMPLIFICATION: API keys are stored as plaintext.
        // Production systems should store only a SHA-256 hash (with a pepper)
        // and never return the plaintext after initial creation.
        // The full key is returned once here and never stored in a retrievable form.
        apiKey: app.apiKey,
        createdAt: app.createdAt.toISOString()
      }
    });
  })
);

router.post(
  '/:id/rotate-key',
  appsRateLimiter,
  asyncHandler(async (req, res) => {
    const ownerId = requireOwnerId(req);
    const appId = z.string().cuid().parse(req.params.id);
    const app = await prisma.app.findFirst({ where: { id: appId, ownerId } });

    if (!app) {
      throw new AppError('App not found', 404, 'APP_NOT_FOUND');
    }

    const updated = await prisma.app.update({
      where: { id: app.id },
      data: { apiKey: createApiKey() }
    });
    await clearApiKeyCache(app.apiKey);

    return res.json({ success: true, data: { newApiKey: updated.apiKey } });
  })
);

router.delete(
  '/:id',
  appsRateLimiter,
  asyncHandler(async (req, res) => {
    const ownerId = requireOwnerId(req);
    const appId = z.string().cuid().parse(req.params.id);
    const app = await prisma.app.findFirst({ where: { id: appId, ownerId } });

    if (!app) {
      throw new AppError('App not found', 404, 'APP_NOT_FOUND');
    }

    await prisma.app.update({ where: { id: app.id }, data: { isActive: false } });
    await clearApiKeyCache(app.apiKey);
    return res.status(204).send();
  })
);

export default router;
