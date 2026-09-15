-- AlterTable
ALTER TABLE "ImportJob" ADD COLUMN     "undo" JSONB,
ADD COLUMN     "undoneAt" TIMESTAMP(3),
ADD COLUMN     "undoneById" TEXT;
