-- AlterTable
ALTER TABLE "Attachment" ADD COLUMN     "quoteId" TEXT;

-- CreateIndex
CREATE INDEX "Attachment_quoteId_idx" ON "Attachment"("quoteId");

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE SET NULL ON UPDATE CASCADE;
