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
| P7 | Renewals — close the "won deal, no renewal" gap | 🔄 |
| P8 | Documents — invoice creator + formatting review | ⬜ |
| P9 | Security hardening | ⬜ |
| P10 | Data retention & privacy | ⬜ |
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

## P7 — Renewals gap-closing ⬜

Renewals already automate: an **issued invoice with termed lines** creates a
`Subscription`; `sweepRenewals` fires `renewal_due` (90d) + `renewal_lapsed`.
**Decision: keep invoice-driven** (accurate to what is billed) and **flag the gap** —
surface WON deals that produced **no renewal** (no termed invoice line) so nothing
silently falls out of the renewal pipeline. A watch-list + notification.

## P8 — Documents: creator + formatting ⬜

Quote PDF shows **Prepared by**, PO shows **Raised by**; the **invoice PDF shows no
creator**. **Decision:** add a *Prepared by* line to the invoice PDF (parity), then
generate sample quote / PO / invoice PDFs and fix any alignment/structure/spacing
issues found. Verify the creator tagged is correct (`preparedById` / `createdById`).

## P9 — Security hardening ⬜

Rate-limiting is `global:false` (only login/2FA limited). Add sane limits to write
endpoints; enforce 2FA for admins/managers (policy setting); review session/lockout.

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

**Last git commit:** `ea2b907` (doc pointer only — P6 frontend below is UNCOMMITTED).
**Working tree:** P6 frontend changes are sitting uncommitted. Run `git status` to confirm
before doing anything destructive.

**Tests:** 124 integration + 27 unit, all green. Run: `cd apps/api && LC_ALL=C npm test`.
(Local Postgres quirk: if it won't boot, `LC_ALL=C pg_ctl -D /opt/homebrew/var/postgresql@17 start`.)
Web typecheck clean: `cd apps/web && npx tsc -b --noEmit`.

**P6 — Quote approval: DONE, backend + frontend, browser-verified end-to-end.**
- Backend (already committed in `461836a`): approval fields on `Quote`, `quotes` wired into
  `services/approvals.ts` + `routes/approvals.ts`, send/status→SENT gated via
  `ensureQuoteApproved()` in `routes/quotes.ts`. Test: `quoteApproval.test.ts`.
- Frontend (uncommitted, this session):
  - `components/approvals.tsx` — widened `ApprovalEntity` and the `module` prop to include
    `'quotes'`, added its `BLOCKED_STEP` copy. No new component — reused `ApprovalBar` as-is.
  - `pages/QuoteEditor.tsx` — `QuoteFull` now extends `ApprovalState`; renders `<ApprovalBar
    entity="quotes" module="quotes" .../>` inside the lifecycle card when `status === 'DRAFT'`,
    same placement pattern as `InvoiceEditor.tsx`.
  - `pages/Dashboard.tsx` — **bug found + fixed during browser verification**: the "Waiting on
    you" queue widget's entity union and its `enabled` gate (`can('deals'/'invoices','approve')`)
    didn't know about `'quotes'`, and the row-link ternary fell through to
    `/purchase-orders/:id` for any quote — silently sending an approver to the wrong record.
    Fixed: type now includes `'quotes'`, `enabled` also checks `can('quotes','approve')`, link
    ternary has an explicit `/quotes/:id` branch.
  - Verified live in the browser as admin: created a draft quote → "Send for approval" →
    badge went to Awaiting sign-off → appeared correctly in the dashboard's "Waiting on you"
    tab as `Quote · from Zeus Administrator`, clicking it opened `/quotes/:id` (not
    `/purchase-orders/:id`) → Approve → badge went green/Approved. Two scratch quotes
    (`ZEU-Q-000009`, `ZEU-Q-000010`) were created against Gulf Systems / Emirates NBD in the
    local dev DB during this check — harmless, not cleaned up.

**NEXT STEP:** commit the P6 frontend changes (not yet committed — ask before committing per
standing rule), then **P7 — renewals gap-closing**: keep the existing invoice-driven
`Subscription` creation, add a watch-list/notification surfacing WON deals that produced no
renewal (no termed invoice line). Look at `sweepRenewals` and wherever `Subscription` gets
created off an invoice line today as the starting point. Then P8 (invoice creator +
formatting) … P12, then backup track B1–B3.

---

## Caveats (accepted)

1. **Backup encryption key = DR single point of failure** — must be escrowed separately.
2. **NAS path is not truly offsite** — a good *second* copy, not a sole one.
3. **Invoices & POs are legal records** — module-restore over them gets an extra confirm.
4. **FK / cascade order** — logical restore & transfer respect dependency order.
5. **Every-quote approval adds manager load** — mitigated by the submit→approve queue and
   self-approval setting for one-manager teams.
