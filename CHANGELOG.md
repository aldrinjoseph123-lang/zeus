# Changelog

What changed in each release, and why. Written for whoever has to operate this — the
administrator deciding whether to deploy tonight, and the person six months from now
asking why a delete started refusing.

Every entry names anything that **changes behaviour people rely on** and anything that
**needs a hand after the deploy**, because those are the two things a release note is
actually for. Dates are the tag date.

Deploy any version with `./docker/deploy.sh vX.Y.Z`; roll back with the previous tag.

---

## Unreleased

### Added — export the list you are looking at

- **Every list exports to Excel, exactly as filtered.** Deals, leads, accounts, contacts, quotes,
  invoices and products have an Excel button that downloads what is on screen — the search,
  every filter, the sort and the reader's own view (owner scope and hidden fields apply as on
  the page). The Excel buttons on deals, leads, accounts and quotes used to download a
  *report* that ignored most of the filters; PDF still does. Ten thousand rows at most; the
  sheet says so if there were more. Needs the module's **export** permission, as before; each
  export is in the audit trail with its filters.

### Added — which release this is, and what changed in it

- **Settings → System status names the running release** and shows that release's entry
  from this changelog, so whoever is looking at the box can see what the last deploy
  brought without opening GitHub. `/api/health` reports the version too, so `deploy.sh`
  prints it the moment a release comes up. Nothing to do: compose passes the tag through.

### Changed — the box looks after itself a little more

- **Container logs are capped.** Docker kept every log line forever; now each service keeps
  50 MB and drops the oldest. **Needs a hand:** the first deploy with this recreates the
  database and Caddy containers too (their compose config changed), so expect a few seconds
  more downtime than usual that night. `deploy.sh` still dumps the database first.
- **CI now fails on a high-severity dependency advisory** in the runtime tree, and the lint
  step fails if the warning count grows (30 in the app, 1 in the portal — the number can only
  come down). `SECURITY.md` tells a finder how to report privately.
- **A deploy also checks the app page.** `deploy.sh` waited for `/api/health`, which proves
  the API and its database; a build that shipped no bundle was healthy and blank. It now
  also fetches `/` and rolls back if the page is not there.
- **Every CI run is now an upgrade drill.** The previous release's own image boots first
  and writes a working company into the database (staff, vendors, deals, invoices,
  subscriptions); the new image then boots on top of it, so its migrations are applied to
  rows shaped by the release before — what `deploy.sh` will do on the box — rather than to
  an empty database. A migration that only works on empty tables now fails in CI.
- **A nightly run shuffles the test files** (06:00 Dubai, on `main`) to catch two tests
  leaning on each other's leftovers, and prints the order so a failure can be replayed.
- **CI is a third of the length.** The test job took 26 minutes, 18 of them a second run of
  the API suite for coverage in which every test file waited on the database pool's idle
  timeout before exiting. The pool now lets the process exit when idle (`allowExitOnIdle`,
  no effect on a running server) and the suite runs once, under coverage.
- **`npm ci` generates the Prisma client itself** (a `postinstall`), so a fresh checkout or
  a wiped `node_modules` no longer boots the API into `does not provide an export named
  'PrismaClient'`.

### Fixed — a quote's VAT rate on screen

- **Changing a quote's VAT rate now moves its totals straight away.** The rate box changed the
  quote, but the VAT and total beside it went on counting at the old rate until the quote was
  saved and reopened, so a zero-rated quote showed 5% VAT while it was being written. What was
  saved was always right; the screen now agrees with it before the save.
- **Security update:** `fast-uri`, the address parser inside Fastify, moved to a patched release
  (high-severity advisories for host confusion). Nothing to do after the deploy.

### Fixed — reports a role was offered but could not open

- **The report catalogue now offers what the role can actually open.** It listed every report
  there is, so a role with the reports permission but no access to leads, quotes, invoices or the
  catalogue saw twenty reports, opened one, and was told "Your role cannot see leads". The refusal
  was right; offering it was not. Found by a new sweep that walks every report a role is offered
  and insists each one opens.

### Added — hover

- **Hovering a record's name previews it.** After a short pause, a small card shows an account,
  deal, contact or lead: its owner, stage and value, open deals, contact details and last
  activity. It works wherever a record is named: the lists, the deals board, the dashboard,
  search, and inside other records. The card shows only what the reader could see by opening
  the record, and says so when their role cannot open it. On a touch screen a long press opens
  the card and a tap still opens the record.
- **With read logging on, previews are in the audit trail.** A preview shows a record's contact
  details and value, so it counts as looking. It is logged as *preview*, once an hour per person
  and record, so running the mouse down a list does not write a row per name. The audit trail
  can be filtered by it.
- **Tooltips are Zeus's own.** Every hint that used the browser's slow grey tooltip now shows at
  once in Zeus's style, and appears for keyboard focus too.
- **Quick actions on list rows.** Hovering a row on Accounts, Contacts, Leads, Deals, or an
  account's contacts shows Call, Email, Log activity and Open at its end. Log activity opens the
  composer over the list. On a touch screen the actions are always shown.
- **Figures behind the bars.** Hovering a progress bar gives its percentage, and hovering a
  funnel stage gives its count, value and weighted value. A stage that cannot be clicked is no
  longer drawn as a disabled button, and a worksheet tooltip sits on the cell rather than the
  input inside it: Safari and Firefox send no pointer events to a disabled control, so those
  hints would never have opened there.
- The card follows its name if the list redraws underneath it, a tooltip says which control it
  describes (`aria-describedby`), and a figure worked out from a hidden field — an account's open
  pipeline is deal amounts summed — is hidden with it.

## v1.6.0 — 16 September 2026

Quotes are priced from the vendor's own quote, imports check every account before they write and can be undone, and Settings saves through one bar.

### Security — a Sales Executive could open every quote and invoice in the company

- **Quotes and invoices now follow the role's scope.** The routes never checked it, so a rep
  scoped to their team listed, opened, printed and could edit any quote or invoice. Neither
  has an owner column. The rule chosen: a document belongs to **the owner of its deal, and
  whoever made it**. A rep opens every quote on their own deal, including one a manager
  prepared, and keeps the ones they prepared on someone else's. A document with neither
  stays reachable.
- The same rule now covers invoice ageing, the dashboard's overdue invoices, an account's
  quote and invoice lists, submitting for approval, and both reports.
- **An account's deals follow the Deals screen's rule too.** The account page listed every deal
  on the account, whoever owned it, to anyone who could open the account. It now lists only the
  deals the reader could open, and the Deals column on the accounts list counts the same
  deals. That column also stops counting deleted deals.
- **Behaviour change:** a rep whose role edits "own" records can read a teammate's quote but
  no longer edit it. Opening a document out of reach shows "unavailable" instead of an empty
  form.

### Security — cost reached roles that are not meant to see it

- **A Sales Executive or Read Only user could read buy prices.** Masking hid a field only
  on its own module's screens, but records travel between modules: a deal arrives with its
  quotes, an account with its deals and quotes. Opening a deal returned the unit cost and
  margin of every quote on it. An account returned deal cost and quote margin. Quote lines
  carried `lineCost` (quantity × unit cost), and invoice lines carried `unitCost` itself.
  A field hidden on any module is now hidden on every response, together with the fields
  worked out from it. Roles that see cost are unaffected.
- **The quotes report crashed for every role scoped narrower than "all".** It filtered
  quotes by an owner field quotes do not have. It now uses the person who prepared the quote.

### Changed — an approval covers the prices it was given

- **Changing what the customer pays, or what it costs us, on an approved quote voids the
  approval.** That means lines, quantities, prices, costs, discount, VAT or the worksheet's
  markup. The quote must be sent for approval again before it can be sent or its worksheet
  downloaded. A pending request is withdrawn the same way. Before this, a rep could get a
  manager's approval and then change the prices.
- Rewording notes, terms or a description keeps the approval.
- The approval bar says why an approval was voided. An edit that voided one cannot be undone:
  undo does not restore a signature.

### Added — the quote worksheet (part 1 of 3)

- **A Worksheet view on every quote**, for roles that see cost. Each line records what the
  vendor quoted, in the vendor's currency, the rate used, and a markup on cost. Zeus works
  out the cost in dirhams and the sell price, and shows the margin on sell beside the markup,
  because the approval floor and every report measure margin, not markup. 100 at 20% markup
  sells for 120, which is a 16.7% margin.
- **A default markup per quote**, with a per-line override. Changing the default reprices
  every line that uses it.
- **The rate is copied onto the line** when a currency is picked, so reopening the quote
  later shows the arithmetic that was actually used.
- **Internal lines** for costs bought from nobody, such as installation or freight.
- **Subtotals per vendor**, to check each block against the quote that vendor sent.
- **Laid out like a spreadsheet:** one row per line, every heading over its figures, and the
  totals as a strip under the sheet (subtotal, discount, net, VAT, total, cost, markup, margin).
- **Markup is shown wherever margin is:** in the Totals card, on the approval bar, and in the
  approvals queue, so a manager sees both numbers they are signing off.
- **Markup is shown as an amount as well as a percentage:** in the Totals card, the totals strip,
  the approval bar and queue, and in a *Markup* column on every worksheet line. Markup and margin
  are the same amount (the sell less the cost); only the percentage differs, because markup is
  measured on the cost and margin on the sell price.
- A vendor part number that matches a catalogue SKU links the line to that product.
- The server prices worksheet lines itself; a price sent from a browser is not trusted.
  A new version of a quote carries the worksheet, and so does undo.
- **Behaviour change:** on a line priced from the worksheet, the unit price and discount
  cannot be typed in the customer view. A Sales Executive sees the price but not the markup
  behind it, and cannot change or erase the worksheet by saving the quote.

### Added — reading the vendor's quote in (part 2 of 3)

- **Vendor quote** on the Worksheet view: paste the table from the email, or upload the
  vendor's Excel, CSV, Word or PDF. It works on a new quote too. Zeus reads it on its own server;
  the document is never sent to an outside service.
- **Nothing goes onto the worksheet unchecked.** Each line found is shown beside the row it was
  read from. Lines whose quantity × price matches their own total are ticked; the rest are
  marked *check this*. The ticked lines are added up against **the vendor's printed total**,
  and the screen says plainly whether anything was missed.
- **Re-quotes:** a part number already on the worksheet updates that line's cost in place and
  shows the change (1,180.00 → 1,250.00, +5.9%) rather than adding it twice. Markups stay as set.
- **The original is kept with the quote** under *Vendor documents*: straight away on a saved
  quote, or when you click Create on a new one. These carry buy prices, so they are visible only
  to roles that see cost, and never appear on the account.
- A scanned PDF has no text to read; Zeus says so and asks for the table or the Excel version.

**After the deploy:** nothing to do. The server image now includes `pdftotext`, which reads PDFs.

### Added — the worksheet as Excel (part 3 of 3)

- **Download the worksheet once the quote is approved**, from the Worksheet view. Two files:
  - **Excel**: the approved figures, for the record. For any role that sees cost.
  - **With formulas**: the sell prices are live formulas over the vendor price, rate and
    markup, so changing a markup or a rate reprices the sheet. Only for roles that approve
    quotes. The formulas are Zeus's own arithmetic, so an untouched file shows exactly the
    approved figures.
- Both files say at the top that they contain buy prices and are not for customers or vendors.
  Every download is recorded in the audit log.

### Changed — imports settle their accounts first

- **Every account an import names is settled before anything is written.** Contacts, deals,
  catalogue items and vendor price lists all name an account. Before, a name Zeus did not have
  exactly was silently created as a Customer, and a contact whose row named no company was
  created belonging to nobody. Now a *Settle the accounts* step lists each one Zeus does not
  hold by that exact name, with suggestions: an account whose name matches once "LLC", "FZE"
  and the like are set aside, or one on the same email domain as the rows. For each, link it,
  create it as a Customer, Partner, Prospect or Vendor, or leave its rows out. The import will
  not run until every one has an answer.
- **A contact is never imported without an account.** A row with no account name is settled in
  the same step; if its email has a company domain, a name is suggested from it.
- **A contact's last name is optional**, in imports and on the contact form. So is a lead's.
- **Only a record's name is required; other details can be missing.** Contacts need a first name
  and an account; leads need a first name; accounts need a name; deals need a name and a
  customer. Some details are *expected* and are marked amber in the template and the column
  list: email or phone for contacts, leads and accounts, company for leads, and type and domain
  for accounts. The preview lists every row missing one. A single tick box, *Import the rows
  missing details, leaving them blank*, decides whether those rows are imported or skipped. A
  Type that isn't one of Zeus's types counts as missing. A lead with no company can be
  converted only into an account you choose.
- **A contact always has an account**, however it is made: imported, converted from a lead, or
  added by hand. The contact form requires one, and an edit cannot remove it. Contacts already
  without an account are untouched until someone edits their account.
- **Undo on import history.** An import can be undone for 72 hours (the same undo window as the
  rest of Zeus). Undo removes the records it created and puts back the records it updated as they
  were. Anything worked on since is kept and listed with the reason, such as a contact put on a
  quote, a deal moved on, or a record edited again. Imports run before this release kept no
  record of what they wrote, so they cannot be undone.
- New accounts created by an import keep the email domain of their contacts, so the next
  duplicate check can find them.

### Changed — Settings, reorganised

- **The menu is grouped** under Business, Sales setup, People & security, Connections, Alerts,
  Data & health, and You.
- **One save bar.** Each card no longer has its own Save button. When anything changes, a bar
  at the bottom shows how many changes there are and saves or discards them together.
  Leaving with changes unsaved asks first, whether by a link, the browser's Back button, a reload
  or closing the tab. Alert rules used to save on every click; they now wait for the bar too.
  Buttons that act on saved values (Test connection, Grant admin consent, Send test email, the
  WhatsApp test) wait until pending changes are saved, instead of quietly testing the old values.
- **Fields are in the order a person reads them**, under sub-headings: Company is identity,
  address, contact, bank; Finance & VAT is VAT, currency, then quotes, invoices and purchase
  orders. Every window reads start before end.
- **Plain inputs.** Hours are chosen from a list of times instead of typed as 0–23. The backup
  schedule is "Every day / Every Monday … at 02:00" instead of a cron string; an unusual
  schedule still shows its cron. The default role for new users is picked from the roles. "Rates
  last fetched" is no longer an editable box.
- **Sign-in & security** is its own page: sign-in methods, sessions, lockout, and bot protection.
  These used to sit under Integrations.
- **Alert rules** are grouped into Sales, Finance, Partners, and Security & system. Each group
  has one "who gets it" control that sets every alert in it. The Teams and WhatsApp columns only
  appear once that channel is connected. Teams channels and Scheduled reports have their own
  pages.
- **Backups** shows the schedule first and the latest 5 backups, with *Show all*.
- **Data & privacy** is its own page: read logging, data retention and SIEM forwarding. They used
  to sit above the audit trail and under the system log. The log pages now hold only logs.
- **On a phone** the Settings menu is a single dropdown, so the page is not below 26 links.
- **Settings that had no screen now have one:** Approvals, document numbering (with an example
  of the next number), Renewals, Duplicates (including the free email domains), and General
  (undo window, the coaching high-value amount, and product name).

### Fixed — a template filled in elsewhere could not be imported

- Zeus's import template puts a note on every header. A template re-saved by a tool that writes
  those notes differently (openpyxl, and tools built on it) failed to upload with "Cannot read
  properties of undefined (reading 'comments')", before a single row was read. Notes are now
  ignored when a workbook is read. The same applies to vendor quotes uploaded as Excel.

### Fixed — alerts that reported a blip as an outage

Found on 14 September, when the office router's DNS dropped lookups for an afternoon.

- **Outbound email no longer stays red for a day after one failed send.** It is now judged
  by the most recent send. Before, two alert emails that failed at 15:00 kept email "down"
  until 15:00 the next day, although the mail sent at 16:00 went out.
- **Teams alerts are no longer marked down by a post that never reached Teams.** When the
  last post failed on the network (DNS, a timeout), the status check now asks whether the
  Teams host answers *now*. Before, one failed card held Teams down until another alert
  happened to post, and that failure raised a "Teams alerts is down" alert of its own.
  An error Teams itself sends back, such as a deleted channel, still counts as down.
- **Infrastructure alerts go to Administrators only on existing installs too.** A component
  down or recovered, a backup failed, missed or unverified, or a data-integrity finding went to
  Sales Managers as well on any install whose rules were created before that default. The deploy
  moves those six rules to *Administrators only* if they still have the old audience. A rule set
  to anything else is left as it is.

### Fixed — accessibility

- **Warning text is readable.** Amber used as small text, such as "48d in stage" on the deals
  board, measured 3.1:1 against white. It now has its own darker text colour (6.6:1), and a
  lighter one in dark mode.
- **Error text is readable in dark mode.** Sixteen warning and error messages, including the
  dashboard's overdue-deals line, used a light-mode red that measured 2.1:1 on the dark
  background.
- **A keyboard can scroll** a table wider than the screen and a long column on the deals board.
- **Pop-ups are announced as dialogs.** Keyboard focus moves into them when they open and returns
  to where it was when they close.
- The accessibility check now also covers Alert rules, Backups and Import.

**After the deploy:** nothing to do. Three migrations only add columns; the fourth moves the six
infrastructure alert rules described above.

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
