-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ActivityType" ADD VALUE 'VISIT';
ALTER TYPE "ActivityType" ADD VALUE 'REQUEST';

-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "channelManagerId" TEXT,
ADD COLUMN     "engagementCadenceDays" INTEGER,
ADD COLUMN     "isDormant" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastContactAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Account_channelManagerId_idx" ON "Account"("channelManagerId");

-- CreateIndex
CREATE INDEX "Account_type_isDormant_lastContactAt_idx" ON "Account"("type", "isDormant", "lastContactAt");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_channelManagerId_fkey" FOREIGN KEY ("channelManagerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Data: every existing partner gets a channel manager.
--
-- A partner with nobody responsible never appears in anyone's digest and shows as
-- unmanaged on the register, so leaving these null would mean the feature arrives
-- already looking broken. The account owner is the closest true answer; where it is
-- wrong it is one change per partner, and there are three.
UPDATE "Account"
   SET "channelManagerId" = "ownerId"
 WHERE "type" = 'PARTNER' AND "ownerId" IS NOT NULL AND "channelManagerId" IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Data: give the shipped roles the new `partners` module.
--
-- Without this the feature ships dead. seed.ts deliberately leaves an existing role
-- "as configured" so it never overwrites someone's edits, and permissionFor() reads a
-- missing module as NONE — so on an instance that has already been seeded, nobody,
-- including the Administrator, could open the register.
--
-- Only the four roles that ship are touched, and only where the key is genuinely
-- absent: a custom role someone built stays exactly as they left it and is granted
-- access deliberately from Settings → Roles. Permissions are never widened silently.
UPDATE "Role"
   SET "permissions" = jsonb_set("permissions", '{partners}',
         '{"read":"all","create":true,"update":"all","delete":"all","export":true,"approve":true}'::jsonb)
 WHERE "name" IN ('Administrator', 'Sales Manager')
   AND NOT jsonb_exists("permissions", 'partners');

UPDATE "Role"
   SET "permissions" = jsonb_set("permissions", '{partners}',
         '{"read":"team","create":true,"update":"own","delete":"none","export":true,"approve":false}'::jsonb)
 WHERE "name" = 'Sales Executive'
   AND NOT jsonb_exists("permissions", 'partners');

UPDATE "Role"
   SET "permissions" = jsonb_set("permissions", '{partners}',
         '{"read":"all","create":false,"update":"none","delete":"none","export":true,"approve":false}'::jsonb)
 WHERE "name" = 'Read Only'
   AND NOT jsonb_exists("permissions", 'partners');
