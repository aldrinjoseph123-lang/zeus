-- CreateTable
CREATE TABLE "AccessRequest" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "note" TEXT,
    "ip" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "handledById" TEXT,
    "handledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccessRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccessRequest_status_createdAt_idx" ON "AccessRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AccessRequest_email_idx" ON "AccessRequest"("email");

-- AddForeignKey
ALTER TABLE "AccessRequest" ADD CONSTRAINT "AccessRequest_handledById_fkey" FOREIGN KEY ("handledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
