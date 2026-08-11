-- CreateTable
CREATE TABLE "SystemLog" (
    "id" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "context" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SystemLog_at_idx" ON "SystemLog"("at");

-- CreateIndex
CREATE INDEX "SystemLog_level_at_idx" ON "SystemLog"("level", "at");

-- CreateIndex
CREATE INDEX "SystemLog_source_at_idx" ON "SystemLog"("source", "at");
