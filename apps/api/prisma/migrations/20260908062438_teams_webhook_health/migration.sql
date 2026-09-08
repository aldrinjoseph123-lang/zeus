-- AlterTable
ALTER TABLE "TeamsWebhook" ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "lastPostAt" TIMESTAMP(3);
