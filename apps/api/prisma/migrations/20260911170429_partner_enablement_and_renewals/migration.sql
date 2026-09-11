-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "partnerAccountId" TEXT;

-- CreateTable
CREATE TABLE "PartnerEnablement" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "enabledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "recordedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerEnablement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PartnerEnablement_expiresAt_idx" ON "PartnerEnablement"("expiresAt");

-- CreateIndex
CREATE INDEX "PartnerEnablement_vendorId_idx" ON "PartnerEnablement"("vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerEnablement_partnerId_vendorId_key" ON "PartnerEnablement"("partnerId", "vendorId");

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_partnerAccountId_fkey" FOREIGN KEY ("partnerAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerEnablement" ADD CONSTRAINT "PartnerEnablement_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerEnablement" ADD CONSTRAINT "PartnerEnablement_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerEnablement" ADD CONSTRAINT "PartnerEnablement_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Data: every existing subscription inherits the partner from the deal that sold it.
--
-- The design said twice that this was impossible — that a subscription knew only its
-- customer and its product, so the renewal book would start empty and fill only as new
-- terms were written. Both times a case-sensitive search had missed "sourceDealId",
-- which every creation path already sets. So the history is here, and there is no reason
-- to start blind: only subscriptions entered with no deal at all stay unassigned.
UPDATE "Subscription" s
   SET "partnerAccountId" = d."partnerAccountId"
  FROM "Deal" d
 WHERE d.id = s."sourceDealId"
   AND d."partnerAccountId" IS NOT NULL
   AND s."partnerAccountId" IS NULL;
