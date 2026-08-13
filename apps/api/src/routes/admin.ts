import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../db.js';
import { audit, diff } from '../lib/audit.js';
import { badRequest, clientIp, listParams, notFound, paged, requirePermission } from '../lib/http.js';
import { MODULES, PROTECTED_FIELDS, SYSTEM_ROLES, type PermissionMap } from '../auth/rbac.js';
import { getSettings, invalidateSettings, setSetting, SETTING_DEFAULTS } from '../lib/settings.js';
import { invalidateCustomFields } from '../lib/customFields.js';
import { NOTIFICATION_EVENTS } from '../services/notify.js';
import { postToWebhook } from '../services/teams.js';
import { refreshRates } from '../services/fx.js';
import { previewTransfer, transferOwnership, reverseTransfer, exportUserBook, TRANSFERABLE_MODULES } from '../services/transfer.js';
import { checkEgress } from '../lib/egress.js';
import { encryptJson } from '../lib/crypto.js';
import { deliverOne, generateSecret as generateWebhookSecret } from '../services/webhooks.js';

export default async function adminRoutes(app: FastifyInstance): Promise<void> {
  // ── users ───────────────────────────────────────────────────────────────────

  app.get('/api/users', { preHandler: requirePermission('users', 'read') }, async (request) => {
    const params = listParams(request.query as Record<string, unknown>, 'name');
    const where: Record<string, unknown> = {};
    if (params.filters.isActive !== undefined) where.isActive = params.filters.isActive === 'true';
    if (params.search) where.OR = [
      { name: { contains: params.search, mode: 'insensitive' } },
      { email: { contains: params.search, mode: 'insensitive' } },
    ];

    const [data, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          id: true, email: true, name: true, jobTitle: true, phone: true, whatsappNumber: true, avatarColor: true, isActive: true,
          lastLoginAt: true, lastLoginIp: true, lastLoginDevice: true, totpEnabledAt: true, createdAt: true, entraOid: true,
          role: { select: { id: true, name: true } },
          team: { select: { id: true, name: true } },
          manager: { select: { id: true, name: true } },
          _count: { select: { ownedDeals: true, ownedAccounts: true } },
        },
        orderBy: { name: 'asc' },
        skip: params.skip,
        take: params.take,
      }),
      prisma.user.count({ where }),
    ]);
    return paged(data, total, params);
  });

  /** Everyone's id+name, for owner dropdowns. Any signed-in user may read it. */
  app.get('/api/users/lookup', async (request) => {
    if (!request.user) throw badRequest('Not signed in.');
    return prisma.user.findMany({
      where: { isActive: true },
      select: { id: true, name: true, email: true, avatarColor: true, team: { select: { name: true } } },
      orderBy: { name: 'asc' },
    });
  });

  const userSchema = z.object({
    email: z.string().email(),
    name: z.string().min(1),
    password: z.string().min(10).optional(),
    jobTitle: z.string().optional().nullable(),
    phone: z.string().optional().nullable(),
    whatsappNumber: z.string().optional().nullable(),
    avatarColor: z.string().optional(),
    roleId: z.string().min(1),
    teamId: z.string().optional().nullable(),
    managerId: z.string().optional().nullable(),
    isActive: z.boolean().optional(),
  });

  app.post('/api/users', { preHandler: requirePermission('users', 'create') }, async (request, reply) => {
    const parsed = userSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
    const { password, ...data } = parsed.data;

    const email = data.email.toLowerCase().trim();
    if (await prisma.user.findUnique({ where: { email } })) throw badRequest('A user with that email already exists.');

    const user = await prisma.user.create({
      data: { ...data, email, passwordHash: password ? await bcrypt.hash(password, 10) : null },
      select: { id: true, email: true, name: true, role: { select: { name: true } } },
    });
    await audit({ user: request.user, action: 'create', entity: 'User', entityId: user.id, summary: `${user.name} (${user.role.name})`, ip: clientIp(request) });
    return reply.status(201).send(user);
  });

  app.patch('/api/users/:id', { preHandler: requirePermission('users', 'update') }, async (request) => {
    const { id } = request.params as { id: string };
    const parsed = userSchema.partial().safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
    const { password, ...data } = parsed.data;

    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) throw notFound('User not found.');

    // Guard against locking everyone out of the system.
    if (data.isActive === false || data.roleId) {
      const adminRole = await prisma.role.findFirst({ where: { name: 'Administrator' } });
      if (adminRole && existing.roleId === adminRole.id) {
        const otherAdmins = await prisma.user.count({ where: { roleId: adminRole.id, isActive: true, id: { not: id } } });
        if (otherAdmins === 0) throw badRequest('This is the last active administrator — promote someone else first.');
      }
    }

    const user = await prisma.user.update({
      where: { id },
      data: { ...data, ...(data.email ? { email: data.email.toLowerCase().trim() } : {}), ...(password ? { passwordHash: await bcrypt.hash(password, 10) } : {}) },
      select: { id: true, email: true, name: true, isActive: true, role: { select: { name: true } } },
    });
    await audit({
      user: request.user, action: 'update', entity: 'User', entityId: id, summary: user.name,
      changes: diff(existing as unknown as Record<string, unknown>, { ...data } as Record<string, unknown>),
      ip: clientIp(request),
    });
    return user;
  });

  app.delete('/api/users/:id', { preHandler: requirePermission('users', 'delete') }, async (request) => {
    const { id } = request.params as { id: string };
    if (id === request.user.id) throw badRequest('You cannot deactivate your own account.');
    // Deactivate, never delete — audit history and record ownership must survive.
    await prisma.user.update({ where: { id }, data: { isActive: false } });
    await audit({ user: request.user, action: 'update', entity: 'User', entityId: id, summary: 'Deactivated', ip: clientIp(request) });
    return { ok: true };
  });

  // ── offboarding: transfer a leaving user's records to another user ────────────

  /** The transferable modules and how many records the user owns in each. */
  app.get('/api/users/:id/transfer/preview', { preHandler: requirePermission('users', 'read') }, async (request) => {
    const { id } = request.params as { id: string };
    return { modules: TRANSFERABLE_MODULES, counts: await previewTransfer(id) };
  });

  app.post('/api/users/:id/transfer', { preHandler: requirePermission('users', 'update') }, async (request) => {
    const { id } = request.params as { id: string };
    const parsed = z.object({
      toUserId: z.string().min(1, 'Choose who receives the records.'),
      modules: z.array(z.string()).min(1, 'Select at least one module.'),
      deactivate: z.boolean().optional().default(false),
    }).safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
    return transferOwnership({ fromUserId: id, ...parsed.data, byUser: request.user });
  });

  app.post('/api/transfers/:jobId/reverse', { preHandler: requirePermission('users', 'update') }, async (request) => {
    const { jobId } = request.params as { jobId: string };
    return reverseTransfer(jobId, request.user);
  });

  /** Download a user's whole book of business as JSON — archive or handover. */
  app.get('/api/users/:id/export', { preHandler: requirePermission('users', 'read') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = await prisma.user.findUnique({ where: { id }, select: { name: true } });
    const book = await exportUserBook(id);
    await audit({ user: request.user, action: 'export', entity: 'User', entityId: id, summary: `Exported book of business for ${user?.name ?? id}`, ip: clientIp(request) });
    return reply
      .header('content-type', 'application/json')
      .header('content-disposition', `attachment; filename="zeus-book-${id}-${new Date().toISOString().slice(0, 10)}.json"`)
      .send(JSON.stringify({ user: user?.name ?? id, exportedAt: new Date().toISOString(), ...book }, null, 2));
  });

  // ── roles ───────────────────────────────────────────────────────────────────

  app.get('/api/roles', { preHandler: requirePermission('roles', 'read') }, async () => ({
    roles: await prisma.role.findMany({
      include: { _count: { select: { users: true } } },
      orderBy: { name: 'asc' },
    }),
    modules: MODULES,
    protectedFields: PROTECTED_FIELDS,
    scopes: ['all', 'team', 'own', 'none'],
  }));

  const roleSchema = z.object({
    name: z.string().min(1),
    description: z.string().optional().nullable(),
    permissions: z.record(z.object({
      read: z.enum(['all', 'team', 'own', 'none']),
      create: z.boolean(),
      update: z.enum(['all', 'team', 'own', 'none']),
      delete: z.enum(['all', 'team', 'own', 'none']),
      export: z.boolean(),
      fields: z.record(z.enum(['hidden', 'read', 'write'])).optional(),
    })),
  });

  app.post('/api/roles', { preHandler: requirePermission('roles', 'create') }, async (request, reply) => {
    const parsed = roleSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
    const role = await prisma.role.create({ data: { ...parsed.data, permissions: parsed.data.permissions as never } });
    await audit({ user: request.user, action: 'create', entity: 'Role', entityId: role.id, summary: role.name, ip: clientIp(request) });
    return reply.status(201).send(role);
  });

  app.patch('/api/roles/:id', { preHandler: requirePermission('roles', 'update') }, async (request) => {
    const { id } = request.params as { id: string };
    const parsed = roleSchema.partial().safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);

    const existing = await prisma.role.findUnique({ where: { id } });
    if (!existing) throw notFound('Role not found.');

    // The Administrator role must keep full access or the app becomes unadministrable.
    if (existing.name === 'Administrator' && parsed.data.permissions) {
      const perms = parsed.data.permissions as PermissionMap;
      const stillAdmin = perms.settings?.update === 'all' && perms.users?.create && perms.roles?.update === 'all';
      if (!stillAdmin) throw badRequest('The Administrator role must keep full access to settings, users and roles.');
    }

    const role = await prisma.role.update({
      where: { id },
      data: { ...parsed.data, permissions: (parsed.data.permissions ?? existing.permissions) as never },
    });
    await audit({ user: request.user, action: 'update', entity: 'Role', entityId: id, summary: role.name, ip: clientIp(request) });
    return role;
  });

  app.delete('/api/roles/:id', { preHandler: requirePermission('roles', 'delete') }, async (request) => {
    const { id } = request.params as { id: string };
    const role = await prisma.role.findUnique({ where: { id }, include: { _count: { select: { users: true } } } });
    if (!role) throw notFound('Role not found.');
    if (role.isSystem) throw badRequest('Built-in roles can be edited but not deleted.');
    if (role._count.users > 0) throw badRequest(`${role._count.users} user(s) still have this role. Reassign them first.`);
    await prisma.role.delete({ where: { id } });
    await audit({ user: request.user, action: 'delete', entity: 'Role', entityId: id, summary: role.name, ip: clientIp(request) });
    return { ok: true };
  });

  /** Reset a role back to its shipped defaults. */
  app.post('/api/roles/:id/reset', { preHandler: requirePermission('roles', 'update') }, async (request) => {
    const { id } = request.params as { id: string };
    const role = await prisma.role.findUnique({ where: { id } });
    if (!role) throw notFound('Role not found.');
    const preset = SYSTEM_ROLES.find((r) => r.name === role.name);
    if (!preset) throw badRequest('That role has no shipped default to reset to.');
    const updated = await prisma.role.update({ where: { id }, data: { permissions: preset.permissions as never } });
    await audit({ user: request.user, action: 'update', entity: 'Role', entityId: id, summary: `Reset ${role.name} to defaults`, ip: clientIp(request) });
    return updated;
  });

  // ── teams ───────────────────────────────────────────────────────────────────

  app.get('/api/teams', async () => prisma.team.findMany({ include: { _count: { select: { users: true } } }, orderBy: { name: 'asc' } }));

  app.post('/api/teams', { preHandler: requirePermission('users', 'create') }, async (request, reply) => {
    const { name, kind } = z.object({ name: z.string().min(1), kind: z.string().default('product') }).parse(request.body);
    return reply.status(201).send(await prisma.team.create({ data: { name, kind } }));
  });

  app.patch('/api/teams/:id', { preHandler: requirePermission('users', 'update') }, async (request) => {
    const { id } = request.params as { id: string };
    const body = z.object({ name: z.string().min(1).optional(), kind: z.string().optional() }).parse(request.body);
    return prisma.team.update({ where: { id }, data: body });
  });

  // ── pipelines & stages ──────────────────────────────────────────────────────

  app.get('/api/pipelines', async () =>
    prisma.pipeline.findMany({
      include: { stages: { orderBy: { order: 'asc' } }, _count: { select: { deals: true } } },
      orderBy: { order: 'asc' },
    }),
  );

  app.post('/api/pipelines', { preHandler: requirePermission('settings', 'create') }, async (request, reply) => {
    const schema = z.object({
      name: z.string().min(1),
      kind: z.string().default('product'),
      isDefault: z.boolean().default(false),
      stages: z.array(z.object({
        name: z.string().min(1),
        probability: z.number().int().min(0).max(100).default(0),
        isWon: z.boolean().default(false),
        isLost: z.boolean().default(false),
        color: z.string().default('#6b6b6b'),
        rotDays: z.number().int().positive().default(14),
      })).min(2, 'A pipeline needs at least two stages.'),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);

    if (parsed.data.isDefault) await prisma.pipeline.updateMany({ data: { isDefault: false } });
    const pipeline = await prisma.pipeline.create({
      data: {
        name: parsed.data.name,
        kind: parsed.data.kind,
        isDefault: parsed.data.isDefault,
        stages: { create: parsed.data.stages.map((s, i) => ({ ...s, order: i })) },
      },
      include: { stages: { orderBy: { order: 'asc' } } },
    });
    await audit({ user: request.user, action: 'create', entity: 'Pipeline', entityId: pipeline.id, summary: pipeline.name, ip: clientIp(request) });
    return reply.status(201).send(pipeline);
  });

  /** Rename/reorder stages, add new ones. Existing deals keep their stage id. */
  app.put('/api/pipelines/:id/stages', { preHandler: requirePermission('settings', 'update') }, async (request) => {
    const { id } = request.params as { id: string };
    const schema = z.array(z.object({
      id: z.string().optional(),
      name: z.string().min(1),
      probability: z.number().int().min(0).max(100),
      isWon: z.boolean(),
      isLost: z.boolean(),
      color: z.string(),
      rotDays: z.number().int().positive(),
    })).min(2, 'A pipeline needs at least two stages.');
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);

    const existing = await prisma.stage.findMany({ where: { pipelineId: id } });
    const keptIds = parsed.data.map((s) => s.id).filter(Boolean) as string[];
    const removed = existing.filter((s) => !keptIds.includes(s.id));

    for (const stage of removed) {
      const count = await prisma.deal.count({ where: { stageId: stage.id, deletedAt: null } });
      if (count > 0) throw badRequest(`Stage "${stage.name}" still holds ${count} deal(s). Move them before removing it.`);
    }

    await prisma.$transaction([
      ...removed.map((s) => prisma.stage.delete({ where: { id: s.id } })),
      ...parsed.data.map((s, index) =>
        s.id
          ? prisma.stage.update({ where: { id: s.id }, data: { ...s, order: index } })
          : prisma.stage.create({ data: { ...s, id: undefined, pipelineId: id, order: index } }),
      ),
    ]);

    await audit({ user: request.user, action: 'update', entity: 'Pipeline', entityId: id, summary: 'Stages updated', ip: clientIp(request) });
    return prisma.pipeline.findUnique({ where: { id }, include: { stages: { orderBy: { order: 'asc' } } } });
  });

  // ── settings ────────────────────────────────────────────────────────────────

  app.get('/api/settings', { preHandler: requirePermission('settings', 'read') }, async (request) => {
    const prefix = (request.query as Record<string, string>).prefix;
    return { values: await getSettings(prefix), defaults: SETTING_DEFAULTS };
  });

  /** Public subset every signed-in user needs to render forms (currency, lists, VAT). */
  app.get('/api/settings/public', async (request) => {
    if (!request.user) throw badRequest('Not signed in.');
    const all = await getSettings();
    const allowed = ['company.name', 'branding.', 'finance.currency', 'finance.vatRate', 'finance.vatLabel', 'lists.', 'pipeline.'];
    return Object.fromEntries(Object.entries(all).filter(([key]) => allowed.some((p) => key === p || key.startsWith(p))));
  });

  app.put('/api/settings', { preHandler: requirePermission('settings', 'update') }, async (request) => {
    const body = z.record(z.unknown()).parse(request.body);
    for (const [key, value] of Object.entries(body)) {
      await setSetting(key, value, key.split('.')[0]);
    }
    invalidateSettings();
    await audit({ user: request.user, action: 'update', entity: 'Setting', summary: `Updated ${Object.keys(body).join(', ')}`, ip: clientIp(request) });
    return { ok: true, values: await getSettings() };
  });

  /**
   * Pull the rates now rather than waiting for tomorrow's job. Useful the first time
   * a currency appears in the price book, and when someone wants to see for themselves
   * that the feed is answering.
   */
  app.post('/api/settings/exchange-rates/refresh', { preHandler: requirePermission('settings', 'update') }, async (request) => {
    const result = await refreshRates();
    if (result.updated.length > 0) {
      await audit({
        user: request.user, action: 'update', entity: 'Setting',
        summary: `Fetched exchange rates: ${result.updated.map((c) => `${c}=${result.rates[c]}`).join(', ')}`,
        ip: clientIp(request),
      });
    }
    return result;
  });

  // ── outbound webhooks ───────────────────────────────────────────────────────

  const webhookFields = {
    id: true, name: true, url: true, events: true, isActive: true,
    failureCount: true, disabledAt: true, lastError: true, createdAt: true,
  } as const;

  app.get('/api/webhooks', { preHandler: requirePermission('integrations', 'read') }, async () => {
    // The secret is never sent back — only the fact that one exists.
    return prisma.webhook.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        ...webhookFields,
        deliveries: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: { id: true, event: true, ok: true, responseCode: true, error: true, durationMs: true, createdAt: true },
        },
      },
    });
  });

  const webhookSchema = z.object({
    name: z.string().min(1, 'Give it a name so you know what it is for.'),
    url: z.string().min(1, 'Where should Zeus send it?'),
    events: z.array(z.string()).min(1, 'Pick at least one event.'),
    isActive: z.boolean().optional(),
  });

  app.post('/api/webhooks', { preHandler: requirePermission('integrations', 'update') }, async (request, reply) => {
    const parsed = webhookSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);

    // Checked here as well as before every send: catching a typo where somebody typed it
    // is kinder than a delivery log full of refusals.
    const egress = await checkEgress(parsed.data.url);
    if (!egress.ok) throw badRequest(egress.reason ?? 'Zeus will not send there.');

    const unknown = parsed.data.events.filter((e) => !NOTIFICATION_EVENTS.some((known) => known.event === e));
    if (unknown.length) throw badRequest(`Zeus does not raise an event called "${unknown[0]}".`);

    const secret = generateWebhookSecret();
    const hook = await prisma.webhook.create({
      data: { ...parsed.data, secret: encryptJson({ secret }) },
      select: webhookFields,
    });

    await audit({ user: request.user, action: 'create', entity: 'Webhook', entityId: hook.id, summary: `${hook.name} → ${hook.url}`, ip: clientIp(request) });
    // The only time the secret is returned. The receiver needs it to check signatures.
    return reply.status(201).send({ ...hook, secret });
  });

  app.patch('/api/webhooks/:id', { preHandler: requirePermission('integrations', 'update') }, async (request) => {
    const { id } = request.params as { id: string };
    const parsed = webhookSchema.partial().safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);

    if (parsed.data.url) {
      const egress = await checkEgress(parsed.data.url);
      if (!egress.ok) throw badRequest(egress.reason ?? 'Zeus will not send there.');
    }

    const hook = await prisma.webhook.update({
      where: { id },
      // Switching it back on is also how a disabled hook is revived.
      data: { ...parsed.data, ...(parsed.data.isActive ? { disabledAt: null, failureCount: 0, lastError: null } : {}) },
      select: webhookFields,
    });
    await audit({ user: request.user, action: 'update', entity: 'Webhook', entityId: id, summary: hook.name, ip: clientIp(request) });
    return hook;
  });

  app.delete('/api/webhooks/:id', { preHandler: requirePermission('integrations', 'update') }, async (request) => {
    const { id } = request.params as { id: string };
    const hook = await prisma.webhook.findUnique({ where: { id }, select: { name: true } });
    if (!hook) throw notFound('That webhook no longer exists.');
    await prisma.webhook.delete({ where: { id } });
    await audit({ user: request.user, action: 'delete', entity: 'Webhook', entityId: id, summary: hook.name, ip: clientIp(request) });
    return { ok: true };
  });

  /** Send a real signed call, so the receiving end can be tested before it matters. */
  app.post('/api/webhooks/:id/test', { preHandler: requirePermission('integrations', 'update') }, async (request) => {
    const { id } = request.params as { id: string };
    const hook = await prisma.webhook.findUnique({ where: { id }, select: { id: true, url: true, secret: true } });
    if (!hook) throw notFound('That webhook no longer exists.');

    const ok = await deliverOne(hook, {
      event: 'test',
      title: 'Test call from Zeus',
      body: 'If you can read this and the signature checks out, the endpoint is wired up.',
    });

    const latest = await prisma.webhookDelivery.findFirst({ where: { webhookId: id }, orderBy: { createdAt: 'desc' } });
    return { ok, responseCode: latest?.responseCode ?? null, error: latest?.error ?? null };
  });

  // ── custom fields ───────────────────────────────────────────────────────────

  app.get('/api/custom-fields', async (request) => {
    const module = (request.query as Record<string, string>).module;
    return prisma.customField.findMany({ where: { ...(module ? { module } : {}), isActive: true }, orderBy: [{ module: 'asc' }, { order: 'asc' }] });
  });

  app.post('/api/custom-fields', { preHandler: requirePermission('settings', 'create') }, async (request, reply) => {
    const schema = z.object({
      module: z.string().min(1),
      key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, 'Key must start with a letter and contain only letters, numbers and underscores.'),
      label: z.string().min(1),
      type: z.enum(['text', 'textarea', 'number', 'currency', 'date', 'select', 'multiselect', 'checkbox', 'url', 'email']).default('text'),
      options: z.array(z.string()).default([]),
      required: z.boolean().default(false),
      order: z.number().int().default(0),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
    const field = await prisma.customField.create({ data: parsed.data });
    invalidateCustomFields();
    await audit({ user: request.user, action: 'create', entity: 'CustomField', entityId: field.id, summary: `${field.module}.${field.key}`, ip: clientIp(request) });
    return reply.status(201).send(field);
  });

  app.patch('/api/custom-fields/:id', { preHandler: requirePermission('settings', 'update') }, async (request) => {
    const { id } = request.params as { id: string };
    const body = z.object({
      label: z.string().optional(), options: z.array(z.string()).optional(), required: z.boolean().optional(),
      order: z.number().int().optional(), isActive: z.boolean().optional(),
    }).parse(request.body);
    const updated = await prisma.customField.update({ where: { id }, data: body });
    invalidateCustomFields();
    return updated;
  });

  app.delete('/api/custom-fields/:id', { preHandler: requirePermission('settings', 'delete') }, async (request) => {
    const { id } = request.params as { id: string };
    // Deactivate: the values stay in each record's customFields JSON in case it comes back.
    await prisma.customField.update({ where: { id }, data: { isActive: false } });
    invalidateCustomFields();
    return { ok: true };
  });

  // ── targets ─────────────────────────────────────────────────────────────────

  app.get('/api/targets', { preHandler: requirePermission('reports', 'read') }, async (request) => {
    const q = request.query as Record<string, string>;
    const year = Number(q.year ?? new Date().getFullYear());
    return prisma.target.findMany({
      where: { year },
      include: { user: { select: { id: true, name: true, avatarColor: true } } },
      orderBy: [{ quarter: 'asc' }],
    });
  });

  app.put('/api/targets', { preHandler: requirePermission('settings', 'update') }, async (request) => {
    const schema = z.array(z.object({
      userId: z.string().nullable(),
      year: z.number().int(),
      quarter: z.number().int().min(0).max(4),
      amount: z.number().nonnegative(),
    }));
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);

    for (const t of parsed.data) {
      // Prisma treats null in a compound unique as "no match", so company-wide
      // targets (userId = null) are matched explicitly rather than via upsert.
      if (t.userId === null) {
        const existing = await prisma.target.findFirst({ where: { userId: null, year: t.year, quarter: t.quarter } });
        if (existing) await prisma.target.update({ where: { id: existing.id }, data: { amount: t.amount } });
        else await prisma.target.create({ data: t });
      } else {
        await prisma.target.upsert({
          where: { userId_year_quarter: { userId: t.userId, year: t.year, quarter: t.quarter } },
          create: t,
          update: { amount: t.amount },
        });
      }
    }
    await audit({ user: request.user, action: 'update', entity: 'Target', summary: `${parsed.data.length} target(s) updated`, ip: clientIp(request) });
    return { ok: true };
  });

  // ── notification rules & Teams webhooks ─────────────────────────────────────

  app.get('/api/notification-rules', { preHandler: requirePermission('settings', 'read') }, async () => ({
    rules: await prisma.notificationRule.findMany({ include: { teamsWebhook: true }, orderBy: { label: 'asc' } }),
    events: NOTIFICATION_EVENTS,
    webhooks: await prisma.teamsWebhook.findMany({ orderBy: { name: 'asc' } }),
  }));

  app.patch('/api/notification-rules/:id', { preHandler: requirePermission('settings', 'update') }, async (request) => {
    const { id } = request.params as { id: string };
    const body = z.object({
      enabled: z.boolean().optional(), inApp: z.boolean().optional(), email: z.boolean().optional(), teams: z.boolean().optional(),
      whatsapp: z.boolean().optional(),
      thresholdDays: z.number().int().nonnegative().nullable().optional(),
      audience: z.enum(['owner', 'manager', 'admins', 'all', 'specific']).optional(),
      recipientIds: z.array(z.string()).optional(),
      teamsWebhookId: z.string().nullable().optional(),
    }).parse(request.body);
    const rule = await prisma.notificationRule.update({ where: { id }, data: body });
    await audit({ user: request.user, action: 'update', entity: 'NotificationRule', entityId: id, summary: rule.label, ip: clientIp(request) });
    return rule;
  });

  app.post('/api/teams-webhooks', { preHandler: requirePermission('settings', 'create') }, async (request, reply) => {
    const body = z.object({
      name: z.string().min(1),
      url: z.string().url().refine((u) => /(webhook\.office\.com|logic\.azure\.com|office\.com|microsoft\.com)/i.test(u), 'That does not look like a Teams webhook URL.'),
      isDefault: z.boolean().default(false),
    }).parse(request.body);

    if (body.isDefault) await prisma.teamsWebhook.updateMany({ data: { isDefault: false } });
    const hook = await prisma.teamsWebhook.create({ data: body });
    await audit({ user: request.user, action: 'create', entity: 'TeamsWebhook', entityId: hook.id, summary: hook.name, ip: clientIp(request) });
    return reply.status(201).send(hook);
  });

  app.post('/api/teams-webhooks/:id/test', { preHandler: requirePermission('settings', 'update') }, async (request) => {
    const { id } = request.params as { id: string };
    const hook = await prisma.teamsWebhook.findUnique({ where: { id } });
    if (!hook) throw notFound('Webhook not found.');
    await postToWebhook(hook.url, {
      title: 'Zeus is connected',
      text: `Test message from Zeus CRM, sent by ${request.user.name}.`,
      facts: [{ title: 'Channel', value: hook.name }, { title: 'Time', value: new Date().toLocaleString('en-GB') }],
      severity: 'info',
    });
    return { ok: true };
  });

  app.delete('/api/teams-webhooks/:id', { preHandler: requirePermission('settings', 'delete') }, async (request) => {
    const { id } = request.params as { id: string };
    await prisma.notificationRule.updateMany({ where: { teamsWebhookId: id }, data: { teamsWebhookId: null, teams: false } });
    await prisma.teamsWebhook.delete({ where: { id } });
    return { ok: true };
  });

  // ── in-app notifications ────────────────────────────────────────────────────

  app.get('/api/notifications', async (request) => {
    if (!request.user) throw badRequest('Not signed in.');
    const params = listParams(request.query as Record<string, unknown>, 'createdAt');
    const where = { userId: request.user.id, ...(params.filters.unread === 'true' ? { readAt: null } : {}) };
    const [data, total, unread] = await Promise.all([
      prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, skip: params.skip, take: params.take }),
      prisma.notification.count({ where }),
      prisma.notification.count({ where: { userId: request.user.id, readAt: null } }),
    ]);
    return { ...paged(data, total, params), unread };
  });

  app.post('/api/notifications/read', async (request) => {
    if (!request.user) throw badRequest('Not signed in.');
    const { ids } = z.object({ ids: z.array(z.string()).optional() }).parse(request.body ?? {});
    await prisma.notification.updateMany({
      where: { userId: request.user.id, readAt: null, ...(ids?.length ? { id: { in: ids } } : {}) },
      data: { readAt: new Date() },
    });
    return { ok: true };
  });

  // ── audit trail ─────────────────────────────────────────────────────────────

  app.get('/api/audit', { preHandler: requirePermission('audit', 'read') }, async (request) => {
    const params = listParams(request.query as Record<string, unknown>, 'at');
    const where: Record<string, unknown> = {};
    if (params.filters.entity) where.entity = params.filters.entity;
    if (params.filters.entityId) where.entityId = params.filters.entityId;
    if (params.filters.userId) where.userId = params.filters.userId;
    if (params.filters.action) where.action = params.filters.action;
    if (params.filters.from || params.filters.to) {
      where.at = {
        ...(params.filters.from ? { gte: new Date(params.filters.from) } : {}),
        ...(params.filters.to ? { lte: new Date(params.filters.to) } : {}),
      };
    }
    const [data, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        include: { user: { select: { id: true, name: true, avatarColor: true } } },
        orderBy: { at: 'desc' },
        skip: params.skip,
        take: params.take,
      }),
      prisma.auditLog.count({ where }),
    ]);
    return paged(data, total, params);
  });
}
