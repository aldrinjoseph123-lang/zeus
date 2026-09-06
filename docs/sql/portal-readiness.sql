-- Portal plan, phase 0 — data readiness.
--
-- Before building the partner and customer portal, find out whether the data it would
-- show actually exists. Read-only. Run on production from the server:
--
--   cd ~/zeus && docker compose exec -T db psql -U zeus zeus < docs/sql/portal-readiness.sql
--
-- If most of these are zero, the first job is data entry (partner contacts with emails,
-- expiry dates on registrations), not software.

\echo '── Partners ───────────────────────────────────────────────'
select count(*)                                         as partner_accounts,
       count(*) filter (where exists (
         select 1 from "Contact" c
          where c."accountId" = a.id and c."deletedAt" is null and c."erasedAt" is null
            and coalesce(c.email, '') <> ''))            as with_a_contact_email
  from "Account" a
 where a.type = 'PARTNER' and a."deletedAt" is null;

\echo '── Partner-side registrations ─────────────────────────────'
select r.status,
       count(*)                                          as registrations,
       count(*) filter (where r."expiresAt" is not null) as with_expiry,
       count(*) filter (where r."partnerContactId" is not null) as with_partner_contact
  from "DealRegistration" r
  join "Deal" d on d.id = r."dealId" and d."deletedAt" is null
 where r.side = 'PARTNER'
 group by r.status
 order by r.status;

\echo '── Vendor-side registrations (the "locked with the vendor" half) ──'
select r.status, count(*) as registrations, count(*) filter (where r."expiresAt" is not null) as with_expiry
  from "DealRegistration" r
  join "Deal" d on d.id = r."dealId" and d."deletedAt" is null
 where r.side = 'VENDOR'
 group by r.status
 order by r.status;

\echo '── Customers ──────────────────────────────────────────────'
select count(*)                                                     as customer_accounts,
       count(*) filter (where exists (
         select 1 from "Subscription" s
          where s."accountId" = a.id and s."deletedAt" is null
            and s.status in ('ACTIVE', 'EXPIRING')))                 as with_live_subscription,
       count(*) filter (where exists (
         select 1 from "Subscription" s
          where s."accountId" = a.id and s."deletedAt" is null
            and s.status in ('ACTIVE', 'EXPIRING'))
         and exists (
         select 1 from "Contact" c
          where c."accountId" = a.id and c."deletedAt" is null and c."erasedAt" is null
            and coalesce(c.email, '') <> ''))                        as live_and_contactable
  from "Account" a
 where a.type = 'CUSTOMER' and a."deletedAt" is null;

\echo '── Duplicate contact emails (a login key must be unique) ──'
select lower(email) as email, count(*) as contacts
  from "Contact"
 where "deletedAt" is null and coalesce(email, '') <> ''
 group by lower(email)
having count(*) > 1
 order by contacts desc
 limit 20;
