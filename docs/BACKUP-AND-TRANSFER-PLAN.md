# Zeus roadmap — data resilience, coaching & platform hardening

Living roadmap. Started as backup + offboarding; expanded (with the product owner) to
manager coaching, sales-process validation fixes, and platform hardening. Decisions
below are confirmed and are the contract to build against. Status: ✅ done · 🔄 in
progress · ⬜ pending.

---

## Master sequence

| # | Epic | Status |
|---|---|---|
| P4 | Offboarding: user record transfer | ✅ |
| P5 | Manager review & coaching (5.1 ✅ · 5.2 ✅ · 5.3 ✅ backend+UI, tested/typechecked) | ✅ |
| P6 | Quote approval — every quote gated before send (backend + editor UI, tested/typechecked) | ✅ |
| P7 | Renewals — close the "won deal, no renewal" gap | ✅ |
| P8 | Documents — invoice creator + formatting review | ✅ |
| P9 | Security hardening | ✅ |
| P10 | Data retention & privacy | ✅ |
| P11 | Notifications & scheduled reports | ✅ |
| P12 | Search & QoL parity | ✅ |
| B1 | Backup engine (logical/config/encrypted/tiers/2nd destination) | ✅ |
| B2 | Backup automation & control | ✅ |
| B3 | Granular restore + auto-verify | ✅ |

**Order:** finish P5, then the sales-process fixes P6–P8 (high value, mostly assembly
on existing systems), then hardening P9–P10, then P11–P12, then the backup track B1–B3
(heaviest infra). Adjustable.

---

## P4 — Offboarding transfer ✅ (shipped, tested)

Reassign a leaving user's records to another, per-module, reversibly. `TransferJob`
(keeps exact moved ids), preview counts, per-module transfer, exact reverse, JSON book
export, optional deactivate. Users-tab wizard; admin-only; 4 tests.

## P5 — Manager review & coaching 🔄

> Finding: much already existed — required loss-reason dropdown (`lists.lostReasons`),
> per-deal Won/Lost report, daily aggregate `PipelineSnapshot`. Scope shrank to the
> genuine gaps.

- **5.1 Loss-reasons summary report ✅** — lost deals grouped by reason, ranked by lost
  value + share % + avg cycle; blanks → *Uncategorised*. Tested.
- **5.2 Weekly per-deal movement ✅** — `DealSnapshot` model + Monday 06:00 cron
  (`takeWeeklyDealSnapshot`) + `weeklyDealMovement()` + a `deal-movement` report
  (new / advanced / slipped / grew / shrank / won / lost). Tested (`dealMovement.test.ts`).
- **5.3 Coaching dashboard — backend ✅, UI built (browser-verify pending)** — **reframed:** a **rep-owned, visual, drill-able
  pipeline-review board**, driven live in the 1:1 as the manager asks questions
  (manager can also view any rep's). **Panels (all):** pipeline by stage (funnel +
  net/weighted, drill to deals), quota gauge vs `Target`, aging & stuck/escalation
  (rot-days, slipped close, high-value stalls), activity & win/loss trend. Reuses
  existing data + the 5.2 movement data.

## P6 — Quote approval ✅

Today: deals (close-won), invoices (before send), POs all have manager sign-off; quotes
have only a margin *warning*. **Decision: every quote requires approval before it can be
SENT to the customer — no threshold.** Add a `quotes` entity to the approval system
(`approvals.quotesEnabled`), submit→approve/reject like the others, block send until
approved, self-approval off by default. Audited.

## P7 — Renewals gap-closing ✅

Renewals already automate: an **issued invoice with termed lines** creates a
`Subscription`; `sweepRenewals` fires `renewal_due` (90d) + `renewal_lapsed`.
**Decision: keep invoice-driven** (accurate to what is billed) and **flag the gap** —
surface WON deals that produced **no renewal** (no termed invoice line) so nothing
silently falls out of the renewal pipeline. A watch-list + notification.

## P8 — Documents: creator + formatting ✅

Quote PDF shows **Prepared by**, PO shows **Raised by**; the **invoice PDF shows no
creator**. **Decision:** add a *Prepared by* line to the invoice PDF (parity), then
generate sample quote / PO / invoice PDFs and fix any alignment/structure/spacing
issues found. Verify the creator tagged is correct (`preparedById` / `createdById`).

## P9 — Security hardening ✅

Rate-limiting is `global:false` (only login/2FA limited). Add sane limits to write
endpoints; enforce 2FA for admins/managers (policy setting); review session/lockout.

**Shipped:** rate-limit now `global: true` (300/min/IP on every route, login/2FA keep
their tighter per-route overrides) — off under the test runner only, since a full
suite legitimately exceeds 300 req/min from one address and that isn't testing our
code. Account-level lockout added (`auth.lockoutThreshold`/`auth.lockoutMinutes`,
counts recent `login_failed` audit rows per account regardless of source IP — the
existing IP rate limit alone doesn't stop a distributed guess against one email).
2FA enforcement for Administrators/Sales Managers behind `auth.require2faForManagers`
(off by default): once on, a manager/admin without `totpEnabledAt` gets writes blocked
with a clear message, reads and the 2FA-enrolment/logout/change-password endpoints stay
open so they can fix it without being locked out. Session review: JWT cookie
(httpOnly/sameSite=lax/secure-in-prod, 12h default) already re-checks `user.isActive`
on every request, so deactivating a user ends their session immediately — no changes
needed there.

## P10 — Data retention & privacy ✅

Right-to-erasure and per-entity retention policies; explicit controls + retention for
the login IP/ISP/device telemetry now collected (personal data). Documented handling.

**Shipped:**
- **Right to erasure** — `POST /api/contacts/:id/erase` and `POST /api/leads/:id/erase`
  (require a `reason`, gated on the same `delete` permission as the entity). Scrubs PII
  fields in place (name/email/phone/LinkedIn/notes/custom fields) rather than deleting
  the row — a contact can still be the "attn:" on an already-issued quote or invoice,
  and that document has to keep meaning what it meant the day it was issued. New
  `erasedAt` column on both models (migration `right_to_erasure`). No undo — an
  erasure that can be silently reversed is not one. UI: "Erase data" button on
  `LeadDetail.tsx` (Contact has the backend capability only — no page in the app
  deletes a Contact today either, so adding erase-only UI there would have been a new
  surface out of proportion to this phase; noted here rather than silently skipped).
- **Per-entity retention** — `retention.deletedLeadDays` (default 0/off). Nightly sweep
  hard-deletes soft-deleted Leads past that age, but only ones with zero Activities and
  zero Attachments — deliberately narrow scope. Accounts/Contacts/Deals stay archived
  rather than auto-destroyed: they can carry invoices and other legal-document
  relations downstream that a blind purge would orphan or break the trail for.
- **Login telemetry retention** — `auth.loginAuditRetentionDays` (default 180). The
  system log already pruned at 30 days; the audit trail's `login`/`login_failed`/
  `login_pending_2fa` rows — which also carry an IP — did not, and the rest of the
  audit trail is intentionally kept forever, so this prunes only that family of
  actions, nightly.
- Both sweeps live in `services/retention.ts`, wired into `jobs/scheduler.ts` at
  03:15 GST (right after the existing 03:00 log prune).
- All three settings surface automatically in Settings → Audit trail → Data
  retention / Sign-in, via the existing generic settings renderer.
- Test: `retention.test.ts` (erase scrubs PII + keeps business fields, double-erase
  guarded, requires a reason, login-audit prune respects the 0=off setting and only
  touches login-family rows, lead purge skips ones with activity/attachments).
  Browser-verified live: created a scratch lead, erased it through the UI, confirmed
  in the database that PII was scrubbed and `erasedAt`/`deletedAt` were stamped while
  `company`/`status` survived, confirmed the audit-trail entry, confirmed the new
  Settings card renders — then cleaned up the scratch lead.

## P11 — Notifications & scheduled reports ✅

Per-user digest + quiet hours; email a report on a cron (extends the existing reports +
notify systems).

**Shipped:**
- **Quiet hours + per-user digest, one mechanism.** `notify.quietHoursEnabled` (off by
  default), `notify.quietHoursStart`/`quietHoursEnd` (21/7, Gulf time, wraps midnight).
  While on, a non-critical event's email is held instead of sent immediately — critical
  severity always bypasses it (a failed backup still pages right away). `Notification`
  gained `wantsEmail`/`emailedAt`; the digest queue *is* just "wantsEmail true,
  emailedAt null" on rows already being created anyway, no separate queue table.
  `sendPendingDigests()` (nightly, 07:00 GST — right as the default window ends) groups
  everyone's held notifications into one email each. In-app and Teams alerts are
  completely unaffected; only email timing changes, and only when opted in.
- **Scheduled reports.** New `ScheduledReport` model — pick a report from the existing
  registry (`REPORTS` in `routes/reports.ts`, now exported alongside `buildContext` and
  `ReportDef`/`ReportContext`/`ReportResult`), a cadence (daily/weekly + hour, Gulf
  time), a format (PDF/xlsx), recipient emails (don't have to be Zeus users). Runs with
  the *scheduling admin's own read scope* (`sessionUserById`, factored out of
  `loadSessionUser` in `auth/session.ts`) — never leaks a rep's numbers to someone the
  screen would have refused. Hourly sweep (`services/scheduledReports.ts`, `:05` past
  the hour) — the due/dedupe decision (`isDue`) is a pure function kept separate from
  the DB fetch and the mail send specifically so it's unit-testable without either.
  CRUD at `/api/scheduled-reports` (admin-only, same `settings` permission as
  `NotificationRule`), in `routes/admin.ts`.
- Both surface in Settings → Notifications: a "Quiet hours" `SettingsGroup` card (zero
  new settings-UI code, same generic renderer as everywhere else) and a new "Scheduled
  reports" card (list + enable toggle + delete + a create modal) — genuinely new UI,
  the one part of this phase with no existing pattern to lean on.
- Test: `notificationDigest.test.ts` (8 cases — quiet-hours boundary math including the
  midnight wrap, critical bypass, notify() defer-vs-send-immediately, an email-off
  event never enters the queue, digest never falsely marks a row sent when delivery
  fails) + `scheduledReports.test.ts` (11 cases — `isDue` pure-logic matrix, resilience
  when a report key doesn't exist or mail fails, full route CRUD, a real bug caught and
  fixed: the weekly-needs-a-weekday validation checked `!== null` but an *omitted*
  field parses as `undefined`, not `null` — silently let a weekly schedule through with
  no day set). 157/157 total. Browser-verified end-to-end: toggled quiet hours on/off
  through Settings, created a weekly schedule through the UI (confirmed the day-picker
  appears/disappears correctly), toggled it off, deleted it, confirmed each step's
  toast and persisted state.

## P12 — Search & QoL parity ✅

Postgres full-text search (current global search is `ILIKE`); bulk actions on
Accounts/Contacts/Leads (only Deals today); clone/duplicate a record (quote, deal).

**Shipped:**
- **Search.** The ⌘K box already ran plain `ILIKE '%term%'` (Prisma `contains` +
  `insensitive`) against unindexed columns — every keystroke was a sequential scan.
  Rather than switching to `tsvector`/`tsquery` (built for whole-word/stemmed natural-
  language search — wrong tool for "type three letters of a company name"), enabled
  `pg_trgm` and added GIN trigram indexes on exactly the columns already being
  searched (`Deal.name`/`reference`, `Account.name`/`domain`, `Contact.firstName`/
  `lastName`, `Lead.firstName`/`lastName`/`company`). Postgres now serves the same
  ILIKE query from the index automatically — **zero application code changed**, this
  is a migration-only phase item. Not modelled in `schema.prisma` (Prisma's
  declarative GIN/operator-class support needs a preview flag for four raw
  statements that get applied once and never touched again) — migration
  `pg_trgm_search` is hand-written SQL, verified directly against Postgres
  (`\dx`, `pg_indexes`) rather than through Prisma.
- **Bulk actions on Accounts/Contacts/Leads.** Deals' bulk-assign/bulk-delete were
  inline in `Deals.tsx`, not a shared component. Extracted `useBulkSelection` +
  `BulkActionBar` (`components/bulkActions.tsx`) — assumes `POST {basePath}/bulk-
  assign` and `bulk-delete` with the shape Deals already established
  (`{ ids, ownerId? }` → `{ updated|deleted, skipped }`). Added those two routes to
  `accounts.ts` (honouring the existing open-deal delete guard, per-row), `contacts.ts`,
  `leads.ts` — each skips rows the caller can't touch rather than failing the whole
  batch, matching deals' existing behaviour. Deals itself deliberately left as-is
  (working, tested — no reason to churn it for consistency alone).
- **Clone/duplicate.** Quote already had this under "New version" (`POST
  /quotes/:id/revise` — same document number, next version). Deal had nothing.
  Added `POST /api/deals/:id/clone`: new reference, `"<name> (Copy)"`, same account/
  partner/contact/type/amount/cost, but resets to the pipeline's *first* stage and a
  fresh 30-day close date — a clone is a new opportunity, not a copy of how far the
  old one got. Owned by whoever clicked Clone, not the source's owner. "Clone" button
  on `DealDetail.tsx`.
- Test: `bulkActions.test.ts` (5 — including a real correction to my own first draft:
  the ownerAllowed scope check only gates the *existing* owner, not the reassignment
  target, so "rep reassigns their own contact to someone outside their team"
  correctly succeeds, not skips) + `dealClone.test.ts` (4). 166 total.
  Browser-verified end-to-end: selected/reassigned/deleted real rows on Accounts (and
  confirmed search itself still returns correct results against the new index),
  confirmed the same bar renders on Leads, cloned a real deal and confirmed the
  fresh reference/stage/close-date — cleaned up every scratch record afterward.

---

## Backup track

### B1 — Backup engine ✅
Per-module **logical NDJSON export** + **app-side config snapshot**; **AES-256-GCM**
encryption (reuse app key); write to **local + NAS + OneDrive**; grandfather-father-son
retention. `BackupRun` gains `kind / tier / destinations / encrypted / checksum /
rowCounts`.

**Shipped:**
- **Three kinds.** `physical` (existing `pg_dump`), `logical` (new — NDJSON export of
  10 business tables: account/contact/lead/deal/quote/invoice/purchaseOrder/product/
  subscription/activity, one line per row as `{model, row}`, gzipped), `config` (new —
  NDJSON export of 8 app-config tables: setting/role/pipeline/stage/customField/
  notificationRule/teamsWebhook/scheduledReport, kept strictly separate from business
  data). Each run records a per-model row count in `BackupRun.rowCounts`.
- **Encryption.** `encryptBuffer`/`decryptBuffer` added to `lib/crypto.ts` — AES-256-GCM,
  keyed via `scryptSync(APP_SECRET, 'zeus-backups', 32)` (separate derived key from the
  existing `encryptJson` purpose, same root secret). On by default
  (`backup.encrypted: true`); encrypted files get a `.enc` suffix and a 🔒 badge in the
  UI. `BackupRun.checksum` is a SHA-256 of the exact bytes written to disk (post-
  encryption), so a checksum mismatch would catch corruption either at rest or in
  transit.
- **Second destination.** `backup.nasPath` setting (blank = off) — a plain mounted
  filesystem path, no NAS protocol handling needed since the OS already handles the
  mount. Each destination (local/nas/onedrive) is attempted independently; one failing
  never blocks another. `BackupRun.destinations` (was singular `destination`) records
  which ones actually landed for that specific run.
- **Grandfather-father-son retention.** `BackupRun.tier` (`daily`/`weekly`/`monthly`)
  assigned once at creation from the Gulf-time calendar (1st of month → monthly, Sunday
  → weekly, else daily) — never reclassified later. `backup.retainDaily/Weekly/Monthly`
  (replaced the old single `backup.retainLocal`) prune each tier independently.
- **Validate/Verify stay physical-only** — deliberate scope boundary, both now decrypt
  first when the target run's `encrypted` flag is set. Deep logical/config verification
  (row-count parity, auto-verify) is explicitly B3's job.
- Schema: hand-written migration `backup_engine_kinds_tiers` (Prisma's non-interactive
  CLI refuses to confirm a destructive column drop even with `--create-only`; applied
  via `migrate deploy`) — backfilled the 5 existing rows' `destination` into
  `destinations: [that value]`. A second migration,
  `drop_stale_backup_retain_local`, deletes the orphaned `backup.retainLocal` Setting
  row left behind by the rename — caught during browser verification (see below), not
  by any test, since tests start from an empty Setting table.
- Test: `backupEngine.test.ts` (8, new) covering tier classification, logical/config
  export shape, encryption round-trip, checksum, NAS destination, and GFS pruning; one
  assertion fixed in `backupStatus.test.ts` (`.uploaded` boolean → `.destinations`
  array). **Caught a real bug via the retention test:** `pruneLocal()` was querying
  `destinations: { has: 'local' }` before the current run's own `destinations` had been
  persisted, so every run was invisible to its own prune pass — retention silently
  undercounted by 1 forever. Fixed by writing the run's final `destinations` before
  calling `pruneLocal()`. 174 total (166 + 8).
  Browser-verified end-to-end: triggered all three kinds from the Backups page, each
  landed on `local, onedrive` with the correct `.enc` filename and 🔒 badge; table's
  new Kind/Tier/Where columns and the settings form's new fields (retainDaily/Weekly/
  Monthly, nasPath, encrypted) render with correct labels and defaults; Validate and
  Verify (restore) both ran against a fresh encrypted physical backup and passed (45
  tables, genuine restore into a throwaway DB). Found and fixed the stale-setting-row
  bug above during this pass.

### B2 — Automation & control ✅
Per-kind schedules (physical nightly / logical daily / config weekly), maintenance
window, skip-if-unchanged; Backups page badges; **alert on a missed run**.

**Shipped:**
- **Per-kind schedules.** Physical keeps its existing admin-set `backup.cron`
  (unchanged). Logical and config are new fixed schedules, computed at scheduler
  boot from `backup.windowStartHour` (`15 <hour> * * *` daily, `45 <hour> * * 0`
  weekly) — so moving the one setting shifts both together, no separate cron field
  per kind. All three go through `runScheduledBackup()` instead of calling
  `runBackup()` directly (still what the manual "Back up now"/Logical/Config
  buttons call — a click always runs, guards and all, deliberately bypassed).
- **Maintenance window.** `backup.windowStartHour`/`windowEndHour` (Gulf hours,
  default 1-5, equal values = no restriction) — same wrap-safe range check
  `isQuietHours` already uses. Gates logical/config only; physical already has its
  own admin-chosen time and isn't re-gated (avoids a contradiction if an admin sets
  `backup.cron` outside the default window on purpose).
- **Overlap guard.** No kind starts while any `BackupRun` is still `running` —
  matters once three schedules can land close together instead of one.
- **Skip-if-unchanged.** Logical/config only. Cheap `count()` per model (added
  alongside each `find()` in `LOGICAL_MODELS`/`CONFIG_MODELS`) compared against the
  last run's `rowCounts`; an exact match skips the full export+encrypt+write+upload
  cycle. Known limitation, documented in code: a same-count edit slips through —
  proportionate for config data that rarely churns, not used for physical.
- **Skipped runs are real rows.** `BackupRun.status = 'skipped'` (window/overlap/
  unchanged, with the reason in `error`) so automation is auditable on the Backups
  page rather than silent. Carries `rowCounts` forward on an unchanged-skip so the
  *next* check still compares against real numbers, not a skip-of-a-skip gap.
- **Backups page badges.** Status column now distinguishes all four states —
  success (secure/green), failed (accent/red), running (info/blue), skipped
  (neutral/grey), partial (watch/amber) — previously partial/running/skipped all
  collapsed into one grey "neutral" badge.
- **Alert on a missed run.** New `backup_missed` notification event (admins
  audience, registered in `NOTIFICATION_EVENTS`). `checkMissedBackups()` runs daily
  in the existing 08:30 GST job; a kind with no success/partial/**skipped** run
  inside its grace window (36h physical/logical, 9 days config) fires a critical
  alert — a legitimate "nothing changed" skip counts as on-schedule, only real
  silence pages.
- Test: `backupAutomation.test.ts` (9, new) — overlap guard, window in/out (physical
  unaffected), skip-if-unchanged both directions, missed-run alert (fires with zero
  history, stays quiet with a recent success/skip or with backups disabled). 183
  total (174 + 9).
  Browser-verified end-to-end: confirmed the 3 schedules register correctly at boot
  from server logs (`physical backup scheduled (0 2 * * *)`, `logical … (15 1 * * *)`,
  `config … (45 1 * * 0)` — the 1 matching the default window start); confirmed the
  two new Maintenance window fields render with correct labels/defaults (1/5);
  changed and saved `windowStartHour`, confirmed it persisted via direct query, then
  restored the default; confirmed a manual Config backup still runs normally
  (guards correctly bypassed for manual triggers) after the `backup.ts` refactor.

### B3 — Granular restore + auto-verify ✅
**Module-into-live** restore (dry-run diff → confirm → auto safety-backup → upsert by
id, dependency-ordered; invoices/POs extra-gated); row-count **parity** per backup;
**weekly auto-verify** with alert on fail.

**Shipped:**
- **Module-into-live restore** (`services/restore.ts`, new). One endpoint, two modes:
  `POST /api/backups/:id/restore { models, confirm }` — without `confirm` it only
  reads (the backup file plus a batched `findMany(id in …)` per requested model) and
  returns a dry-run diff (`toCreate`/`toUpdate` per module); with `confirm: true` it
  takes a fresh safety backup of the same kind first, then upserts by id. No deletes
  — a restore only creates or updates, never removes a live record the backup
  doesn't have. Multi-module requests always apply in `LOGICAL_MODELS`/
  `CONFIG_MODELS`' own declaration order regardless of what order the admin picked
  them in — that order is already dependency-safe (verified against every FK in
  `schema.prisma`: contact→account, deal→account/contact, quote→deal, invoice→deal,
  subscription→product/account, stage→pipeline, activity→everything before it), so
  restoring `['contact', 'account']` still applies account first. One documented
  cross-kind gap: `Deal.pipelineId/stageId` point at `CONFIG_MODELS`, so restoring
  `deal` assumes the pipeline/stage already exist live.
- **Invoices/POs extra-gated.** `needsElevatedPermission(models)` — restoring
  `invoice` or `purchaseOrder` needs `backups:delete` (same elevated permission
  Verify already requires), checked inline in the route (not a `preHandler`, since
  it only applies to some requests to this route) rather than a new permission
  concept.
- **Row-count parity per backup** (`checkBackupParity`, exported from `backup.ts`).
  Logical/config's analogue of Validate: decrypts/decompresses a specific
  `BackupRun`'s file, counts NDJSON lines per model, compares to the `rowCounts`
  recorded at write time. Catches corruption/truncation that would otherwise look
  fine (valid gzip, valid JSON) while quietly missing records. New
  `POST /api/backups/:id/parity` route (`backups:read`, same tier as Validate) plus
  a per-row "check parity" action in the Backups table for any logical/config row.
- **Weekly auto-verify** (`weeklyAutoVerify`, new Monday 06:00 GST cron — clear of
  the maintenance window so it checks that week's fresh files). Runs physical's
  existing `verifyLatestBackup()` plus parity on the latest local logical and config
  run; one `backup_verify_failed` alert for the whole sweep if anything fails,
  rather than one per kind.
- **Backups table row actions.** New Actions column (parity check + Restore) shown
  only for logical/config rows that are success/partial with a local copy —
  physical rows correctly show neither, since physical restores as a whole database
  via the existing Verify button, not by module.
- **Restore modal** (`RestoreModal` in `Settings.tsx`). Checklist of every model the
  backup recorded (label + row count from `BackupRun.rowCounts` — no extra request),
  Preview button (dry-run diff), Confirm & restore gated on having previewed first
  and, if a financial model is checked, on `can('backups','delete')` client-side
  too (mirrored server-side, so this is UX only, not the real gate).
- Test: `backupRestore.test.ts` (12, new) — physical rejected, invalid module
  rejected, preview writes nothing, apply creates/updates/takes a safety backup,
  dependency order holds when requested backwards, update-in-place does not
  duplicate, parity matches and detects a forced mismatch, physical refused by
  parity, weekly sweep stays quiet or alerts exactly once. 195 total (183 + 12).
  Browser-verified end-to-end, including a real data-loss-and-recovery proof: ran
  Parity on a live config backup (matched, 8 models); opened Restore, saw all 8
  modules with correct row counts; tampered a live Role's name directly in
  Postgres (`Read Only` → `TAMPERED`); Confirm & restore — safety backup landed
  first (visible in the table immediately after), then the tampered role's name was
  genuinely reverted back to `Read Only` (confirmed via direct query); audit trail
  showed all three actions (parity check, preview, applied restore with the safety
  backup's filename).

---

## Resume state (updated after each phase — cold-start handoff)

**Last git commit:** `9c406e0` (CI pg_dump fix, pushed to origin/main — via SSH now, see
below). **P11, P12, and the entire B1-B3 backup track below are UNCOMMITTED,**
including four new migrations (B2 and B3 needed no schema changes). Run `git status`
to confirm before doing anything destructive.

**Remote auth:** switched from HTTPS+PAT to SSH mid-session — HTTPS kept silently failing
(stale/wrong osxkeychain credential every few pushes, never fully diagnosed). `origin` is now
`git@github.com:aldrinjoseph123-lang/zeus.git`. Pushing still only works from the user's own
terminal — this session's own `git push` gets blocked or hangs regardless of retries — hand
the command back to the user rather than retrying it here.

**Tests:** 195 integration + 27 unit, all green. Run: `cd apps/api && LC_ALL=C npm test`.
(Local Postgres quirk: if it won't boot, `LC_ALL=C pg_ctl -D /opt/homebrew/var/postgresql@17 start`.)
Web typecheck clean: `cd apps/web && npx tsc -b --noEmit`.

**Pre-commit UAT (2026-08-19), across the entire uncommitted P11–B3 change set:** seeded
realistic fake data through the real API (not raw DB inserts) as a fresh non-2FA
"Demo QA" admin user — 15 accounts, 27 contacts, 6 leads, 15 deals across all 6 pipeline
stages (2 backdated 20 days to exercise the stale-deal digest), 15 quotes, 11 invoices
(2 overdue), 5 purchase orders, 3 subscriptions (one renewing in 20 days), 12 activities
(4 overdue tasks), 1 scheduled report. Then browser-verified with that data live:
- Search (⌘K) returns correct cross-entity matches ("Falcon" → the right deal, 2 accounts,
  2 contacts) against the real `pg_trgm` index at realistic volume.
- Bulk-reassign on Accounts correctly moved ownership for 2 selected rows.
- Deal clone produced a fresh reference at stage New with a new 30-day close date.
- Settings → Notifications lists both new B2/B3 events (`backup_missed`,
  `backup_verify_failed`) correctly, and the seeded scheduled report shows up with the
  right cadence/recipient.
- Dashboard and the "Open pipeline" report both aggregate the new data correctly (stale/
  overdue counts, pipeline value, weighted forecast).
- Re-ran the full backup/restore/parity cycle at the new, larger scale: logical backup
  grew 5 KB → 10 KB and parity matched all 10 models; a fresh physical backup grew
  40 KB → 56 KB and Verify genuinely restored 45 tables.
- Full backend suite (195/195) and both typechecks re-confirmed clean after seeding —
  isolated test DB, unaffected by dev DB state, but re-run anyway for certainty before
  commit. The fake data is intentionally left in the dev database (not cleaned up), per
  what was asked.

**P6–P10: DONE, committed and pushed** (`b6434e1`, `c77e3f7`, `5df0d23`, `aebf947`,
`a8cbae5`, plus two CI-only fixes `a2ade14`/`9c406e0`), all browser-verified end-to-end. See
git log / earlier entries in this doc's history for detail. CI (`.github/workflows/ci.yml`)
is now green — first-ever run had two env gaps (missing `DATABASE_URL`/`APP_SECRET` for
`test:unit`, and a `pg_dump` 16-vs-17 version mismatch for the backup test), both fixed.

**P11 — Notifications & scheduled reports: DONE, browser-verified end-to-end (UNCOMMITTED).**
Quiet hours + per-user digest (one mechanism — `Notification.wantsEmail`/`emailedAt` *is* the
queue) + `ScheduledReport` (any report from the registry, emailed on a cron, runs with the
scheduling admin's own read scope). Full detail in the P11 section above. Migration:
`notifications_digest_and_scheduled_reports`.

**P12 — Search & QoL parity: DONE, browser-verified end-to-end (UNCOMMITTED). This was the
last of the P4–P12 roadmap.**
- Search: `pg_trgm` + GIN trigram indexes on the columns the ⌘K box already searches — zero
  app code changed, migration-only (`pg_trgm_search`, hand-written SQL, not modelled in
  `schema.prisma`).
- Bulk actions: `components/bulkActions.tsx` (`useBulkSelection` + `BulkActionBar`, extracted
  from Deals' inline pattern) + matching `bulk-assign`/`bulk-delete` routes on `accounts.ts`,
  `contacts.ts`, `leads.ts`. Deals itself untouched (already working).
- Clone: `POST /api/deals/:id/clone` (new reference, resets stage/close-date, keeps owner as
  whoever cloned it) + a Clone button on `DealDetail.tsx`. Quote already had this
  (`/quotes/:id/revise`, "New version").
- Test: `bulkActions.test.ts` (5) + `dealClone.test.ts` (4). Full detail in the P12 section
  above, including a real bug caught in my own first test draft.

**B1 — Backup engine: DONE, browser-verified end-to-end (UNCOMMITTED). First of the B1–B3
backup track — the original request this entire roadmap grew out of.**
Three kinds (physical/logical/config), AES-256-GCM encryption on by default, a second
(NAS) destination alongside local/OneDrive, grandfather-father-son retention per tier.
Full detail, including a real pruning-order bug and a stray-setting-row bug both caught
during this phase, in the "B1 — Backup engine" section above.

**B2 — Automation & control: DONE, browser-verified end-to-end (UNCOMMITTED).**
`runScheduledBackup()` wraps `runBackup()` with overlap/window/skip-if-unchanged guards
the scheduler uses (manual buttons still call `runBackup()` directly, unguarded). Logical
runs daily and config weekly, both timed off `backup.windowStartHour` so one setting moves
all three schedules together. Skipped runs are visible `BackupRun` rows, not silence. New
`backup_missed` alert fires daily if a kind has gone stale. Full detail in the "B2 —
Automation & control" section above.

**B3 — Granular restore + auto-verify: DONE, browser-verified end-to-end (UNCOMMITTED).
This was the last item on the entire P4-P12 + B1-B3 roadmap.**
`services/restore.ts` (new) does module-into-live restore: dry-run diff, then confirm
takes a safety backup and upserts by id in dependency-safe order; invoices/POs need the
same elevated permission Verify does. `checkBackupParity()` is logical/config's Validate
analogue (row counts vs. what was recorded at write time). Monday 06:00 GST
`weeklyAutoVerify()` runs physical's restore-check plus parity on the latest logical/
config, one alert for the whole sweep. Browser-verified with a real tamper-and-recover:
edited a live Role's name directly in Postgres, restored it from a backup through the UI,
confirmed the name genuinely reverted. Full detail in the "B3" section above.

**NEXT STEP:** commit the entire P11 + P12 + B1 + B2 + B3 change set (not yet committed —
ask before committing per standing rule; push is on the user). There is no further planned
phase — the backup track (the original request this whole roadmap grew out of) and every
P4-P12 item are now done. Any next work is a new ask, not a continuation of this doc.

---

## Caveats (accepted)

1. **Backup encryption key = DR single point of failure** — must be escrowed separately.
2. **NAS path is not truly offsite** — a good *second* copy, not a sole one.
3. **Invoices & POs are legal records** — module-restore over them gets an extra confirm.
4. **FK / cascade order** — logical restore & transfer respect dependency order.
5. **Every-quote approval adds manager load** — mitigated by the submit→approve queue and
   self-approval setting for one-manager teams.
