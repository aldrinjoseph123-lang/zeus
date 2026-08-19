import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { audit } from '../lib/audit.js';
import { badRequest, clientIp, forbidden, requirePermission } from '../lib/http.js';
import { can } from '../auth/rbac.js';
import { getM365, saveM365, testConnection, resetTokenCache, sendMail, pingM365, REQUIRED_APP_PERMISSIONS } from '../services/graph.js';
import { adminConsentUrl, redirectUri } from '../auth/entra.js';
import { lastBackups, localBackupSize, runBackup, verifyLatestBackup, validateLatestBackup, checkBackupParity } from '../services/backup.js';
import { restoreModules, needsElevatedPermission } from '../services/restore.js';
import { emailTemplate } from '../services/notify.js';
import { getWhatsapp, saveWhatsapp, testWhatsapp, pingWhatsapp } from '../services/whatsapp.js';

export default async function integrationRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Heartbeat across every integration, checked live and in parallel. Cheap by
   * design: M365 reuses the cached app token, WhatsApp reads phone metadata (no
   * send), webhooks are judged from the DB.
   * ponytail: runs only when polled (Settings page open). If you need alerting
   * while nobody is looking, move this to a cron that writes status to the row.
   */
  app.get('/api/integrations/health', { preHandler: requirePermission('integrations', 'read') }, async () => {
    const [m365, whatsapp, hooks] = await Promise.all([
      pingM365(),
      pingWhatsapp(),
      prisma.webhook.findMany({ where: { isActive: true }, select: { disabledAt: true } }),
    ]);
    const disabled = hooks.filter((h) => h.disabledAt).length;
    const checkedAt = new Date().toISOString();
    return [
      { provider: 'microsoft365', label: 'Microsoft 365', ...m365, checkedAt },
      { provider: 'whatsapp', label: 'WhatsApp', ...whatsapp, checkedAt },
      {
        provider: 'webhooks',
        label: 'Outbound webhooks',
        configured: hooks.length > 0,
        ok: disabled === 0,
        message: hooks.length === 0 ? 'No webhooks configured.' : disabled > 0 ? `${disabled} disabled by delivery failures.` : `${hooks.length} active.`,
        checkedAt,
      },
    ];
  });

  /** Current wiring state plus everything the admin needs to finish the Entra setup. */
  app.get('/api/integrations/microsoft365', { preHandler: requirePermission('integrations', 'read') }, async () => {
    const row = await prisma.integration.findUnique({ where: { provider: 'microsoft365' } });
    const m365 = await getM365();
    return {
      isConnected: row?.isConnected ?? false,
      status: row?.status ?? 'disconnected',
      lastError: row?.lastError ?? null,
      connectedAt: row?.connectedAt ?? null,
      config: m365?.config ?? { tenantId: '', clientId: '' },
      hasSecret: Boolean(m365?.secrets?.clientSecret),
      /** Paste these into the Entra app registration. */
      setup: {
        redirectUri: redirectUri(),
        consentRedirectUri: `${env.APP_URL.replace(/\/$/, '')}/api/auth/microsoft/consent-callback`,
        requiredApplicationPermissions: REQUIRED_APP_PERMISSIONS,
        requiredDelegatedPermissions: ['openid', 'profile', 'email', 'offline_access', 'User.Read'],
      },
    };
  });

  app.put('/api/integrations/microsoft365', { preHandler: requirePermission('integrations', 'update') }, async (request) => {
    const schema = z.object({
      tenantId: z.string().min(1, 'Tenant ID is required.'),
      clientId: z.string().min(1, 'Application (client) ID is required.'),
      clientSecret: z.string().optional(),
      senderUpn: z.string().email().optional().or(z.literal('')),
      backupDriveUpn: z.string().email().optional().or(z.literal('')),
      backupDriveId: z.string().optional(),
      backupFolder: z.string().optional(),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
    const { clientSecret, ...config } = parsed.data;

    await saveM365(
      {
        tenantId: config.tenantId.trim(),
        clientId: config.clientId.trim(),
        senderUpn: config.senderUpn || undefined,
        backupDriveUpn: config.backupDriveUpn || undefined,
        backupDriveId: config.backupDriveId || undefined,
        backupFolder: config.backupFolder || undefined,
      },
      clientSecret || undefined,
    );
    resetTokenCache();

    await audit({ user: request.user, action: 'integration', entity: 'Integration', summary: 'Microsoft 365 settings saved', ip: clientIp(request) });
    return { ok: true, consentUrl: await adminConsentUrl().catch(() => null) };
  });

  app.post('/api/integrations/microsoft365/test', { preHandler: requirePermission('integrations', 'update') }, async (request) => {
    resetTokenCache();
    const result = await testConnection();
    await prisma.integration.updateMany({
      where: { provider: 'microsoft365' },
      data: {
        isConnected: result.ok,
        status: result.ok ? 'connected' : 'error',
        lastError: result.ok ? null : (result.error ?? result.mailbox?.message ?? result.drive?.message ?? null),
        connectedAt: result.ok ? new Date() : null,
      },
    });
    await audit({ user: request.user, action: 'integration', entity: 'Integration', summary: `Connection test: ${result.ok ? 'passed' : 'failed'}`, ip: clientIp(request) });
    return result;
  });

  app.get('/api/integrations/microsoft365/consent-url', { preHandler: requirePermission('integrations', 'update') }, async () => ({
    url: await adminConsentUrl(),
  }));

  app.post('/api/integrations/microsoft365/test-email', { preHandler: requirePermission('integrations', 'update') }, async (request) => {
    const { to } = z.object({ to: z.string().email() }).parse(request.body);
    await sendMail({
      to: [to],
      subject: '[Zeus] Test message',
      html: emailTemplate(
        'Zeus can send email',
        `This test was triggered by ${request.user.name} from Settings → Integrations.`,
        `${env.APP_URL}/settings/integrations`,
      ),
    });
    return { ok: true };
  });

  app.post('/api/integrations/microsoft365/disconnect', { preHandler: requirePermission('integrations', 'update') }, async (request) => {
    await prisma.integration.updateMany({
      where: { provider: 'microsoft365' },
      data: { isConnected: false, status: 'disconnected', secrets: null, connectedAt: null },
    });
    resetTokenCache();
    await audit({ user: request.user, action: 'integration', entity: 'Integration', summary: 'Microsoft 365 disconnected', ip: clientIp(request) });
    return { ok: true };
  });

  // ── backups ─────────────────────────────────────────────────────────────────

  // ── WhatsApp (Meta Cloud API) ───────────────────────────────────────────────
  //
  // Business-initiated messages are template-only and metered. The free way to run
  // this is Meta's test number: approved templates, no charge, up to five verified
  // recipients. Everything the admin needs to know about that is returned here so the
  // screen can say it rather than the user discovering it from a Meta error.

  app.get('/api/integrations/whatsapp', { preHandler: requirePermission('integrations', 'read') }, async () => {
    const wa = await getWhatsapp();
    const withNumbers = await prisma.user.count({ where: { whatsappNumber: { not: null }, isActive: true } });
    return {
      isConnected: wa?.isConnected ?? false,
      status: wa?.status ?? 'disconnected',
      lastError: wa?.lastError ?? null,
      config: wa?.config ?? { phoneNumberId: '', templateName: 'zeus_alert', languageCode: 'en', isTestNumber: true },
      hasToken: wa?.hasToken ?? false,
      recipients: withNumbers,
      setup: {
        freeTierRecipientLimit: 5,
        templateBodyExample: 'Zeus: {{1}}',
        notes: [
          'Meta charges per business-initiated template message on a production number.',
          'A test number sends the same templates free to up to 5 recipients you verify in Meta.',
          'The template needs one body parameter — Zeus passes the whole alert as {{1}}.',
          'Numbers go in international form, e.g. +971501234567.',
        ],
      },
    };
  });

  app.put('/api/integrations/whatsapp', { preHandler: requirePermission('integrations', 'update') }, async (request) => {
    const schema = z.object({
      phoneNumberId: z.string().min(1, 'Phone number ID is required — copy it from Meta → WhatsApp → API setup.'),
      templateName: z.string().min(1, 'Template name is required.'),
      languageCode: z.string().min(2, 'Language code is required, e.g. en or en_US.'),
      isTestNumber: z.boolean().optional(),
      accessToken: z.string().optional(),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
    const { accessToken, ...config } = parsed.data;

    await saveWhatsapp({ ...config, isTestNumber: config.isTestNumber ?? true }, accessToken);
    await audit({
      user: request.user, action: 'integration', entity: 'Integration', entityId: 'whatsapp',
      summary: 'WhatsApp settings saved', ip: clientIp(request),
    });
    return getWhatsapp();
  });

  app.post('/api/integrations/whatsapp/test', { preHandler: requirePermission('integrations', 'update') }, async (request) => {
    const parsed = z.object({ to: z.string().min(6, 'Enter the number to test, in international form.') }).safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);

    const result = await testWhatsapp(parsed.data.to);
    await audit({
      user: request.user, action: 'integration', entity: 'Integration', entityId: 'whatsapp',
      summary: result.ok ? `Test message sent to ${parsed.data.to}` : `Test failed: ${result.error}`,
      ip: clientIp(request),
    });
    if (!result.ok) throw badRequest(result.error);
    return { ok: true };
  });

  app.get('/api/backups', { preHandler: requirePermission('backups', 'read') }, async () => ({
    runs: await lastBackups(),
    local: await localBackupSize(),
  }));

  app.post('/api/backups/run', { preHandler: requirePermission('backups', 'update') }, async (request) => {
    const { uploadToOneDrive, kind } = z.object({
      uploadToOneDrive: z.boolean().default(true),
      kind: z.enum(['physical', 'logical', 'config']).default('physical'),
    }).parse(request.body ?? {});
    const result = await runBackup({ uploadToOneDrive, kind });
    await audit({ user: request.user, action: 'backup', entity: 'BackupRun', entityId: result.id, summary: result.filename, ip: clientIp(request) });
    return result;
  });

  // Validate = integrity only, no database touched — open to anyone who can read backups.
  app.post('/api/backups/validate', { preHandler: requirePermission('backups', 'read') }, async (request) => {
    const result = await validateLatestBackup();
    await audit({ user: request.user, action: 'integration', entity: 'BackupRun', summary: `Backup validate: ${result.ok ? 'valid' : 'FAILED'} (${result.filename ?? 'none'})`, ip: clientIp(request) });
    return result;
  });

  // Verify = a real restore into a throwaway database. Privileged: needs backups:delete.
  app.post('/api/backups/verify', { preHandler: requirePermission('backups', 'delete') }, async (request) => {
    const result = await verifyLatestBackup();
    await audit({ user: request.user, action: 'integration', entity: 'BackupRun', summary: `Backup verify (restore): ${result.ok ? 'restorable' : 'FAILED'} (${result.filename ?? 'none'})`, ip: clientIp(request) });
    return result;
  });

  // Row-count parity — logical/config's analogue of Validate. No database touched.
  app.post('/api/backups/:id/parity', { preHandler: requirePermission('backups', 'read') }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const result = await checkBackupParity(id);
    await audit({ user: request.user, action: 'integration', entity: 'BackupRun', entityId: id, summary: `Backup parity: ${result.ok ? 'matches' : 'FAILED'} (${result.filename ?? 'none'})`, ip: clientIp(request) });
    return result;
  });

  /**
   * Module-into-live restore. Without `confirm` this only reads and returns a
   * dry-run diff; `confirm: true` takes a safety backup first, then upserts.
   * Invoices/purchase orders need the same elevated permission Verify does, checked
   * here rather than via `preHandler` because it only applies to *some* requests to
   * this route, not all of it.
   */
  app.post('/api/backups/:id/restore', { preHandler: requirePermission('backups', 'update') }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { models, confirm } = z.object({
      models: z.array(z.string()).min(1, 'Select at least one module.'),
      confirm: z.boolean().default(false),
    }).parse(request.body);

    if (needsElevatedPermission(models) && !can(request.user, 'backups', 'delete')) {
      throw forbidden('Restoring invoices or purchase orders needs the privileged Backups permission.');
    }

    let result;
    try {
      result = await restoreModules(id, models, confirm);
    } catch (err) {
      throw badRequest((err as Error).message);
    }

    await audit({
      user: request.user, action: 'integration', entity: 'BackupRun', entityId: id,
      summary: result.applied
        ? `Restored ${models.join(', ')}: ${result.created} created, ${result.updated} updated${result.failed?.length ? `, ${result.failed.length} failed` : ''} (safety backup ${result.safetyBackupFilename})`
        : `Previewed restore of ${models.join(', ')} (not applied)`,
      ip: clientIp(request),
    });
    return result;
  });
}
