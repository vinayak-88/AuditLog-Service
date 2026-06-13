import type { ZodSchema } from 'zod';
import { validate } from './validate';

/*
 * CHANGED: validateQuery now delegates to the shared validation factory.
 *
 * This keeps the public helper available for existing routes while removing the
 * duplicate parsing and error-response logic that previously lived here.
 */
export function validateQuery(schema: ZodSchema) {
  return validate('query', schema);
}
