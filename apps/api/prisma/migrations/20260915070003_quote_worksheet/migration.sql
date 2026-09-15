-- AlterTable
ALTER TABLE "Quote" ADD COLUMN     "defaultMarkupPct" DECIMAL(6,2);

-- AlterTable
ALTER TABLE "QuoteLine" ADD COLUMN     "fxRate" DECIMAL(12,6) NOT NULL DEFAULT 1,
ADD COLUMN     "isInternal" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "markupPct" DECIMAL(6,2),
ADD COLUMN     "vendorCode" TEXT,
ADD COLUMN     "vendorCurrency" TEXT NOT NULL DEFAULT 'AED',
ADD COLUMN     "vendorId" TEXT,
ADD COLUMN     "vendorUnitCost" DECIMAL(14,4);

-- AddForeignKey
ALTER TABLE "QuoteLine" ADD CONSTRAINT "QuoteLine_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
