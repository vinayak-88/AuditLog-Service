CREATE TABLE "apps" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "apiKey" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "apps_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "audit_logs" (
  "id" TEXT NOT NULL,
  "appId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "actorType" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "resourceId" TEXT NOT NULL,
  "resourceType" TEXT NOT NULL,
  "metadata" JSONB,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "entryHash" TEXT NOT NULL,
  "previousHash" TEXT NOT NULL,
  "sequenceNumber" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "apps_apiKey_key" ON "apps"("apiKey");
CREATE INDEX "apps_ownerId_idx" ON "apps"("ownerId");
CREATE UNIQUE INDEX "audit_logs_appId_sequenceNumber_key" ON "audit_logs"("appId", "sequenceNumber");
CREATE INDEX "audit_logs_appId_createdAt_idx" ON "audit_logs"("appId", "createdAt");
CREATE INDEX "audit_logs_appId_actorId_idx" ON "audit_logs"("appId", "actorId");
CREATE INDEX "audit_logs_appId_resourceId_idx" ON "audit_logs"("appId", "resourceId");
CREATE INDEX "audit_logs_appId_action_idx" ON "audit_logs"("appId", "action");

ALTER TABLE "audit_logs"
  ADD CONSTRAINT "audit_logs_appId_fkey"
  FOREIGN KEY ("appId") REFERENCES "apps"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
