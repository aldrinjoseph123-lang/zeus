import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { audit } from '../lib/audit.js';
import { badRequest, clientIp, requirePermission } from '../lib/http.js';
import { getM365, saveM365, testConnection, resetTokenCache, sendMail, REQUIRED_APP_PERMISSIONS } from '../services/graph.js';
import { adminConsentUrl, redirectUri } from '../auth/entra.js';
import { lastBackups, localBackupSize, runBackup } from '../services/backup.js';
import { emailTemplate } from '../services/notify.js';
import { getWhatsapp, saveWhatsapp, testWhatsapp } from '../services/whatsapp.js';

export default async function integrationRoutes(app: FastifyInstance): Promise<void> {
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
        lastError: result.error ?? result.mailbox?.message ?? null,
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

  app.get('/api/backups', { preHandler: requirePermission('integrations', 'read') }, async () => ({
    runs: await lastBackups(),
    local: await localBackupSize(),
  }));

  app.post('/api/backups/run', { preHandler: requirePermission('integrations', 'update') }, async (request) => {
    const { uploadToOneDrive } = z.object({ uploadToOneDrive: z.boolean().default(true) }).parse(request.body ?? {});
    const result = await runBackup({ uploadToOneDrive });
    await audit({ user: request.user, action: 'backup', entity: 'BackupRun', entityId: result.id, summary: result.filename, ip: clientIp(request) });
    return result;
  });
}
