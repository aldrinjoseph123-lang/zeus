-- CreateTable
CREATE TABLE "PipelineSnapshot" (
    "id" TEXT NOT NULL,
    "takenOn" DATE NOT NULL,
    "stageId" TEXT NOT NULL,
    "ownerId" TEXT,
    "openCount" INTEGER NOT NULL DEFAULT 0,
    "openNet" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "weighted" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PipelineSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PipelineSnapshot_takenOn_idx" ON "PipelineSnapshot"("takenOn");

-- CreateIndex
CREATE INDEX "PipelineSnapshot_takenOn_ownerId_idx" ON "PipelineSnapshot"("takenOn", "ownerId");

-- AddForeignKey
ALTER TABLE "PipelineSnapshot" ADD CONSTRAINT "PipelineSnapshot_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "Stage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PipelineSnapshot" ADD CONSTRAINT "PipelineSnapshot_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
