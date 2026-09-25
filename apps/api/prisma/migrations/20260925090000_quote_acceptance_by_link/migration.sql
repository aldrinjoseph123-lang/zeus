-- The customer's own way to accept a quotation: a link in the email. The token is the
-- capability; who clicked, and from where, is kept for the record.
ALTER TABLE "Quote"
  ADD COLUMN "acceptToken" TEXT,
  ADD COLUMN "acceptTokenExpiresAt" TIMESTAMP(3),
  ADD COLUMN "acceptedByName" TEXT,
  ADD COLUMN "acceptedByEmail" TEXT,
  ADD COLUMN "acceptedFromIp" TEXT;

CREATE UNIQUE INDEX "Quote_acceptToken_key" ON "Quote"("acceptToken");
