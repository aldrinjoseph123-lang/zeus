-- CreateTable
CREATE TABLE "DealSnapshot" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "weekOf" DATE NOT NULL,
    "stageId" TEXT NOT NULL,
    "ownerId" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "status" TEXT NOT NULL,
    "stageOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DealSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DealSnapshot_weekOf_idx" ON "DealSnapshot"("weekOf");

-- CreateIndex
CREATE UNIQUE INDEX "DealSnapshot_dealId_weekOf_key" ON "DealSnapshot"("dealId", "weekOf");
