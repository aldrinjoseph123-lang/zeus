import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { audit } from '../lib/audit.js';
import { badRequest, clientIp, notFound, requirePermission } from '../lib/http.js';
import { readWorkbook, templateXlsx } from '../services/xlsx.js';
import { checkDuplicates, extractDomain, normalizeCompany } from '../services/dedupe.js';
import { nextReference } from '../lib/counters.js';
import { applyVat } from '../lib/money.js';
import { vatRate } from '../lib/settings.js';

/**
 * Spreadsheet import. Three steps, same as every CRM worth using:
 *   1. upload   → headers + sample rows + a guessed column mapping
 *   2. dry run  → exactly what would be created/updated/skipped, nothing written
 *   3. commit   → writes, with duplicates resolved by the chosen strategy
 */

interface FieldDef {
  key: string;
  label: string;
  required?: boolean;
  /** Header names we recognise without being told. */
  aliases: string[];
  type?: 'number' | 'date' | 'boolean';
  /** Sample value for the downloadable template — what a filled cell looks like. */
  example?: string;
  /** Second sample row, so the template shows the column varying rather than repeating. */
  example2?: string;
  /** Closed list. Becomes a dropdown in the Excel template and a note in the CSV one. */
  values?: string[];
}

const EMIRATES = ['Dubai', 'Abu Dhabi', 'Sharjah', 'Ajman', 'Ras Al Khaimah', 'Fujairah', 'Umm Al Quwain'];
const SOURCES = ['Database', 'LinkedIn', 'Partner', 'Referral', 'Website', 'Event'];

export const MODULE_FIELDS: Record<string, FieldDef[]> = {
  leads: [
    { key: 'firstName', label: 'First name', required: true, aliases: ['first name', 'firstname', 'given name', 'name'], example: 'Ahmed', example2: 'Priya' },
    { key: 'lastName', label: 'Last name', required: true, aliases: ['last name', 'lastname', 'surname', 'family name'], example: 'Al Mansoori', example2: 'Nair' },
    { key: 'company', label: 'Company', required: true, aliases: ['company', 'company name', 'organisation', 'organization', 'account'], example: 'Gulf Systems General Trading', example2: 'Al Noor Hospital Group' },
    { key: 'email', label: 'Email', aliases: ['email', 'e-mail', 'email address', 'work email'], example: 'ahmed@gulfsystems.ae', example2: 'priya.nair@alnoorhealth.ae' },
    { key: 'phone', label: 'Phone', aliases: ['phone', 'telephone', 'mobile', 'contact number'], example: '+971 50 123 4567', example2: '+971 2 555 8899' },
    { key: 'jobTitle', label: 'Job title', aliases: ['title', 'job title', 'designation', 'position'], example: 'IT Manager', example2: 'Head of Information Security' },
    { key: 'linkedinUrl', label: 'LinkedIn', aliases: ['linkedin', 'linkedin url', 'profile'], example: 'https://linkedin.com/in/ahmed-al-mansoori', example2: '' },
    { key: 'source', label: 'Source', aliases: ['source', 'lead source', 'origin'], values: SOURCES, example: 'LinkedIn', example2: 'Partner' },
    { key: 'status', label: 'Status', aliases: ['status', 'lead status'], values: ['NEW', 'WORKING', 'NURTURING', 'QUALIFIED', 'DISQUALIFIED'], example: 'NEW', example2: 'WORKING' },
    { key: 'rating', label: 'Rating', aliases: ['rating', 'temperature'], values: ['Hot', 'Warm', 'Cold'], example: 'Warm', example2: 'Hot' },
    { key: 'interestArea', label: 'Interest area', aliases: ['interest', 'interest area', 'product', 'requirement'], example: 'Endpoint & Detection', example2: 'Managed SOC' },
    { key: 'estimatedValue', label: 'Estimated value', type: 'number', aliases: ['value', 'estimated value', 'budget', 'amount'], example: '250000', example2: '90000' },
    { key: 'emirate', label: 'Emirate', aliases: ['emirate', 'city', 'location'], values: EMIRATES, example: 'Dubai', example2: 'Abu Dhabi' },
    { key: 'description', label: 'Notes', aliases: ['notes', 'description', 'comments', 'remarks'], example: 'Met at GISEC, renewing EDR in Q4', example2: '' },
  ],
  accounts: [
    { key: 'name', label: 'Account name', required: true, aliases: ['name', 'account', 'company', 'company name', 'customer'], example: 'Emirates NBD Bank P.J.S.C.', example2: 'Falcon Technologies LLC' },
    { key: 'type', label: 'Type', aliases: ['type', 'account type', 'category'], values: ['CUSTOMER', 'PARTNER', 'VENDOR', 'PROSPECT'], example: 'CUSTOMER', example2: 'PARTNER' },
    { key: 'domain', label: 'Domain', aliases: ['domain', 'website', 'url', 'web'], example: 'emiratesnbd.com', example2: 'falcontech.ae' },
    { key: 'industry', label: 'Industry', aliases: ['industry', 'sector', 'vertical'], example: 'Banking & Finance', example2: 'IT Reseller' },
    { key: 'phone', label: 'Phone', aliases: ['phone', 'telephone', 'contact number'], example: '+971 4 316 0000', example2: '+971 4 887 1200' },
    { key: 'email', label: 'Email', aliases: ['email', 'e-mail'], example: 'procurement@emiratesnbd.com', example2: 'sales@falcontech.ae' },
    { key: 'trn', label: 'TRN', aliases: ['trn', 'tax number', 'vat number', 'tax registration number'], example: '100123456700003', example2: '100987654300003' },
    { key: 'addressLine1', label: 'Address', aliases: ['address', 'address line 1', 'street'], example: 'Baniyas Road, Deira', example2: 'Dubai Silicon Oasis, Building A' },
    { key: 'city', label: 'City', aliases: ['city', 'town'], example: 'Dubai', example2: 'Dubai' },
    { key: 'emirate', label: 'Emirate', aliases: ['emirate', 'state', 'region'], values: EMIRATES, example: 'Dubai', example2: 'Dubai' },
    { key: 'poBox', label: 'P.O. Box', aliases: ['po box', 'p.o. box', 'pobox'], example: '777', example2: '341041' },
    { key: 'employeeBand', label: 'Employees', aliases: ['employees', 'size', 'headcount'], values: ['1-10', '11-50', '51-200', '201-1000', '1000+'], example: '1000+', example2: '11-50' },
    { key: 'description', label: 'Notes', aliases: ['notes', 'description', 'comments'], example: 'Group-wide security refresh planned', example2: '' },
  ],
  contacts: [
    { key: 'firstName', label: 'First name', required: true, aliases: ['first name', 'firstname', 'given name'], example: 'Fatima', example2: 'John' },
    { key: 'lastName', label: 'Last name', required: true, aliases: ['last name', 'lastname', 'surname'], example: 'Al Hashimi', example2: 'Mathew' },
    { key: 'accountName', label: 'Account name', aliases: ['company', 'account', 'company name', 'customer', 'organisation'], example: 'Emirates NBD Bank P.J.S.C.', example2: 'Falcon Technologies LLC' },
    { key: 'email', label: 'Email', aliases: ['email', 'e-mail', 'email address'], example: 'fatima.alhashimi@emiratesnbd.com', example2: 'john.mathew@falcontech.ae' },
    { key: 'phone', label: 'Phone', aliases: ['phone', 'telephone', 'direct'], example: '+971 4 316 0142', example2: '+971 4 887 1215' },
    { key: 'mobile', label: 'Mobile', aliases: ['mobile', 'cell', 'cellphone'], example: '+971 50 998 4411', example2: '+971 55 220 7788' },
    { key: 'jobTitle', label: 'Job title', aliases: ['title', 'job title', 'designation'], example: 'CISO', example2: 'Account Manager' },
    { key: 'department', label: 'Department', aliases: ['department', 'function'], example: 'Information Security', example2: 'Sales' },
    { key: 'linkedinUrl', label: 'LinkedIn', aliases: ['linkedin', 'linkedin url'], example: 'https://linkedin.com/in/fatima-alhashimi', example2: '' },
  ],
  products: [
    { key: 'sku', label: 'SKU', required: true, aliases: ['sku', 'part number', 'code', 'item code', 'part no'], example: 'CRWD-FLC-PRO', example2: 'P24-SOC-MDR' },
    { key: 'name', label: 'Name', required: true, aliases: ['name', 'product', 'description', 'item'], example: 'CrowdStrike Falcon Pro — 1 year', example2: 'Managed Detection & Response' },
    { key: 'type', label: 'Type', aliases: ['type', 'product type'], values: ['PRODUCT', 'SERVICE'], example: 'PRODUCT', example2: 'SERVICE' },
    { key: 'category', label: 'Category', aliases: ['category', 'group', 'portfolio'], example: 'Endpoint Security', example2: 'Managed Services' },
    { key: 'vendorName', label: 'Vendor', aliases: ['vendor', 'manufacturer', 'brand', 'oem'], example: 'CrowdStrike', example2: 'Protect24x7' },
    { key: 'unit', label: 'Unit', aliases: ['unit', 'uom', 'billing unit'], values: ['licence', 'endpoint', 'device', 'user', 'month', 'year', 'each'], example: 'endpoint', example2: 'month' },
    { key: 'listPrice', label: 'List price', type: 'number', aliases: ['list price', 'price', 'sell', 'msrp', 'unit price'], example: '210', example2: '15000' },
    { key: 'cost', label: 'Cost', type: 'number', aliases: ['cost', 'buy', 'purchase price', 'dealer price'], example: '138', example2: '9000' },
    { key: 'description', label: 'Description', aliases: ['description', 'details', 'notes'], example: 'NGAV + device control, per endpoint per year', example2: '24x7 SOC monitoring, per month' },
  ],
  deals: [
    { key: 'name', label: 'Deal name', required: true, aliases: ['name', 'deal', 'opportunity', 'subject'], example: 'ENBD — EDR rollout 2026', example2: 'Al Noor — Managed SOC' },
    { key: 'accountName', label: 'Customer', required: true, aliases: ['customer', 'account', 'company', 'end customer', 'client'], example: 'Emirates NBD Bank P.J.S.C.', example2: 'Al Noor Hospital Group' },
    { key: 'partnerName', label: 'Partner', aliases: ['partner', 'reseller', 'channel partner'], example: 'Falcon Technologies LLC', example2: '' },
    { key: 'amount', label: 'Net amount', type: 'number', aliases: ['amount', 'value', 'net', 'deal value', 'price'], example: '250000', example2: '180000' },
    { key: 'stageName', label: 'Stage', aliases: ['stage', 'status', 'phase'], example: 'Qualified', example2: 'Proposal' },
    { key: 'type', label: 'Type', aliases: ['type', 'deal type'], values: ['PRODUCT', 'SERVICE'], example: 'PRODUCT', example2: 'SERVICE' },
    { key: 'source', label: 'Source', aliases: ['source', 'lead source'], values: SOURCES, example: 'Partner', example2: 'Database' },
    { key: 'closeDate', label: 'Close date', type: 'date', aliases: ['close date', 'expected close', 'closing date', 'date'], example: '2026-09-30', example2: '2026-11-15' },
    { key: 'description', label: 'Notes', aliases: ['notes', 'description', 'comments'], example: '3-year licence, phased rollout', example2: '' },
  ],
};

const norm = (s: string) => s.toLowerCase().replace(/[_\-.]/g, ' ').replace(/\s+/g, ' ').trim();

function guessMapping(headers: string[], module: string): Record<string, string> {
  const fields = MODULE_FIELDS[module] ?? [];
  const mapping: Record<string, string> = {};
  const used = new Set<string>();

  for (const field of fields) {
    const match = headers.find((h) => !used.has(h) && (norm(h) === norm(field.label) || field.aliases.includes(norm(h))));
    if (match) { mapping[field.key] = match; used.add(match); }
  }
  return mapping;
}

function coerce(value: string | undefined, type?: string): unknown {
  if (value === undefined || value === '') return null;
  if (type === 'number') {
    const n = Number(String(value).replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  if (type === 'date') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (type === 'boolean') return ['yes', 'true', '1', 'y'].includes(value.toLowerCase());
  return value;
}

export default async function importRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/imports/fields/:module', { preHandler: requirePermission('imports', 'read') }, async (request) => {
    const { module } = request.params as { module: string };
    const fields = MODULE_FIELDS[module];
    if (!fields) throw badRequest(`Import is not supported for "${module}".`);
    return fields;
  });

  /**
   * Step 0 — the blank template. Headers are the field labels the guesser already
   * recognises, so a file filled in from this maps itself with nothing to correct.
   */
  app.get('/api/imports/template/:module', { preHandler: requirePermission('imports', 'read') }, async (request, reply) => {
    const { module } = request.params as { module: string };
    const { format = 'xlsx' } = request.query as { format?: string };
    const fields = MODULE_FIELDS[module];
    if (!fields) throw badRequest(`Import is not supported for "${module}".`);

    // Deal stages are configurable, so the template offers whatever this Zeus has.
    let columns = fields as FieldDef[];
    if (module === 'deals') {
      const pipeline = await prisma.pipeline.findFirst({
        where: { isDefault: true, isActive: true },
        include: { stages: { orderBy: { order: 'asc' } } },
      });
      const names = pipeline?.stages.map((s) => s.name) ?? [];
      if (names.length) {
        columns = fields.map((f) => (f.key === 'stageName' ? { ...f, values: names, example: names[0], example2: names[1] ?? names[0] } : f));
      }
    }

    const title = `zeus-${module}-template`;
    const note = 'Keep the header row exactly as it is, fill one record per row, and delete the two grey example rows before uploading.';

    if (format === 'csv') {
      const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
      const csv = [
        columns.map((f) => cell(f.label)),
        columns.map((f) => cell(f.example ?? '')),
        columns.map((f) => cell(f.example2 ?? '')),
      ].map((row) => row.join(',')).join('\r\n');
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${title}.csv"`)
        .send(`﻿${csv}\r\n`);
    }

    const buffer = await templateXlsx({ title: module, columns, note });
    return reply
      .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', `attachment; filename="${title}.xlsx"`)
      .send(buffer);
  });

  /** Step 1 — upload, parse headers, guess the mapping. */
  app.post('/api/imports/upload', { preHandler: requirePermission('imports', 'create') }, async (request, reply) => {
    const file = await request.file();
    if (!file) throw badRequest('No file uploaded.');

    const module = String((file.fields.module as { value?: string } | undefined)?.value ?? 'leads');
    if (!MODULE_FIELDS[module]) throw badRequest(`Import is not supported for "${module}".`);

    const buffer = await file.toBuffer();
    if (buffer.byteLength > 20 * 1024 * 1024) throw badRequest('File is larger than 20 MB.');

    const { headers, rows } = await readWorkbook(buffer, file.filename);
    if (!headers.length) throw badRequest('That file has no header row.');
    if (!rows.length) throw badRequest('That file has no data rows.');

    await mkdir(env.UPLOAD_DIR, { recursive: true });
    const storedName = `${randomUUID()}${path.extname(file.filename) || '.csv'}`;
    await writeFile(path.join(env.UPLOAD_DIR, storedName), buffer);

    const job = await prisma.importJob.create({
      data: {
        module,
        filename: file.filename,
        status: 'mapping',
        totalRows: rows.length,
        mapping: { storedName, guess: guessMapping(headers, module) } as never,
        createdById: request.user.id,
      },
    });

    return reply.status(201).send({
      jobId: job.id,
      module,
      filename: file.filename,
      headers,
      totalRows: rows.length,
      sample: rows.slice(0, 5),
      fields: MODULE_FIELDS[module],
      suggestedMapping: guessMapping(headers, module),
    });
  });

  /** Step 2 & 3 — dry run then commit, same code path so the preview is honest. */
  app.post('/api/imports/:id/run', { preHandler: requirePermission('imports', 'create') }, async (request) => {
    const { id } = request.params as { id: string };
    const schema = z.object({
      mapping: z.record(z.string()),
      dryRun: z.boolean().default(true),
      /** skip = leave existing alone, update = merge into it, create = add anyway */
      onDuplicate: z.enum(['skip', 'update', 'create']).default('skip'),
      ownerId: z.string().optional(),
      defaults: z.record(z.string()).optional(),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
    const { mapping, dryRun, onDuplicate, defaults } = parsed.data;

    const job = await prisma.importJob.findUnique({ where: { id } });
    if (!job) throw notFound('Import job not found.');

    const stored = (job.mapping as { storedName?: string }).storedName;
    if (!stored) throw badRequest('The uploaded file is no longer available. Upload it again.');

    const buffer = await readFile(path.join(env.UPLOAD_DIR, stored));
    const { rows } = await readWorkbook(buffer, job.filename);
    const fields = MODULE_FIELDS[job.module];
    const ownerId = parsed.data.ownerId ?? request.user.id;

    const errors: Array<{ row: number; message: string }> = [];
    const preview: Array<{ row: number; action: string; label: string; note?: string }> = [];
    let imported = 0;
    let updated = 0;
    let skipped = 0;

    // Cache name lookups so a 5000-row file does not run 5000 identical queries.
    const accountCache = new Map<string, string | null>();
    const resolveAccount = async (name: string, type: 'CUSTOMER' | 'PARTNER' | 'VENDOR' = 'CUSTOMER'): Promise<string | null> => {
      const key = normalizeCompany(name);
      if (!key) return null;
      if (accountCache.has(key)) return accountCache.get(key)!;
      let account = await prisma.account.findFirst({
        where: { deletedAt: null, name: { equals: name, mode: 'insensitive' } },
        select: { id: true },
      });
      if (!account && !dryRun) {
        account = await prisma.account.create({ data: { name, type, ownerId, lastActivityAt: new Date() }, select: { id: true } });
      }
      accountCache.set(key, account?.id ?? null);
      return account?.id ?? null;
    };

    const defaultVat = await vatRate();
    const pipeline = await prisma.pipeline.findFirst({ where: { isDefault: true, isActive: true }, include: { stages: { orderBy: { order: 'asc' } } } });

    for (const [index, raw] of rows.entries()) {
      const rowNo = index + 2; // +1 header, +1 to be 1-based like the spreadsheet
      const record: Record<string, unknown> = {};
      for (const field of fields) {
        const column = mapping[field.key];
        if (!column) continue;
        record[field.key] = coerce(raw[column], field.type);
      }
      for (const [key, value] of Object.entries(defaults ?? {})) {
        if (record[key] === null || record[key] === undefined || record[key] === '') record[key] = value;
      }

      const missing = fields.filter((f) => f.required && !record[f.key]).map((f) => f.label);
      if (missing.length) {
        errors.push({ row: rowNo, message: `Missing required: ${missing.join(', ')}` });
        skipped += 1;
        continue;
      }

      try {
        if (job.module === 'leads') {
          const domain = extractDomain(record.email as string);
          const dupes = await checkDuplicates({ module: 'leads', company: record.company as string, email: record.email as string, domain });
          if (dupes.hasDuplicates && onDuplicate === 'skip') {
            skipped += 1;
            preview.push({ row: rowNo, action: 'skip', label: String(record.company), note: dupes.matches[0]?.reason });
            continue;
          }
          preview.push({ row: rowNo, action: dupes.hasDuplicates ? 'create (duplicate)' : 'create', label: `${record.firstName} ${record.lastName} — ${record.company}` });
          if (!dryRun) {
            await prisma.lead.create({
              data: {
                firstName: String(record.firstName), lastName: String(record.lastName), company: String(record.company),
                email: (record.email as string) || null, phone: (record.phone as string) || null,
                jobTitle: (record.jobTitle as string) || null, linkedinUrl: (record.linkedinUrl as string) || null,
                source: (record.source as string) || 'Database',
                status: (['NEW', 'WORKING', 'NURTURING', 'QUALIFIED', 'DISQUALIFIED'].includes(String(record.status ?? '').toUpperCase())
                  ? String(record.status).toUpperCase() : 'NEW') as never,
                rating: (record.rating as string) || null,
                interestArea: (record.interestArea as string) || null,
                estimatedValue: (record.estimatedValue as number) ?? null,
                emirate: (record.emirate as string) || null,
                description: (record.description as string) || null,
                domain, ownerId, lastActivityAt: new Date(),
              },
            });
          }
          imported += 1;
        }

        else if (job.module === 'accounts') {
          const domain = extractDomain((record.domain as string) ?? (record.email as string));
          const existing = domain
            ? await prisma.account.findFirst({ where: { domain, deletedAt: null } })
            : await prisma.account.findFirst({ where: { name: { equals: String(record.name), mode: 'insensitive' }, deletedAt: null } });

          if (existing && onDuplicate === 'skip') {
            skipped += 1;
            preview.push({ row: rowNo, action: 'skip', label: String(record.name), note: 'Account already exists' });
            continue;
          }

          const data = {
            name: String(record.name),
            type: (['CUSTOMER', 'PARTNER', 'VENDOR', 'PROSPECT'].includes(String(record.type ?? '').toUpperCase())
              ? String(record.type).toUpperCase() : 'PROSPECT') as never,
            domain,
            website: (record.domain as string) || null,
            industry: (record.industry as string) || null,
            phone: (record.phone as string) || null,
            email: (record.email as string) || null,
            trn: (record.trn as string) || null,
            addressLine1: (record.addressLine1 as string) || null,
            city: (record.city as string) || null,
            emirate: (record.emirate as string) || null,
            poBox: (record.poBox as string) || null,
            employeeBand: (record.employeeBand as string) || null,
            description: (record.description as string) || null,
          };

          if (existing && onDuplicate === 'update') {
            preview.push({ row: rowNo, action: 'update', label: String(record.name) });
            if (!dryRun) await prisma.account.update({ where: { id: existing.id }, data });
            updated += 1;
          } else {
            preview.push({ row: rowNo, action: 'create', label: String(record.name) });
            if (!dryRun) await prisma.account.create({ data: { ...data, ownerId, lastActivityAt: new Date() } });
            imported += 1;
          }
        }

        else if (job.module === 'contacts') {
          const accountId = record.accountName ? await resolveAccount(String(record.accountName)) : null;
          const existing = record.email
            ? await prisma.contact.findFirst({ where: { email: String(record.email), deletedAt: null } })
            : null;

          if (existing && onDuplicate === 'skip') {
            skipped += 1;
            preview.push({ row: rowNo, action: 'skip', label: `${record.firstName} ${record.lastName}`, note: 'Email already on file' });
            continue;
          }

          const data = {
            firstName: String(record.firstName), lastName: String(record.lastName),
            email: (record.email as string) || null, phone: (record.phone as string) || null,
            mobile: (record.mobile as string) || null, jobTitle: (record.jobTitle as string) || null,
            department: (record.department as string) || null, linkedinUrl: (record.linkedinUrl as string) || null,
            accountId,
          };

          if (existing && onDuplicate === 'update') {
            preview.push({ row: rowNo, action: 'update', label: `${record.firstName} ${record.lastName}` });
            if (!dryRun) await prisma.contact.update({ where: { id: existing.id }, data });
            updated += 1;
          } else {
            preview.push({ row: rowNo, action: 'create', label: `${record.firstName} ${record.lastName}` });
            if (!dryRun) await prisma.contact.create({ data: { ...data, ownerId } });
            imported += 1;
          }
        }

        else if (job.module === 'products') {
          const existing = await prisma.product.findUnique({ where: { sku: String(record.sku) } });
          if (existing && onDuplicate === 'skip') {
            skipped += 1;
            preview.push({ row: rowNo, action: 'skip', label: String(record.sku), note: 'SKU already exists' });
            continue;
          }
          const vendorId = record.vendorName ? await resolveAccount(String(record.vendorName), 'VENDOR') : null;
          const data = {
            sku: String(record.sku), name: String(record.name),
            type: (String(record.type ?? '').toUpperCase() === 'SERVICE' ? 'SERVICE' : 'PRODUCT') as never,
            category: (record.category as string) || null,
            vendorId,
            unit: (record.unit as string) || 'licence',
            listPrice: (record.listPrice as number) ?? 0,
            cost: (record.cost as number) ?? 0,
            description: (record.description as string) || null,
          };
          if (existing && onDuplicate === 'update') {
            preview.push({ row: rowNo, action: 'update', label: `${record.sku} ${record.name}` });
            if (!dryRun) await prisma.product.update({ where: { id: existing.id }, data });
            updated += 1;
          } else {
            preview.push({ row: rowNo, action: 'create', label: `${record.sku} ${record.name}` });
            if (!dryRun) await prisma.product.create({ data });
            imported += 1;
          }
        }

        else if (job.module === 'deals') {
          if (!pipeline || pipeline.stages.length === 0) throw new Error('No default pipeline with stages is configured.');
          const accountId = await resolveAccount(String(record.accountName));
          if (!accountId && !dryRun) throw new Error(`Could not resolve customer "${record.accountName}".`);

          const partnerId = record.partnerName ? await resolveAccount(String(record.partnerName), 'PARTNER') : null;
          const stage = pipeline.stages.find((s) => norm(s.name) === norm(String(record.stageName ?? ''))) ?? pipeline.stages[0];
          const net = (record.amount as number) ?? 0;
          const { vatAmount, total } = applyVat(net, defaultVat);

          preview.push({ row: rowNo, action: 'create', label: `${record.name} — ${record.accountName}`, note: `Stage: ${stage.name}` });
          if (!dryRun) {
            const deal = await prisma.deal.create({
              data: {
                reference: await nextReference('deal'),
                name: String(record.name),
                accountId: accountId!,
                partnerAccountId: partnerId,
                pipelineId: pipeline.id,
                stageId: stage.id,
                status: stage.isWon ? 'WON' : stage.isLost ? 'LOST' : 'OPEN',
                type: (String(record.type ?? '').toUpperCase() === 'SERVICE' ? 'SERVICE' : 'PRODUCT') as never,
                amount: net, vatRate: defaultVat, vatAmount, totalAmount: total,
                probability: stage.probability,
                closeDate: (record.closeDate as Date) ?? new Date(Date.now() + 30 * 86_400_000),
                source: (record.source as string) || 'Database',
                description: (record.description as string) || null,
                ownerId, lastActivityAt: new Date(),
                closedAt: stage.isWon || stage.isLost ? new Date() : null,
              },
            });
            await prisma.stageHistory.create({
              data: { dealId: deal.id, toStageId: stage.id, toStatus: stage.isWon ? 'WON' : stage.isLost ? 'LOST' : 'OPEN', amount: net, changedById: request.user.id },
            });
          }
          imported += 1;
        }
      } catch (err) {
        errors.push({ row: rowNo, message: (err as Error).message });
        skipped += 1;
      }
    }

    await prisma.importJob.update({
      where: { id },
      data: {
        status: dryRun ? 'mapping' : errors.length && !imported ? 'failed' : 'done',
        mapping: { ...(job.mapping as object), applied: mapping } as never,
        imported: dryRun ? 0 : imported,
        updated: dryRun ? 0 : updated,
        skipped,
        errors: errors.slice(0, 200) as never,
        dryRun,
        finishedAt: dryRun ? null : new Date(),
      },
    });

    if (!dryRun) {
      await audit({
        user: request.user, action: 'import', entity: job.module, entityId: id,
        summary: `${imported} created, ${updated} updated, ${skipped} skipped from ${job.filename}`,
        ip: clientIp(request),
      });
    }

    return {
      dryRun,
      totalRows: rows.length,
      wouldCreate: imported,
      wouldUpdate: updated,
      skipped,
      errors: errors.slice(0, 200),
      preview: preview.slice(0, 100),
    };
  });

  app.get('/api/imports', { preHandler: requirePermission('imports', 'read') }, async () =>
    prisma.importJob.findMany({
      include: { createdBy: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
  );
}
