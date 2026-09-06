# Browser audit — staging, 6 September 2026

Walked as a user, on the workstation (staging), at the same commit production runs
(`305c9f4` = `v1.0.3`). Two accounts: an Administrator and a Sales Executive. Every page
reached from the sidebar plus one detail page per module, Settings end to end, the setup
checklist, the notification bell and ⌘K search. Desktop (800×450 pane) and mobile
(375×812). Console and network read after every page.

Production-only properties (security headers through Cloudflare, `Secure` cookie, real
visitor IP behind the tunnel) were verified separately from outside on `v1.0.2`/`v1.0.3`
and are not repeated here.

## Result

**33 pages, 0 console errors, 0 failed API calls** beyond the expected pre-sign-in 401s.
Two real defects, both in code shipped this week, both fixed in this commit. Five low
items left open with a suggestion each.

## Fixed in this commit

1. **Setup checklist unusable on a phone.** At 375 px the Skip / Configure buttons kept
   their width and the description collapsed to one word per line, with "Skip for now"
   drawn over the row title. Rows now stack on narrow screens, buttons under the text.
   `apps/web/src/pages/Setup.tsx`.
2. **Notification popover ignored Escape.** It closed only on an outside click, so it
   stayed open underneath the ⌘K palette. Escape closes it now.
   `apps/web/src/components/Layout.tsx`.

## Open, low

3. **Login page asks `/api/auth/me` three times per load** (three 401s in the console).
   `AuthProvider` already owns that query; `pages/Login.tsx:29` makes its own call on top,
   and React's dev double-render adds the third. Harmless; noisy. Drop the call in
   `Login.tsx` and route on `useAuth().user` instead.
4. **Dashboard loads before the setup redirect.** On sign-in with setup unfinished, the
   dashboard's five queries fire, then the checklist redirect lands — a flash and wasted
   requests. Gate the dashboard queries on `setup.finished`, or send the redirect from the
   login handler using the status it already has.
5. **"New deal" wraps to two lines in the mobile header.** Icon-only below `sm`, or a
   shorter label.
6. **Rejected quote and cancelled invoice look editable.** The editors render live inputs
   and a Save button in terminal states. The API is the real guard — an accepted quote and a
   posted invoice both refuse edits with a clear message — but a rejected quote is *not*
   blocked server-side, which may be intended (revise and resend) or not. Either lock the
   inputs in terminal states or decide rejected-is-editable on purpose and say so in the UI.
7. **Leads table at tablet width** wraps a two-word name onto three lines in the Lead
   column. A minimum column width fixes it.

## Passed

- **Role masking holds in the UI.** As a Sales Executive: Catalog shows no Cost or Margin
  columns; Settings shows only "My account" with a clear "No access" state; `/setup` is
  denied; no setup redirect; `/api/setup/status` is never requested.
- **Mobile.** Dashboard tiles stack; the deals board scrolls horizontally inside its own
  container; deal detail and invoice list stack cleanly. `document.documentElement.scrollWidth
  === innerWidth` on every page checked — no page-level horizontal scroll.
- **Bell.** Shows "Finish setting up Zeus — N pending: …" above real notifications and
  counts it in the badge. Real notifications (target coverage, invoice paid, approval
  needed) render with severity dots and relative times.
- **⌘K.** One keystroke, four modules queried in parallel, the ENBD deal found by name.
- **Unknown routes** fall back to the dashboard (`/catalog` is not a route — the Catalog
  link goes to `/products`).
- **Every Settings section** renders with data: Company (with the first-run banner naming
  the missing field), Finance & VAT, Dropdown lists, Custom fields, Pipelines, Users & teams,
  Roles & permissions, Targets, Notifications, Integrations, Backups, Audit trail, System
  status, System log, My account.

## Staging-only observations (not defects)

- System status shows Microsoft 365 down on staging — the local secret is stale. Production
  is connected.
- Company `phone` is empty on staging, so the checklist's required row is pending here.
- Two leftover `UAT …` accounts from the first UAT run remain on staging by design (an
  issued invoice keeps its party).

## Method notes for next time

- Sign in by coordinates in the in-app browser; `form_input` sets the DOM value without
  React noticing and the form submits empty.
- A JSX comment between `.map(() => (` and the element is two siblings, not a comment.
  Vite reports it as a failed reload, not a build error — read the console after edits.
