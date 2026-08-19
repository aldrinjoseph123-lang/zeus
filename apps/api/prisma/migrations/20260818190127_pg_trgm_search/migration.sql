-- Global search (the ⌘K box) runs plain ILIKE '%term%' queries against these columns
-- (routes/deals.ts, accounts.ts, leads.ts, contacts.ts). None of them were indexed, so
-- every keystroke was a sequential scan. pg_trgm lets a GIN index serve an ILIKE '%...%'
-- query directly — no application code changes, Postgres just stops seq-scanning.
-- Not modelled in schema.prisma: Prisma's declarative index types add a preview-feature
-- flag for something this narrow: four raw statements, applied once, never touched again.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "Deal_name_trgm_idx" ON "Deal" USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Deal_reference_trgm_idx" ON "Deal" USING gin (reference gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Account_name_trgm_idx" ON "Account" USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Account_domain_trgm_idx" ON "Account" USING gin (domain gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Contact_firstName_trgm_idx" ON "Contact" USING gin ("firstName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Contact_lastName_trgm_idx" ON "Contact" USING gin ("lastName" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Lead_firstName_trgm_idx" ON "Lead" USING gin ("firstName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Lead_lastName_trgm_idx" ON "Lead" USING gin ("lastName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Lead_company_trgm_idx" ON "Lead" USING gin (company gin_trgm_ops);
