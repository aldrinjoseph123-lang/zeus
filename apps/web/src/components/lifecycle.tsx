import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Check, Ban } from 'lucide-react';
import { Badge, Button, cx } from './ui';
import type { Hint, Track } from '../lib/lifecycle';

// The track maths lives in ../lib/lifecycle so it stays testable without a DOM;
// pages import both halves from here.
export * from '../lib/lifecycle';

// ── rendering ─────────────────────────────────────────────────────────────────

const TONE_BG: Record<NonNullable<Hint['tone']>, string> = {
  neutral: 'bg-sunken text-n700',
  accent: 'bg-accent-soft text-[var(--red-700)]',
  watch: 'bg-[#fdf3e7] text-[#8a4d10]',
  secure: 'bg-[#e8f5ed] text-[#14653a]',
};

/** "Next step" strip — the one line that tells the rep what to do now. */
export function NextStep({ hint }: { hint: Hint }) {
  return (
    <div className={cx('flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-line px-4 py-2.5', TONE_BG[hint.tone ?? 'neutral'])}>
      <ArrowRight size={13} className="shrink-0" />
      <span className="eyebrow">Next</span>
      <span className="min-w-0 text-[13px]">{hint.text}</span>
      {hint.cta ? (
        <span className="ml-auto">
          {hint.cta.to ? (
            <Link to={hint.cta.to}><Button size="sm" variant="outline">{hint.cta.label}</Button></Link>
          ) : (
            <Button size="sm" variant="outline" loading={hint.cta.loading} onClick={hint.cta.onClick}>{hint.cta.label}</Button>
          )}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The rail itself. Pass `onStep` to make the segments clickable — that is how
 * a rep moves a lead along without hunting for a dropdown.
 */
export function LifecycleRail({
  title = 'Lifecycle', track, hint, onStep, disabled, meta,
}: {
  title?: string;
  track: Track;
  hint?: Hint | null;
  onStep?: (key: string) => void;
  disabled?: boolean;
  meta?: ReactNode;
}) {
  const { steps, current, stopped, note } = track;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3">
        <span className="eyebrow">{title}</span>
        <span className="flex items-center gap-2">
          {meta}
          {note ? <Badge tone={note === 'Won' ? 'secure' : 'watch'}>{note}</Badge> : null}
          {stopped ? (
            <Badge tone="accent"><span className="inline-flex items-center gap-1"><Ban size={10} />{stopped}</span></Badge>
          ) : (
            <span className="text-[11px] text-muted">Step {current + 1} of {steps.length}</span>
          )}
        </span>
      </div>

      <div className="flex flex-wrap gap-1 px-4 pb-3 pt-2">
        {steps.map((step, index) => {
          const state = stopped
            ? index <= current ? 'done' : 'todo'
            : index < current ? 'done' : index === current ? 'now' : 'todo';
          const clickable = Boolean(onStep) && !disabled && state !== 'now';
          return (
            <button
              key={step.key}
              type="button"
              disabled={!clickable}
              onClick={clickable ? () => onStep?.(step.key) : undefined}
              className={cx('min-w-[92px] flex-1 text-left disabled:cursor-default', clickable && 'group cursor-pointer')}
            >
              <span
                className={cx(
                  'block h-[5px] w-full transition-colors',
                  state === 'done' ? 'bg-n950' : state === 'now' ? 'bg-accent' : 'bg-n200',
                  clickable && 'group-hover:bg-n600',
                )}
                style={state === 'now' && step.color ? { background: step.color } : undefined}
              />
              <span className="mt-1.5 flex items-center gap-1">
                {state === 'done' ? <Check size={11} className="shrink-0 text-n600" /> : null}
                {state === 'now' ? <span className="h-1.5 w-1.5 shrink-0 bg-accent" /> : null}
                <span
                  className={cx(
                    'truncate text-[11px] font-bold uppercase tracking-[0.06em]',
                    state === 'now' ? 'text-ink' : state === 'done' ? 'text-n600' : 'text-n400',
                  )}
                >
                  {step.label}
                </span>
              </span>
              {step.sub ? <span className="mt-0.5 block truncate text-[10px] text-n400">{step.sub}</span> : null}
            </button>
          );
        })}
      </div>

      {hint ? <NextStep hint={hint} /> : null}
    </div>
  );
}

/** Four-bar version for list rows — same track, no labels. */
export function LifecycleMini({ track }: { track: Track }) {
  const { steps, current, stopped, note } = track;
  const caption = stopped
    ? stopped
    : `${steps[current]?.label ?? ''} — step ${current + 1} of ${steps.length}${note ? ` · ${note}` : ''}`;
  return (
    <span className="flex items-center gap-[3px]" title={caption} aria-label={caption}>
      {steps.map((step, index) => (
        <span
          key={step.key}
          className={cx(
            'h-[4px] w-[12px]',
            stopped
              ? index <= current ? 'bg-n300' : 'bg-n100'
              : index < current ? 'bg-n950' : index === current ? (note ? 'bg-[var(--status-watch)]' : 'bg-accent') : 'bg-n200',
          )}
        />
      ))}
    </span>
  );
}
