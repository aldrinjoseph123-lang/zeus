# Zeus

CRM for Protect24x7 — cybersecurity product distribution and managed services, UAE.

Self-hosted, no licence cost, no SaaS dependency. Runs on any Linux box with Docker.

---

## What it does

**Sell** — leads with source attribution, a drag-and-drop deal board, per-stage win
probability, and one-click status updates for the sales team.

**Both sides of the business** — every deal has an *end customer*; a *partner* can be
attached when one introduced it. Reporting splits direct from partner-sourced revenue,
and product reselling from managed services.

**Vendor deal registration** — register an opportunity with a vendor, record the
approved discount and the expiry date, and get warned before it lapses.

**Duplicate detection** — the customer's web domain is the key. Creating a lead,
account, contact or deal that collides with an existing record raises a domain alert
listing what already exists and who owns it, before anything is saved. Free mailbox
domains (gmail, outlook…) are excluded so SME leads don't all match each other.

**The full commercial chain** — quote → customer PO → supplier PO → tax invoice →
payment → credit note, on one platform. A supplier PO raised from a won quote carries
the lines across *at cost*, because that is what you pay the vendor.

**Money in AED** — line items from a vendor catalog, VAT charged per line so a
zero-rated export sits beside a standard-rated service on the same document, cost and
margin per line, branded PDFs. Cost and margin are hidden from roles that shouldn't see
them.

**Payments both ways** — every receipt and disbursement is its own row with date,
method and reference, so part-payments and advances reconcile on their own. Balances
are always derived, never typed. A reminder fires a configurable number of days
(5 by default) before an invoice falls due *and* before a supplier PO does — so you
chase the customer and pay the vendor before the date, not after it.

**Visualisation** — the dashboard is the point: pipeline funnel, weighted forecast
against a quarterly target, revenue by expected close month, source attribution with win
rate, deal ageing, direct-vs-partner split, rep leaderboard, and a "needs attention"
panel for stale accounts, stuck deals, expiring registrations and overdue tasks.

**RBAC** — per-module read/create/update/delete with a record scope
(`own` / `team` / `all`), plus field-level hiding for cost and margin. Four roles ship;
all of them are editable and you can add more without touching code.

**Office 365** — one Entra app registration powers Microsoft sign-in, sending quotes and
alerts from a shared Outlook mailbox, adaptive cards into Teams channels, and offsite
database backups to OneDrive or SharePoint.

**Backups you can actually rely on** — three kinds (whole-database, business data, and
configuration) on their own schedules, AES-256-GCM encrypted, written to the server, a
NAS path and OneDrive independently, with grandfather-father-son retention. Zeus
verifies its own backups weekly by restoring one into a throwaway database, alerts if a
backup stops happening, and can restore a single module back into the live system with
a dry-run diff and an automatic safety copy first. See [Backups](#backups) and
[Disaster recovery](#disaster-recovery).

**Reports** — 14 built-in reports, each exportable to Excel and PDF, including a VAT
summary and a receivables ageing.

**Import** — CSV/XLSX wizard with column auto-mapping, duplicate strategy, and a dry run
that shows exactly what would happen before anything is written.

**Files** — drag-and-drop attachments on any account, contact, lead or deal. Purchase
orders, signed quotes, vendor confirmations. Downloads go through the API so record
permissions still apply, and nothing is ever served inline from the app's origin.

**Custom fields** — add a field to any module from Settings, no migration and no
redeploy. It appears on the record form and detail page immediately, and values are
validated against the declared type on save.

---

## Install on a Linux server

Requirements: Docker Engine 24+ and the Compose plugin. Two CPU cores and 4 GB RAM is
plenty for a team of this size.

```bash
git clone <your-repo> zeus && cd zeus
cp .env.example .env
```

Fill in `.env`:

```bash
openssl rand -hex 32     # paste into APP_SECRET
openssl rand -hex 16     # paste into POSTGRES_PASSWORD
```

Set `APP_URL` and `ZEUS_DOMAIN` to your hostname (or `ZEUS_DOMAIN=:80` for a LAN-only
install), then:

```bash
docker compose up -d --build
```

The app container waits for Postgres, applies the schema, seeds roles, pipeline stages,
settings and the five managed service lines, and starts. Watch it come up:

```bash
docker compose logs -f app
```

Sign in at `APP_URL` with `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD`, then change the
password under Settings → My account.

### Day-two commands

```bash
docker compose logs -f app          # tail the API
docker compose exec app node dist/seed.js   # re-run seed (safe, idempotent)
docker compose pull && docker compose up -d --build   # upgrade
docker compose down                 # stop (data volumes survive)
```

Manual database dump, independent of the OneDrive job:

```bash
docker compose exec db pg_dump -U zeus zeus | gzip > zeus-$(date +%F).sql.gz
```

---

## Connecting Office 365

One app registration covers everything. In the **Microsoft Entra admin centre**:

1. **App registrations → New registration.** Name it `Zeus CRM`, single tenant.
2. **Authentication → Add a platform → Web.** Add both redirect URIs (Zeus shows you the
   exact values in Settings → Microsoft 365):
   - `https://<your-domain>/api/auth/microsoft/callback`
   - `https://<your-domain>/api/auth/microsoft/consent-callback`
3. **Certificates & secrets → New client secret.** Copy the *Value* immediately.
4. **API permissions → Microsoft Graph → Application permissions**, add:
   - `Mail.Send` — sending quotes and alerts
   - `Files.ReadWrite.All` — OneDrive/SharePoint backup
   - `User.Read.All` — verifying the sending mailbox
5. In Zeus: **Settings → Microsoft 365**, paste the tenant ID, client ID and secret, set
   the sending mailbox (e.g. `crm@protect24x7.ae`) and the backup OneDrive account, then
   **Save**.
6. Press **Grant admin consent** — one click, one approval screen, done.
7. Press **Test connection**, then **Send test email** to prove it end to end.

The client secret is encrypted at rest with `APP_SECRET`. Rotate the secret in Entra and
paste the new value; nothing else changes.

### Teams notifications

In the Teams channel you want alerts in: **⋯ → Workflows → "Post to a channel when a
webhook request is received"**, then copy the generated URL into
**Settings → Notifications → Add webhook**. Press **Test** to post a card.

Each event (deal won, deal lost, stale account, stuck deal, registration expiring,
overdue task, backup failed, target at risk…) has its own row where you choose the
channels, the threshold in days, and who receives it.

### Backups to OneDrive

Set the backup account and folder in Settings → Microsoft 365, then turn on
`backup.enabled` and set `backup.cron` in Settings → Backups. OneDrive is one of three
independent destinations — if the upload fails, the local (and NAS) copies still exist,
the run is recorded as `partial`, and you get a notification. Retention, encryption,
the other two backup kinds and the restore paths are all covered in
[Backups](#backups).

---

## Local development

Needs Node 22+ and a PostgreSQL you can reach.

```bash
npm install
cp apps/api/.env.example apps/api/.env    # point DATABASE_URL at your database
npm run db:migrate                        # applies prisma/migrations in order
npm run db:seed
npm run dev            # API on :4000, web on :5174
```

### Changing the schema

The database is versioned by the migrations in `apps/api/prisma/migrations`. Edit
`schema.prisma`, then:

```bash
npm run db:migrate:dev --workspace=apps/api -- --name what_you_changed
```

That writes a new migration, applies it locally and regenerates the client. Commit the
migration alongside the schema change — deployments run `prisma migrate deploy`, which
replays exactly those files and refuses anything it does not recognise.

`db:push` still exists for throwaway experiments, but never point it at a database
holding real records: it reshapes tables to match the schema and will drop a column
without a way back.

## Tests

```bash
npm test                 # unit self-checks, no database
npm run test:api         # integration suite against a real database
```

The self-checks cover VAT and margin arithmetic, domain and company-name normalisation,
the CSV parser, renewal term dates and the RBAC rules — all pure functions, no database.

The integration suite drives the real Fastify app with a real PostgreSQL behind it and
asserts what the HTTP layer actually does: that a rep cannot read another rep's deals,
that an issued invoice refuses to change its figures, that approval gates hold when the
endpoint is called directly, and that a renewal chain rolls forward correctly. It uses
its own database (`zeus_test` by default) and never touches your development data.

```
apps/
  api/          Fastify + Prisma + PostgreSQL
    prisma/     schema
    src/
      auth/     Entra OIDC, sessions, RBAC model
      routes/   one file per module
      services/ Graph, Teams, notifications, dedupe, PDF, Excel, backup
      jobs/     cron: reminders, stale digests, expiry, backup
  web/          React + Vite + Tailwind, Recharts
```

In production the API serves the built frontend from the same origin, so there is one
container and no CORS to configure.

---

## UAE tax documents

**There is no government-approved invoice template.** The FTA does not certify layouts —
it mandates *content*. Article 59 of the Executive Regulations to Federal Decree-Law
No. 8 of 2017 lists what a Tax Invoice must carry, and Zeus prints all of it:

- the words **Tax Invoice**, and a sequential unique number
- your name, address and TRN; the customer's name, address and TRN
- issue date, and the date of supply when it differs
- per line: description, quantity, unit price and **the tax rate**
- any discount, the taxable amount, the tax payable and the gross payable
- a reverse-charge statement where the recipient accounts for the VAT
- the exchange rate and AED equivalents when you bill in another currency

**Tax Credit Notes** carry their own numbering series, reference the invoice they
correct and state the reason — required whenever you reduce the value of an issued
invoice.

Quotes and purchase orders are commercial documents with no FTA content requirements.

Before you send anything, Zeus shows what is missing — your TRN, the customer's TRN on
an invoice above AED 10,000, a missing exchange rate. **Once issued, an invoice's figures
are locked**: you correct it with a credit note, which is what keeps the numbering
sequence and your filed VAT intact.

E-invoicing is being introduced in the UAE on a phased Peppol model. The data model
carries the fields it needs, but confirm the current timetable and your obligations with
your tax advisor before relying on any date.

---

## Changing the defaults

Nothing important is hard-coded. **Settings** covers:

| Screen | What it changes |
| --- | --- |
| Company | Letterhead, TRN, address, place of supply, bank details |
| Finance & VAT | Currency, VAT rate and label, validity, payment terms, reminder lead time, per-document terms text, numbering prefixes |
| Dropdown lists | Lead sources, lost reasons, industries, emirates, units, product categories, ratings |
| Pipelines | Stage names, order, win probability, colour, and the "stuck" threshold per stage |
| Users & teams | Accounts, roles, reporting lines; teams drive the `team` permission scope |
| Roles & permissions | Per-module scope and field-level hiding for cost and margin |
| Targets | Company-wide and per-rep quarterly targets |
| Notifications | Which events fire, on which channel, at what threshold, to whom |
| Microsoft 365 | Tenant credentials, sending mailbox, backup destination, schedule |
| Custom fields | Extra fields on deals, accounts, contacts, leads and catalog items |
| Audit trail | Every create, update, delete, export, sign-in and integration change |

**Custom fields** support text, long text, number, currency, date, dropdown,
multi-select, checkbox, URL and email. Values live in each record's `customFields`
column, so a new field needs no migration. Retiring a field hides it everywhere but
keeps the data — turn it back on and the values return.

---

## Design

Zeus uses the Protect24x7 design language — Chakra Petch, `#0a0a0a` ink, `#e11d2e`
accent, 2–4px radii, tight uppercase micro-labels. All of it lives as CSS variables in
`apps/web/src/theme.css`; change a token there and the whole app follows.

---

## Security notes

- Sessions are httpOnly, SameSite=Lax cookies signed with `APP_SECRET`; length is
  configurable and they expire on their own.
- Passwords are bcrypt hashed. Sign-in is rate limited and does not reveal whether an
  account exists.
- The Microsoft client secret is AES-256-GCM encrypted at rest.
- Every write is recorded in the audit trail with a field-level diff.
- Accounts, contacts, leads and deals are soft-deleted, so a mis-click is recoverable.
- Uploads are stored under generated names, never the client's filename; executable
  extensions are refused, and downloads are forced as attachments with `nosniff`.
- Custom field values are filtered against the defined schema on write, so the JSON
  column cannot be used as arbitrary storage.
- Postgres is not published to the host; only the app container can reach it.
- Backup files are AES-256-GCM encrypted at rest by default (see Backups below).

Keep `.env` out of version control. **`APP_SECRET` is now part of your backup**: it
derives the key that encrypts every backup file, so a backup without it cannot be
restored. Escrow it somewhere separate from the server — a password manager, not the
same disk.

---

## Backups

Three kinds, each on its own schedule, all configured in **Settings → Backups**:

| Kind | What it holds | When it runs |
|---|---|---|
| **Physical** | `pg_dump` of the whole database — the restore-anywhere copy | Nightly, on the cron you set |
| **Logical** | Business tables (accounts, deals, quotes, invoices…) as NDJSON | Daily, inside the maintenance window |
| **Config** | How Zeus behaves — settings, roles, pipelines, custom fields | Weekly, inside the maintenance window |

- **Encrypted at rest.** AES-256-GCM, keyed from `APP_SECRET`. On by default; files
  get a `.enc` suffix and a 🔒 in the backups table.
- **Up to three destinations per run**, each independent — one failing never stops
  another: the server itself (always), a mounted NAS/external path (set
  `backup.nasPath`, blank = off), and OneDrive/SharePoint when Microsoft 365 is
  connected. The table records which destinations a given run actually reached.
- **Grandfather-father-son retention.** A run is tagged daily/weekly/monthly from the
  calendar when it is created, and each tier is pruned to its own count — so a monthly
  copy from three months ago survives a week of daily churn.
- **Skips itself when nothing changed.** Logical and config runs compare row counts
  against the previous run and record a `skipped` row rather than writing an identical
  file. A skip is visible in the table, not silence.
- **Tells you when it stops happening.** If a kind has no successful (or legitimately
  skipped) run inside its grace window, admins get a `Backup overdue` alert.
- **Checks itself weekly.** Every Monday Zeus restores the latest physical backup into
  a throwaway database to prove it is genuinely restorable, and re-counts the rows in
  the latest logical/config files against what was recorded when they were written.
  Anything that fails raises one alert for the sweep.

Three buttons on the Backups page, and what each actually proves:

- **Validate** — the file decrypts and decompresses into something shaped like a
  database dump. Cheap, touches no database.
- **Verify (restore)** — restores the latest physical backup into a real throwaway
  database and counts the tables, then drops it. This is the one that proves a backup
  would actually work.
- **Check parity** (per row, logical/config only) — re-counts the records inside the
  file against the counts recorded when it was written, catching a file that has been
  truncated or corrupted since.

### Restoring one module, not the whole database

A logical or config backup row offers **Restore**, which puts selected modules back
into the live database without touching anything else. It shows a dry-run diff first
(how many records would be created vs updated), takes a fresh safety backup
automatically before applying anything, then upserts by id in dependency order.
Nothing is ever deleted — a restore only creates or updates. Invoices and purchase
orders need the elevated Backups permission on top of the normal one.

---

## Disaster recovery

If the server is gone, this is the procedure. It has been rehearsed end to end — a
real encrypted backup restored into a fresh database, with a real API booted against
it and confirmed serving correct data.

**You need two things: a backup file, and the `APP_SECRET` that encrypted it.**

1. **Find the newest physical backup.** In order of preference: the OneDrive/SharePoint
   folder (survives the server dying), the NAS path, or `BACKUP_DIR` on the server.
   The filename tells you what it is — `zeus-physical-<timestamp>.sql.gz.enc`.

2. **Decrypt it.** The file is `[12-byte IV][16-byte GCM tag][ciphertext]`, AES-256-GCM,
   with the key derived as `scrypt(APP_SECRET, 'zeus-backups', 32)`. This script needs
   nothing but Node — deliberately, because in a real disaster Zeus itself may be
   exactly what you no longer have:

   ```js
   // dr-decrypt.mjs — node dr-decrypt.mjs <in.enc> <out.sql.gz> <APP_SECRET>
   import { readFileSync, writeFileSync } from 'node:fs';
   import { scryptSync, createDecipheriv } from 'node:crypto';
   const [, , inFile, outFile, appSecret] = process.argv;
   const raw = readFileSync(inFile);
   const decipher = createDecipheriv('aes-256-gcm',
     scryptSync(appSecret, 'zeus-backups', 32), raw.subarray(0, 12));
   decipher.setAuthTag(raw.subarray(12, 28));
   writeFileSync(outFile, Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]));
   ```

   Then `gunzip out.sql.gz`. (An unencrypted backup has no `.enc` suffix — skip
   straight to gunzip.)

3. **Restore into a fresh database.**

   ```bash
   createdb zeus_restored
   psql -d zeus_restored -v ON_ERROR_STOP=0 -f out.sql
   ```

   `ON_ERROR_STOP=0` is deliberate: a dump replays harmless notices (roles that already
   exist, and similar) that should not abort a recovery. Judge success by the table and
   row counts, not by silence.

4. **Check it before trusting it.**

   ```bash
   psql -d zeus_restored -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'"
   psql -d zeus_restored -c 'SELECT count(*) FROM "Account"'
   ```

   Expect ~45 tables and row counts that match what the business had.

5. **Point Zeus at it.** Set `DATABASE_URL` to the restored database and start the app.
   `docker compose up -d` with the new URL in `.env`, or `PORT=4100 DATABASE_URL=… npm
   run dev` for a throwaway check first. Sign in and open the dashboard — if the
   pipeline figures look right, the recovery is real.

**What the rehearsal proved:** a 59 KB encrypted backup decrypted with the standalone
script above, restored to 45 tables with row counts matching the source exactly, and a
real API booted against it and served accounts, deals, invoices, products, reports and
dashboard aggregates — all 200s, correct numbers.

**What it did not prove:** restoring onto a *different machine* (same host, same
Postgres 17 throughout) and OneDrive download as the file source (the drill used a
local file). Both are worth rehearsing once on the real production host.
