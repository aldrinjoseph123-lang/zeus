# Changelog

What changed in each release, and why. Written for whoever has to operate this — the
administrator deciding whether to deploy tonight, and the person six months from now
asking why a delete started refusing.

Every entry names anything that **changes behaviour people rely on** and anything that
**needs a hand after the deploy**, because those are the two things a release note is
actually for. Dates are the tag date.

Deploy any version with `./docker/deploy.sh vX.Y.Z`; roll back with the previous tag.

---

## v1.5.0 — 12 September 2026

Partners stop being a list of companies and start being a relationship Zeus keeps track of.

### Added — the partner register

- **Partners now have a page of their own**, ordered by who has waited longest rather than
  alphabetically. A partner nobody has ever contacted sits at the top, then the longest
  overdue. It answers the question Zeus could not answer at all before: *when did we last
  speak to them.*
- **A channel manager per partner** — deliberately not the account owner, because the
  person who looks after a relationship is often not the one on its deals. Existing
  partners inherit their owner, and "nobody managing" is counted on the page.
- **A contact rhythm.** One house setting covers every partner from the day it is created
  — thirty days to start — and any partner can carry its own. Overdue is measured against
  whichever applies.
- **A ten-second log**: what it was, who you met, one line, with today already filled in
  and the next visit offered a rhythm ahead. The follow-up task defaults to the channel
  manager, so a colleague covering a visit does not silently inherit the relationship.
- **Two new kinds of activity.** *Visit* — the one piece of partner engagement Zeus had no
  word for. *Request* — something a partner asked us for, which stays open so its age is a
  number rather than a feeling.
- **Dormant partners** keep their history and leave the lists. Their registrations still
  expire; they simply stop being chased.
- An **Engagement tab** on a partner's page: everything logged against them, what is still
  waiting on us, and the rhythm they are held to.

### Added — partner protection

- **A partner that registers an end customer now holds it.** Registering a second partner
  at the same customer is refused, and the refusal names who holds it, on which deal, and
  until when — so the awkward conversation is settled by a date rather than by whoever
  remembers the arrangement.
- **An administrator or sales manager can register anyway**, from the same dialog, and the
  override is recorded against their name. Nobody else can.
- **Protection has to be live to hold anything.** Approved, and not yet expired. A draft, a
  rejection or a lapsed registration releases the customer — without that, every customer
  ever registered would stay locked to its first partner forever.
- **Attaching a partner to a deal warns rather than refuses.** Registering is where
  protection is claimed, so a rep can still record an opportunity they are genuinely
  working — they just hear about the conflict from Zeus instead of from the other partner.
- **Registrations record when the partner asked**, as distinct from when we got round to
  it. Protection goes to whoever registers first, so a request left sitting for two days
  protects the wrong partner; that gap is now a number.

### Changed — partner performance

- The report credited any partner **on** a deal. It now credits the partner that **brought**
  it, which is what its name always implied — a reseller handed a deal to fulfil was
  scoring identically to one that found it.
- Two columns added: how many of the deals a partner registered actually closed, and how
  long their requests waited before someone registered them. The second is blank until
  registrations recorded after this release accumulate — inventing a date for the existing
  ones would have written a fictional same-day response into the number.

### Added — what a partner can sell, and who renews what

- **Vendor enablement per partner**, recorded on their Engagement tab. Per vendor rather
  than per product, so a new item under a vendor they already carry needs no new record.
  **Everything expires**, a year by default, warned on the same window registrations use —
  a list nobody re-checks is a list of what was true once.
- **A deal says when its partner is not enabled** on a vendor being quoted there. It says
  so and saves: Zeus refuses in exactly one place, partner protection, and a second gate
  built on a record someone forgot to renew would stop real work.
- **Subscriptions now know which partner services them**, so "what is this partner's
  renewal book" is finally answerable. New terms inherit it from the deal that sold them.
- **A "Renewals by partner" report** — the live book each partner services and what is
  expiring in the window, with unassigned rows grouped rather than dropped, because
  "nobody is on these" is the most useful line on it.

### Added — it comes to you

- **A weekly digest, Monday morning**, to each channel manager, naming only their own
  overdue partners. **Silent when nothing is overdue** — a weekly message that always
  arrives is a weekly message people stop opening.
- **An individual nudge** when a partner passes twice its rhythm, sent once per crossing
  rather than every night until somebody acts, and reset by the next logged contact so it
  can fire again if they are neglected a second time. It runs every morning except Monday,
  because Monday's digest already names them.
- **Coverage on the dashboard**, in the panel people already open: *"2 of 4 partners past
  their contact rhythm · 1 with nobody managing them"*. Reach rather than activity — a
  visit count rewards seeing the same three partners again, coverage only improves when
  somebody new gets called.
- **Movement on the partner report**: the same window immediately before this one, so a
  partner whose volume halved over three quarters stops looking healthy in every single
  snapshot. A partner with no prior business shows no movement rather than a 100% rise.

### Fixed

- **Every screen now passes an accessibility check, in both themes, with nothing pinned.**
  Two colours were being read as text that were never calibrated for it: the accent red,
  which is a background colour behind white, and the lightest grey in the palette. Both
  now have counterparts meant to be read, used everywhere — 144 places across 27 files.
  Small text that was at 2.9:1 is at 5.3:1 or better.
- The step indicator on list rows — the little bars showing how far a quote or invoice has
  got — carried its meaning in an `aria-label` on a plain element, which screen readers are
  required to ignore. Anyone not seeing the bars was told nothing at all. It is now marked
  as a graphic, so the label it always carried actually reaches them.
- Small grey badges were close to unreadable in dark mode — they paired a background that
  stays light with text that lightens at night, which came out at a contrast of 1.3
  against a floor of 4.5. Same cause as the sidebar and the error banner: a colour taken
  from the raw palette where a named one belongs.

### Fixed — settings nobody could reach

- **Eight thresholds had labels and stored defaults and appeared on no settings page**, so
  changing when an account counts as stale, how long a registration runs, or how often a
  partner should be contacted meant an API call. They are now on **Settings → Pipelines**
  under *Thresholds and reminders*. Six of the eight have been unreachable since they were
  added; the partner rhythm would have shipped the same way.

### For anyone running their own instance

- **A new permission, "Partners"**, so channel work can be granted without granting the
  right to edit customer records. The four roles that ship are updated in place. **A role
  you created yourself is not touched** — permissions are never widened silently — so give
  it access in Settings → Roles if it needs it.
- Handover now moves partners as well: a leaving user's partners go to whoever receives
  their records, and come back if the transfer is reversed.

### After deploying

Nothing required. Worth doing once: open **Partners** and check the channel manager on
each, since they were set to the account owner and that is a guess.

---

## v1.4.0 — 11 September 2026

Two screens that were wrong in the dark, and the checks that would have said so.

### Added — a boot splash

- **The blank screen before the app appears now says something.** Between the HTML
  arriving and React mounting there was nothing at all — a white rectangle for however
  long the bundle took. Both the staff app and the partner portal now fill that gap.
- Drawn in Zeus's own marks rather than a stock spinner: the hatched plate from the empty
  states, the square hairline, the uppercase micro-type, and the app's own mechanical
  easing curve. A hard-edged band wipes across the plate and lights the lightning mark as
  it passes — a machine reading itself. Nothing on it is invented: no fake progress
  percentage, no checklist of things that were never checked.
- It is **invisible for the first 250ms**, so a warm cache or the office LAN never shows
  it. Only a genuinely slow load fades it up. Under *reduce motion* nothing moves at all —
  the mark simply sits lit.
- It costs **no JavaScript and no extra request** — 2.7 KB gzipped inside `index.html`.
  The markup sits in `#root`, and React clears the container when it mounts, which is the
  whole teardown.

### Fixed — things that were wrong in the dark

- **Dark mode flashed white on every cold load.** The theme was applied in `main.tsx`,
  which runs only once the bundle has downloaded — so a dark-mode user got the light
  palette for the length of the download and then a flip. It is now set in the document
  head, before the first paint. The in-app toggle is unchanged.
- **The dashboard's server-error banner was close to unreadable in dark mode.** The strip
  that says *"N server errors in the last 24 hours"* — the most urgent thing on the page —
  drew dark red text on the dark red wash the accent surface becomes at night: a contrast
  ratio of 2.1 against a floor of 4.5. It painted itself from raw palette values, and the
  palette deliberately does not flip per theme. It now uses named danger colours defined
  for both, measured at 7.3 in daylight and 5.9 at night.
- Hovering that same banner in dark mode flashed it pale pink, because the hover colour
  named a value that was never defined and quietly fell back to a light-mode literal.

### Changed — easier to use without a mouse

- **The filter dropdowns now say what they are.** Twelve of them — on leads, accounts,
  quotes and invoices — showed their name only as the first option in the list, which a
  screen reader does not read as a name. Anyone using one heard an unlabelled control.
- **The deal board can be scrolled from the keyboard.** It runs off the side of the
  screen and, until now, only a mouse or trackpad could move it.

### Testing

- **Accessibility is checked on every build**, across nine screens in both themes, against
  the page the browser actually drew rather than the stylesheet. It found both problems
  above on its first run, and it is the reason they were found at all — the two contrast
  failures fixed this release were caught by hand, and hand-checking does not scale.
- **Every screen now passes**, in both themes. The check first reported sixty-eight
  further contrast problems, and they turned out to be one bug seen sixty-eight times:
  the sidebar and top bar are dark in *both* themes, but their text was drawn from a
  palette that only lightens at night — so in daylight the section headings sat at 1.9
  against their own background. Nav text now has its own colours, fixed light-on-dark,
  because the surface behind them never changes.
- **A coverage floor**, measured before it was set: 82% of lines, 72% of branches. It
  exists to catch coverage sliding when a route arrives without a test.
- A check that fails the build when any colour names a value the theme never defines —
  the exact shape of the banner's hover bug, which cannot fail loudly on its own.

### For anyone running their own instance

- The request ceiling is now configurable through `RATE_LIMIT_MAX`. **The default is
  unchanged at 300 a minute per address** and there is nothing to do; it exists so the
  browser test suite, which drives one address far harder than a person does, can be given
  headroom without weakening what ships.

### After deploying

Nothing. The two notification settings named under v1.3.0 are still worth doing if they
have not been done.

---

## v1.3.0 — 10 September 2026

The release that went looking for one class of bug and found three of them.

### Fixed — money a role was not allowed to see

- **Subscriptions handed a cost-masked rep the whole book's buy price.**
  `/api/subscriptions` and `/api/subscriptions/summary` are gated on the *deals*
  permission, and the Sales Executive role sets `cost: hidden` there — but both returned
  `unitCost` and `termCost` on every row plus the summed cost in the totals. A rep saw
  byte for byte what an administrator saw. The masking helper was already being called
  and stripped nothing, because the role hides the key `cost` and these columns are
  named differently.
- **Coaching printed the margin in prose.** The escalation list rendered
  "Margin 12.3% below 20%" beside an amount the rep could already see, which is the buy
  price after one subtraction. Same role, same masked field, a third spelling.
- Both are the same rule as the price-book report leak fixed earlier — a rule that must
  hold everywhere, implemented in most places.

### Changed — behaviour you may notice

- **Deleting a deal or a contact now refuses** while live records point at them: a deal
  with quotes, invoices or subscriptions; a contact who is the primary contact on an open
  deal. Accounts already worked this way. The message names what is in the way.
  *If you are used to clearing out quoted deals, this is new.* Products are unaffected —
  one in use is still deactivated rather than deleted.
- **A component is called down only after two consecutive failed checks**, roughly ten
  minutes. One bad probe is usually a blip, and an alarm that fires on those is one people
  learn to ignore.
- **Recovery now sends email.** An alarm with no all-clear is worse than no alarm.
- **New "Administrators only" notification audience.** Infrastructure events default to
  it for new installs; "Administrators and Sales Managers" stays for commercial ones.
- The bot-check probe records *why* Cloudflare was unreachable — a refused response reads
  differently from a timeout, and only one of them is Cloudflare's fault.

### Fixed — quieter, but real

- The scheduler did not wait for cron tasks to stop before registering their
  replacements, so a backup schedule could briefly exist twice.
- The nightly integrity sweep only checked whether a record's *account* had been deleted.
  It now also catches a quote outliving its deal and a deal naming a deleted contact.
- Nine settings on the Company and Finance pages were labelled with their own storage
  keys — `poPaymentTermsDays`, `reverseChargeStatement`, `placeOfSupply` and six more.

### Faster

- The command palette queried on every keystroke, four requests a round — up to 44 for
  one search, against a rate limit an office shares by IP. It now waits for the typing to
  settle.
- The three heaviest detail screens load on demand, which let the bundler lift the chart
  library and the portal panel out of the first download too. **The login page waits for
  415 KB instead of about 1 MB.**

### Testing

- Route sweeps that assert against the real route table rather than the paths someone
  remembered: every route refuses an anonymous caller, none answers 500 to a malformed
  body, no read leaks masked money, no delete orphans its children, nothing outside a
  rep's scope appears in any total.
- Convention checks that read the source — no `.partial()` in a route schema, every route
  file gates on a permission or says why not, no `<button>` inside an `<a>`.
- Browser tests, where there were none: signing in, creating a deal, filtering, walking
  every screen for console errors, and checking no setting is drawn twice.
- The suite went from **11m23s to under 3 minutes** — it was idling on an open database
  handle, not working.

### After deploying

Two settings the code deliberately does not change for you, because channels and
audiences are yours: in **Settings → Notifications**, switch the six infrastructure events
to *Administrators only*, and tick **email** on *A system component recovered*.

---

## v1.2.1 — 8 September 2026

- Fixed: "Require the bot check to sign in to Zeus" was drawn twice on Settings →
  Integrations — once by the Sign-in card, which renders every `auth.*` setting, and again
  by the Turnstile panel that owns it. Two controls, one stored value.

---

## v1.2.0 — 8 September 2026

### Added

- **Sessions.** Every sign-in is now a row, so signing out means something and an
  administrator can end anyone's session from Settings → Active sessions. Device, city and
  country come from Cloudflare's visitor headers.
- **Login alerts.** A sign-in from a new device or a new country tells the person and the
  administrators, once per sign-in, silent on a first sign-in or an unknown location.
- **Email log.** Every message Zeus sends, with status and a preview, and a resend for
  failures — Settings → Email log.
- **Bot protection on the staff sign-in**, off until switched on. A Cloudflare outage lets
  people in and says so in the log rather than locking the team out.
- **Heartbeat on every integration** — nine components, each answering for itself, with
  uptime beside it.
- **Portal: roles and filters.** A partner's primary contact sees every deal at that
  account; everyone else sees only deals under their own name. Search, status, vendor,
  stage, expiry window and sort, all in the URL so a view is a link.
- **Portal: per-account control panel** — logo, which fields that partner sees, and the
  people with access, all in one place.

### Fixed

- **Switching backups on scheduled nothing until the next restart.** The setting said yes
  and the scheduler held nothing. This is the reason "Scheduled jobs" appears on the System
  status page: it reports what is actually registered.
- The lookup menu would not close inside a modal.
- The discount label wrapped and pushed its field out of line.

---

## v1.1.0 — 6 September 2026

- **The partner and customer portal**, on its own hostname: partners see their registered
  deals and both sides of each vendor registration; customers see live services and renewal
  dates. Access is granted per contact, never implied.
- Request access — the portal's one public write, quarantined to its own table so a
  stranger's typing can never become an account.
- Three layers of control over what a partner sees, with per-account overrides.
- **Fixed: PATCH routes overwrote fields they were not sent.** Zod 4 keeps `.default()`
  values under `.partial()`, so a body of `{ name }` silently arrived carrying every
  default. This was live data corruption from 6 September until it was caught.

---

## v1.0.4 — 6 September 2026

- Two defects found by a staging walkthrough before the first production release.

## v1.0.3 — 6 September 2026

- Accept Power Automate (`*.powerplatform.com`) Teams webhook URLs, and check the host
  properly rather than by substring.

## v1.0.2 — 6 September 2026

- Caddy: `trusted_proxies` as a global option, and mount the `docker/` directory rather
  than the single file.

## v1.0.1 — 6 September 2026

- Caddy trusts `X-Forwarded-*` from the Docker bridge, so a visitor arriving through the
  Cloudflare tunnel keeps their own IP address instead of the proxy's.
- `deploy.sh` reloads Caddy after bringing the stack up.

## v1.0.0 — 6 September 2026

First production release. Accounts, contacts, leads and deals; quotes, invoices and
purchase orders with UAE tax-document rules; a vendor price book with USD-to-AED
conversion; the renewals engine with entitlements and automatic renewal deals; role-based
access with field-level masking; Microsoft 365 sign-in, email and OneDrive backups; Teams
and WhatsApp alerts; encrypted backups with restore and verification.
