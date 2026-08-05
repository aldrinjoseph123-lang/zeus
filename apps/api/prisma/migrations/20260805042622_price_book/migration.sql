-- CreateTable
CREATE TABLE "PriceEntry" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "vendorId" TEXT,
    "cost" DECIMAL(14,2) NOT NULL,
    "listPrice" DECIMAL(14,2),
    "currency" TEXT NOT NULL DEFAULT 'AED',
    "vendorSku" TEXT,
    "minQuantity" DECIMAL(12,2) NOT NULL DEFAULT 1,
    "validFrom" TIMESTAMP(3),
    "validTo" TIMESTAMP(3),
    "dealId" TEXT,
    "registrationId" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PriceEntry_productId_dealId_idx" ON "PriceEntry"("productId", "dealId");

-- CreateIndex
CREATE INDEX "PriceEntry_vendorId_idx" ON "PriceEntry"("vendorId");

-- CreateIndex
CREATE INDEX "PriceEntry_validTo_idx" ON "PriceEntry"("validTo");

-- AddForeignKey
ALTER TABLE "PriceEntry" ADD CONSTRAINT "PriceEntry_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceEntry" ADD CONSTRAINT "PriceEntry_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceEntry" ADD CONSTRAINT "PriceEntry_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceEntry" ADD CONSTRAINT "PriceEntry_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "DealRegistration"("id") ON DELETE SET NULL ON UPDATE CASCADE;
