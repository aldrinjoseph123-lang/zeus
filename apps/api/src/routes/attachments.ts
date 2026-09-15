import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { z } from 'zod';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { audit } from '../lib/audit.js';
import { badRequest, clientIp, forbidden, notFound, requireDocument } from '../lib/http.js';
import { can, ownerAllowed, permissionFor, type Module } from '../auth/rbac.js';
import { touch } from '../lib/touch.js';

/**
 * File attachments on accounts, contacts, leads and deals, and vendor documents on quotes.
 *
 * Files are written to UPLOAD_DIR under a generated name — the client's filename is
 * only ever metadata, never a path. Downloads are forced as attachments with nosniff,
 * so an uploaded .svg or .html can never execute in the app's origin.
 */

type Parent = 'account' | 'contact' | 'lead' | 'deal' | 'quote';

const PARENT_MODULE: Record<Parent, Module> = {
  account: 'accounts',
  contact: 'contacts',
  lead: 'leads',
  deal: 'deals',
  quote: 'quotes',
};

/**
 * Which record a stored file belongs to. The quote is asked first: a vendor document carries
 * buy prices, and resolving it through anything broader would hand it to whoever can read that.
 */
function parentOf(a: { quoteId: string | null; dealId: string | null; leadId: string | null; contactId: string | null; accountId: string | null }): { parent: Parent; id: string } | null {
  if (a.quoteId) return { parent: 'quote', id: a.quoteId };
  if (a.dealId) return { parent: 'deal', id: a.dealId };
  if (a.leadId) return { parent: 'lead', id: a.leadId };
  if (a.contactId) return { parent: 'contact', id: a.contactId };
  if (a.accountId) return { parent: 'account', id: a.accountId };
  return null;
}

/** Extensions we refuse outright — no business reason to store them in a CRM. */
const BLOCKED = new Set([
  '.exe', '.dll', '.bat', '.cmd', '.com', '.scr', '.msi', '.ps1', '.vbs', '.js', '.jar', '.sh', '.app',
]);

const MAX_BYTES = 20 * 1024 * 1024;

/** Load the parent record and check this user may write to it. */
async function assertParentAccess(
  user: Parameters<typeof ownerAllowed>[0],
  parent: Parent,
  id: string,
  action: 'read' | 'update',
): Promise<{ ownerId: string | null; label: string; accountId: string | null }> {
  const module = PARENT_MODULE[parent];
  if (!can(user, module, action === 'read' ? 'read' : 'update')) {
    throw forbidden(`Your role cannot ${action} ${module}.`);
  }

  if (parent === 'quote') {
    await requireDocument(user, 'quotes', id, action);
    if ((permissionFor(user, 'quotes').fields ?? {}).unitCost === 'hidden') {
      throw forbidden('Vendor documents show buy prices, which your role cannot see.');
    }
    const quote = await prisma.quote.findUniqueOrThrow({ where: { id }, select: { number: true } });
    return { ownerId: null, label: quote.number, accountId: null };
  }
  if (parent === 'deal') {
    const deal = await prisma.deal.findFirst({ where: { id, deletedAt: null }, select: { ownerId: true, reference: true, accountId: true } });
    if (!deal) throw notFound('Deal not found.');
    if (!(await ownerAllowed(user, module, action, deal.ownerId))) throw forbidden();
    return { ownerId: deal.ownerId, label: deal.reference, accountId: deal.accountId };
  }
  if (parent === 'account') {
    const account = await prisma.account.findFirst({ where: { id, deletedAt: null }, select: { ownerId: true, name: true } });
    if (!account) throw notFound('Account not found.');
    if (!(await ownerAllowed(user, module, action, account.ownerId))) throw forbidden();
    return { ownerId: account.ownerId, label: account.name, accountId: id };
  }
  if (parent === 'contact') {
    const contact = await prisma.contact.findFirst({ where: { id, deletedAt: null }, select: { ownerId: true, firstName: true, lastName: true, accountId: true } });
    if (!contact) throw notFound('Contact not found.');
    if (!(await ownerAllowed(user, module, action, contact.ownerId))) throw forbidden();
    return { ownerId: contact.ownerId, label: `${contact.firstName} ${contact.lastName}`, accountId: contact.accountId };
  }
  const lead = await prisma.lead.findFirst({ where: { id, deletedAt: null }, select: { ownerId: true, company: true } });
  if (!lead) throw notFound('Lead not found.');
  if (!(await ownerAllowed(user, module, action, lead.ownerId))) throw forbidden();
  return { ownerId: lead.ownerId, label: lead.company, accountId: null };
}

export default async function attachmentRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Upload. Multipart with fields `parent` (account|contact|lead|deal) and `parentId`,
   * streamed straight to disk so a 20 MB file never sits in memory.
   */
  app.post('/api/attachments', async (request, reply) => {
    const file = await request.file();
    if (!file) throw badRequest('No file was uploaded.');

    const parent = String((file.fields.parent as { value?: string } | undefined)?.value ?? '') as Parent;
    const parentId = String((file.fields.parentId as { value?: string } | undefined)?.value ?? '');
    if (!PARENT_MODULE[parent]) throw badRequest('parent must be one of account, contact, lead, deal, quote.');
    if (!parentId) throw badRequest('parentId is required.');

    const target = await assertParentAccess(request.user, parent, parentId, 'update');

    const original = path.basename(file.filename || 'file');
    const ext = path.extname(original).toLowerCase();
    if (BLOCKED.has(ext)) throw badRequest(`Files of type ${ext} cannot be uploaded.`);

    await mkdir(env.UPLOAD_DIR, { recursive: true });
    const storedName = `${randomUUID()}${ext}`;
    const fullPath = path.join(env.UPLOAD_DIR, storedName);

    await pipeline(file.file, createWriteStream(fullPath));

    // @fastify/multipart flags a truncated stream rather than throwing — clean up.
    if (file.file.truncated) {
      await rm(fullPath, { force: true });
      throw badRequest('That file is larger than 20 MB.');
    }

    const { size } = await stat(fullPath);
    if (size === 0) {
      await rm(fullPath, { force: true });
      throw badRequest('That file is empty.');
    }
    if (size > MAX_BYTES) {
      await rm(fullPath, { force: true });
      throw badRequest('That file is larger than 20 MB.');
    }

    const attachment = await prisma.attachment.create({
      data: {
        filename: original,
        storedName,
        mimeType: file.mimetype || 'application/octet-stream',
        sizeBytes: size,
        uploadedById: request.user.id,
        accountId: parent === 'account' ? parentId : parent === 'deal' || parent === 'contact' ? target.accountId : null,
        contactId: parent === 'contact' ? parentId : null,
        leadId: parent === 'lead' ? parentId : null,
        dealId: parent === 'deal' ? parentId : null,
        quoteId: parent === 'quote' ? parentId : null,
      },
      include: { uploadedBy: { select: { id: true, name: true } } },
    });

    await touch({
      accountId: parent === 'account' ? parentId : target.accountId,
      dealId: parent === 'deal' ? parentId : null,
      leadId: parent === 'lead' ? parentId : null,
    });

    await audit({
      user: request.user, action: 'upload', entity: 'Attachment', entityId: attachment.id,
      summary: `${original} → ${parent} ${target.label}`, ip: clientIp(request),
    });

    return reply.status(201).send(attachment);
  });

  app.get('/api/attachments', async (request) => {
    const query = z.object({ parent: z.enum(['account', 'contact', 'lead', 'deal', 'quote']), parentId: z.string().min(1) }).safeParse(request.query);
    if (!query.success) throw badRequest('parent and parentId are required.');

    await assertParentAccess(request.user, query.data.parent, query.data.parentId, 'read');

    const key = `${query.data.parent}Id` as 'accountId' | 'contactId' | 'leadId' | 'dealId' | 'quoteId';
    return prisma.attachment.findMany({
      where: { [key]: query.data.parentId },
      include: { uploadedBy: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });
  });

  /** Download. Always as an attachment — never rendered in the app's origin. */
  app.get('/api/attachments/:id/download', async (request, reply) => {
    const { id } = request.params as { id: string };
    const attachment = await prisma.attachment.findUnique({ where: { id } });
    if (!attachment) throw notFound('File not found.');

    const owner = parentOf(attachment);
    if (!owner) throw notFound('This file is not linked to a record.');

    await assertParentAccess(request.user, owner.parent, owner.id, 'read');

    const fullPath = path.join(env.UPLOAD_DIR, path.basename(attachment.storedName));
    try {
      await stat(fullPath);
    } catch {
      throw notFound('The stored file is missing from disk.');
    }

    // Quote the filename and strip anything that could break out of the header.
    const safeName = attachment.filename.replace(/["\\\r\n]/g, '_');

    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-disposition', `attachment; filename="${safeName}"`)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .send(createReadStream(fullPath));
  });

  app.delete('/api/attachments/:id', async (request) => {
    const { id } = request.params as { id: string };
    const attachment = await prisma.attachment.findUnique({ where: { id } });
    if (!attachment) throw notFound('File not found.');

    const owner = parentOf(attachment);
    if (!owner) throw notFound('This file is not linked to a record.');

    await assertParentAccess(request.user, owner.parent, owner.id, 'update');

    await prisma.attachment.delete({ where: { id } });
    await rm(path.join(env.UPLOAD_DIR, path.basename(attachment.storedName)), { force: true });

    await audit({ user: request.user, action: 'delete', entity: 'Attachment', entityId: id, summary: attachment.filename, ip: clientIp(request) });
    return { ok: true };
  });
}
