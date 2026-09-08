import { prisma } from '../db.js';
import { decryptJson, encryptJson } from '../lib/crypto.js';
import { env } from '../env.js';

/**
 * Microsoft 365 via one tenant app registration (client credentials).
 * Admin consents once; Zeus then sends mail from a shared mailbox, and backs up
 * to a OneDrive/SharePoint folder, without any user being online.
 *
 * The same app registration also serves interactive SSO (see auth/entra.ts).
 */

export interface M365Config {
  tenantId: string;
  clientId: string;
  /** Mailbox Zeus sends from, e.g. crm@protect24x7.ae */
  senderUpn?: string;
  /** UPN whose OneDrive receives backups, or a SharePoint drive id. */
  backupDriveUpn?: string;
  backupDriveId?: string;
  backupFolder?: string;
}

export interface M365Secrets {
  clientSecret: string;
}


const GRAPH = 'https://graph.microsoft.com/v1.0';
const APP_SCOPE = 'https://graph.microsoft.com/.default';

/** Application permissions the admin must consent to for the full feature set. */
export const REQUIRED_APP_PERMISSIONS = ['Mail.Send', 'Files.ReadWrite.All', 'User.Read.All'];

export async function getM365(): Promise<{ config: M365Config; secrets: M365Secrets | null; isConnected: boolean } | null> {
  const row = await prisma.integration.findUnique({ where: { provider: 'microsoft365' } });
  if (!row) {
    // Fall back to env pre-fill on a fresh install so a scripted deploy can work day one.
    if (env.M365_TENANT_ID && env.M365_CLIENT_ID) {
      return {
        config: { tenantId: env.M365_TENANT_ID, clientId: env.M365_CLIENT_ID },
        secrets: env.M365_CLIENT_SECRET ? { clientSecret: env.M365_CLIENT_SECRET } : null,
        isConnected: false,
      };
    }
    return null;
  }
  return {
    config: row.config as unknown as M365Config,
    secrets: decryptJson<M365Secrets>(row.secrets),
    isConnected: row.isConnected,
  };
}

export async function saveM365(config: M365Config, clientSecret?: string): Promise<void> {
  const existing = await prisma.integration.findUnique({ where: { provider: 'microsoft365' } });
  const secrets = clientSecret
    ? encryptJson({ clientSecret })
    : existing?.secrets ?? null;

  await prisma.integration.upsert({
    where: { provider: 'microsoft365' },
    create: { provider: 'microsoft365', config: config as never, secrets, status: 'configured' },
    update: { config: config as never, secrets },
  });
}

export async function markM365(status: string, isConnected: boolean, lastError?: string | null): Promise<void> {
  await prisma.integration.updateMany({
    where: { provider: 'microsoft365' },
    data: { status, isConnected, lastError: lastError ?? null, connectedAt: isConnected ? new Date() : null },
  });
}

// ── token cache ───────────────────────────────────────────────────────────────
let tokenCache: { token: string; expiresAt: number } | null = null;

export function resetTokenCache(): void {
  tokenCache = null;
}

export async function appToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;

  const m365 = await getM365();
  if (!m365?.secrets?.clientSecret) throw new Error('Microsoft 365 is not configured. Settings → Integrations.');

  const body = new URLSearchParams({
    client_id: m365.config.clientId,
    client_secret: m365.secrets.clientSecret,
    scope: APP_SCOPE,
    grant_type: 'client_credentials',
  });

  const res = await fetch(`https://login.microsoftonline.com/${m365.config.tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !json.access_token) {
    throw new Error(json.error_description ?? `Token request failed (${res.status})`);
  }
  tokenCache = { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
  return json.access_token;
}

/** Cheap liveness check for the heartbeat: can we still get an app token? */
export async function pingM365(): Promise<{ configured: boolean; ok: boolean; message: string }> {
  const m365 = await getM365();
  if (!m365?.secrets?.clientSecret) return { configured: false, ok: false, message: 'Not configured yet.' };
  try {
    await appToken();
    return { configured: true, ok: true, message: 'Token acquired.' };
  } catch (err) {
    return { configured: true, ok: false, message: (err as Error).message };
  }
}

export async function graphFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await appToken();
  return fetch(path.startsWith('http') ? path : `${GRAPH}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

export interface MailInput {
  to: string[];
  cc?: string[];
  subject: string;
  html: string;
  attachments?: Array<{ filename: string; contentBytes: string; contentType: string }>;
  /**
   * What this message is and what it belongs to. Optional so a forgotten caller still
   * sends, but every caller in the tree passes it — without it the log says "other"
   * and links nowhere, which is the one thing the log exists to avoid.
   */
  log?: { kind: string; entity?: string; entityId?: string; userId?: string | null; resentFromId?: string };
}

/** The body as a couple of readable lines: enough to know what went, no stored correspondence. */
function previewOf(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    // A space only where the markup was a line break; inline tags close up, or the text
    // reads "there , your quote" wherever a word was bolded.
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6]|td)>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/**
 * Send, and record it either way.
 *
 * The row is written by this function rather than by the ten places that call it, so
 * a new caller cannot forget and an old one cannot drift. A failure keeps the whole
 * message so it can be replayed exactly, then rethrows — callers behave exactly as
 * they did before this log existed.
 */
export async function sendMail(mail: MailInput): Promise<void> {
  const record = async (status: 'SENT' | 'FAILED', error?: string) => {
    await prisma.emailLog.create({
      data: {
        to: mail.to, cc: mail.cc ?? [], subject: mail.subject, preview: previewOf(mail.html),
        kind: mail.log?.kind ?? 'other', status, error: error?.slice(0, 2000) ?? null,
        entity: mail.log?.entity ?? null, entityId: mail.log?.entityId ?? null, userId: mail.log?.userId ?? null,
        attachments: (mail.attachments ?? []).map((a) => a.filename),
        resentFromId: mail.log?.resentFromId ?? null,
        // Only a failure keeps the payload, and only until it is resent.
        payload: status === 'FAILED' ? ({ html: mail.html, attachments: mail.attachments ?? [] } as never) : undefined,
      },
    }).catch((err) => console.error('[mail] could not record the send:', (err as Error).message));
  };

  const m365 = await getM365();
  const sender = m365?.config.senderUpn;
  if (!sender) {
    const message = 'No sender mailbox set. Settings → Integrations → Sending mailbox.';
    await record('FAILED', message);
    throw new Error(message);
  }

  const payload = {
    message: {
      subject: mail.subject,
      body: { contentType: 'HTML', content: mail.html },
      toRecipients: mail.to.map((address) => ({ emailAddress: { address } })),
      ccRecipients: (mail.cc ?? []).map((address) => ({ emailAddress: { address } })),
      attachments: (mail.attachments ?? []).map((a) => ({
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: a.filename,
        contentType: a.contentType,
        contentBytes: a.contentBytes,
      })),
    },
    saveToSentItems: true,
  };

  let res: Response;
  try {
    res = await graphFetch(`/users/${encodeURIComponent(sender)}/sendMail`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  } catch (err) {
    // Graph unreachable at all — no HTTP status to report, just the network error.
    await record('FAILED', (err as Error).message);
    throw err;
  }
  if (!res.ok) {
    const message = `Graph sendMail failed (${res.status}): ${await res.text()}`;
    await record('FAILED', message);
    throw new Error(message);
  }
  // 202 Accepted: Microsoft has the message. That is the most this API ever tells us.
  await record('SENT');
}

/** Resolve the drive backups go to: an explicit drive id, or a user's OneDrive. */
async function resolveBackupDrive(): Promise<string> {
  const m365 = await getM365();
  if (m365?.config.backupDriveId) return `/drives/${m365.config.backupDriveId}`;
  if (m365?.config.backupDriveUpn) return `/users/${encodeURIComponent(m365.config.backupDriveUpn)}/drive`;
  throw new Error('No backup destination set. Settings → Integrations → Backup location.');
}

/**
 * Upload a file to OneDrive/SharePoint. Uses a resumable session above 4 MB,
 * which a database dump will exceed almost immediately.
 */
export async function uploadFile(remotePath: string, data: Buffer, contentType = 'application/octet-stream'): Promise<string> {
  const drive = await resolveBackupDrive();
  const encoded = remotePath.split('/').map(encodeURIComponent).join('/');

  if (data.byteLength < 4 * 1024 * 1024) {
    const res = await graphFetch(`${drive}/root:/${encoded}:/content`, {
      method: 'PUT',
      headers: { 'content-type': contentType },
      body: new Uint8Array(data),
    });
    if (!res.ok) throw new Error(`Graph upload failed (${res.status}): ${await res.text()}`);
    const json = (await res.json()) as { webUrl?: string };
    return json.webUrl ?? remotePath;
  }

  const sessionRes = await graphFetch(`${drive}/root:/${encoded}:/createUploadSession`, {
    method: 'POST',
    body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }),
  });
  if (!sessionRes.ok) throw new Error(`Graph upload session failed (${sessionRes.status}): ${await sessionRes.text()}`);
  const { uploadUrl } = (await sessionRes.json()) as { uploadUrl: string };

  const CHUNK = 5 * 1024 * 1024; // must be a multiple of 320 KiB
  let webUrl = remotePath;
  for (let start = 0; start < data.byteLength; start += CHUNK) {
    const end = Math.min(start + CHUNK, data.byteLength) - 1;
    const chunk = data.subarray(start, end + 1);
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'content-length': String(chunk.byteLength),
        'content-range': `bytes ${start}-${end}/${data.byteLength}`,
      },
      body: new Uint8Array(chunk),
    });
    if (!res.ok && res.status !== 202) throw new Error(`Chunk upload failed (${res.status}): ${await res.text()}`);
    if (res.status === 200 || res.status === 201) {
      const json = (await res.json()) as { webUrl?: string };
      webUrl = json.webUrl ?? remotePath;
    }
  }
  return webUrl;
}

export interface ConnectionCheck {
  ok: boolean;
  token: boolean;
  mailbox: { ok: boolean; message: string } | null;
  drive: { ok: boolean; message: string } | null;
  error?: string;
}

/** What the "Test connection" button calls. Checks each capability independently. */
export async function testConnection(): Promise<ConnectionCheck> {
  const result: ConnectionCheck = { ok: false, token: false, mailbox: null, drive: null };
  try {
    await appToken();
    result.token = true;
  } catch (err) {
    result.error = (err as Error).message;
    return result;
  }

  const m365 = await getM365();
  if (m365?.config.senderUpn) {
    const res = await graphFetch(`/users/${encodeURIComponent(m365.config.senderUpn)}?$select=id,mail,displayName`);
    result.mailbox = res.ok
      ? { ok: true, message: `Mailbox found: ${(((await res.json()) as { displayName?: string }).displayName) ?? m365.config.senderUpn}` }
      : { ok: false, message: `Mailbox check failed (${res.status}). Confirm Mail.Send is consented.` };
  }

  if (m365?.config.backupDriveId || m365?.config.backupDriveUpn) {
    try {
      const drive = await resolveBackupDrive();
      const res = await graphFetch(`${drive}?$select=id,name`);
      result.drive = res.ok
        ? { ok: true, message: 'Backup drive reachable.' }
        : { ok: false, message: `Drive check failed (${res.status}). Confirm Files.ReadWrite.All is consented.` };
    } catch (err) {
      result.drive = { ok: false, message: (err as Error).message };
    }
  }

  result.ok = result.token && result.mailbox?.ok !== false && result.drive?.ok !== false;
  return result;
}
