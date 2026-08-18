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
| P10 | Data retention & privacy | 🔄 |
| P11 | Notifications & scheduled reports | ⬜ |
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

## P10 — Data retention & privacy ⬜

Right-to-erasure and per-entity retention policies; explicit controls + retention for
the login IP/ISP/device telemetry now collected (personal data). Documented handling.

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

**Last git commit:** `5df0d23` (P8). **P9 below is UNCOMMITTED.** Run `git status` to confirm
before doing anything destructive. `origin` remote is set (github.com,
aldrinjoseph123-lang/zeus) but push only works from the user's own terminal — this session's
`git push` is blocked by the sandbox classifier regardless of retries; hand the command back
to the user instead of retrying it.

**Tests:** 132 integration + 27 unit, all green. Run: `cd apps/api && LC_ALL=C npm test`.
(Local Postgres quirk: if it won't boot, `LC_ALL=C pg_ctl -D /opt/homebrew/var/postgresql@17 start`.)
Web typecheck clean: `cd apps/web && npx tsc -b --noEmit`.

**P6 (quote approval), P7 (renewals gap-closing), P8 (invoice creator + PDF pagination fix):
DONE, committed (`b6434e1`, `c77e3f7`, `5df0d23`), all browser-verified end-to-end.** See git
log / earlier entries in this doc's history for detail.

**P9 — Security hardening: DONE, browser-verified end-to-end (UNCOMMITTED).**
- `app.ts` — rate-limit plugin flipped from `global: false` to `global: process.env.NODE_ENV
  !== 'test'`. Previously only `/auth/login` and `/auth/2fa/verify` had any rate limit at all;
  every write endpoint in the app was completely unlimited. Now everything gets the 300/min/IP
  default unless it has its own tighter `config.rateLimit` (login/2FA keep theirs). Disabled
  under the test runner because a full suite legitimately fires far more than 300 req/min from
  one address and that isn't testing our own code — verified manually with a standalone script
  forcing `NODE_ENV=production` that request #301 gets a 429.
- `routes/auth.ts` login — added account-level lockout: counts recent `login_failed` audit rows
  for that specific user (`auth.lockoutThreshold`/`auth.lockoutMinutes` settings, default
  10/15) and blocks with 429 even on a correct password once tripped. The existing per-IP limit
  alone doesn't stop guesses spread across many IPs at one email.
- `app.ts` onRequest hook — 2FA enforcement for `Administrator`/`Sales Manager` roles behind
  `auth.require2faForManagers` (off by default). Once on: a manager/admin whose
  `SessionUser.totpEnabledAt` is null gets non-GET requests blocked with a clear message; GET
  requests and the 2FA-enrol/confirm/logout/change-password paths stay open so they can fix it
  without a lockout. `SessionUser` gained `totpEnabledAt` (`auth/rbac.ts`, populated in
  `auth/session.ts`'s `loadSessionUser`).
- Session/lockout review: JWT cookie (httpOnly/sameSite=lax/secure-in-prod, 12h default,
  `auth.sessionHours`) already re-checks `user.isActive` on every request — deactivating a user
  ends their session immediately, nothing to change there.
- All three settings surfaced in Settings → Integrations → Sign-in (the existing generic
  `SettingsGroup` renderer — just added `LABELS` entries, no new UI code).
- Test: `security.test.ts` (6 cases — lockout trips and a clean account doesn't, 2FA gate
  blocks/allows correctly across off/on/enrolled/rep-is-unaffected). Browser-verified live:
  toggled `auth.require2faForManagers` on in Settings, confirmed via `fetch()` that the
  *already-2FA-enrolled* dev admin correctly passes through (this dev DB's admin account had
  2FA from before this session), then reverted the setting and cleaned up the scratch record
  created during the check.

**NEXT STEP:** commit the P9 changes (not yet committed — ask before committing per standing
rule; then push is on the user, same as above), then **P10 — data retention & privacy**:
right-to-erasure, per-entity retention policies, explicit controls/retention for the login
IP/ISP/device telemetry now being collected. Then P11…P12, then backup track B1–B3.

---

## Caveats (accepted)

1. **Backup encryption key = DR single point of failure** — must be escrowed separately.
2. **NAS path is not truly offsite** — a good *second* copy, not a sole one.
3. **Invoices & POs are legal records** — module-restore over them gets an extra confirm.
4. **FK / cascade order** — logical restore & transfer respect dependency order.
5. **Every-quote approval adds manager load** — mitigated by the submit→approve queue and
   self-approval setting for one-manager teams.
