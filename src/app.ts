import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import appsRouter from './routes/apps';
import eventsRouter from './routes/events';
import exportRouter from './routes/export';
import healthRouter from './routes/health';
import searchRouter from './routes/search';
import verifyRouter from './routes/verify';
import { apiKeyAuth, dashboardOrApiKeyAuth } from './middleware/auth';
import { closeVerificationQueue } from './queues/verificationQueue';
import { errorHandler } from './middleware/errorHandler';
import { requestId } from './middleware/requestId';
import { validateEnv } from './config/validateEnv';
import logger from './config/logger';
import prisma from './config/db';
import redis from './config/redis';

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(
    cors({
      origin: (process.env.CORS_ORIGINS ?? '')
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      /*
       * CHANGED: allow browser clients to send x-request-id on CORS preflight.
       *
       * The request-id middleware already propagates upstream correlation IDs,
       * but browsers will not send that header cross-origin unless CORS permits
       * it explicitly.
       */
      allowedHeaders: ['Content-Type', 'Authorization', 'x-owner-id', 'x-user-id', 'x-app-id', 'x-request-id'],
      /*
       * CHANGED: expose x-request-id so browser clients can read the response
       * correlation ID and include it in their own error reporting.
       */
      exposedHeaders: ['x-request-id'],
      credentials: true
    })
  );

  app.use(requestId);
  app.use(express.json({ limit: '1mb' }));
  app.use(
    /*
     * CHANGED: include x-request-id in every Morgan access log line so the
     * correlation ID assigned above is visible in request-level logging.
     */
    morgan(':req[x-request-id] :remote-addr - :remote-user [:date[clf]] ":method :url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent"', {
      stream: { write: (message) => logger.info(message.trim()) },
      skip: (req) => req.path === '/health'
    })
  );

  app.use('/health', healthRouter);
  /*
   * CHANGED: all public API routes except /health are mounted under /v1.
   *
   * Versioning the route surface now gives future breaking API changes a clean
   * migration path while preserving the unversioned health check for platform
   * probes. The apiKeyAuth middleware remains below dashboard-facing /v1/apps and
   * above the protected event, verification, and export routes.
   */
  app.use('/v1/apps', appsRouter);

  /*
   * Read-only event/search/activity routes accept either a customer app key
   * (apiKeyAuth fallback) or dashboard owner/app credentials, using the same
   * ownership-verified model as verify/export.
   *
   * The read router is mounted FIRST on purpose: Express executes each mount's
   * auth middleware for every subpath, so a customer-only gate mounted first
   * would reject dashboard reads before they reach the search router.
   * Ingestion (POST /) still falls through to eventsRouter behind apiKeyAuth,
   * so customer write authentication is unchanged.
   */
  app.use('/v1/events', dashboardOrApiKeyAuth, searchRouter);
  app.use('/v1/events', apiKeyAuth, eventsRouter);
  app.use('/v1/verify', dashboardOrApiKeyAuth, verifyRouter);
  app.use('/v1/export', dashboardOrApiKeyAuth, exportRouter);

  app.use((_req, res) => {
    res.status(404).json({
      success: false,
      error: { message: 'Route not found', code: 'NOT_FOUND', statusCode: 404 }
    });
  });

  app.use(errorHandler);

  return app;
}

const app = createApp();

if (require.main === module) {
  validateEnv();
  const PORT = Number.parseInt(process.env.PORT || '3000', 10);
  const server = app.listen(PORT, () => {
    logger.info(`API server running on port ${PORT}`);
  });

  async function shutdown(signal: string) {
    logger.info(`${signal} received; starting graceful shutdown`);

    server.closeAllConnections();
    server.close(async () => {
      logger.info('HTTP server closed');
      await closeVerificationQueue();
      await prisma.$disconnect();
      redis.disconnect();
      process.exit(0);
    });

    setTimeout(() => {
      logger.error('Graceful shutdown timeout; forcing exit');
      process.exit(1);
    }, 10000).unref();
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason: unknown) => {
    logger.error({ message: 'Unhandled promise rejection - shutting down', reason });
    void shutdown('unhandledRejection');
  });

  process.on('uncaughtException', (err: Error) => {
    logger.error({ message: 'Uncaught exception - shutting down', error: err.message, stack: err.stack });
    void shutdown('uncaughtException');
  });
}

export default app;
