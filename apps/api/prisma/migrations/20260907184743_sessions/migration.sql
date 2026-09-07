-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "userId" TEXT,
    "portalUserId" TEXT,
    "viewingAsId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,
    "ip" TEXT,
    "device" TEXT,
    "city" TEXT,
    "region" TEXT,
    "country" TEXT,
    "isp" TEXT,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Session_userId_revokedAt_lastSeenAt_idx" ON "Session"("userId", "revokedAt", "lastSeenAt");

-- CreateIndex
CREATE INDEX "Session_portalUserId_revokedAt_lastSeenAt_idx" ON "Session"("portalUserId", "revokedAt", "lastSeenAt");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_portalUserId_fkey" FOREIGN KEY ("portalUserId") REFERENCES "PortalUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_viewingAsId_fkey" FOREIGN KEY ("viewingAsId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
