'use client';

import { useState } from 'react';
import type { VerdictRow } from '@/app/actions/runs';
import { buildGrid, meanScorePerPhase, type GridRow } from '@/lib/eval/playground/grid';
import VerdictDetail from '@/components/playground/VerdictDetail';

// ---------------------------------------------------------------------------
// VerdictGrid — participant × phase verdict table with a per-phase improvement
// strip (Task B3-3).
//
// Rows = participants (from buildGrid, verdict-driven). Columns = the 5 phase
// ordinals (0 = requirement, 1–4 = after each scenario). Each cell aggregates
// the (up to 4) scenario verdicts at that (pid, phase): it shows the per-phase
// mean score (metric-agnostic v1 = mean of non-null scenario scores, grid.ts)
// and a pass roll-up (all-pass ✓ / any-fail ✗ / all-null —), colored by score.
// A phaseDeltas strip under the header shows the improvement signal (▲/▼/—),
// where — is an HONEST null (unmeasured), distinct from a 0 delta.
//
// Clicking a cell drills into that phase's scenario verdicts and opens
// VerdictDetail for a chosen scenario cell. The `annotate` render-prop is the
// seam B3-4 uses to mount its annotate box inside VerdictDetail without editing
// this file.
// ---------------------------------------------------------------------------

const PHASE_LABELS = ['Req', 'S1', 'S2', 'S3', 'S4'];

/** Pass roll-up for a phase's scenario cells: ✓ if all gradable cells pass,
 *  ✗ if any gradable cell fails, — if none are gradable. */
function passRollup(cells: { pass: boolean | null }[]): '✓' | '✗' | '—' {
  const gradable = cells.filter((c) => c.pass !== null);
  if (gradable.length === 0) return '—';
  return gradable.every((c) => c.pass === true) ? '✓' : '✗';
}

/** Tailwind cell tint by mean score (null = unmeasured, neutral). */
function scoreTint(mean: number | null): string {
  if (mean === null) return 'bg-foreground/5 text-foreground/40';
  if (mean >= 0.8) return 'bg-emerald-600/15 text-emerald-800';
  if (mean >= 0.5) return 'bg-amber-500/15 text-amber-800';
  return 'bg-red-500/15 text-red-800';
}

function DeltaBadge({ delta }: { delta: number | null }) {
  if (delta === null) return <span className="text-foreground/30" title="unmeasured (ungradable phase)">—</span>;
  if (delta > 0) return <span className="text-emerald-700" title={`+${delta.toFixed(2)}`}>▲ {delta.toFixed(2)}</span>;
  if (delta < 0) return <span className="text-red-700" title={delta.toFixed(2)}>▼ {delta.toFixed(2)}</span>;
  return <span className="text-foreground/50" title="no change">▬ 0.00</span>;
}

export default function VerdictGrid({ verdicts, participants }: {
  verdicts: VerdictRow[];
  participants: { pid: string; cohort: string | null }[];
}) {
  const rows: GridRow[] = buildGrid(verdicts, participants);
  const [selected, setSelected] = useState<{ pid: string; phaseOrdinal: number } | null>(null);
  const [activeVerdictId, setActiveVerdictId] = useState<string | null>(null);

  if (rows.length === 0) {
    return <p className="text-sm text-foreground/60">No verdicts for this run.</p>;
  }

  const selectedRow = selected ? rows.find((r) => r.pid === selected.pid) ?? null : null;
  const selectedCells =
    selectedRow && selected
      ? selectedRow.cells
          .filter((c) => c.phaseOrdinal === selected.phaseOrdinal)
          .sort((a, b) => (a.scenarioIdx ?? -1) - (b.scenarioIdx ?? -1))
      : [];
  const activeVerdict = activeVerdictId ? verdicts.find((v) => v.id === activeVerdictId) ?? null : null;

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-foreground/15 text-left">
              <th className="px-2 py-1.5 text-xs font-semibold uppercase tracking-wider text-foreground/50">
                Participant
              </th>
              {PHASE_LABELS.map((label, ord) => (
                <th
                  key={ord}
                  className="px-2 py-1.5 text-center text-xs font-semibold uppercase tracking-wider text-foreground/50"
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const means = meanScorePerPhase(row.cells);
              return (
                <tr key={row.pid} className="border-b border-foreground/10">
                  <td className="px-2 py-1.5">
                    <span className="font-mono">{row.pid}</span>{' '}
                    <span className="text-xs text-foreground/40">{row.cohort ?? '—'}</span>
                  </td>
                  {means.map((mean, ord) => {
                    const cells = row.cells.filter((c) => c.phaseOrdinal === ord);
                    const isSel = selected?.pid === row.pid && selected?.phaseOrdinal === ord;
                    return (
                      <td key={ord} className="px-1 py-1 text-center">
                        <button
                          type="button"
                          disabled={cells.length === 0}
                          onClick={() => {
                            setSelected({ pid: row.pid, phaseOrdinal: ord });
                            setActiveVerdictId(null);
                          }}
                          aria-pressed={isSel}
                          className={`w-full rounded px-2 py-1 font-mono text-xs transition disabled:opacity-30 ${scoreTint(
                            mean,
                          )} ${isSel ? 'ring-2 ring-foreground/40' : 'hover:brightness-95'}`}
                        >
                          <span className="block">{passRollup(cells)}</span>
                          <span className="block text-[10px] opacity-80">
                            {mean === null ? '—' : mean.toFixed(2)}
                          </span>
                        </button>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            {/* Per-phase improvement delta strip for the FIRST selected row, or
                the first row if none is selected — the improvement signal is
                per-participant, so it tracks the row under inspection. */}
            <tr className="border-t border-foreground/15">
              <td className="px-2 py-1.5 text-xs font-semibold uppercase tracking-wider text-foreground/50">
                Δ {selectedRow ? selectedRow.pid : rows[0].pid}
              </td>
              {(selectedRow ?? rows[0]).phaseDeltas.map((delta, ord) => (
                <td key={ord} className="px-1 py-1.5 text-center font-mono text-xs">
                  <DeltaBadge delta={delta} />
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>

      {selected && selectedCells.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-foreground/50">
            {selected.pid} · phase {selected.phaseOrdinal} · scenarios
          </p>
          <div className="flex flex-wrap gap-1">
            {selectedCells.map((c) => (
              <button
                key={c.verdictId}
                type="button"
                onClick={() => setActiveVerdictId(c.verdictId)}
                aria-pressed={activeVerdictId === c.verdictId}
                className={`rounded border px-2 py-1 font-mono text-xs transition ${
                  activeVerdictId === c.verdictId
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-foreground/15 hover:bg-foreground/5'
                }`}
              >
                sc {c.scenarioIdx ?? '—'} ·{' '}
                {c.pass === null ? '—' : c.pass ? '✓' : '✗'}
                {c.score !== null ? ` ${c.score.toFixed(2)}` : ''}
              </button>
            ))}
          </div>
        </div>
      )}

      {activeVerdict && <VerdictDetail verdict={activeVerdict} />}
    </div>
  );
}
