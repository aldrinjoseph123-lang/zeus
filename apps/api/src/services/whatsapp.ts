import { prisma } from '../db.js';
import { decryptJson, encryptJson } from '../lib/crypto.js';

/**
 * WhatsApp notifications via Meta's Cloud API.
 *
 * The money bit, stated plainly because it decides how this is used:
 *
 *   Zeus alerts are *business-initiated* — nobody messaged us first. Meta only allows
 *   those as pre-approved **templates**, and bills them per message. Free-form text is
 *   free but only inside the 24-hour window that opens when the human messages the
 *   business number, which a background alert cannot rely on.
 *
 * So this ships aimed at the free path: Meta's **test number**, which sends approved
 * templates at no cost to up to five verified recipients. Point it at a production
 * number later and only the credentials change.
 *
 * The template is expected to take one body parameter — the whole alert as a single
 * string — so adding an event never needs a new template approved.
 */

const GRAPH = 'https://graph.facebook.com/v21.0';

export interface WhatsappConfig {
  /** From Meta → WhatsApp → API setup. Not the phone number itself. */
  phoneNumberId: string;
  /** Approved template name, e.g. "zeus_alert". */
  templateName: string;
  /** Template language code, e.g. "en" or "en_US" — must match Meta exactly. */
  languageCode: string;
  /** Free test numbers only reach verified recipients; kept here to warn honestly. */
  isTestNumber: boolean;
}

interface WhatsappSecrets {
  accessToken: string;
}

const DEFAULTS: WhatsappConfig = {
  phoneNumberId: '',
  templateName: 'zeus_alert',
  languageCode: 'en',
  isTestNumber: true,
};

export async function getWhatsapp(): Promise<{
  config: WhatsappConfig;
  hasToken: boolean;
  isConnected: boolean;
  status: string;
  lastError: string | null;
} | null> {
  const row = await prisma.integration.findUnique({ where: { provider: 'whatsapp' } });
  if (!row) return null;
  return {
    config: { ...DEFAULTS, ...((row.config ?? {}) as Partial<WhatsappConfig>) },
    hasToken: Boolean(decryptJson<WhatsappSecrets>(row.secrets)?.accessToken),
    isConnected: row.isConnected,
    status: row.status,
    lastError: row.lastError,
  };
}

export async function saveWhatsapp(config: WhatsappConfig, accessToken?: string): Promise<void> {
  const existing = await prisma.integration.findUnique({ where: { provider: 'whatsapp' } });
  // An empty token field means "leave the stored one alone", never "wipe it".
  const secrets = accessToken?.trim()
    ? encryptJson({ accessToken: accessToken.trim() })
    : existing?.secrets ?? null;

  await prisma.integration.upsert({
    where: { provider: 'whatsapp' },
    create: { provider: 'whatsapp', config: config as never, secrets, status: 'configured' },
    update: { config: config as never, secrets, status: 'configured', lastError: null },
  });
}

export async function markWhatsapp(isConnected: boolean, lastError?: string | null): Promise<void> {
  await prisma.integration.update({
    where: { provider: 'whatsapp' },
    data: {
      isConnected,
      status: isConnected ? 'connected' : 'error',
      lastError: lastError ?? null,
      connectedAt: isConnected ? new Date() : undefined,
    },
  });
}

/** Meta wants digits only, no plus, no spaces, no dashes. */
export function normalizeNumber(raw: string): string | null {
  const digits = raw.replace(/[^\d]/g, '');
  // A UAE mobile written locally (0501234567) is missing its country code.
  if (digits.length < 8) return null;
  return digits.startsWith('0') && digits.length === 10 ? `971${digits.slice(1)}` : digits;
}

/**
 * One alert, flattened into the single template parameter.
 * WhatsApp template parameters reject newlines and tabs, so the facts join with
 * separators instead of lines.
 */
export function alertText(input: { title: string; body?: string; facts?: Array<{ title: string; value: string }>; linkUrl?: string }): string {
  const parts = [
    input.title,
    input.body,
    ...(input.facts ?? []).map((f) => `${f.title}: ${f.value}`),
    input.linkUrl,
  ].filter(Boolean) as string[];
  return parts.join(' · ').replace(/[\n\r\t]+/g, ' ').slice(0, 1000);
}

export async function sendWhatsapp(to: string, text: string): Promise<void> {
  const row = await prisma.integration.findUnique({ where: { provider: 'whatsapp' } });
  const config = { ...DEFAULTS, ...((row?.config ?? {}) as Partial<WhatsappConfig>) };
  const token = decryptJson<WhatsappSecrets>(row?.secrets)?.accessToken;

  if (!config.phoneNumberId || !token) {
    throw new Error('WhatsApp is not configured. Settings → Integrations → WhatsApp.');
  }

  const number = normalizeNumber(to);
  if (!number) throw new Error(`"${to}" is not a usable WhatsApp number — use the full international form.`);

  const res = await fetch(`${GRAPH}/${config.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: number,
      type: 'template',
      template: {
        name: config.templateName,
        language: { code: config.languageCode },
        components: [{ type: 'body', parameters: [{ type: 'text', text }] }],
      },
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    // Meta's errors are the only way to learn a template was never approved or a test
    // recipient was never verified, so they are surfaced rather than swallowed.
    throw new Error(`WhatsApp send failed (${res.status}): ${detail.slice(0, 300)}`);
  }
}

export async function testWhatsapp(to: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await sendWhatsapp(to, alertText({ title: 'Zeus test alert', body: 'WhatsApp notifications are wired up correctly.' }));
    await markWhatsapp(true, null);
    return { ok: true };
  } catch (err) {
    const error = (err as Error).message;
    await markWhatsapp(false, error).catch(() => undefined);
    return { ok: false, error };
  }
}
