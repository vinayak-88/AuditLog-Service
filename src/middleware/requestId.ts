import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';

declare global {
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const headerRequestId = req.headers['x-request-id'];
  const id = Array.isArray(headerRequestId) ? headerRequestId[0] : headerRequestId || randomUUID();
  req.requestId = id;
  req.id = id;
  req.headers['x-request-id'] = id;
  res.setHeader('x-request-id', id);
  next();
}
