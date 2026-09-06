-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "portalLogo" TEXT,
ADD COLUMN     "portalOverrides" JSONB NOT NULL DEFAULT '{}';
