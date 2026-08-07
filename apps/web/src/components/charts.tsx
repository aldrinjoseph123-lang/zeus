import {
  Area, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Legend, Line,
  Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { moneyShort, money, number as fmtNumber } from '../lib/format';
import { EmptyState } from './ui';

/**
 * Chart wrappers. All colour, type and axis decisions live here so every chart in
 * Zeus reads as one system: black ink, red accent, sparse gridlines, no 3D.
 */

const INK = '#0a0a0a';
const ACCENT = '#e11d2e';
const MUTED = '#6b6b6b';
const LINE = '#d8d8d4';

/** Categorical ramp: accent first, then neutrals, so the eye lands on what matters. */
export const SERIES_COLORS = ['#e11d2e', '#0a0a0a', '#6b6b6b', '#d97a1f', '#1f8a4c', '#2563a8', '#b8b8b4', '#9e0e19'];

const axis = { stroke: LINE, tick: { fill: MUTED, fontSize: 10 }, tickLine: false, axisLine: { stroke: LINE } };

// Recharts' enter animation double-fires under React StrictMode and can leave bars
// with no geometry. These are dashboard figures, not a title sequence — draw them once.
const noAnim = { isAnimationActive: false } as const;

function ChartTooltip({ active, payload, label, valueFormat = 'money' }: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string;
  valueFormat?: 'money' | 'number' | 'percent';
}) {
  if (!active || !payload?.length) return null;
  const format = (v: number) => (valueFormat === 'money' ? money(v) : valueFormat === 'percent' ? `${v.toFixed(1)}%` : fmtNumber(v));
  return (
    <div className="border border-line bg-white px-2.5 py-2 shadow-[var(--shadow-md)]">
      {label ? <div className="eyebrow mb-1">{label}</div> : null}
      {payload.map((entry) => (
        <div key={entry.name} className="flex items-center gap-2 text-[12px]">
          <span className="inline-block h-2 w-2" style={{ background: entry.color }} />
          <span className="text-muted">{entry.name}</span>
          <span className="tabular ml-auto font-semibold">{format(entry.value)}</span>
        </div>
      ))}
    </div>
  );
}

const legendStyle = { fontSize: 11, color: MUTED, textTransform: 'uppercase' as const, letterSpacing: '0.06em' };

function Frame({ height = 260, children }: { height?: number; children: React.ReactElement }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      {children}
    </ResponsiveContainer>
  );
}

// ── pipeline funnel ───────────────────────────────────────────────────────────

export function FunnelChart({ data, onStageClick }: {
  data: Array<{ name: string; count: number; value: number; color: string; probability: number }>;
  onStageClick?: (name: string) => void;
}) {
  if (!data.length) return <EmptyState title="No open deals" message="Create a deal to see the funnel take shape." />;
  const max = Math.max(...data.map((d) => d.value), 1);

  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      {data.map((stage) => (
        <button
          key={stage.name}
          onClick={onStageClick ? () => onStageClick(stage.name) : undefined}
          className="group w-full text-left"
          disabled={!onStageClick}
        >
          <div className="mb-1 flex items-baseline justify-between gap-3">
            <span className="flex items-center gap-1.5 text-[12px] font-semibold">
              <span className="inline-block h-2.5 w-2.5" style={{ background: stage.color }} />
              {stage.name}
              <span className="text-[10px] font-normal text-n400">{stage.probability}%</span>
            </span>
            <span className="tabular text-[12px] text-muted">
              {stage.count} · <span className="font-semibold text-ink">{moneyShort(stage.value)}</span>
            </span>
          </div>
          <div className="h-6 w-full bg-n100">
            <div
              className="flex h-full items-center justify-end px-1.5 transition-[width]"
              style={{ width: `${Math.max(2, (stage.value / max) * 100)}%`, background: stage.color, transitionDuration: 'var(--dur-slow)' }}
            />
          </div>
        </button>
      ))}
    </div>
  );
}

// ── revenue & forecast by month ───────────────────────────────────────────────

export function ForecastChart({ data }: {
  data: Array<{ month: string; won: number; lost: number; openWeighted: number; openNet: number }>;
}) {
  if (!data.length) return <EmptyState title="No dated deals yet" message="Deals appear here once they have an expected close date." />;
  return (
    <Frame height={280}>
      <ComposedChart data={data} margin={{ top: 12, right: 8, bottom: 4, left: 4 }}>
        <CartesianGrid stroke={LINE} strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey="month" {...axis} />
        <YAxis {...axis} tickFormatter={(v) => moneyShort(v).replace('AED ', '')} width={54} />
        <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(10,10,10,0.04)' }} />
        <Legend wrapperStyle={legendStyle} iconType="square" iconSize={9} />
        <Bar dataKey="won" name="Won" fill={INK} barSize={18} {...noAnim} />
        <Bar dataKey="openNet" name="Open pipeline" fill="#b8b8b4" barSize={18} {...noAnim} />
        <Line type="monotone" dataKey="openWeighted" name="Weighted forecast" stroke={ACCENT} strokeWidth={2} dot={{ r: 3, fill: ACCENT }} {...noAnim} />
      </ComposedChart>
    </Frame>
  );
}

/**
 * The open pipeline day by day, from the nightly snapshot.
 *
 * The empty state is the interesting one: history cannot be backfilled, so a new install
 * has nothing to show and that is expected rather than broken. Say when it will fill in.
 */
export function PipelineHistoryChart({ data }: {
  data: Array<{ date: string; openNet: number; weighted: number }>;
}) {
  if (data.length < 2) {
    return (
      <EmptyState
        title={data.length ? 'One day recorded so far' : 'History starts tonight'}
        message="The pipeline is photographed every evening. A trend needs two days, so this fills in from tomorrow."
      />
    );
  }
  return (
    <Frame height={220}>
      <ComposedChart data={data} margin={{ top: 12, right: 8, bottom: 4, left: 4 }}>
        <CartesianGrid stroke={LINE} strokeDasharray="2 4" vertical={false} />
        <XAxis
          dataKey="date"
          {...axis}
          tickFormatter={(v: string) => new Date(v).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
        />
        <YAxis {...axis} tickFormatter={(v) => moneyShort(v).replace('AED ', '')} width={54} />
        <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(10,10,10,0.04)' }} />
        <Legend wrapperStyle={legendStyle} iconType="square" iconSize={9} />
        <Area type="monotone" dataKey="openNet" name="Open pipeline" stroke={INK} fill={INK} fillOpacity={0.08} strokeWidth={2} {...noAnim} />
        <Line type="monotone" dataKey="weighted" name="Weighted" stroke={ACCENT} strokeWidth={2} dot={false} {...noAnim} />
      </ComposedChart>
    </Frame>
  );
}

// ── generic horizontal bars (sources, partners, reps) ─────────────────────────

export function RankedBars({ data, valueKey = 'value', nameKey = 'name', height = 260, color = INK }: {
  data: Array<Record<string, unknown>>;
  valueKey?: string;
  nameKey?: string;
  height?: number;
  color?: string;
}) {
  if (!data.length) return <EmptyState title="Nothing to rank yet" />;
  return (
    <Frame height={height}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 4 }}>
        <CartesianGrid stroke={LINE} strokeDasharray="2 4" horizontal={false} />
        <XAxis type="number" {...axis} tickFormatter={(v) => moneyShort(v).replace('AED ', '')} />
        <YAxis type="category" dataKey={nameKey} {...axis} width={128} />
        <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(10,10,10,0.04)' }} />
        <Bar dataKey={valueKey} name="Value" fill={color} barSize={14} {...noAnim}>
          {data.map((_, index) => (
            <Cell key={index} fill={index === 0 ? ACCENT : color} />
          ))}
        </Bar>
      </BarChart>
    </Frame>
  );
}

// ── split donut (direct vs partner, product vs service) ───────────────────────

export function SplitDonut({ data, height = 220, valueFormat = 'money' }: {
  data: Array<{ name: string; value: number }>;
  height?: number;
  valueFormat?: 'money' | 'number';
}) {
  const total = data.reduce((sum, d) => sum + d.value, 0);
  if (total === 0) return <EmptyState title="No data in this split yet" />;

  return (
    <div className="flex items-center gap-4">
      <div className="shrink-0" style={{ width: height, height }}>
        <Frame height={height}>
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" innerRadius="58%" outerRadius="88%" paddingAngle={2} stroke="none" {...noAnim}>
              {data.map((_, index) => (
                <Cell key={index} fill={SERIES_COLORS[index % SERIES_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip content={<ChartTooltip valueFormat={valueFormat} />} />
          </PieChart>
        </Frame>
      </div>
      <ul className="min-w-0 flex-1 space-y-2">
        {data.map((slice, index) => (
          <li key={slice.name} className="min-w-0">
            <div className="flex items-baseline justify-between gap-2">
              <span className="flex min-w-0 items-center gap-1.5 text-[12px]">
                <span className="inline-block h-2.5 w-2.5 shrink-0" style={{ background: SERIES_COLORS[index % SERIES_COLORS.length] }} />
                <span className="truncate">{slice.name}</span>
              </span>
              <span className="tabular shrink-0 text-[12px] font-semibold">
                {valueFormat === 'money' ? moneyShort(slice.value) : fmtNumber(slice.value)}
              </span>
            </div>
            <div className="mt-1 h-1 w-full bg-n100">
              <div className="h-full" style={{ width: `${(slice.value / total) * 100}%`, background: SERIES_COLORS[index % SERIES_COLORS.length] }} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── deal ageing ───────────────────────────────────────────────────────────────

export function AgeingChart({ data }: { data: Array<{ label: string; count: number; value: number }> }) {
  if (!data.some((d) => d.count > 0)) return <EmptyState title="No open deals to age" />;
  return (
    <Frame height={200}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: 4 }}>
        <CartesianGrid stroke={LINE} strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey="label" {...axis} />
        <YAxis {...axis} tickFormatter={(v) => moneyShort(v).replace('AED ', '')} width={54} />
        <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(10,10,10,0.04)' }} />
        <Bar dataKey="value" name="Open value" barSize={34} {...noAnim}>
          {data.map((bucket, index) => (
            <Cell key={bucket.label} fill={index >= 3 ? ACCENT : index === 2 ? '#d97a1f' : INK} />
          ))}
        </Bar>
      </BarChart>
    </Frame>
  );
}
