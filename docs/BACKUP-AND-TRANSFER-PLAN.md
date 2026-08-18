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
| P11 | Notifications & scheduled reports | 🔄 |
| P12 | Search & QoL parity | ⬜ |
| B1 | Backup engine (logical/config/encrypted/tiers/2nd destination) | ⬜ |
| B2 | Backup automation & control | ⬜ |
| B3 | Granular restore + auto-verify | ⬜ |

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

## P11 — Notifications & scheduled reports ⬜

Per-user digest + quiet hours; email a report on a cron (extends the existing reports +
notify systems).

## P12 — Search & QoL parity ⬜

Postgres full-text search (current global search is `ILIKE`); bulk actions on
Accounts/Contacts/Leads (only Deals today); clone/duplicate a record (quote, deal).

---

## Backup track

### B1 — Backup engine ⬜
Per-module **logical NDJSON export** + **app-side config snapshot**; **AES-256-GCM**
encryption (reuse app key); write to **local + NAS + OneDrive**; grandfather-father-son
retention. `BackupRun` gains `kind / tier / destinations / encrypted / checksum /
rowCounts`.

### B2 — Automation & control ⬜
Per-kind schedules (physical nightly / logical daily / config weekly), maintenance
window, skip-if-unchanged; Backups page badges; **alert on a missed run**.

### B3 — Granular restore + auto-verify ⬜
**Module-into-live** restore (dry-run diff → confirm → auto safety-backup → upsert by
id, dependency-ordered; invoices/POs extra-gated); row-count **parity** per backup;
**weekly auto-verify** with alert on fail.

---

## Resume state (updated after each phase — cold-start handoff)

**Last git commit:** `aebf947` (P9, pushed to origin/main). **P10 below is UNCOMMITTED,**
including a new migration. Run `git status` to confirm before doing anything destructive.
`origin` is github.com/aldrinjoseph123-lang/zeus — pushing works from the user's own terminal
(confirmed working after clearing a stale osxkeychain credential); this session's own
`git push` gets blocked or hangs regardless of retries — hand the command back to the user.

**Tests:** 138 integration + 27 unit, all green. Run: `cd apps/api && LC_ALL=C npm test`.
(Local Postgres quirk: if it won't boot, `LC_ALL=C pg_ctl -D /opt/homebrew/var/postgresql@17 start`.)
Web typecheck clean: `cd apps/web && npx tsc -b --noEmit`.

**P6–P9: DONE, committed and pushed (`b6434e1`, `c77e3f7`, `5df0d23`, `aebf947`), all
browser-verified end-to-end.** See git log / earlier entries in this doc's history for detail.

**P10 — Data retention & privacy: DONE, browser-verified end-to-end (UNCOMMITTED).**
- Migration `right_to_erasure` — adds `erasedAt DateTime?` to `Contact` and `Lead`.
- `routes/contacts.ts` / `routes/leads.ts` — `POST /api/{contacts,leads}/:id/erase` (reason
  required, `delete` permission, PII scrubbed in place, `erasedAt`+`deletedAt` stamped, no
  undo). Contact has backend-only (no Contact-delete UI exists anywhere in the app today
  either — deliberately not building erase-only UI ahead of that).
- `services/retention.ts` (new) — `pruneLoginAudit()` (deletes `login`/`login_failed`/
  `login_pending_2fa` `AuditLog` rows past `auth.loginAuditRetentionDays`, default 180; rest of
  the audit trail stays forever) and `purgeExpiredLeads()` (hard-deletes soft-deleted Leads
  past `retention.deletedLeadDays`, default 0/off, only when they have zero Activities/
  Attachments — Accounts/Contacts/Deals deliberately excluded, can carry invoices downstream).
  Wired into `jobs/scheduler.ts` at 03:15 GST.
- Three new setting keys, auto-rendered in Settings → Audit trail (new "Data retention" card)
  and → Sign-in (existing card) via the generic settings renderer — no new settings-UI code.
- UI: "Erase data" button + reason modal on `LeadDetail.tsx`.
- Test: `retention.test.ts` (6 cases). Browser-verified live: created and erased a scratch
  lead through the UI, confirmed in the database that PII was scrubbed correctly while
  `company`/`status` survived, confirmed the audit-trail entry, confirmed the new Settings
  card renders — then cleaned up the scratch lead.

**NEXT STEP:** commit the P10 changes (not yet committed — ask before committing per standing
rule; push is on the user, same as always), then **P11 — notifications & scheduled reports**:
per-user digest + quiet hours, email a report on a cron (extends the existing reports +
notify systems). Then P12, then backup track B1–B3.

---

## Caveats (accepted)

1. **Backup encryption key = DR single point of failure** — must be escrowed separately.
2. **NAS path is not truly offsite** — a good *second* copy, not a sole one.
3. **Invoices & POs are legal records** — module-restore over them gets an extra confirm.
4. **FK / cascade order** — logical restore & transfer respect dependency order.
5. **Every-quote approval adds manager load** — mitigated by the submit→approve queue and
   self-approval setting for one-manager teams.
