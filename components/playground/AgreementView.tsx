'use client';

import { Fragment, useEffect, useState, useTransition } from 'react';
import { compareRuns, listRuns, listVerdicts } from '@/app/actions/runs';
import type { AgreementReport, RunSummary, VerdictRow } from '@/app/actions/runs';
import { sortDisagreements, type DiscordantCell } from '@/lib/eval/playground/disagreement';
import VerdictDetail from '@/components/playground/VerdictDetail';

// ---------------------------------------------------------------------------
// AgreementView — Cohen's κ + the disagreement browser (Task B3-5).
//
// The empirical fork-resolver (B spec §3): pick two runs, Compare, and read the
// cells where the two graders SPLIT — the cases Hudson inspects before deciding
// which grader to trust. This surface PRESENTS disagreements; it never
// adjudicates which grader is right (passA/passB are shown side-by-side, no
// verdict is marked "correct").
//
// DIVISION OF LABOR: compareRuns (app/actions/runs.ts) OWNS the κ arithmetic and
// the pairing on (pid, phaseOrdinal, scenarioIdx); it returns κ + raw agreement %
// + n + the discordant cells. This component does NO κ recompute client-side —
// it only formats/sorts (sortDisagreements) and renders. Recomputing κ here would
// risk drifting from the executor's pairwise-complete convention.
//
// HONEST κ (the load-bearing render, mirroring the grid's null-vs-0 discipline):
// κ === null means "agreement could not be computed" (n === 0 — no cell was
// gradable by BOTH runs). That is categorically different from κ === 0 ("computed;
// agreement is no better than chance"). Rendering null as "0" would misread a
// non-measurement as a real zero, so null renders as a distinct "n/a" label with
// its reason, never "0.00".
// ---------------------------------------------------------------------------

const PHASE_LABELS = ['Req', 'S1', 'S2', 'S3', 'S4'];

function phaseLabel(ordinal: number): string {
  return PHASE_LABELS[ordinal] ?? `P${ordinal}`;
}

/** Pass label for one side of a discordant cell. — for the abstaining grader. */
function passLabel(pass: boolean | null): string {
  return pass === null ? '—' : pass ? '✓ pass' : '✗ fail';
}

function passClass(pass: boolean | null): string {
  if (pass === null) return 'text-foreground/40';
  return pass ? 'text-emerald-700' : 'text-red-700';
}

/** A run picker <select>. */
function RunPicker({
  label,
  value,
  runs,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  runs: RunSummary[];
  disabled: boolean;
  onChange: (id: string) => void;
}) {
  return (
    <label className="space-y-1 text-sm">
      <span className="text-xs font-semibold uppercase tracking-wider text-foreground/50">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        aria-label={label}
        className="w-72 border border-foreground/15 bg-background px-2 py-1.5 outline-none focus:border-foreground/40 disabled:opacity-50"
      >
        <option value="">Select a run…</option>
        {runs.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name} · {r.graderId} · {r.status} · {r.verdictCount} verdicts
          </option>
        ))}
      </select>
    </label>
  );
}

export default function AgreementView() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [runA, setRunA] = useState('');
  const [runB, setRunB] = useState('');
  const [report, setReport] = useState<AgreementReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Verdict lookups for jump-to-detail: each side's verdicts, keyed by cell.
  const [verdictsA, setVerdictsA] = useState<VerdictRow[] | null>(null);
  const [verdictsB, setVerdictsB] = useState<VerdictRow[] | null>(null);
  const [openCell, setOpenCell] = useState<string | null>(null);
  const [isComparing, startCompare] = useTransition();
  const [, startRefresh] = useTransition();

  // Load the run list on mount (documented mount pattern: setState INSIDE a
  // transition callback, never synchronously in the effect body — so it never
  // trips the set-state-in-effect lint). Empty deps: load once.
  useEffect(() => {
    startRefresh(async () => {
      try {
        setRuns(await listRuns());
      } catch {
        // Non-fatal — the pickers just stay empty.
      }
    });
  }, []);

  function compare() {
    if (!runA || !runB) return;
    setError(null);
    setReport(null);
    setOpenCell(null);
    startCompare(async () => {
      try {
        // compareRuns owns the κ; we also pull both runs' verdicts so a
        // disagreement row can jump into each side's VerdictDetail.
        const [rep, va, vb] = await Promise.all([
          compareRuns(runA, runB),
          listVerdicts(runA),
          listVerdicts(runB),
        ]);
        setReport(rep);
        setVerdictsA(va);
        setVerdictsB(vb);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Compare failed.');
      }
    });
  }

  const sameRun = runA !== '' && runA === runB;
  const canCompare = runA !== '' && runB !== '' && !sameRun && !isComparing;

  const cells: DiscordantCell[] = report ? sortDisagreements(report) : [];
  const hardCount = cells.filter((c) => c.kind === 'hard').length;

  /** Find one side's verdict for a discordant cell (join by pid/phase/scenario). */
  function findVerdict(
    side: VerdictRow[] | null,
    cell: DiscordantCell,
  ): VerdictRow | null {
    if (!side) return null;
    return (
      side.find(
        (v) =>
          v.pid === cell.pid &&
          v.phaseOrdinal === cell.phaseOrdinal &&
          v.scenarioIdx === cell.scenarioIdx,
      ) ?? null
    );
  }

  function cellKey(cell: DiscordantCell): string {
    return `${cell.pid}|${cell.phaseOrdinal}|${cell.scenarioIdx ?? 'x'}`;
  }

  return (
    <div className="space-y-4 border border-foreground/15 px-6 py-6">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-foreground/60">
          Agreement — κ + disagreement browser
        </h2>
        <p className="mt-1 text-xs text-foreground/50">
          Compare two runs to measure inter-grader agreement (Cohen&apos;s κ) and read the cells where they
          split. This presents the fork; it does not adjudicate which grader is right.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <RunPicker label="Run A" value={runA} runs={runs} disabled={isComparing} onChange={setRunA} />
        <RunPicker label="Run B" value={runB} runs={runs} disabled={isComparing} onChange={setRunB} />
        <button
          type="button"
          onClick={compare}
          disabled={!canCompare}
          title={sameRun ? 'Pick two DIFFERENT runs to compare.' : undefined}
          className="border border-foreground bg-foreground px-4 py-1.5 text-sm text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isComparing ? 'Comparing…' : 'Compare'}
        </button>
        {sameRun && <p className="text-xs text-foreground/50">Pick two different runs.</p>}
      </div>

      {error && (
        <p className="border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700">{error}</p>
      )}

      {report && !isComparing && (
        <div className="space-y-4">
          {/* Headline stats. κ null renders DISTINCTLY from κ 0 (honest signal). */}
          <div className="flex flex-wrap gap-6 border border-foreground/15 px-4 py-3 text-sm">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-foreground/50">Cohen&apos;s κ</p>
              {report.kappa === null ? (
                <p className="font-mono text-foreground/50" title="n = 0 — no cell was gradable by both runs">
                  n/a
                  <span className="ml-1 text-xs text-foreground/40">(insufficient/constant — not 0)</span>
                </p>
              ) : (
                <p className="font-mono text-foreground/90">{report.kappa.toFixed(3)}</p>
              )}
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-foreground/50">
                Raw agreement
              </p>
              {report.agreement === null ? (
                <p className="font-mono text-foreground/50">n/a</p>
              ) : (
                <p className="font-mono text-foreground/90">{(report.agreement * 100).toFixed(1)}%</p>
              )}
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-foreground/50">
                n (both-gradable cells)
              </p>
              <p className="font-mono text-foreground/90">{report.n}</p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-foreground/50">
                Disagreements
              </p>
              <p className="font-mono text-foreground/90">
                {cells.length}
                <span className="ml-1 text-xs text-foreground/50">
                  ({hardCount} hard · {cells.length - hardCount} soft)
                </span>
              </p>
            </div>
          </div>

          {/* Disagreement browser: sharpest fork (hard: true-vs-false) first. */}
          {cells.length === 0 ? (
            <p className="text-sm text-foreground/60">
              No discordant cells — the two runs agreed on every jointly-graded cell.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-foreground/15 text-left">
                    {['', 'Participant', 'Phase', 'Scenario', 'Run A', 'Run B', ''].map((h, i) => (
                      <th
                        key={i}
                        className="px-2 py-1.5 text-xs font-semibold uppercase tracking-wider text-foreground/50"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {cells.map((cell) => {
                    const key = cellKey(cell);
                    const isOpen = openCell === key;
                    const va = findVerdict(verdictsA, cell);
                    const vb = findVerdict(verdictsB, cell);
                    return (
                      <Fragment key={key}>
                        <tr className="border-b border-foreground/10">
                          <td className="px-2 py-1.5">
                            <span
                              className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                                cell.kind === 'hard'
                                  ? 'bg-red-500/15 text-red-800'
                                  : 'bg-amber-500/15 text-amber-800'
                              }`}
                              title={
                                cell.kind === 'hard'
                                  ? 'true vs false — both graders produced a boolean and disagree'
                                  : 'boolean vs null — one grader abstained (dropped from κ)'
                              }
                            >
                              {cell.kind}
                            </span>
                          </td>
                          <td className="px-2 py-1.5 font-mono">{cell.pid}</td>
                          <td className="px-2 py-1.5 font-mono text-foreground/70">
                            {phaseLabel(cell.phaseOrdinal)}
                          </td>
                          <td className="px-2 py-1.5 font-mono text-foreground/70">
                            {cell.scenarioIdx ?? '—'}
                          </td>
                          <td className={`px-2 py-1.5 font-mono ${passClass(cell.passA)}`}>
                            {passLabel(cell.passA)}
                          </td>
                          <td className={`px-2 py-1.5 font-mono ${passClass(cell.passB)}`}>
                            {passLabel(cell.passB)}
                          </td>
                          <td className="px-2 py-1.5 text-right">
                            <button
                              type="button"
                              onClick={() => setOpenCell(isOpen ? null : key)}
                              aria-pressed={isOpen}
                              className="border border-foreground/15 px-2 py-0.5 text-xs transition hover:bg-foreground/5"
                            >
                              {isOpen ? 'Hide' : 'Inspect'}
                            </button>
                          </td>
                        </tr>
                        {isOpen && (
                          <tr>
                            <td colSpan={7} className="px-2 py-3">
                              <div className="grid gap-3 md:grid-cols-2">
                                <div className="space-y-1">
                                  <p className="text-xs font-semibold uppercase tracking-wider text-foreground/50">
                                    Run A verdict
                                  </p>
                                  {va ? (
                                    <VerdictDetail verdict={va} annotate={<></>} />
                                  ) : (
                                    <p className="text-xs text-foreground/40">verdict not found.</p>
                                  )}
                                </div>
                                <div className="space-y-1">
                                  <p className="text-xs font-semibold uppercase tracking-wider text-foreground/50">
                                    Run B verdict
                                  </p>
                                  {vb ? (
                                    <VerdictDetail verdict={vb} annotate={<></>} />
                                  ) : (
                                    <p className="text-xs text-foreground/40">verdict not found.</p>
                                  )}
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
