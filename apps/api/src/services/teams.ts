import { prisma } from '../db.js';

/**
 * Teams delivery via Incoming Webhook / Workflows.
 * Adaptive Card wrapped in the `attachments` envelope, which both the classic
 * Office 365 connector and the newer Workflows webhook accept.
 */

export interface CardFact {
  title: string;
  value: string;
}

export interface CardInput {
  title: string;
  text?: string;
  facts?: CardFact[];
  linkUrl?: string;
  linkLabel?: string;
  severity?: 'info' | 'warn' | 'critical';
}

const ACCENT = { info: 'accent', warn: 'warning', critical: 'attention' } as const;

export function buildCard(input: CardInput): unknown {
  const body: unknown[] = [
    {
      type: 'ColumnSet',
      columns: [
        {
          type: 'Column',
          width: 'stretch',
          items: [
            { type: 'TextBlock', text: 'ZEUS', weight: 'Bolder', size: 'Small', spacing: 'None', color: ACCENT[input.severity ?? 'info'] },
            { type: 'TextBlock', text: input.title, weight: 'Bolder', size: 'Medium', wrap: true, spacing: 'None' },
          ],
        },
      ],
    },
  ];

  if (input.text) body.push({ type: 'TextBlock', text: input.text, wrap: true, spacing: 'Small' });
  if (input.facts?.length) body.push({ type: 'FactSet', facts: input.facts });

  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body,
          actions: input.linkUrl
            ? [{ type: 'Action.OpenUrl', title: input.linkLabel ?? 'Open in Zeus', url: input.linkUrl }]
            : [],
        },
      },
    ],
  };
}

export async function postToWebhook(url: string, card: CardInput): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(buildCard(card)),
  });
  if (!res.ok) throw new Error(`Teams webhook failed (${res.status}): ${await res.text()}`);
}

/** Post to a named webhook, or the default one when no id is given. */
export async function postToTeams(card: CardInput, webhookId?: string | null): Promise<void> {
  const hook = webhookId
    ? await prisma.teamsWebhook.findUnique({ where: { id: webhookId } })
    : await prisma.teamsWebhook.findFirst({ where: { isDefault: true, isActive: true } });
  if (!hook || !hook.isActive) return;
  await postToWebhook(hook.url, card);
}
