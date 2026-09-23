import type { FastifyInstance } from 'fastify';
import { can, maskFields, type Module } from '../auth/rbac.js';
import { audit } from '../lib/audit.js';
import { clientIp, forbidden, HttpError, notFound } from '../lib/http.js';
import { tableXlsx } from '../services/xlsx.js';
import type { TableColumn } from '../services/pdf.js';

/**
 * Export the list you are looking at.
 *
 * One route for every list. It asks the list's own endpoint for the same query, page by
 * page, and writes the rows to a workbook. The list route is the one place that knows the
 * filters, the search, the sort, the owner scope and which fields this reader may see, so
 * the export cannot disagree with the screen: it is the screen, without the paging.
 */
const LISTS: Record<string, { path: string; module: Module; label: string }> = {
  deals: { path: '/api/deals', module: 'deals', label: 'Deals' },
  leads: { path: '/api/leads', module: 'leads', label: 'Leads' },
  accounts: { path: '/api/accounts', module: 'accounts', label: 'Accounts' },
  contacts: { path: '/api/contacts', module: 'contacts', label: 'Contacts' },
  quotes: { path: '/api/quotes', module: 'quotes', label: 'Quotes' },
  invoices: { path: '/api/invoices', module: 'invoices', label: 'Invoices' },
  products: { path: '/api/products', module: 'products', label: 'Products' },
  'purchase-orders': { path: '/api/purchase-orders', module: 'invoices', label: 'Purchase orders' },
};
const PAGE = 500; // the most a list hands over in one page
const MOST = 10_000; // ponytail: a spreadsheet, not a warehouse; raise it when a list outgrows it

export default async function exportRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/export/:list', async (request, reply) => {
    const key = (request.params as { list: string }).list;
    const list = LISTS[key];
    if (!list) throw notFound();
    if (!request.user) throw new HttpError(401, 'Sign in required.');
    if (!can(request.user, list.module, 'export')) throw forbidden(`Your role (${request.user.roleName}) cannot export ${list.module}.`);

    const query = { ...(request.query as Record<string, string>) };
    delete query.page; delete query.pageSize; delete query.format;
    const rows: Array<Record<string, unknown>> = [];
    let total = 0;
    for (let page = 1; rows.length < MOST; page++) {
      const res = await app.inject({
        method: 'GET', url: list.path, query: { ...query, page: String(page), pageSize: String(PAGE) },
        headers: { cookie: request.headers.cookie ?? '', authorization: request.headers.authorization ?? '' },
      });
      if (res.statusCode !== 200) throw new HttpError(res.statusCode, (res.json() as { error?: string }).error ?? 'The list could not be read.');
      const body = res.json() as { data: Array<Record<string, unknown>>; total: number };
      rows.push(...body.data);
      total = body.total;
      if (body.data.length < PAGE) break;
    }

    // The list already masked what this reader may not see; masking again costs nothing
    // and means the export never depends on a list route remembering to.
    const flat = maskFields(request.user, list.module, rows).map(flatten);
    const columns = columnsOf(flat);
    const filters = Object.entries(query).filter(([k, v]) => v && !['sortBy', 'sortDir'].includes(k)).map(([k, v]) => `${label(k)}: ${v}`).join(' · ');
    const buffer = await tableXlsx({
      title: list.label,
      columns,
      rows: flat,
      summary: [
        ['Rows', rows.length < total ? `${rows.length} of ${total} — narrow the filters for the rest` : String(rows.length)],
        ['Filters', filters || 'none'],
        ['Exported', new Date().toISOString().slice(0, 10)],
      ],
    });
    await audit({ user: request.user, action: 'export', entity: list.label, summary: `${rows.length} of ${total} rows as xlsx${filters ? ` (${filters})` : ''}`, ip: clientIp(request) });
    return reply
      .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', `attachment; filename="zeus-${key}-${new Date().toISOString().slice(0, 10)}.xlsx"`)
      .send(buffer);
  });
}

// ── rows to cells ────────────────────────────────────────────────────────────────

/** Ids, tombstones and child collections are not what a spreadsheet is for. */
const SKIP = /^id$|Id$|^deletedAt$|^_count$|^customFields$/;
const MONEY = /(amount|total|subtotal|cost|price|value|paid|balance|margin|net|gross)$/i;
const PERCENT = /(pct|probability)$/i;
const WHEN = /(At|Date)$/;
const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?/;
const NUMERIC = /^-?\d+(\.\d+)?$/;

/** A related record is named by the field a person would use for it. */
function cell(value: unknown): unknown {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(cell).filter((v) => v !== '' && typeof v !== 'object').join(', ');
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o.name === 'string') return o.name;
    if (typeof o.number === 'string') return o.number;
    if (typeof o.reference === 'string') return o.reference;
    if (typeof o.firstName === 'string') return `${o.firstName} ${(o.lastName as string) ?? ''}`.trim();
    return '';
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return value;
}

function flatten(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (SKIP.test(k)) continue;
    const c = cell(v);
    // Money and percentages arrive as Decimal strings; phones and TRNs must stay text.
    out[k] = typeof c === 'string' && NUMERIC.test(c) && (MONEY.test(k) || PERCENT.test(k)) ? Number(c) : c;
  }
  return out;
}

/** camelCase to words, with the initialisms a spreadsheet reader expects. */
export function label(key: string): string {
  const words = key.replace(/([A-Z])/g, ' $1').trim().toLowerCase();
  return (words.charAt(0).toUpperCase() + words.slice(1)).replace(/\b(vat|trn|po|id|url|sku|fx)\b/gi, (m) => m.toUpperCase());
}

/** Columns in the order the list gives them, dropping any that would be blank throughout. */
function columnsOf(rows: Array<Record<string, unknown>>): TableColumn[] {
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) => rows.some((r) => r[k] !== '' && r[k] !== null));
  return keys.map((key) => {
    const sample = rows.find((r) => r[key] !== '' && r[key] !== null)?.[key];
    const format: TableColumn['format'] =
      typeof sample === 'number' && MONEY.test(key) ? 'money'
        : typeof sample === 'number' && PERCENT.test(key) ? 'percent'
          : typeof sample === 'string' && WHEN.test(key) && ISO.test(sample) ? 'date'
            : 'text';
    return { key, label: label(key), format, align: format === 'money' || format === 'percent' ? 'right' : 'left' };
  });
}
