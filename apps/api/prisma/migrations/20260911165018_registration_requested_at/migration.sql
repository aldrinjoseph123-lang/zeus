-- AlterTable
ALTER TABLE "DealRegistration" ADD COLUMN     "requestedAt" TIMESTAMP(3);

-- Existing registrations have no record of when the partner actually asked, and inventing
-- one would put a fictional zero-day response time into the report this field exists to
-- feed. They stay null; the number starts from the ones recorded after this ships.
