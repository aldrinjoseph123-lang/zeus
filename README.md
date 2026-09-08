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
./docker/deploy.sh v1.2.3           # update to a release — see below
docker compose down                 # stop (data volumes survive)
```

Manual database dump, independent of the OneDrive job:

```bash
docker compose exec db pg_dump -U zeus zeus | gzip > zeus-$(date +%F).sql.gz
```

### Releases and updating production

Production never builds code and never runs `main`. It runs an image that CI built,
booted, migrated, seeded, served traffic from and header-checked — then published
under a release tag.

**Staging is your workstation.** Everything that writes test data runs there:

```bash
npm test                                   # the full suite, both workspaces
cd apps/api && UAT_URL=http://localhost:4000 UAT_EMAIL=… UAT_PASSWORD=… npm run uat
```

`npm run uat` walks a real account → deal → quote → invoice → payment chain through
the HTTP API, goes through the approval sign-off with a second user, checks the
dashboard, reports, integrity sweep and a real backup, and removes everything it
created. It writes, so it is for staging only — never point it at production.

**Cut a release** once the branch is green:

```bash
git tag v1.2.3 && git push --tags
```

CI builds the image again from that tag, runs the same boot and header checks, and
only then pushes `ghcr.io/aldrinjoseph123-lang/zeus:v1.2.3`. A red run publishes
nothing.

One-time: the first push creates the package as *private*. Either make it public
(GitHub → Packages → zeus → Package settings → Change visibility — the repo is
public, so there is nothing to hide) or sign the server in with a read-only token
(`docker login ghcr.io`). Public is simpler.

**Update production** from the checked-out repo on the server:

```bash
./docker/deploy.sh v1.2.3
```

It dumps the database to `backups/pre-deploy-v1.2.3-<time>.sql.gz`, checks the repo
out at the tag so `docker-compose.yml` and the Caddyfile match the image, writes
`ZEUS_TAG` into `.env`, pulls the image, restarts only the app container, and waits
for `/api/health`. If health never comes it puts the previous tag back on its own and
tells you where the dump is. Roll back deliberately with the same command and the
previous tag.

Two things to know:

- Migrations are forward-only (`prisma migrate deploy` in the entrypoint). Rolling the
  code back does not roll the schema back; the dump taken at the start of the deploy is
  the way back for data. Read the release's migrations before deploying it.
- The previous image stays on disk so a rollback is a pull-free restart. Prune old
  images by hand (`docker image prune`) once a release has settled.

**Refresh staging with real data** by restoring a production backup into your local
database — the standalone decryptor and steps under *Disaster recovery* below do
exactly that. The disaster drill and the staging refresh are the same procedure, so
rehearsing one rehearses the other.

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

In the Teams channel you want alerts in: **⋯ → Workflows → "Send webhook alerts to a
channel"** (older Teams builds call it "Post to a channel when a webhook request is
received"), then copy the generated URL into **Settings → Notifications → Add webhook**.
Press **Test** to post a card. The URL is a secret — anyone holding it can post to the
channel.

Each event (deal won, deal lost, stale account, stuck deal, registration expiring,
overdue task, backup failed, target at risk…) has its own row where you choose the
channels, the threshold in days, and who receives it.

### System status

*Settings → System status* is the heartbeat: every integration answers for itself,
every five minutes, with uptime over the day and week beside it.

| Component | What it actually checks |
|---|---|
| PostgreSQL | A real query, and how long it took |
| Microsoft 365 | An app token can still be obtained |
| Outbound email | Recent sends from the email log, then the sending mailbox itself — a token proves the app registration, not that mail can leave |
| WhatsApp | The Business API answers |
| Teams alerts | How the last post to each channel went |
| Bot protection | Cloudflare answers siteverify, and whether it is guarding the sign-in |
| Outbound webhooks | How many have been switched off by failures |
| Backups | A successful run inside the expected window, and the newest file really on disk |
| Scheduled jobs | What is registered — not just what is configured |

An integration nobody has set up reads as healthy, not down: nothing depends on it yet.

That last row exists because of how backups failed once. An install that booted with
backups switched off registered no backup jobs, and switching them on afterwards
changed nothing until a restart — the setting said yes and the scheduler held nothing.
"Scheduled jobs" states what is actually registered, so that disagreement is visible
instead of silent.

### Bot protection

Cloudflare Turnstile guards the two doors that face the open internet: the portal's
request-access form, and — when you switch it on — the staff sign-in at
`zeus.protect24x7.com`.

**Setting it up.** In Cloudflare → **Turnstile** → *Add widget*, mode **Managed**, with
both hostnames on the one widget (`portal.protect24x7.com` and
`zeus.protect24x7.com`). Paste the site key and secret into **Settings → Integrations →
Bot protection**. The secret is encrypted at rest; the site key is public by design.
The portal form starts using it immediately. The staff sign-in does not — tick **Also
protect the staff sign-in** for that, so configuring the portal cannot gate the whole
team as a side effect.

**It cannot lock you out.** Three outcomes are distinguished, not two: a *refusal* from
Cloudflare stops the sign-in, but an *outage* — Cloudflare unreachable or answering an
error — lets it through and writes a warning to the system log, because somebody else's
downtime must not shut the team out of their own CRM. The password, the per-account
lockout and the rate limit are all still in front of anyone who gets past it. Microsoft
sign-in ignores the check entirely, and the whole thing can be switched off from
Settings, or in the last resort with
`update "Setting" set value='false' where key='auth.turnstileOnLogin';`.

**Testing it.** Cloudflare publishes dummy keys that always pass
(`1x00000000000000000000AA` / `1x0000000000000000000000000000000AA`) or always fail
(`2x00000000000000000000AB` / `2x0000000000000000000000000000000AA`), which exercise
the real service without minting production keys.

### Sessions

Every sign-in — staff and portal alike — creates a `Session` row, and the session id
travels inside the cookie. Each request checks that the row is still live, which is
what makes ending a session mean something: before this, a signed cookie was good
until it expired, so signing out only deleted the browser's copy and deactivating
someone left their open tabs working.

A session ends when the person signs out, when they change their password (their
*other* sessions go, not the one doing it), when an administrator deactivates them or
resets their password, or when portal access is revoked. Revoking is final: restoring
access does not bring an old session back, the person signs in again.

**Cost and timing.** The check is a primary-key read behind a 60-second in-process
cache, and `lastSeenAt` is written at most once every five minutes per session, so an
open tab does not turn reads into writes. Anything Zeus revokes itself drops that
cache entry immediately, so it takes effect on the very next request; a change made
directly in the database takes up to a minute to be noticed. (If Zeus is ever run as
more than one app container, that minute also applies between containers.)

**Where from.** Behind Cloudflare the answer arrives on the request and costs nothing:
`CF-Connecting-IP` is the visitor rather than the tunnel, and the visitor-location
headers give city, region and country. Turn them on once at **Cloudflare → your domain
→ Rules → Settings → Add visitor location headers**; without it only the country
arrives. Anything Cloudflare has not tagged — LAN access straight to the server —
falls back to an `ipinfo.io` lookup, which is only ever asked about public addresses
and never holds up a sign-in. This is IP-level: a home connection often resolves to
the ISP's hub city rather than the person's, and a VPN shows its exit node. Country
and network are the reliable parts; city is a hint.

**Seeing them.** *Settings → Active sessions* lists everyone signed in — staff and
portal — with device, place, when they signed in and when they were last seen, marking
which row is the one you are reading it on. Active means used in the last 15 minutes;
older sessions are idle, not gone. Filters narrow to staff or to partners and
customers, and *Include ended* shows the last month with the reason each one closed.
A portal preview is labelled with the administrator behind it. *My account → Your
devices* is the same list narrowed to you, with one button to sign out everywhere
else. Ending someone else's session needs the same permission as deactivating them,
and every such sign-out is audited.

**Was this you?** A sign-in from a device or a country the account has not used in
the last 90 days alerts the person *and* the administrators — one message per sign-in,
naming the device, the place and the time, linking to My account where it can be
ended. Being told about your own account is not something the notification rules can
switch off. Ordinary sign-ins are silent: a first sign-in has nothing to compare
against, a familiar laptop in a familiar country says nothing, and an administrator
previewing the portal is somebody looking on purpose, not a stranger arriving. Portal
users have no account inside Zeus to receive an in-app notice, so they are mailed
directly and the administrators get the in-app alert.

**On upgrade** nobody is signed out: a cookie issued before this existed carries no
session id and is honoured until it expires, and the next sign-in gets a row. Ended
sessions are kept 30 days — long enough to still show where someone signed in from
last week — then pruned with the nightly 03:00 job.

### Email log

Every email Zeus sends is recorded — quotes, invoices, purchase orders, portal
sign-in links, partner registration mail, alerts and scheduled reports. Settings →
Email log lists them newest first, filtered by status or kind and searchable by
recipient. The row is written by `sendMail()` itself, so a new caller cannot forget
to log and an old one cannot drift.

**What "sent" means.** Microsoft Graph's `sendMail` returns *202 Accepted*: it has
taken the message. There is no delivery receipt on that API, so the log says **Sent**
(handed over) or **Failed** (refused, with the exact error) and never claims a
message was delivered or read. Bounce detection would need `Mail.Read` on the sending
mailbox and is deliberately not built.

**What is kept.** Recipients, subject, kind, who pressed send, attachment filenames,
and the first 300 characters of the body as plain text — enough to know what went,
without storing customer correspondence twice. A failure additionally keeps the whole
message so it can be replayed exactly; **Send it again** on the failed row replays it
and then drops that copy. Rows are kept a year; stored copies of failures are dropped
after a month. Both run in the nightly 03:00 prune.

## Backups to OneDrive

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

## Partner & customer portal

A second, deliberately small front end (`apps/portal`) for the two parties outside the
company. It is **read-only by construction** — the only routes an outsider can POST to
are its own sign-in, set-password and link-request; every other non-GET under
`/api/portal/` is refused before a route runs. It is **off by default** (`portal.enabled`)
until an admin switches it on.

**Identity.** A portal user is a `Contact`, never a `User`, and access is granted on
purpose from inside Zeus (`POST /api/portal-admin/users`, the `portal` module —
Administrator only by default). A contact under a partner account gets nothing by merely
existing; a grant fails if another contact shares the email address, because the login
key must name one person.

**Passwords** are set and reset only from an emailed single-use link, so the public page
never offers to create one. Sign-in is email then password; an unknown address, a wrong
password and a locked account all get the same answer. Lockout matches the internal
login.

**Who qualifies**, re-checked on every request: a live contact under a live `PARTNER`
account, or under a `CUSTOMER` account with an `ACTIVE`/`EXPIRING` subscription.
Revoking, deleting the contact, or the last subscription lapsing closes the door on the
next request. Every portal read is written to the audit trail.

**Hosting.** The API serves the portal build on its own hostname (`PORTAL_URL`, e.g.
`https://portal.protect24x7.com`): the portal's assets live under `/portal-app/`, and on
that hostname the internal app's bundle is withheld, so an outsider never downloads the
CRM's screens. Behind the Cloudflare Tunnel, add a second public hostname for the portal
pointing at the same `localhost:80`; Caddy needs no change in `:80` mode. The portal's
session cookie has its own name and JWT issuer — an internal session is worthless on
the portal and the other way round.

Dev: `npm run dev:portal` (port 5175). Tests: `apps/api/src/test/portal.test.ts`.

### Controlling what a partner sees

*Settings → Portal access* is arranged around accounts, not people. Three master
switches at the top (portal on, partners, customers); then **Partners & customers** —
one row per account that has anyone on the portal, summarising who they are and their
state. Open a row and everything about that account is in one place:

- **Their logo**, shown beside yours on every screen their people see.
- **What their people see** — one Default / Shown / Hidden choice per field:
  opportunity stage, deal value, quoted amount (the total on the latest quote that
  actually went out — never a draft), and the vendor registration number. *Default*
  follows *What partners see by default* further down the page; the other two
  override it for this account only. Neither can reach a field the code does not
  allow out at all.
- **People with access** — grant, send a set-password link, view the portal as
  them, revoke, restore. Each person is marked either *primary contact — sees every
  deal* or *sees their own deals* (see below).

The same panel sits on the account's own page under *Portal*, for sales who are
already there. Company branding (your logo, welcome line, banner, contact details)
has its own card; password, lockout and session settings are folded away under
*Security and sessions* since they are rarely changed.

### Who at a partner sees which deals

A partner is a company with several account managers, and one of them must not see
another's pipeline. Every registration names the partner contact who brought it, and a
person signing in sees only the registrations under their own name. The exception is the
account's **primary contact** — the flag sales already set when they add people to an
account — who sees every registration at the account, including any nobody has been
named on yet. There is exactly one primary contact per account, so exactly one admin;
to hand it to somebody else, mark them primary on the account's contacts. Partners
cannot change it themselves. The portal says which view a person has: *You see every
deal registered under X* or *You see the deals registered under your name*.

### Narrowing hundreds of registrations

The list takes a search (customer or reference), a status (with the vendor / approved /
expired / not approved), a vendor, a stage (when stage is shown), an expiry window
(next 30, 60 or 90 days, or already lapsed) and a sort (soonest expiry, newest, or
highest value when deal value is shown). Filters live in the URL, so *CrowdStrike,
expiring in 30 days* is a link a partner can keep. The choices offered come from that
person's own rows — a filter narrows what they may already see, never widens it. A
rejected registration stays visible for 30 days after the decision; drafts never appear.

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
