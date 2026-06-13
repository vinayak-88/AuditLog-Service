import type { NextFunction, Request, Response } from 'express';
import type { ZodSchema } from 'zod';

type ValidatedRequest = Request & {
  body: unknown;
  query: unknown;
};

/*
 * CHANGED: validateBody and validateQuery now share this one factory.
 *
 * The old middleware files had the same parsing, error response, and request
 * mutation logic duplicated with only `req.body` versus `req.query` differing.
 * Keeping the behavior here means future validation changes only need to be made
 * once while preserving the existing validateBody/validateQuery import paths.
 */
export function validate(field: 'body' | 'query', schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[field]);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: {
          message: 'Validation failed',
          code: 'VALIDATION_ERROR',
          statusCode: 400,
          details: result.error.flatten()
        }
      });
    }

    (req as ValidatedRequest)[field] = result.data;
    return next();
  };
}
