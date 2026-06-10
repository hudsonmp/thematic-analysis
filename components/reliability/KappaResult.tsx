'use client';

import { useState } from 'react';
import { landisKochBand, MIS_CARVED_THRESHOLD } from '@/lib/reliability/stats';
import type { Tables } from '@/lib/types/cb-db';

type ReliabilityRun = Tables<'cb_reliability_runs'>;

/** Format a 0–1 statistic as a fixed-precision string, or an em-dash when null. */
function num(value: number | null | undefined, digits = 2): string {
  if (value == null || Number.isNaN(value)) return '—';
  return value.toFixed(digits);
}

/** Human label for the scope column (the id → name resolution is the caller's
 *  job; here we only describe the scope KIND so the card is self-contained). */
function scopeLabel(run: ReliabilityRun, scopeName: string | null): string {
  if (run.scope === 'overall') return 'overall';
  if (run.scope === 'facet_value') return `facet-value${scopeName ? `: ${scopeName}` : ''}`;
  if (run.scope === 'code') return `code${scopeName ? `: ${scopeName}` : ''}`;
  return run.scope;
}

/**
 * Render one computed/stored reliability run.
 *
 * Degenerate guard (HARD REQUIREMENT, carry-forward): a single-category input
 * makes Pe collapse to 1, so the kappa convention returns 1 — which would read
 * as "almost perfect" agreement. That is a lie: there was no disagreement that
 * COULD have been observed, so κ is undefined, not perfect. We read the
 * `degenerate` COLUMN (never the note string) and, when set, replace the band
 * with a "single-category input — κ undefined" badge AND de-emphasize the
 * numeric κ (struck through, muted) so it cannot be mistaken for a real result.
 *
 * Mis-carved advisory (κ < 0.5, non-degenerate): an amber, non-blocking note
 * with the §2.9 guidance; dismissable with a written rationale. If
 * `dismissed_note` is already set, we show it as dismissed instead of the live
 * advisory. Prevalence/bias sit next to κ so the kappa-paradox (high P_o, low κ)
 * reads as expected diagnostics, not a failure.
 */
export default function KappaResult({
  run,
  scopeName,
  isPending,
  onDismiss,
}: {
  run: ReliabilityRun;
  scopeName: string | null;
  isPending: boolean;
  onDismiss: (rationale: string) => void;
}) {
  const kappa = run.cohen_kappa;
  const degenerate = run.degenerate === true;
  const band = kappa == null ? null : landisKochBand(kappa);

  // Advisory fires on a genuine low-κ run only. A degenerate run's κ is not a
  // trustworthy number, so a "mis-carved? split/merge" prompt off it would be
  // noise — suppress it there.
  const showMisCarved =
    !degenerate && kappa != null && kappa < MIS_CARVED_THRESHOLD && !run.dismissed_note;
  const dismissed = !degenerate && run.dismissed_note != null && run.dismissed_note !== '';

  return (
    <div className="border border-foreground/15 p-3 space-y-3 text-sm">
      {/* Header: scope + version tag + timestamp */}
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs uppercase tracking-wider text-foreground/50">
          {scopeLabel(run, scopeName)}
        </span>
        <span className="text-xs text-foreground/40">
          {run.computed_at ? new Date(run.computed_at).toLocaleString() : ''}
        </span>
      </div>

      {/* κ + its band — or the degenerate badge */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-baseline gap-2">
          <span className="text-foreground/60">Cohen&apos;s κ</span>
          <span
            className={
              degenerate
                ? 'font-mono text-base text-foreground/30 line-through'
                : 'font-mono text-base'
            }
            title={degenerate ? 'κ is undefined for single-category input' : undefined}
          >
            {num(kappa)}
          </span>
        </div>

        {degenerate ? (
          <span className="inline-flex items-center gap-1.5 border border-amber-500 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
            Degenerate: single-category input — κ undefined
          </span>
        ) : (
          band && (
            <span className="text-xs text-foreground/60">
              {band} <span className="text-foreground/40">(conventional)</span>
            </span>
          )
        )}
      </div>

      {/* The full stat row. Prevalence/bias sit beside κ so a high-P_o / low-κ
          paradox reads as an expected diagnostic, not a failure. */}
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
        <Stat label="Percent agreement" value={num(run.percent_agreement)} />
        <Stat
          label="PABAK"
          value={run.pabak == null ? 'n/a — non-binary' : num(run.pabak)}
        />
        <Stat label="Krippendorff's α" value={num(run.krippendorff_alpha)} />
        <Stat
          label="Prevalence index"
          value={run.prevalence_index == null ? 'n/a — non-binary' : num(run.prevalence_index)}
        />
        <Stat
          label="Bias index"
          value={run.bias_index == null ? 'n/a — non-binary' : num(run.bias_index)}
        />
        <Stat label="Units" value={run.n_units != null ? String(run.n_units) : '—'} />
      </dl>

      {run.note && (
        <p className="text-xs text-foreground/40 italic">{run.note}</p>
      )}

      {/* Advisory mis-carved flag (amber, non-blocking) + dismiss-with-rationale */}
      {showMisCarved && (
        <MisCarvedAdvisory isPending={isPending} onDismiss={onDismiss} />
      )}
      {dismissed && (
        <p className="border-l-2 border-foreground/20 pl-2 text-xs text-foreground/50">
          Mis-carved flag dismissed: <span className="italic">{run.dismissed_note}</span>
        </p>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-foreground/50">{label}</dt>
      <dd className="font-mono">{value}</dd>
    </div>
  );
}

/**
 * The advisory itself, with an inline rationale field. Kept local so its draft
 * state doesn't leak into the parent list and the form resets when the run
 * re-renders after a successful dismiss.
 */
function MisCarvedAdvisory({
  isPending,
  onDismiss,
}: {
  isPending: boolean;
  onDismiss: (rationale: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [rationale, setRationale] = useState('');

  return (
    <div className="border border-amber-500/60 bg-amber-500/10 p-2 space-y-2">
      <p className="text-xs text-amber-700 dark:text-amber-400">
        mis-carved? split / merge / sharpen near-miss (§2.9)
      </p>
      {open ? (
        <div className="space-y-2">
          <textarea
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            disabled={isPending}
            rows={2}
            placeholder="Why is this κ acceptable? (e.g. sparse-cell depression, not a coding failure)"
            className="w-full border border-foreground/15 px-2 py-1 text-xs bg-background resize-y disabled:opacity-50"
            aria-label="Dismiss rationale"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={isPending || rationale.trim() === ''}
              onClick={() => onDismiss(rationale.trim())}
              className="border border-foreground px-2 py-0.5 text-xs hover:bg-foreground hover:text-background transition disabled:opacity-50"
            >
              Dismiss flag
            </button>
            <button
              type="button"
              disabled={isPending}
              onClick={() => {
                setOpen(false);
                setRationale('');
              }}
              className="border border-foreground/30 px-2 py-0.5 text-xs hover:bg-foreground/10 transition disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          disabled={isPending}
          onClick={() => setOpen(true)}
          className="border border-foreground/30 px-2 py-0.5 text-xs hover:bg-foreground/10 transition disabled:opacity-50"
        >
          Dismiss with rationale
        </button>
      )}
    </div>
  );
}
