import { prisma } from '../db.js';

/**
 * Undoing an import.
 *
 * A committed import keeps a ledger of what it wrote: every record it created, and every record
 * it updated with its fields as they were before. Undo walks that ledger. What was created is
 * removed and what was updated gets its old values back, except where someone has worked on the
 * record since. Those are kept and named, with the reason, rather than taken away from under the
 * person using them. That was the user's choice over refusing the whole undo, so that one contact
 * on a quote does not hold 500 rows hostage.
 *
 * "Worked on since" is either something that now depends on the record (a quote, an activity, a
 * portal login) or an edit after the import finished. Records created inside the import count
 * only against each other: an account the import created is free to go once its contacts, also
 * from the import, have gone.
 */

export type LedgerModel = 'lead' | 'account' | 'contact' | 'product' | 'priceEntry' | 'deal';

export interface ImportLedger {
  created: Array<{ model: LedgerModel; id: string; label: string }>;
  updated: Array<{ model: LedgerModel; id: string; label: string; before: Record<string, unknown> }>;
}

export interface UndoResult {
  removed: number;
  restored: number;
  kept: Array<{ label: string; reason: string }>;
}

/** "purchaseOrders: 2" → "2 purchase orders". */
const describe = (counts: Record<string, number>) =>
  Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k.replace(/([A-Z])/g, ' $1').toLowerCase()}`)
    .join(', ');

export async function undoImport(ledger: ImportLedger, finishedAt: Date): Promise<UndoResult> {
  // Everything the import wrote was written before it finished; a second's grace covers the clock.
  const since = finishedAt.getTime() + 1000;
  const editedSince = (updatedAt: Date) => updatedAt.getTime() > since;
  const now = new Date();
  const result: UndoResult = { removed: 0, restored: 0, kept: [] };
  const created = (model: LedgerModel) => new Map(ledger.created.filter((c) => c.model === model).map((c) => [c.id, c.label]));
  const removed: Record<LedgerModel, string[]> = { lead: [], account: [], contact: [], product: [], priceEntry: [], deal: [] };

  /** Keep, or remove: one decision per record, reported the same way whatever the model. */
  const settle = async (model: LedgerModel, id: string, label: string, reason: string | null, remove: () => Promise<unknown>) => {
    if (reason) {
      result.kept.push({ label, reason });
      return;
    }
    await remove();
    removed[model].push(id);
    result.removed += 1;
  };

  // Dependents first, so the accounts they belong to are judged without them.
  const deals = created('deal');
  for (const d of await prisma.deal.findMany({
    where: { id: { in: [...deals.keys()] }, deletedAt: null },
    select: { id: true, updatedAt: true, _count: { select: { quotes: true, invoices: true, purchaseOrders: true, activities: true, attachments: true, registrations: true, soldSubscriptions: true, renewingSubscriptions: true, specialPrices: true, stageHistory: true } } },
  })) {
    const { stageHistory, ...rest } = d._count;
    // The import wrote the first stage; a second means the deal has been moved on.
    const counts = { ...rest, stageMoves: stageHistory - 1 };
    const reason = editedSince(d.updatedAt) ? 'edited since the import' : describe(counts) ? `has ${describe(counts)}` : null;
    await settle('deal', d.id, deals.get(d.id)!, reason, () => prisma.deal.update({ where: { id: d.id }, data: { deletedAt: now } }));
  }

  const contacts = created('contact');
  for (const c of await prisma.contact.findMany({
    where: { id: { in: [...contacts.keys()] }, deletedAt: null },
    select: { id: true, updatedAt: true, portalUser: { select: { id: true } }, _count: { select: { deals: true, quotes: true, invoices: true, purchaseOrders: true, activities: true, attachments: true, registrations: true } } },
  })) {
    const uses = describe(c._count);
    const reason = editedSince(c.updatedAt) ? 'edited since the import'
      : c.portalUser ? 'has a portal login'
      : uses ? `has ${uses}` : null;
    await settle('contact', c.id, contacts.get(c.id)!, reason, () => prisma.contact.update({ where: { id: c.id }, data: { deletedAt: now } }));
  }

  const leads = created('lead');
  for (const l of await prisma.lead.findMany({
    where: { id: { in: [...leads.keys()] }, deletedAt: null },
    select: { id: true, updatedAt: true, convertedAt: true, _count: { select: { activities: true, attachments: true } } },
  })) {
    const uses = describe(l._count);
    const reason = l.convertedAt ? 'converted since the import' : editedSince(l.updatedAt) ? 'edited since the import' : uses ? `has ${uses}` : null;
    await settle('lead', l.id, leads.get(l.id)!, reason, () => prisma.lead.update({ where: { id: l.id }, data: { deletedAt: now } }));
  }

  const entries = created('priceEntry');
  for (const e of await prisma.priceEntry.findMany({ where: { id: { in: [...entries.keys()] } }, select: { id: true, updatedAt: true } })) {
    await settle('priceEntry', e.id, entries.get(e.id)!, editedSince(e.updatedAt) ? 'edited since the import' : null,
      () => prisma.priceEntry.delete({ where: { id: e.id } }));
  }

  // A product has no soft delete, and paperwork points at it: only one nothing uses can go.
  const products = created('product');
  for (const p of await prisma.product.findMany({
    where: { id: { in: [...products.keys()] } },
    select: { id: true, updatedAt: true, _count: { select: { quoteLines: true, invoiceLines: true, poLines: true, subscriptions: true } } },
  })) {
    const prices = await prisma.priceEntry.count({ where: { productId: p.id, id: { notIn: removed.priceEntry } } });
    const uses = describe({ ...p._count, prices });
    const reason = editedSince(p.updatedAt) ? 'edited since the import' : uses ? `has ${uses}` : null;
    await settle('product', p.id, products.get(p.id)!, reason, () => prisma.product.delete({ where: { id: p.id } }));
  }

  const accounts = created('account');
  for (const a of await prisma.account.findMany({
    where: { id: { in: [...accounts.keys()] }, deletedAt: null },
    select: {
      id: true, updatedAt: true,
      _count: { select: { quotes: true, invoices: true, purchaseOrders: true, payments: true, activities: true, attachments: true, registrations: true, partnerRegistrations: true, subscriptions: true, partnerSubscriptions: true, vendorSubscriptions: true, enablements: true, enabledPartners: true, convertedFromLeads: true, quoteLinesSupplied: true } },
    },
  })) {
    // What this undo has already taken away does not keep the account; anything else does.
    const [contactCount, dealCount, partnerDeals, productCount, prices] = await Promise.all([
      prisma.contact.count({ where: { accountId: a.id, deletedAt: null, id: { notIn: removed.contact } } }),
      prisma.deal.count({ where: { accountId: a.id, deletedAt: null, id: { notIn: removed.deal } } }),
      prisma.deal.count({ where: { partnerAccountId: a.id, deletedAt: null, id: { notIn: removed.deal } } }),
      prisma.product.count({ where: { vendorId: a.id, id: { notIn: removed.product } } }),
      prisma.priceEntry.count({ where: { vendorId: a.id, id: { notIn: removed.priceEntry } } }),
    ]);
    const uses = describe({ ...a._count, contacts: contactCount, deals: dealCount, partnerDeals, products: productCount, prices });
    const reason = editedSince(a.updatedAt) ? 'edited since the import' : uses ? `has ${uses}` : null;
    await settle('account', a.id, accounts.get(a.id)!, reason, () => prisma.account.update({ where: { id: a.id }, data: { deletedAt: now } }));
  }

  // Updates: put the old values back, unless the record has moved on since.
  const delegate = (model: LedgerModel) => prisma[model] as unknown as {
    findUnique: (args: unknown) => Promise<{ updatedAt: Date; deletedAt?: Date | null } | null>;
    update: (args: unknown) => Promise<unknown>;
  };
  for (const u of ledger.updated) {
    const current = await delegate(u.model).findUnique({ where: { id: u.id } });
    if (!current || current.deletedAt) continue;
    if (editedSince(current.updatedAt)) {
      result.kept.push({ label: u.label, reason: 'changed again since the import, so its import-time values were left' });
      continue;
    }
    await delegate(u.model).update({ where: { id: u.id }, data: u.before });
    result.restored += 1;
  }

  return result;
}
