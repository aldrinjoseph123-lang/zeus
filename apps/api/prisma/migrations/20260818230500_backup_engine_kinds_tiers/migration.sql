-- AlterTable
ALTER TABLE "BackupRun" ADD COLUMN     "checksum" TEXT,
ADD COLUMN     "destinations" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "encrypted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'physical',
ADD COLUMN     "rowCounts" JSONB,
ADD COLUMN     "tier" TEXT NOT NULL DEFAULT 'daily';

-- Backfill the new plural destinations[] from the old single-value column before
-- dropping it, so existing history is not silently lost.
UPDATE "BackupRun" SET "destinations" = ARRAY["destination"] WHERE "destination" IS NOT NULL;

ALTER TABLE "BackupRun" ALTER COLUMN "destinations" SET NOT NULL;
ALTER TABLE "BackupRun" ALTER COLUMN "destinations" SET DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "BackupRun" DROP COLUMN "destination";

-- CreateIndex
CREATE INDEX "BackupRun_kind_tier_status_idx" ON "BackupRun"("kind", "tier", "status");
