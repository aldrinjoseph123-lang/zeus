import { prisma } from '../db.js';

/**
 * Settings are the "change it without a deploy" layer: VAT rate, company letterhead,
 * lead sources, lost reasons, stale thresholds, numbering prefixes.
 * Cached in memory and busted on write — a single-node app does not need Redis for this.
 */
let cache: Map<string, unknown> | null = null;

export const SETTING_DEFAULTS: Record<string, unknown> = {
  'company.name': 'Protect24x7',
  'company.legalName': 'Protect24x7 FZ-LLC',
  'company.trn': '',
  'company.addressLine1': 'Dubai Silicon Oasis',
  'company.addressLine2': '',
  'company.city': 'Dubai',
  'company.emirate': 'Dubai',
  'company.country': 'United Arab Emirates',
  'company.poBox': '',
  'company.phone': '',
  'company.email': '',
  'company.website': 'https://protect24x7.ae',
  /// Emirate where supplies are made — printed as the place of supply.
  'company.placeOfSupply': 'Dubai',
  'company.bankName': '',
  'company.bankIban': '',
  'company.bankSwift': '',

  'finance.currency': 'AED',
  /// AED per one unit of the foreign currency, refreshed daily from the feed below.
  /// Seeded with the dirham's dollar peg so a fresh install can price a USD SKU before
  /// the first fetch, and so an unreachable feed always has something sane to fall back on.
  'finance.exchangeRates': { USD: 3.6725 },
  /// Public rates feed. `{from}` is the vendor's currency, `{base}` ours; the response
  /// must carry `rates[base]`. Swap the host here if this one ever goes away — no redeploy.
  'finance.exchangeRateApi': 'https://open.er-api.com/v6/latest/{from}',
  /// When the stored rates were last fetched. Written by the job, not by hand.
  'finance.exchangeRatesUpdatedAt': '',
  'finance.vatRate': 5,
  'finance.vatLabel': 'VAT (5%)',
  'finance.quoteValidDays': 30,
  'finance.paymentTermsDays': 30,
  'finance.quoteTerms':
    'Prices are in AED and exclusive of VAT unless stated. Quotation valid for 30 days from the issue date. Delivery subject to vendor lead time and stock availability.',
  'finance.invoiceTerms':
    'Payment due within 30 days of the invoice date. Please quote the invoice number with your remittance. Bank charges are for the account of the remitter.',
  'finance.poTerms':
    'Delivery to the address stated above. Please acknowledge receipt of this purchase order and confirm the delivery date. Invoices must quote this purchase order number.',
  /// Days before a due date that a payment reminder fires — both the money you are
  /// owed and the money you owe.
  'finance.paymentReminderDays': 5,
  'finance.poPaymentTermsDays': 30,
  /// Printed on the tax invoice. Required where the recipient accounts for the VAT.
  'finance.reverseChargeStatement':
    'Reverse charge: the recipient is required to account for the VAT due on this supply under Article 48 of Federal Decree-Law No. 8 of 2017.',

  'numbering.dealPrefix': 'ZEU-D-',
  'numbering.quotePrefix': 'ZEU-Q-',
  'numbering.invoicePrefix': 'ZEU-INV-',
  'numbering.creditNotePrefix': 'ZEU-CN-',
  'numbering.poPrefix': 'ZEU-PO-',
  'numbering.subscriptionPrefix': 'ZEU-SUB-',
  'numbering.padding': 6,

  'pipeline.staleAccountDays': 7,
  'pipeline.staleDealDays': 14,
  'pipeline.registrationExpiryWarnDays': 30,
  /// How long a registration protects the deal, both channel directions. Vendors and
  /// partners in this market both work to 90 days; override per registration if one
  /// vendor's programme runs to a different clock.
  'pipeline.registrationValidDays': 90,
  /// Mail the partner contact before their protection lapses. Needs Microsoft 365 connected.
  'pipeline.notifyPartnerOnExpiry': true,
  /// Days before expiry the partner gets their warning mail, and the gap between repeats.
  'pipeline.partnerReminderDays': 14,
  'pipeline.taskReminderHours': 24,

  /// Manager sign-off. A threshold of 0 means everything needs approving; raise it to
  /// let small deals and routine invoices through untouched.
  'approvals.dealsEnabled': true,
  'approvals.dealMinAmount': 0,
  // Every quote needs manager/admin sign-off before it can be sent (min 0 = all).
  'approvals.quotesEnabled': true,
  'approvals.quoteMinAmount': 0,
  'approvals.purchaseOrdersEnabled': true,
  'approvals.purchaseOrderMinAmount': 0,
  'approvals.invoicesEnabled': true,
  'approvals.invoiceMinAmount': 0,
  /// Below this margin a deal needs approving whatever it is worth — the discount
  /// giveaway is what a sales manager actually wants to catch.
  'approvals.dealMinMarginPct': 0,

  /// A deal at or above this net value that is also stalling is flagged for escalation
  /// on the coaching dashboard.
  'coaching.highValueAmount': 50000,
  /// A manager who owns the deal cannot normally sign off their own submission. On a
  /// small team where the manager carries a bag too, that would deadlock — switch this
  /// on and the audit trail carries who approved what instead.
  'approvals.allowSelfApproval': false,

  /// Renewals. A reseller's income is mostly re-sold time, so an expiry has to become
  /// a piece of work before it becomes a lost customer.
  /// Days before expiry that Zeus opens the renewal opportunity.
  'renewals.leadDays': 90,
  /// Days before expiry someone gets told. Each step fires once per subscription.
  'renewals.reminderDays': [90, 30, 7],
  /// Turn an issued invoice's termed lines into entitlements automatically.
  'renewals.autoCreateFromInvoice': true,
  /// Standard uplift applied to the renewal opportunity's value, in percent.
  'renewals.upliftPct': 0,
  /// Source recorded on renewal deals, so the pipeline can be split new vs renewal.
  'renewals.dealSource': 'Renewal',
  /// A deal can close won for a one-off sale that was never meant to recur — this is
  /// how long to wait after close before a deal with no entitlement at all counts as
  /// a gap worth chasing, rather than an invoice just not raised yet.
  'renewals.gapGraceDays': 14,

  /// How far back the undo button reaches. Past this the change stands and has to be
  /// corrected by hand — undo is a safety net for a mis-click, not a time machine.
  'undo.windowHours': 72,

  'lists.leadSources': [
    'Database',
    'LinkedIn',
    'Partner Referral',
    'Website',
    'Event',
    'Cold Call',
    'Inbound Email',
    'Existing Customer',
  ],
  'lists.lostReasons': [
    'Price',
    'Lost to competitor',
    'No budget',
    'No decision / timing',
    'Went with incumbent',
    'Requirement withdrawn',
    'Unresponsive',
  ],
  'lists.industries': [
    'Banking & Finance',
    'Government',
    'Healthcare',
    'Oil & Gas',
    'Education',
    'Retail',
    'Logistics',
    'Hospitality',
    'Real Estate',
    'Technology',
    'Manufacturing',
    'Telecom',
  ],
  'lists.emirates': ['Abu Dhabi', 'Dubai', 'Sharjah', 'Ajman', 'Umm Al Quwain', 'Ras Al Khaimah', 'Fujairah'],
  'lists.employeeBands': ['1-50', '51-200', '201-1000', '1001-5000', '5000+'],
  'lists.ratings': ['Hot', 'Warm', 'Cold'],
  'lists.units': ['licence', 'user', 'endpoint', 'device', 'month', 'year', 'project', 'day', 'incident'],
  'lists.productCategories': [
    'Data & Email',
    'Endpoint & Detection',
    'Network & Cloud',
    'Identity & OT',
    'Risk & Exposure',
    'Managed Security',
  ],
  'lists.competitors': [],
  'lists.paymentMethods': ['Bank Transfer', 'Cheque', 'Cash', 'Credit Card', 'Letter of Credit', 'Offset / Credit Note'],

  'dedupe.enabled': true,
  'dedupe.blockOnExactDomain': false,
  'dedupe.freeEmailDomains': [
    'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com', 'icloud.com',
    'aol.com', 'protonmail.com', 'gmx.com', 'yandex.com', 'mail.com', 'zoho.com',
  ],

  'backup.enabled': false,
  'backup.cron': '0 2 * * *',
  'backup.retainLocal': 7,

  // System-log forwarding to a syslog server / SIEM (RFC5424 over UDP or TCP).
  'syslog.enabled': false,
  'syslog.host': '',
  'syslog.port': 514,
  'syslog.protocol': 'udp',

  /// Log every record view (who opened which deal/account/contact/…). High volume — off by default.
  'audit.logReads': false,

  'branding.productName': 'Zeus',
  'branding.tagline': 'Revenue command centre',

  'auth.allowLocalLogin': true,
  'auth.allowEntraLogin': true,
  /// Create a Zeus user automatically the first time someone signs in with a
  /// tenant Microsoft account. Off by default so the roster stays deliberate.
  'auth.autoProvisionEntra': false,
  'auth.defaultRoleName': 'Sales Executive',
  'auth.sessionHours': 12,
  /// Password guesses against one account, counted regardless of which IP they came
  /// from — the per-IP rate limit on /auth/login alone does not stop a distributed
  /// credential-stuffing attempt aimed at a single email.
  'auth.lockoutThreshold': 10,
  'auth.lockoutMinutes': 15,
  /// Administrators and Sales Managers can approve money and reassign the whole
  /// roster — require them to have 2FA switched on before they can change anything.
  'auth.require2faForManagers': false,
};

async function load(): Promise<Map<string, unknown>> {
  if (cache) return cache;
  const rows = await prisma.setting.findMany();
  const map = new Map<string, unknown>(Object.entries(SETTING_DEFAULTS));
  for (const row of rows) map.set(row.key, row.value);
  cache = map;
  return map;
}

export function invalidateSettings(): void {
  cache = null;
}

export async function getSetting<T>(key: string, fallback?: T): Promise<T> {
  const map = await load();
  const value = map.get(key);
  return (value === undefined ? (fallback ?? SETTING_DEFAULTS[key]) : value) as T;
}

export async function getSettings(prefix?: string): Promise<Record<string, unknown>> {
  const map = await load();
  const out: Record<string, unknown> = {};
  for (const [key, value] of map) {
    if (!prefix || key.startsWith(prefix)) out[key] = value;
  }
  return out;
}

export async function setSetting(key: string, value: unknown, category = 'general'): Promise<void> {
  await prisma.setting.upsert({
    where: { key },
    create: { key, value: value as never, category },
    update: { value: value as never },
  });
  invalidateSettings();
}

export async function vatRate(): Promise<number> {
  return Number(await getSetting<number>('finance.vatRate', 5));
}
