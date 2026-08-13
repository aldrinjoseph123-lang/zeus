-- CreateTable
CREATE TABLE "TransferJob" (
    "id" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "byUserId" TEXT,
    "modules" TEXT[],
    "counts" JSONB NOT NULL,
    "snapshot" JSONB NOT NULL,
    "deactivated" BOOLEAN NOT NULL DEFAULT false,
    "reversedAt" TIMESTAMP(3),
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransferJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TransferJob_fromUserId_idx" ON "TransferJob"("fromUserId");

-- CreateIndex
CREATE INDEX "TransferJob_at_idx" ON "TransferJob"("at");
