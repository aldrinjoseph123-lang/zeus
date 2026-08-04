import { prisma } from '../db.js';
import { getSetting } from './settings.js';

/**
 * Gap-free reference numbers (ZEU-D-000142). The atomic `update ... returning`
 * is what stops two reps creating the same reference on a double-click.
 */
export type ReferenceKind = 'deal' | 'quote' | 'invoice' | 'creditNote' | 'purchaseOrder';

export async function nextReference(kind: ReferenceKind): Promise<string> {
  const prefixKey = {
    deal: 'numbering.dealPrefix',
    quote: 'numbering.quotePrefix',
    invoice: 'numbering.invoicePrefix',
    creditNote: 'numbering.creditNotePrefix',
    purchaseOrder: 'numbering.poPrefix',
  }[kind];
  const [prefix, padding] = await Promise.all([
    getSetting<string>(prefixKey),
    getSetting<number>('numbering.padding', 6),
  ]);

  const row = await prisma.counter.upsert({
    where: { key: kind },
    create: { key: kind, value: 1 },
    update: { value: { increment: 1 } },
  });

  return `${prefix}${String(row.value).padStart(Number(padding), '0')}`;
}
