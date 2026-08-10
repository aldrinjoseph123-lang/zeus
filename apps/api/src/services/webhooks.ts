import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { prisma } from '../db.js';
import { decryptJson } from '../lib/crypto.js';
import { checkEgress } from '../lib/egress.js';
import type { NotificationEvent } from './notify.js';

/**
 * Outbound webhooks.
 *
 * Zeus already decides, in one place, that something worth knowing has happened —
 * `notify()`. A webhook is that same decision delivered somewhere else, so the events are
 * the ones the notification rules already use rather than a second vocabulary that would
 * immediately drift out of step with the first.
 *
 * Three things this has to get right, in order of how badly they end:
 *
 *   1. Where it sends. A user-supplied URL fetched by the server is a request forgery
 *      primitive; `checkEgress` runs on the resolved addresses at every delivery.
 *   2. Proving it came from Zeus. Signed with HMAC over timestamp and body, so a receiver
 *      can tell a real call from anyone who learned the URL.
 *   3. Never blocking the thing that triggered it. A slow endpoint must not slow a deal
 *      closing, and a dead one must eventually stop being tried.
 */

const TIMEOUT_MS = 8_000;
const MAX_ATTEMPTS = 3;

/** Consecutive failures before a hook is switched off and someone has to look at it. */
const FAILURE_LIMIT = 10;

/** Deliveries kept per hook. Enough to debug last week; not a second audit log. */
const KEEP_DELIVERIES = 50;

export function generateSecret(): string {
  return `whsec_${randomBytes(24).toString('base64url')}`;
}

/**
 * The signature a receiver checks.
 *
 * The timestamp is inside the signed material, so a captured call cannot be replayed
 * later without breaking it — a receiver that also rejects old timestamps gets replay
 * protection for free.
 */
export function signPayload(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/** Exported so the docs and a receiver's own test can agree on what to compute. */
export function verifySignature(secret: string, timestamp: number, body: string, signature: string): boolean {
  const expected = Buffer.from(signPayload(secret, timestamp, body));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export interface WebhookEvent {
  event: NotificationEvent | string;
  title: string;
  body?: string;
  link?: string;
  severity?: string;
  facts?: Array<{ title: string; value: string }>;
}

const sleep = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Deliver one event to one hook, retrying a few times.
 *
 * Backoff is short and bounded: this runs behind the request that caused it, so the point
 * is to survive a blip, not to guarantee delivery. A receiver that needs guarantees should
 * be reading the audit log, not listening to a webhook.
 */
export async function deliverOne(
  hook: { id: string; url: string; secret: string },
  payload: WebhookEvent,
  allowPrivate = false,
): Promise<boolean> {
  const secret = decryptJson<{ secret: string }>(hook.secret)?.secret;
  if (!secret) {
    await prisma.webhookDelivery.create({
      data: { webhookId: hook.id, event: payload.event, ok: false, error: 'The stored secret could not be read. Rotate it.' },
    });
    return false;
  }

  const body = JSON.stringify({ ...payload, sentAt: new Date().toISOString() });

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    // Re-checked on every attempt, not once at save time: a hostname can start resolving
    // somewhere private between one delivery and the next.
    const egress = await checkEgress(hook.url, allowPrivate);
    if (!egress.ok) {
      await prisma.webhookDelivery.create({
        data: { webhookId: hook.id, event: payload.event, attempt, ok: false, error: egress.reason ?? 'Refused.', resolvedTo: egress.addresses ?? [] },
      });
      return false;
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const started = Date.now();
    try {
      const response = await fetch(hook.url, {
        method: 'POST',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Zeus-Webhook/1',
          'x-zeus-event': String(payload.event),
          'x-zeus-timestamp': String(timestamp),
          'x-zeus-signature': signPayload(secret, timestamp, body),
        },
        body,
      });

      const ok = response.ok;
      await prisma.webhookDelivery.create({
        data: {
          webhookId: hook.id, event: payload.event, attempt, ok,
          responseCode: response.status, durationMs: Date.now() - started,
          resolvedTo: egress.addresses ?? [],
          error: ok ? null : `The endpoint answered ${response.status}.`,
        },
      });
      if (ok) return true;

      // 4xx means the receiver understood and refused; retrying will not change its mind.
      if (response.status >= 400 && response.status < 500 && response.status !== 429) return false;
    } catch (err) {
      await prisma.webhookDelivery.create({
        data: {
          webhookId: hook.id, event: payload.event, attempt, ok: false,
          durationMs: Date.now() - started, resolvedTo: egress.addresses ?? [],
          error: (err as Error).message,
        },
      });
    }

    if (attempt < MAX_ATTEMPTS) await sleep(500 * 2 ** (attempt - 1));
  }
  return false;
}

/**
 * Fan an event out to whoever subscribed.
 *
 * Never throws and never awaited by the caller: a webhook is a courtesy to another
 * system, and a deal closing must not fail because somebody's endpoint is down.
 */
export async function dispatch(payload: WebhookEvent, allowPrivate = false): Promise<void> {
  const hooks = await prisma.webhook.findMany({
    where: { isActive: true, disabledAt: null, events: { has: String(payload.event) } },
    select: { id: true, url: true, secret: true },
  });
  if (hooks.length === 0) return;

  await Promise.all(hooks.map(async (hook) => {
    const ok = await deliverOne(hook, payload, allowPrivate).catch(() => false);

    if (ok) {
      await prisma.webhook.update({ where: { id: hook.id }, data: { failureCount: 0, lastError: null } });
    } else {
      const failed = await prisma.webhook.update({
        where: { id: hook.id },
        data: { failureCount: { increment: 1 } },
        select: { failureCount: true },
      });
      // An endpoint that has been dead for ten events is not coming back on its own.
      if (failed.failureCount >= FAILURE_LIMIT) {
        await prisma.webhook.update({
          where: { id: hook.id },
          data: { disabledAt: new Date(), lastError: `Switched off after ${FAILURE_LIMIT} failures in a row.` },
        });
      }
    }

    await trimDeliveries(hook.id);
  }));
}

/** Keep the log useful rather than unbounded. */
async function trimDeliveries(webhookId: string): Promise<void> {
  const old = await prisma.webhookDelivery.findMany({
    where: { webhookId },
    orderBy: { createdAt: 'desc' },
    skip: KEEP_DELIVERIES,
    select: { id: true },
  });
  if (old.length) await prisma.webhookDelivery.deleteMany({ where: { id: { in: old.map((d) => d.id) } } });
}

