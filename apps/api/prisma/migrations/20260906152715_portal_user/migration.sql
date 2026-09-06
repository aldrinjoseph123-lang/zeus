-- DropIndex
DROP INDEX "Account_domain_trgm_idx";

-- DropIndex
DROP INDEX "Account_name_trgm_idx";

-- DropIndex
DROP INDEX "Contact_firstName_trgm_idx";

-- DropIndex
DROP INDEX "Contact_lastName_trgm_idx";

-- DropIndex
DROP INDEX "Deal_name_trgm_idx";

-- DropIndex
DROP INDEX "Deal_reference_trgm_idx";

-- DropIndex
DROP INDEX "Lead_company_trgm_idx";

-- DropIndex
DROP INDEX "Lead_firstName_trgm_idx";

-- DropIndex
DROP INDEX "Lead_lastName_trgm_idx";

-- CreateTable
CREATE TABLE "PortalUser" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "enabledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disabledAt" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "linkTokenHash" TEXT,
    "linkExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PortalUser_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PortalUser_contactId_key" ON "PortalUser"("contactId");

-- CreateIndex
CREATE UNIQUE INDEX "PortalUser_email_key" ON "PortalUser"("email");

-- CreateIndex
CREATE INDEX "PortalUser_email_idx" ON "PortalUser"("email");

-- AddForeignKey
ALTER TABLE "PortalUser" ADD CONSTRAINT "PortalUser_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
