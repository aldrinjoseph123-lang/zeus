import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { date, daysBetween, money, relative } from '../lib/format';
import { Badge, cx } from './ui';

/**
 * What hovering does, app-wide, from one listener rather than a wrapper at every call site.
 *
 * - **Tooltips.** Any element with a `title` gets a Zeus tooltip instead of the browser's
 *   slow grey one. The title moves to `data-tip` on first hover so the two never show
 *   together. An icon-only control keeps its accessible name, copied to `aria-label`.
 * - **Record previews.** A link to an account, deal, contact or lead, or anything tagged with
 *   `preview(type, id)`, opens a small card after 0.4s. On a touch screen a long press opens it
 *   and a tap still follows the link. The card reads `/api/previews`, which applies the same
 *   permissions as opening the record.
 */

export type PreviewType = 'account' | 'deal' | 'contact' | 'lead';

/** Spread onto whatever names a record: `<span {...preview('deal', deal.id)}>{deal.name}</span>`. */
export const preview = (type: PreviewType, id?: string | null) => (id ? { 'data-preview': `${type}:${id}` } : {});

const LINK = /^\/(accounts|deals|contacts|leads)\/([^/?#]+)$/;
const TYPE_OF: Record<string, PreviewType> = { accounts: 'account', deals: 'deal', contacts: 'contact', leads: 'lead' };
const PREVIEW_DELAY = 400;
const TIP_DELAY = 200;
const LONG_PRESS = 500;

interface Target { el: HTMLElement; type: PreviewType; id: string }

function previewTarget(from: EventTarget | null): Target | null {
  const node = (from as Element | null)?.closest?.<HTMLElement>('[data-preview], a[href]');
  if (!node || node.closest('[data-no-preview]')) return null;
  if (node.dataset.preview) {
    const [type, id] = node.dataset.preview.split(':');
    return { el: node, type: type as PreviewType, id };
  }
  const match = LINK.exec(node.getAttribute('href') ?? '');
  if (!match || match[2] === 'new' || node.getAttribute('href') === window.location.pathname) return null;
  return { el: node, type: TYPE_OF[match[1]], id: match[2] };
}

function tipTarget(from: EventTarget | null): { el: HTMLElement; text: string } | null {
  const el = (from as Element | null)?.closest?.<HTMLElement>('[title], [data-tip], [data-tip-owned]');
  if (!el) return null;
  const title = el.getAttribute('title');
  if (title !== null) {
    // The browser shows `title` itself after a second; moved, it shows only ours.
    el.removeAttribute('title');
    el.dataset.tip = title;
    // React diffs its own props, not the DOM: a render that withdraws the title removes an
    // attribute that is already gone and leaves data-tip saying something no longer true.
    // data-tip-owned marks the ones we moved, so a withdrawn title clears the copy as well.
    el.dataset.tipOwned = '';
    if (!el.getAttribute('aria-label') && !el.textContent?.trim()) el.setAttribute('aria-label', title);
  } else if (el.dataset.tipOwned !== undefined && !el.hasAttribute('title')) {
    const owned = el.dataset.tip;
    delete el.dataset.tip;
    delete el.dataset.tipOwned;
    if (owned && el.getAttribute('aria-label') === owned) el.removeAttribute('aria-label');
    return null;
  }
  const text = el.dataset.tip ?? '';
  return text.trim() ? { el, text } : null;
}

export function HoverLayer() {
  const [tip, setTip] = useState<{ text: string; rect: DOMRect } | null>(null);
  const [card, setCard] = useState<{ type: PreviewType; id: string; rect: DOMRect } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const timers = useRef<{ tip?: number; open?: number; close?: number; press?: number }>({});
  const pressed = useRef<{ x: number; y: number; opened: boolean } | null>(null);
  /** The record whose card is open, or about to open; and the element whose tooltip is. */
  const openFor = useRef<string | null>(null);
  const pendingFor = useRef<string | null>(null);
  const tipEl = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const running = timers.current;
    const clear = (name: keyof typeof running) => { window.clearTimeout(running[name]); running[name] = undefined; };
    const inCard = (node: EventTarget | null) => Boolean(node && cardRef.current?.contains(node as Node));
    const closeCard = () => { clear('open'); clear('close'); openFor.current = null; pendingFor.current = null; setCard(null); };
    const closeTip = () => { clear('tip'); tipEl.current = null; setTip(null); };
    const openCard = (target: Target) => {
      pendingFor.current = null;
      openFor.current = `${target.type}:${target.id}`;
      setCard({ type: target.type, id: target.id, rect: target.el.getBoundingClientRect() });
    };

    const over = (e: PointerEvent | FocusEvent) => {
      if ('pointerType' in e && e.pointerType === 'touch') return;
      if (e.type === 'focusin' && !(e.target as Element).matches?.(':focus-visible')) return;
      if (inCard(e.target)) { clear('close'); return; }
      const target = previewTarget(e.target);
      if (target) {
        closeTip();
        clear('close');
        const key = `${target.type}:${target.id}`;
        if (openFor.current === key || pendingFor.current === key) return;
        clear('open');
        pendingFor.current = key;
        running.open = window.setTimeout(() => openCard(target), PREVIEW_DELAY);
        return;
      }
      const tipped = tipTarget(e.target);
      if (tipped && tipped.el === tipEl.current) return;
      closeTip();
      if (!tipped) return;
      tipEl.current = tipped.el;
      running.tip = window.setTimeout(() => setTip({ text: tipped.text, rect: tipped.el.getBoundingClientRect() }), TIP_DELAY);
    };

    const out = (e: PointerEvent | FocusEvent) => {
      // A finger lifting also "leaves" the element; on touch the card stays until the next tap elsewhere.
      if ('pointerType' in e && e.pointerType === 'touch') return;
      const next = e.relatedTarget as Node | null;
      const from = e.target as Element;
      // Crossing from one part of an element to another (an icon inside a button) is not leaving it.
      if (!(next && tipEl.current?.contains(next))) closeTip();
      if (next && from.closest?.('[data-preview], a[href]')?.contains(next)) return;
      clear('open');
      pendingFor.current = null;
      // A moment's grace, so the pointer can travel from the name onto the card.
      if (openFor.current && !inCard(next)) {
        clear('close');
        running.close = window.setTimeout(closeCard, 200);
      }
    };

    const down = (e: PointerEvent) => {
      closeTip();
      if (inCard(e.target)) return;
      if (e.pointerType !== 'touch') { closeCard(); return; }
      closeCard();
      const target = previewTarget(e.target);
      if (!target) return;
      pressed.current = { x: e.clientX, y: e.clientY, opened: false };
      running.press = window.setTimeout(() => {
        if (pressed.current) pressed.current.opened = true;
        openCard(target);
      }, LONG_PRESS);
    };
    const move = (e: PointerEvent) => {
      if (pressed.current && Math.hypot(e.clientX - pressed.current.x, e.clientY - pressed.current.y) > 10) { clear('press'); pressed.current = null; }
    };
    const up = () => { clear('press'); };
    // A long press opened the card, so the tap that ends it must not also follow the link.
    const click = (e: MouseEvent) => {
      if (pressed.current?.opened) { e.preventDefault(); e.stopPropagation(); }
      pressed.current = null;
      // Following the card's own link leaves the page it belongs to; the card must go with it.
      if (inCard(e.target) && (e.target as Element).closest?.('a[href]')) closeCard();
    };
    const menu = (e: Event) => { if (pressed.current) e.preventDefault(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { closeTip(); closeCard(); } };
    const scrolled = (e: Event) => { if (!inCard(e.target)) { closeTip(); closeCard(); } };

    document.addEventListener('pointerover', over, true);
    document.addEventListener('pointerout', out, true);
    document.addEventListener('focusin', over, true);
    document.addEventListener('focusout', out, true);
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('pointermove', move, true);
    document.addEventListener('pointerup', up, true);
    document.addEventListener('pointercancel', up, true);
    document.addEventListener('click', click, true);
    document.addEventListener('contextmenu', menu, true);
    document.addEventListener('keydown', key);
    document.addEventListener('scroll', scrolled, true);
    return () => {
      Object.keys(running).forEach((name) => clear(name as keyof typeof running));
      document.removeEventListener('pointerover', over, true);
      document.removeEventListener('pointerout', out, true);
      document.removeEventListener('focusin', over, true);
      document.removeEventListener('focusout', out, true);
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('pointerup', up, true);
      document.removeEventListener('pointercancel', up, true);
      document.removeEventListener('click', click, true);
      document.removeEventListener('contextmenu', menu, true);
      document.removeEventListener('keydown', key);
      document.removeEventListener('scroll', scrolled, true);
    };
  }, []);

  return createPortal(
    <>
      {tip ? <Tooltip text={tip.text} rect={tip.rect} /> : null}
      {card ? (
        <div
          ref={cardRef}
          data-hover-card
          onPointerEnter={() => { window.clearTimeout(timers.current.close); }}
          onPointerLeave={() => { timers.current.close = window.setTimeout(() => { openFor.current = null; setCard(null); }, 200); }}
          className="fixed z-[60] w-[300px] max-w-[calc(100vw-16px)] border border-line bg-card text-[12px] shadow-[var(--shadow-lg)]"
          style={{
            left: Math.max(8, Math.min(card.rect.left, window.innerWidth - 308)),
            ...(window.innerHeight - card.rect.bottom > 240 ? { top: card.rect.bottom + 6 } : { bottom: window.innerHeight - card.rect.top + 6 }),
          }}
        >
          <PreviewCard type={card.type} id={card.id} />
        </div>
      ) : null}
    </>,
    document.body,
  );
}

function Tooltip({ text, rect }: { text: string; rect: DOMRect }) {
  const above = rect.top > 44;
  return (
    <div
      role="tooltip"
      className="pointer-events-none fixed z-[70] max-w-[280px] -translate-x-1/2 border border-n800 bg-n950 px-2 py-1 text-[12px] leading-snug text-white shadow-[var(--shadow-md)]"
      style={{
        left: Math.max(148, Math.min(rect.left + rect.width / 2, window.innerWidth - 148)),
        ...(above ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
      }}
    >
      {text}
    </div>
  );
}

// ── the cards ─────────────────────────────────────────────────────────────────

type Named = { id: string; name: string } | null;
interface PreviewData {
  id: string;
  /** An account's kind: CUSTOMER, PARTNER, VENDOR or PROSPECT. */
  type?: string;
  owner?: { name: string } | null;
  lastActivityAt?: string | null;
  // account
  name?: string; industry?: string | null; city?: string | null; emirate?: string | null; phone?: string | null; email?: string | null;
  domain?: string | null; openDeals?: number; openValue?: number; contacts?: number;
  // deal
  reference?: string; status?: string; amount?: number | null; probability?: number; closeDate?: string; stageChangedAt?: string;
  account?: Named; partnerAccount?: Named; stage?: { name: string; color: string };
  // contact and lead
  firstName?: string; lastName?: string; jobTitle?: string | null; mobile?: string | null; isPrimary?: boolean;
  company?: string; rating?: string | null; score?: number; source?: string; estimatedValue?: number | null;
}

const LABEL: Record<PreviewType, string> = { account: 'Account', deal: 'Deal', contact: 'Contact', lead: 'Lead' };
const HREF: Record<PreviewType, (d: PreviewData) => string | null> = {
  account: (d) => `/accounts/${d.id}`,
  deal: (d) => `/deals/${d.id}`,
  // Contacts have no page of their own; the account is where one is looked after.
  contact: (d) => (d.account ? `/accounts/${d.account.id}` : null),
  lead: (d) => `/leads/${d.id}`,
};

function PreviewCard({ type, id }: { type: PreviewType; id: string }) {
  const { data, error, isLoading } = useQuery({
    queryKey: ['preview', type, id],
    queryFn: () => api.get<PreviewData>(`/previews/${type}/${id}`),
    staleTime: 60_000,
    retry: false,
  });

  if (isLoading) return <p className="px-3 py-3 text-muted">Loading…</p>;
  if (error || !data) {
    const status = error instanceof ApiError ? error.status : 0;
    return <p className="px-3 py-3 text-muted">{status === 403 ? 'Your role cannot open this record.' : status === 404 ? 'This record no longer exists.' : 'Could not load a preview.'}</p>;
  }

  const person = [data.firstName, data.lastName].filter(Boolean).join(' ');
  const title = type === 'account' || type === 'deal' ? data.name : person;
  const href = HREF[type](data);
  const rows: Array<[string, ReactNode]> = [];
  const add = (label: string, value: ReactNode) => { if (value !== null && value !== undefined && value !== '') rows.push([label, value]); };

  if (type === 'account') {
    add('Where', [data.industry, data.city ?? data.emirate].filter(Boolean).join(' · '));
    add('Open deals', data.openDeals ? `${data.openDeals} · ${money(data.openValue)}` : 'None');
    add('Contacts', data.contacts);
    add('Phone', data.phone);
    add('Email', data.email ?? data.domain);
  } else if (type === 'deal') {
    add('Account', data.account?.name);
    add('Value', data.amount === undefined || data.amount === null ? null : money(data.amount));
    add('Stage', data.stage ? (
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-block h-2 w-2" style={{ background: data.stage.color }} />
        {data.stage.name}{data.status === 'OPEN' ? ` · ${data.probability}%` : ''}
      </span>
    ) : null);
    add('In stage', data.status === 'OPEN' && data.stageChangedAt ? `${daysBetween(data.stageChangedAt)} days` : null);
    add('Closes', data.closeDate ? date(data.closeDate) : null);
    add('Partner', data.partnerAccount?.name);
  } else if (type === 'contact') {
    add('Role', data.jobTitle);
    add('Account', data.account?.name);
    add('Email', data.email);
    add('Phone', data.mobile ?? data.phone);
  } else {
    add('Company', data.company);
    add('Role', data.jobTitle);
    add('Rating', [data.rating, data.score ? `score ${data.score}` : null].filter(Boolean).join(' · '));
    add('Value', data.estimatedValue ? money(data.estimatedValue) : null);
    add('Email', data.email);
    add('Phone', data.phone);
  }

  return (
    <div>
      <div className="border-b border-line px-3 py-2.5">
        <span className="eyebrow flex items-center gap-2">
          {LABEL[type]}{data.reference ? ` · ${data.reference}` : ''}
          {type === 'account' && data.type ? <Badge tone="neutral">{data.type.toLowerCase()}</Badge> : null}
          {type === 'lead' && data.status ? <Badge tone="info">{data.status.toLowerCase()}</Badge> : null}
          {type === 'contact' && data.isPrimary ? <Badge tone="neutral">primary</Badge> : null}
        </span>
        {href ? (
          <Link to={href} className="mt-0.5 block truncate text-[14px] font-semibold hover:underline">{title}</Link>
        ) : (
          <p className="mt-0.5 truncate text-[14px] font-semibold">{title}</p>
        )}
      </div>
      {rows.length ? (
        <dl className="grid grid-cols-[76px_1fr] gap-x-3 gap-y-1 px-3 py-2.5">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted">{label}</dt>
              <dd className={cx('min-w-0 truncate', label === 'Value' || label === 'Open deals' ? 'tabular font-semibold' : '')}>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <p className="border-t border-line bg-sunken px-3 py-1.5 text-[11px] text-muted">
        {data.owner ? `Owned by ${data.owner.name}` : 'Unassigned'}
        {data.lastActivityAt ? ` · active ${relative(data.lastActivityAt)}` : ''}
      </p>
    </div>
  );
}
