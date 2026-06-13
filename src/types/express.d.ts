import type { App } from '@prisma/client';

declare global {
  namespace Express {
    interface Request {
      /*
       * CHANGED: request correlation IDs are attached by app.ts middleware.
       *
       * Declaring req.id here lets downstream middleware and route handlers use
       * the generated or upstream-provided x-request-id without unsafe casts.
       */
      id: string;
      requestId: string;
      auditApp?: App;
    }
  }
}

export {};
