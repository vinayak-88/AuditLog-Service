/*
 * CHANGED: add the idempotency key storage expected by events.ts.
 *
 * The column is nullable so existing clients remain compatible. The composite
 * unique index scopes keys per app and lets PostgreSQL enforce exactly-once
 * inserts for concurrent retries that share the same idempotency key.
 */
ALTER TABLE "audit_logs" ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "audit_logs_unique_app_idempotency_key_key"
  ON "audit_logs"("appId", "idempotencyKey");
