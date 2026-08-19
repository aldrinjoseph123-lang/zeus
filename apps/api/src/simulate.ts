import bcrypt from 'bcryptjs';
import 'dotenv/config';
import { prisma } from './db.js';
import { nextReference } from './lib/counters.js';
import { round2, taxDocumentTotals } from './lib/money.js';

/**
 * A company that already exists.
 *
 * Run this against an empty, already-seeded database and it produces the state a real
 * reseller would be in on an ordinary Monday: staff in every role, vendors billing in
 * dollars, a distributor billing in dirhams, customers with history, deals won and lost,
 * invoices paid and outstanding, subscriptions part-way through their term.
 *
 * It exists so the platform can be *used* rather than only tested. Empty software always
 * looks like it works; the faults show up when there is enough in it that a screen has to
 * choose what to show, a total has to reconcile against something, and a permission has
 * to hold against a second person.
 *
 * The history is written with the same helpers the API uses — `nextReference` for
 * numbering, `taxDocumentTotals` for money — so the seeded past is arithmetically
 * identical to anything created through the UI afterwards. Everything from Monday onward
 * is meant to be done by hand.
 */

// ── safety ────────────────────────────────────────────────────────────────────
// This writes a lot of fictional business data. Pointing it at a live system would be a
// disaster that looks like a successful run, so the name of the database is the gate.
const url = process.env.DATABASE_URL ?? '';
if (!/zeus_(audit|demo|sim)/.test(url)) {
  console.error('Refusing to run: DATABASE_URL must name a zeus_audit, zeus_demo or zeus_sim database.');
  console.error(`Got: ${url.replace(/\/\/[^@]*@/, '//***@')}`);
  process.exit(1);
}

const PASSWORD = process.env.SIMULATE_PASSWORD ?? 'Simulate#2026';
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const ahead = (days: number) => new Date(Date.now() + days * DAY);

async function main(): Promise<void> {
  console.log('▸ Simulating a working company…');

  // ── people ──────────────────────────────────────────────────────────────────
  const [admin, manager, exec] = await Promise.all([
    prisma.role.findUniqueOrThrow({ where: { name: 'Administrator' } }),
    prisma.role.findUniqueOrThrow({ where: { name: 'Sales Manager' } }),
    prisma.role.findUniqueOrThrow({ where: { name: 'Sales Executive' } }),
  ]);

  const productTeam = await prisma.team.findFirstOrThrow({ where: { name: 'Product Team' } });
  const serviceTeam = await prisma.team.findFirstOrThrow({ where: { name: 'Service Team' } });

  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const staff = [
    { email: 'layla.mansouri@protect24x7.ae', name: 'Layla Al Mansouri', jobTitle: 'Sales Manager', roleId: manager.id, teamId: productTeam.id },
    { email: 'omar.haddad@protect24x7.ae', name: 'Omar Haddad', jobTitle: 'Account Executive', roleId: exec.id, teamId: productTeam.id },
    { email: 'fatima.rashed@protect24x7.ae', name: 'Fatima Al Rashed', jobTitle: 'Account Executive', roleId: exec.id, teamId: serviceTeam.id },
    // No Finance role: one person maintains everything here, so the money work belongs to
    // an administrator. The approval separation still holds — the sales manager signs off.
    { email: 'rashid.noor@protect24x7.ae', name: 'Rashid Noor', jobTitle: 'Operations & Finance', roleId: admin.id, teamId: null },
  ];

  const users: Record<string, { id: string; name: string; email: string }> = {};
  for (const person of staff) {
    users[person.email.split('.')[0]] = await prisma.user.upsert({
      where: { email: person.email },
      create: { ...person, passwordHash },
      update: {},
      select: { id: true, name: true, email: true },
    });
  }
  const bootAdmin = await prisma.user.findFirstOrThrow({ where: { roleId: admin.id }, select: { id: true, name: true, email: true } });
  users.admin = bootAdmin;
  console.log(`  + ${staff.length} staff (password ${PASSWORD})`);

  // ── who we buy from and sell to ─────────────────────────────────────────────
  const account = async (
    name: string,
    type: 'VENDOR' | 'PARTNER' | 'CUSTOMER' | 'PROSPECT',
    over: Record<string, unknown> = {},
  ) =>
    prisma.account.create({
      data: {
        name, type,
        city: 'Dubai', emirate: 'Dubai',
        country: (over.country as string) ?? 'United Arab Emirates',
        ownerId: users.omar.id,
        lastActivityAt: ago(Math.floor(Math.random() * 20) + 1),
        ...over,
      },
    });

  const crowdstrike = await account('CrowdStrike International', 'VENDOR', { country: 'United States', city: 'Austin', emirate: null, domain: 'crowdstrike.com' });
  const mimecast = await account('Mimecast Services Ltd', 'VENDOR', { country: 'United Kingdom', city: 'London', emirate: null, domain: 'mimecast.com' });
  const redington = await account('Redington Gulf FZE', 'VENDOR', { domain: 'redingtongulf.com', trn: '100234567800003', description: 'Regional distributor. Invoices us in AED.' });

  const partners = await Promise.all([
    account('Gulf Systems General Trading', 'PARTNER', { domain: 'gulfsystems.ae', trn: '100111222300003' }),
    account('Falcon IT Solutions LLC', 'PARTNER', { domain: 'falconit.ae', ownerId: users.fatima.id }),
  ]);

  const customers = await Promise.all([
    account('Emirates NBD Bank P.J.S.C.', 'CUSTOMER', { domain: 'emiratesnbd.com', trn: '100300400500003', industry: 'Banking & Finance', employeeBand: '5000+' }),
    account('Dubai Silicon Oasis Authority', 'CUSTOMER', { domain: 'dsoa.ae', trn: '100600700800003', industry: 'Government', employeeBand: '501-1000' }),
    account('Al Habtoor Group', 'CUSTOMER', { domain: 'alhabtoor.com', trn: '100900100200003', industry: 'Construction', ownerId: users.fatima.id }),
    account('Aster DM Healthcare', 'CUSTOMER', { domain: 'asterdmhealthcare.com', trn: '100500600700003', industry: 'Healthcare', ownerId: users.fatima.id }),
  ]);

  const prospects = await Promise.all([
    account('Majid Al Futtaim Retail', 'PROSPECT', { domain: 'maf.ae', industry: 'Retail' }),
    account('Sharjah Islamic Bank', 'PROSPECT', { domain: 'sib.ae', industry: 'Banking & Finance', ownerId: users.fatima.id }),
  ]);
  console.log(`  + ${3 + partners.length + customers.length + prospects.length} accounts`);

  // ── people at those companies ───────────────────────────────────────────────
  const contactSpec = [
    { first: 'Yousef', last: 'Kamal', title: 'Head of Information Security', accountId: customers[0].id },
    { first: 'Noura', last: 'Saeed', title: 'IT Procurement Manager', accountId: customers[0].id, isPrimary: false },
    { first: 'Hassan', last: 'Ali', title: 'CIO', accountId: customers[1].id },
    { first: 'Priya', last: 'Nair', title: 'IT Director', accountId: customers[2].id },
    { first: 'Ahmed', last: 'Zayed', title: 'Group CISO', accountId: customers[3].id },
    { first: 'Marcus', last: 'Bell', title: 'Channel Manager', accountId: crowdstrike.id },
    { first: 'Sanjay', last: 'Menon', title: 'Partner Account Manager', accountId: partners[0].id },
    { first: 'Reem', last: 'Farouk', title: 'Managing Director', accountId: partners[1].id },
  ];
  const contacts = [];
  for (const c of contactSpec) {
    contacts.push(await prisma.contact.create({
      data: {
        firstName: c.first, lastName: c.last, jobTitle: c.title, accountId: c.accountId,
        email: `${c.first.toLowerCase()}.${c.last.toLowerCase()}@example.ae`,
        phone: '+971 4 555 0100', isPrimary: c.isPrimary ?? true, ownerId: users.omar.id,
      },
    }));
  }
  console.log(`  + ${contacts.length} contacts`);

  // ── what we resell, and what it costs us ────────────────────────────────────
  // The catalogue sells in dirhams while these vendors bill in dollars, so a list price
  // has to clear the *converted* cost — USD 249 is AED 914, not AED 249.
  const vendorProducts = [
    { sku: 'CS-FALCON-GO', name: 'CrowdStrike Falcon Go', unit: 'endpoint', listPrice: 760, cost: 138, vendorId: crowdstrike.id, category: 'Endpoint & Detection', currency: 'USD' },
    { sku: 'CS-FALCON-PRO', name: 'CrowdStrike Falcon Pro', unit: 'endpoint', listPrice: 1370, cost: 249, vendorId: crowdstrike.id, category: 'Endpoint & Detection', currency: 'USD' },
    { sku: 'MC-EMAIL-SEC', name: 'Mimecast Email Security', unit: 'user', listPrice: 335, cost: 61, vendorId: mimecast.id, category: 'Data & Email', currency: 'USD' },
    { sku: 'MC-AWARENESS', name: 'Mimecast Awareness Training', unit: 'user', listPrice: 150, cost: 27, vendorId: mimecast.id, category: 'Data & Email', currency: 'USD' },
    { sku: 'RG-FW-APPLIANCE', name: 'Perimeter Firewall Appliance', unit: 'unit', listPrice: 18500, cost: 12900, vendorId: redington.id, category: 'Network', currency: 'AED' },
  ];
  const products: Record<string, { id: string; listPrice: unknown; cost: unknown; unit: string; currency: string }> = {};
  for (const p of vendorProducts) {
    const row = await prisma.product.create({ data: p });
    products[p.sku] = row;
  }
  for (const svc of await prisma.product.findMany({ where: { sku: { startsWith: 'SVC-' } } })) products[svc.sku] = svc;
  console.log(`  + ${vendorProducts.length} vendor SKUs alongside the service lines`);

  // Vendor price lists: quantity breaks, one list about to lapse, one deal-scoped special.
  const priceRows = [
    { sku: 'CS-FALCON-GO', minQuantity: 1, cost: 138, listPrice: 210 },
    { sku: 'CS-FALCON-GO', minQuantity: 100, cost: 120, listPrice: 210 },
    { sku: 'CS-FALCON-GO', minQuantity: 500, cost: 99, listPrice: 210 },
    { sku: 'CS-FALCON-PRO', minQuantity: 1, cost: 249, listPrice: 380 },
    { sku: 'MC-EMAIL-SEC', minQuantity: 1, cost: 61, listPrice: 96, validTo: ahead(21) },
    { sku: 'MC-AWARENESS', minQuantity: 1, cost: 27, listPrice: 44, validTo: ahead(21) },
    { sku: 'RG-FW-APPLIANCE', minQuantity: 1, cost: 12900, listPrice: 18500 },
  ];
  for (const row of priceRows) {
    const product = products[row.sku];
    await prisma.priceEntry.create({
      data: {
        productId: product.id,
        vendorId: vendorProducts.find((p) => p.sku === row.sku)!.vendorId,
        cost: row.cost, listPrice: row.listPrice, minQuantity: row.minQuantity,
        currency: product.currency, vendorSku: `${row.sku}-${row.minQuantity}`,
        validTo: row.validTo ?? null,
      },
    });
  }
  console.log(`  + ${priceRows.length} vendor prices, two of them expiring inside a month`);

  // ── the pipeline as it stands ───────────────────────────────────────────────
  const pipeline = await prisma.pipeline.findFirstOrThrow({ include: { stages: { orderBy: { order: 'asc' } } } });
  const stage = (name: string) => pipeline.stages.find((s) => s.name === name)!;

  const makeDeal = async (over: {
    name: string; accountId: string; stageName: string; amount: number; cost: number;
    ownerId: string; status?: 'OPEN' | 'WON' | 'LOST'; closeDate: Date; closedAt?: Date;
    lostReason?: string; partnerAccountId?: string; primaryContactId?: string; createdAt?: Date;
  }) => {
    const s = stage(over.stageName);
    const vatAmount = round2(over.amount * 0.05);
    return prisma.deal.create({
      data: {
        reference: await nextReference('deal'),
        name: over.name,
        accountId: over.accountId,
        partnerAccountId: over.partnerAccountId ?? null,
        primaryContactId: over.primaryContactId ?? null,
        pipelineId: pipeline.id,
        stageId: s.id,
        status: over.status ?? 'OPEN',
        amount: over.amount, cost: over.cost,
        vatRate: 5, vatAmount, totalAmount: round2(over.amount + vatAmount),
        probability: s.probability,
        closeDate: over.closeDate,
        closedAt: over.closedAt ?? null,
        lostReason: over.lostReason ?? null,
        ownerId: over.ownerId,
        stageChangedAt: over.createdAt ?? ago(10),
        createdAt: over.createdAt ?? ago(30),
        source: 'Referral',
      },
    });
  };

  const wonDeal = await makeDeal({
    name: 'Endpoint refresh — 400 seats', accountId: customers[0].id, stageName: 'Closed Won',
    amount: 148_000, cost: 96_400, ownerId: users.omar.id, status: 'WON',
    closeDate: ago(35), closedAt: ago(35), createdAt: ago(120), primaryContactId: contacts[0].id,
  });
  const wonDeal2 = await makeDeal({
    name: 'Email security renewal', accountId: customers[3].id, stageName: 'Closed Won',
    amount: 62_000, cost: 41_500, ownerId: users.fatima.id, status: 'WON',
    closeDate: ago(70), closedAt: ago(70), createdAt: ago(150),
  });
  await makeDeal({
    name: 'SOC pilot', accountId: prospects[0].id, stageName: 'Closed Lost',
    amount: 96_000, cost: 62_000, ownerId: users.omar.id, status: 'LOST',
    closeDate: ago(20), closedAt: ago(20), createdAt: ago(90), lostReason: 'Price',
  });
  const openDeals = await Promise.all([
    makeDeal({ name: 'MDR rollout — head office', accountId: customers[1].id, stageName: 'Proposal', amount: 210_000, cost: 138_000, ownerId: users.omar.id, closeDate: ahead(25), primaryContactId: contacts[2].id }),
    makeDeal({ name: 'Vulnerability management programme', accountId: customers[2].id, stageName: 'Negotiation', amount: 88_000, cost: 52_000, ownerId: users.fatima.id, closeDate: ahead(12), partnerAccountId: partners[0].id }),
    makeDeal({ name: 'Firewall replacement', accountId: customers[3].id, stageName: 'Qualified', amount: 74_000, cost: 51_600, ownerId: users.fatima.id, closeDate: ahead(40) }),
    makeDeal({ name: 'Awareness training — group wide', accountId: customers[0].id, stageName: 'New', amount: 45_000, cost: 27_000, ownerId: users.omar.id, closeDate: ahead(55) }),
  ]);
  console.log('  + 7 deals: 2 won, 1 lost, 4 in flight');

  // Registrations both ways: one lapsing this month, one from the partner side.
  await prisma.dealRegistration.create({
    data: {
      dealId: openDeals[0].id, side: 'VENDOR', vendorId: crowdstrike.id, status: 'APPROVED',
      submittedAt: ago(68), approvedAt: ago(64), expiresAt: ahead(9),
      regNumber: 'CS-DR-88214', notes: 'Registered for the head office rollout.',
    },
  });
  await prisma.dealRegistration.create({
    data: {
      dealId: openDeals[1].id, side: 'PARTNER', partnerId: partners[0].id, partnerContactId: contacts[6].id,
      status: 'APPROVED', submittedAt: ago(30), approvedAt: ago(28), expiresAt: ahead(60),
      notes: 'Gulf Systems brought this one in.',
    },
  });

  // ── paperwork behind the won business ───────────────────────────────────────
  const issueInvoice = async (opts: {
    accountId: string; dealId: string; lines: Array<{ description: string; quantity: number; unitPrice: number; unitCost: number; productId?: string; unit?: string; termMonths?: number }>;
    issuedDaysAgo: number; paid: 'full' | 'part' | 'none'; ownerId: string;
  }) => {
    const totals = taxDocumentTotals(opts.lines.map((l) => ({ ...l, vatRate: 5, taxable: true })), { defaultVatRate: 5 });
    const issueDate = ago(opts.issuedDaysAgo);
    const invoice = await prisma.invoice.create({
      data: {
        number: await nextReference('invoice'),
        type: 'TAX_INVOICE',
        accountId: opts.accountId, dealId: opts.dealId,
        status: 'SENT', issueDate, dueDate: new Date(issueDate.getTime() + 30 * DAY),
        currency: 'AED', vatRate: 5,
        subtotal: totals.subtotal, discountAmt: totals.discountAmt, vatAmount: totals.vatAmount,
        total: totals.total,
        approvalStatus: 'APPROVED', approvalDecidedAt: issueDate, approvalDecidedById: users.layla.id,
        createdById: opts.ownerId,
        supplierTrn: '100123456700003', recipientTrn: '100300400500003',
        lines: {
          create: opts.lines.map((l, i) => ({
            order: i, description: l.description, quantity: l.quantity, unit: l.unit ?? 'licence',
            unitPrice: l.unitPrice, unitCost: l.unitCost, vatRate: 5, taxable: true,
            productId: l.productId ?? null, termMonths: l.termMonths ?? null,
            lineTotal: totals.lines[i].lineTotal, lineVat: totals.lines[i].lineVat, lineCost: totals.lines[i].lineCost,
          })),
        },
      },
    });

    const amount = opts.paid === 'full' ? Number(totals.total) : opts.paid === 'part' ? round2(Number(totals.total) / 2) : 0;
    if (amount > 0) {
      await prisma.payment.create({
        data: {
          direction: 'INCOMING', amount, currency: 'AED', method: 'Bank Transfer',
          reference: `FT${Math.floor(Math.random() * 900000 + 100000)}`,
          paidAt: ago(Math.max(1, opts.issuedDaysAgo - 20)),
          accountId: opts.accountId, invoiceId: invoice.id, recordedById: users.rashid.id,
        },
      });
      await prisma.invoice.update({
        where: { id: invoice.id },
        data: { amountPaid: amount, status: opts.paid === 'full' ? 'PAID' : 'PARTIAL' },
      });
    }
    return invoice;
  };

  const paidInvoice = await issueInvoice({
    accountId: customers[0].id, dealId: wonDeal.id, ownerId: users.omar.id,
    issuedDaysAgo: 34, paid: 'full',
    lines: [
      { description: 'CrowdStrike Falcon Pro — 400 endpoints', quantity: 400, unitPrice: 370, unitCost: 241, unit: 'endpoint', productId: products['CS-FALCON-PRO'].id, termMonths: 12 },
    ],
  });
  await issueInvoice({
    accountId: customers[3].id, dealId: wonDeal2.id, ownerId: users.fatima.id,
    issuedDaysAgo: 68, paid: 'part',
    lines: [
      { description: 'Mimecast Email Security — 650 users', quantity: 650, unitPrice: 92, unitCost: 58, unit: 'user', productId: products['MC-EMAIL-SEC'].id, termMonths: 12 },
      { description: 'Onboarding and migration', quantity: 1, unitPrice: 12_000, unitCost: 6_000, unit: 'project' },
    ],
  });
  // One left unpaid and past its date, so the overdue path has something to find.
  await issueInvoice({
    accountId: customers[2].id, dealId: openDeals[1].id, ownerId: users.fatima.id,
    issuedDaysAgo: 52, paid: 'none',
    lines: [{ description: 'Vulnerability Management — Q3', quantity: 300, unitPrice: 40, unitCost: 21, unit: 'device' }],
  });
  console.log('  + 3 issued invoices: one paid, one part-paid, one overdue');

  // What we owe the vendor for the business we won.
  const poLines = [{ description: 'CrowdStrike Falcon Pro — 400 endpoints', quantity: 400, unitPrice: 249, unit: 'endpoint' }];
  const poTotals = taxDocumentTotals(poLines.map((l) => ({ ...l, vatRate: 0, taxable: false })));
  const supplierPo = await prisma.purchaseOrder.create({
    data: {
      number: await nextReference('purchaseOrder'), direction: 'SUPPLIER', status: 'RECEIVED',
      accountId: crowdstrike.id, dealId: wonDeal.id, currency: 'USD',
      orderDate: ago(33), paymentTermsDays: 30, paymentDueDate: ago(3),
      subtotal: poTotals.subtotal, vatRate: 0, vatAmount: 0, total: poTotals.total,
      issuedAt: ago(33), ownerId: users.omar.id, createdById: users.rashid.id,
      approvalStatus: 'APPROVED', approvalDecidedAt: ago(33), approvalDecidedById: users.layla.id,
      supplierInvoiceNumber: 'CS-INV-771204',
      lines: {
        create: poLines.map((l, i) => ({
          order: i, description: l.description, quantity: l.quantity, unit: l.unit,
          unitPrice: l.unitPrice, taxable: false, vatRate: 0,
          lineTotal: poTotals.lines[i].lineTotal, lineVat: 0, quantityReceived: l.quantity,
        })),
      },
    },
  });
  console.log('  + 1 supplier purchase order, payment now overdue');

  // ── what the customers actually own, and until when ─────────────────────────
  await prisma.subscription.create({
    data: {
      reference: await nextReference('subscription'),
      accountId: customers[0].id, productId: products['CS-FALCON-PRO'].id, vendorId: crowdstrike.id,
      description: 'CrowdStrike Falcon Pro — 400 endpoints',
      quantity: 400, unit: 'endpoint', unitPrice: 370, unitCost: 241,
      termValue: 148_000, termCost: 96_400, termMonths: 12,
      startDate: ago(34), endDate: ahead(331),
      sourceInvoiceId: paidInvoice.id, sourceDealId: wonDeal.id,
      ownerId: users.omar.id, status: 'ACTIVE',
    },
  });
  // One inside the renewal window, so the sweep has real work to do.
  await prisma.subscription.create({
    data: {
      reference: await nextReference('subscription'),
      accountId: customers[3].id, productId: products['MC-EMAIL-SEC'].id, vendorId: mimecast.id,
      description: 'Mimecast Email Security — 650 users',
      quantity: 650, unit: 'user', unitPrice: 92, unitCost: 58,
      termValue: 59_800, termCost: 37_700, termMonths: 12,
      startDate: ago(298), endDate: ahead(67),
      sourceDealId: wonDeal2.id, ownerId: users.fatima.id, status: 'ACTIVE',
    },
  });
  console.log('  + 2 subscriptions, one inside the renewal window');

  // ── the trail of everyday work ──────────────────────────────────────────────
  const activities = [
    { type: 'CALL' as const, subject: 'Discovery call — endpoint estate', dealId: openDeals[0].id, accountId: customers[1].id, ownerId: users.omar.id, status: 'Completed', completedAt: ago(9) },
    { type: 'MEETING' as const, subject: 'Technical workshop', dealId: openDeals[0].id, accountId: customers[1].id, ownerId: users.omar.id, status: 'Open', dueAt: ahead(2), priority: 'High' },
    { type: 'TASK' as const, subject: 'Send revised pricing', dealId: openDeals[1].id, accountId: customers[2].id, ownerId: users.fatima.id, status: 'Open', dueAt: ago(1), priority: 'Urgent' },
    { type: 'EMAIL' as const, subject: 'Renewal notice — Mimecast', accountId: customers[3].id, ownerId: users.fatima.id, status: 'Completed', completedAt: ago(4) },
    { type: 'TASK' as const, subject: 'Chase overdue invoice', accountId: customers[2].id, ownerId: users.rashid.id, status: 'Open', dueAt: ahead(1), priority: 'High' },
  ];
  for (const a of activities) await prisma.activity.create({ data: { ...a, createdById: users.admin.id } });

  // A lead still in the funnel, and one that came in from a partner.
  await prisma.lead.create({
    data: {
      firstName: 'Khalid', lastName: 'Bin Saleh', company: 'Emaar Properties', domain: 'emaar.com',
      email: 'khalid.binsaleh@example.ae', jobTitle: 'Head of IT Infrastructure',
      source: 'Website', status: 'WORKING', rating: 'Warm', estimatedValue: 120_000,
      interestArea: 'Endpoint & Detection', ownerId: users.omar.id, emirate: 'Dubai',
      lastActivityAt: ago(3),
    },
  });
  await prisma.lead.create({
    data: {
      firstName: 'Mariam', lastName: 'Al Suwaidi', company: 'Etihad Rail', domain: 'etihadrail.ae',
      email: 'mariam.alsuwaidi@example.ae', jobTitle: 'Information Security Manager',
      source: 'Partner', sourcePartnerId: partners[1].id, status: 'NEW', rating: 'Hot',
      estimatedValue: 260_000, interestArea: 'Managed Detection & Response',
      ownerId: users.fatima.id, emirate: 'Abu Dhabi',
    },
  });
  console.log(`  + ${activities.length} activities and 2 open leads`);

  // ── quarterly target, so the dashboard has something to measure against ─────
  // A company-wide target has no user, and a null cannot be part of a unique lookup —
  // so this is a find-then-create rather than an upsert.
  const now = new Date();
  const quarter = Math.floor(now.getMonth() / 3) + 1;
  const existingTarget = await prisma.target.findFirst({ where: { userId: null, year: now.getFullYear(), quarter } });
  if (!existingTarget) await prisma.target.create({ data: { year: now.getFullYear(), quarter, amount: 750_000 } });
  console.log('  + a company target for the current quarter');

  console.log('▸ Done. Sign in as any of:');
  for (const person of staff) console.log(`    ${person.email}  ${PASSWORD}   (${person.jobTitle})`);
  console.log(`  Supplier PO ${supplierPo.number} is overdue; one invoice is past its due date.`);
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
