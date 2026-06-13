import type { ZodSchema } from 'zod';
import { validate } from './validate';

/*
 * CHANGED: validateBody is now a thin wrapper around the shared validation
 * factory so body/query validation stay behaviorally identical without
 * duplicating the same middleware implementation in two files.
 */
export function validateBody(schema: ZodSchema) {
  return validate('body', schema);
}
