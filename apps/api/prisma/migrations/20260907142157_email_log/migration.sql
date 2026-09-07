-- CreateTable
CREATE TABLE "EmailLog" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "to" TEXT[],
    "cc" TEXT[],
    "subject" TEXT NOT NULL,
    "preview" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'other',
    "status" TEXT NOT NULL,
    "error" TEXT,
    "entity" TEXT,
    "entityId" TEXT,
    "userId" TEXT,
    "attachments" TEXT[],
    "payload" JSONB,
    "resentFromId" TEXT,

    CONSTRAINT "EmailLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmailLog_createdAt_idx" ON "EmailLog"("createdAt");

-- CreateIndex
CREATE INDEX "EmailLog_status_createdAt_idx" ON "EmailLog"("status", "createdAt");

-- CreateIndex
CREATE INDEX "EmailLog_entity_entityId_idx" ON "EmailLog"("entity", "entityId");

-- CreateIndex
CREATE INDEX "EmailLog_kind_createdAt_idx" ON "EmailLog"("kind", "createdAt");

-- AddForeignKey
ALTER TABLE "EmailLog" ADD CONSTRAINT "EmailLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
