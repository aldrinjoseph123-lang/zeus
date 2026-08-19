-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "emailedAt" TIMESTAMP(3),
ADD COLUMN     "wantsEmail" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ScheduledReport" (
    "id" TEXT NOT NULL,
    "reportKey" TEXT NOT NULL,
    "label" TEXT,
    "frequency" TEXT NOT NULL,
    "weekday" INTEGER,
    "hour" INTEGER NOT NULL DEFAULT 7,
    "format" TEXT NOT NULL DEFAULT 'pdf',
    "recipientEmails" TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Notification_wantsEmail_emailedAt_idx" ON "Notification"("wantsEmail", "emailedAt");

-- AddForeignKey
ALTER TABLE "ScheduledReport" ADD CONSTRAINT "ScheduledReport_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
