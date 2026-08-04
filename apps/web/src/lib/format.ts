/** Display helpers. Everything money is AED unless a record says otherwise. */

const aed = new Intl.NumberFormat('en-AE', { style: 'currency', currency: 'AED', maximumFractionDigits: 0 });
const aedPrecise = new Intl.NumberFormat('en-AE', { style: 'currency', currency: 'AED', minimumFractionDigits: 2 });
const plain = new Intl.NumberFormat('en-AE');

export const money = (value: unknown, precise = false): string => {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return '—';
  return precise ? aedPrecise.format(n) : aed.format(n);
};

/** Compact figure for KPI tiles: AED 1.2M, AED 480K. */
export function moneyShort(value: unknown): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `AED ${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `AED ${(n / 1_000).toFixed(abs >= 100_000 ? 0 : 1)}K`;
  return aed.format(n);
}

export const number = (value: unknown): string => plain.format(Number(value ?? 0));

export const percent = (value: unknown, digits = 0): string => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? `${n.toFixed(digits)}%` : '—';
};

export function date(value: string | Date | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function dateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function dateInput(value: string | Date | null | undefined): string {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

/** "3 days ago", "in 2 weeks" — used everywhere a staleness signal matters. */
export function relative(value: string | Date | null | undefined): string {
  if (!value) return 'never';
  const diff = new Date(value).getTime() - Date.now();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31_536_000_000], ['month', 2_592_000_000], ['week', 604_800_000],
    ['day', 86_400_000], ['hour', 3_600_000], ['minute', 60_000],
  ];
  for (const [unit, ms] of units) {
    if (abs >= ms) return rtf.format(Math.round(diff / ms), unit);
  }
  return 'just now';
}

export function daysBetween(value: string | Date | null | undefined): number | null {
  if (!value) return null;
  return Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000);
}

export const quarterOf = (d = new Date()): { year: number; quarter: number; label: string } => {
  const quarter = Math.floor(d.getMonth() / 3) + 1;
  return { year: d.getFullYear(), quarter, label: `Q${quarter} ${d.getFullYear()}` };
};
