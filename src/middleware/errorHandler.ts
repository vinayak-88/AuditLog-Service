import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import logger from '../config/logger';

export class AppError extends Error {
  statusCode: number;
  code: string;
  isOperational: boolean;

  constructor(message: string, statusCode = 500, code = 'INTERNAL_ERROR') {
    super(message);
    Object.setPrototypeOf(this, AppError.prototype);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
  }
}

export function errorHandler(err: Error & Partial<AppError>, req: Request, res: Response, _next: NextFunction) {
  /*
   * CHANGED: route-local Zod parsing, such as activity resourceId validation,
   * now follows the same 400 response contract as validateBody/validateQuery.
   *
   * Without this branch, a ZodError thrown inside asyncHandler would be treated
   * as an unexpected 500 even though it represents invalid client input.
   */
  if (err instanceof ZodError) {
    logger.warn({
      message: 'Validation failed',
      requestId: req.requestId,
      path: req.path,
      method: req.method,
      details: err.flatten()
    });

    return res.status(400).json({
      success: false,
      error: {
        message: 'Validation failed',
        code: 'VALIDATION_ERROR',
        statusCode: 400,
        details: err.flatten()
      }
    });
  }

  logger.error({
    message: err.message,
    requestId: req.requestId,
    stack: err.stack,
    path: req.path,
    method: req.method
  });

  const statusCode = err.statusCode || 500;

  return res.status(statusCode).json({
    success: false,
    error: {
      message: err.isOperational ? err.message : 'Internal server error',
      code: err.code || 'INTERNAL_ERROR',
      statusCode
    }
  });
}
