import { prisma } from '../db.js';
import { getSetting } from '../lib/settings.js';

/**
 * Duplicate detection.
 *
 * The customer's web domain is the spine: two reps working "Emirates NBD" and
 * "ENBD" are the same deal if both sit on emiratesnbd.com. Free mailbox domains
 * (gmail, outlook) are deliberately excluded — matching on those would flag every
 * SME lead as a duplicate of every other.
 *
 * This warns; it does not block, unless dedupe.blockOnExactDomain is turned on.
 */

// Sorted longest-first at load, so "general trading" is stripped as a unit rather
// than leaving "general" behind once "trading" is taken off the end.
const LEGAL_SUFFIXES = ([
  'fz llc', 'fz-llc', 'fzco', 'fze', 'llc', 'l l c', 'ltd', 'limited', 'inc', 'incorporated',
  'plc', 'gmbh', 'sa', 'sarl', 'bv', 'nv', 'pvt', 'private', 'co', 'company', 'corp', 'corporation',
  'holding', 'holdings', 'group', 'trading', 'general trading', 'est', 'establishment', 'dmcc', 'dwc',
] as string[]).sort((a, b) => b.length - a.length);

export function extractDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let value = input.trim().toLowerCase();
  if (!value) return null;

  if (value.includes('@')) value = value.split('@').pop() ?? '';
  value = value.replace(/^https?:\/\//, '').replace(/^www\./, '');
  value = value.split('/')[0].split('?')[0].split(':')[0];

  // Must look like a domain: at least one dot, valid characters.
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(value)) return null;
  return value;
}


async function isFreeEmailDomain(domain: string | null): Promise<boolean> {
  if (!domain) return false;
  const list = await getSetting<string[]>('dedupe.freeEmailDomains', []);
  return list.includes(domain.toLowerCase());
}

/** "Emirates NBD Bank P.J.S.C." -> "emirates nbd bank pjsc" -> "emirates nbd bank" */
export function normalizeCompany(name: string | null | undefined): string {
  if (!name) return '';
  let value = name
    .toLowerCase()
    // Dots vanish rather than becoming spaces, so "P.J.S.C." collapses to "pjsc"
    // and still matches the same company written "PJSC".
    .replace(/\./g, '')
    .replace(/[,'"()&]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of LEGAL_SUFFIXES) {
      if (value.endsWith(` ${suffix}`)) {
        value = value.slice(0, -(suffix.length + 1)).trim();
        changed = true;
      }
    }
  }
  return value;
}

export interface DuplicateMatch {
  module: 'accounts' | 'leads' | 'contacts' | 'deals';
  id: string;
  label: string;
  sublabel?: string;
  reason: string;
  confidence: 'high' | 'medium' | 'low';
  ownerName?: string | null;
}

export interface DuplicateCheckInput {
  /** What is being created — changes which matches are worth surfacing. */
  module: 'accounts' | 'leads' | 'contacts' | 'deals';
  name?: string | null;
  company?: string | null;
  email?: string | null;
  website?: string | null;
  domain?: string | null;
  accountId?: string | null;
  /** Exclude the record being edited from its own duplicate check. */
  excludeId?: string | null;
}

export interface DuplicateResult {
  hasDuplicates: boolean;
  blocked: boolean;
  domain: string | null;
  matches: DuplicateMatch[];
}

export async function checkDuplicates(input: DuplicateCheckInput): Promise<DuplicateResult> {
  const enabled = await getSetting<boolean>('dedupe.enabled', true);
  const domain = input.domain ?? extractDomain(input.website) ?? extractDomain(input.email);
  const empty: DuplicateResult = { hasDuplicates: false, blocked: false, domain, matches: [] };
  if (!enabled) return empty;

  const matches: DuplicateMatch[] = [];
  const free = await isFreeEmailDomain(domain);

  // 1. Same corporate domain already on an account.
  if (domain && !free) {
    const accounts = await prisma.account.findMany({
      where: { domain, deletedAt: null, ...(input.module === 'accounts' && input.excludeId ? { id: { not: input.excludeId } } : {}) },
      select: { id: true, name: true, type: true, owner: { select: { name: true } } },
      take: 5,
    });
    for (const a of accounts) {
      matches.push({
        module: 'accounts',
        id: a.id,
        label: a.name,
        sublabel: a.type,
        reason: `Existing ${a.type.toLowerCase()} on domain ${domain}`,
        confidence: 'high',
        ownerName: a.owner?.name ?? null,
      });
    }

    // 2. Same domain sitting in the lead pool, not yet converted.
    const leads = await prisma.lead.findMany({
      where: {
        domain,
        deletedAt: null,
        status: { notIn: ['CONVERTED', 'DISQUALIFIED'] },
        ...(input.module === 'leads' && input.excludeId ? { id: { not: input.excludeId } } : {}),
      },
      select: { id: true, firstName: true, lastName: true, company: true, status: true, owner: { select: { name: true } } },
      take: 5,
    });
    for (const l of leads) {
      matches.push({
        module: 'leads',
        id: l.id,
        label: `${l.firstName} ${l.lastName} — ${l.company}`,
        sublabel: l.status,
        reason: `Open lead on domain ${domain}`,
        confidence: 'high',
        ownerName: l.owner?.name ?? null,
      });
    }
  }

  // 3. Exact email address, wherever it lives. Works for free mailboxes too.
  const email = input.email?.trim().toLowerCase();
  if (email) {
    const [contacts, leads] = await Promise.all([
      prisma.contact.findMany({
        where: { email, deletedAt: null, ...(input.module === 'contacts' && input.excludeId ? { id: { not: input.excludeId } } : {}) },
        select: { id: true, firstName: true, lastName: true, account: { select: { name: true } }, owner: { select: { name: true } } },
        take: 5,
      }),
      prisma.lead.findMany({
        where: { email, deletedAt: null, ...(input.module === 'leads' && input.excludeId ? { id: { not: input.excludeId } } : {}) },
        select: { id: true, firstName: true, lastName: true, company: true, owner: { select: { name: true } } },
        take: 5,
      }),
    ]);
    for (const c of contacts) {
      matches.push({
        module: 'contacts',
        id: c.id,
        label: `${c.firstName} ${c.lastName}`,
        sublabel: c.account?.name ?? undefined,
        reason: `Contact already exists with ${email}`,
        confidence: 'high',
        ownerName: c.owner?.name ?? null,
      });
    }
    for (const l of leads) {
      if (matches.some((m) => m.module === 'leads' && m.id === l.id)) continue;
      matches.push({
        module: 'leads',
        id: l.id,
        label: `${l.firstName} ${l.lastName} — ${l.company}`,
        reason: `Lead already exists with ${email}`,
        confidence: 'high',
        ownerName: l.owner?.name ?? null,
      });
    }
  }

  // 4. Same company name once legal suffixes are stripped.
  const normalized = normalizeCompany(input.company ?? input.name);
  if (normalized.length >= 3) {
    const candidates = await prisma.account.findMany({
      where: {
        deletedAt: null,
        name: { contains: normalized.split(' ')[0], mode: 'insensitive' },
        ...(input.module === 'accounts' && input.excludeId ? { id: { not: input.excludeId } } : {}),
      },
      select: { id: true, name: true, type: true, domain: true, owner: { select: { name: true } } },
      take: 20,
    });
    for (const a of candidates) {
      if (matches.some((m) => m.module === 'accounts' && m.id === a.id)) continue;
      if (normalizeCompany(a.name) !== normalized) continue;
      matches.push({
        module: 'accounts',
        id: a.id,
        label: a.name,
        sublabel: a.domain ?? a.type,
        reason: 'Company name matches an existing account',
        confidence: 'medium',
        ownerName: a.owner?.name ?? null,
      });
    }
  }

  // 5. For a new deal: warn about an open deal already running at this customer.
  if (input.module === 'deals' && input.accountId) {
    const open = await prisma.deal.findMany({
      where: {
        accountId: input.accountId,
        status: 'OPEN',
        deletedAt: null,
        ...(input.excludeId ? { id: { not: input.excludeId } } : {}),
      },
      select: { id: true, reference: true, name: true, amount: true, stage: { select: { name: true } }, owner: { select: { name: true } } },
      take: 5,
    });
    for (const d of open) {
      matches.push({
        module: 'deals',
        id: d.id,
        label: `${d.reference} — ${d.name}`,
        sublabel: d.stage.name,
        reason: 'This customer already has an open deal',
        confidence: 'medium',
        ownerName: d.owner?.name ?? null,
      });
    }
  }

  const blockOnExact = await getSetting<boolean>('dedupe.blockOnExactDomain', false);
  const blocked = blockOnExact && matches.some((m) => m.confidence === 'high');

  return { hasDuplicates: matches.length > 0, blocked, domain, matches };
}
