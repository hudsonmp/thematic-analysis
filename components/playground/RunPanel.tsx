'use client';

import { useEffect, useState, useTransition } from 'react';
import { createAndExecuteRun, listRuns, listVerdicts } from '@/app/actions/runs';
import type { RunSummary, VerdictRow } from '@/app/actions/runs';
import { buildRunRequest, type PlaygroundConfig } from '@/lib/eval/playground/config';
import type { ProgressionParticipant } from '@/app/actions/progression';
import VerdictGrid from '@/components/playground/VerdictGrid';

// ---------------------------------------------------------------------------
// RunPanel — execute a run, load its verdicts, render the grid (Task B3-3).
//
// The Run button is gated by buildRunRequest(name, selectedPids, config): when
// the config isn't runnable, the button is disabled and the disabled reason IS
// the validator's own message (no drift from what createAndExecuteRun would
// throw). A run picker (listRuns) reloads a past run's grid.
//
// The current runId + verdicts are LIFTED to Playground (props + callbacks) so a
// later task (B3-4's fold-into-variant) can read the run under inspection
// without reaching into this panel. RunPanel owns only the transient run-name,
// run-list, and pending/error state.
//
// SLOW-RUN UX: createAndExecuteRun grades a (pids × 5 phases × 4 scenarios) grid
// SEQUENTIALLY through the Anthropic API (runs.ts documents the O(hundreds)-call
// cost) and AWAITS — it does not return a pending run to poll. So the panel
// shows a clear, blocking pending state for the whole run and builds NO polling
// infrastructure (YAGNI — there is nothing to poll; the action resolves with the
// finished run's id). Past runs load via listRuns on mount (the documented
// useEffect + useTransition mount pattern) since the server page does not thread
// them (B3 touches only the files it owns).
// ---------------------------------------------------------------------------

export default function RunPanel({
  participants,
  selected,
  config,
  currentRunId,
  verdicts,
  onRunLoaded,
}: {
  participants: ProgressionParticipant[];
  selected: Set<string>;
  config: PlaygroundConfig | null;
  currentRunId: string | null;
  verdicts: VerdictRow[] | null;
  /** Lift the loaded run to Playground (runId + its verdicts). */
  onRunLoaded: (runId: string, verdicts: VerdictRow[]) => void;
}) {
  const [name, setName] = useState('');
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isRunning, startRun] = useTransition();
  const [isLoading, startLoad] = useTransition();
  const [, startRefresh] = useTransition();

  // Load the run list on mount (documented mount pattern: the setState happens
  // INSIDE a transition callback, not synchronously in the effect body, so it
  // never trips the set-state-in-effect lint). Empty deps: load once.
  useEffect(() => {
    startRefresh(async () => {
      try {
        setRuns(await listRuns());
      } catch {
        // A run-list read failure is non-fatal — the picker just stays empty.
      }
    });
  }, []);

  const selectedPids = [...selected];
  // cohort join for the grid: participant list carries cohort, verdicts do not.
  const participantCohorts = participants.map((p) => ({ pid: p.pid, cohort: p.cohort }));

  // Gate: buildRunRequest returns the disabled reason when the config/selection
  // isn't runnable. Same validation the server action re-runs at the edge.
  const readiness = config
    ? buildRunRequest(name, selectedPids, config)
    : ({ ok: false, error: 'Configure a run.' } as const);

  function run() {
    if (!readiness.ok) return;
    setError(null);
    startRun(async () => {
      try {
        const { runId } = await createAndExecuteRun(readiness.req);
        const [vs, rs] = await Promise.all([listVerdicts(runId), listRuns()]);
        onRunLoaded(runId, vs);
        setRuns(rs);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Run failed.');
      }
    });
  }

  function loadRun(runId: string) {
    if (!runId) return;
    setError(null);
    startLoad(async () => {
      try {
        onRunLoaded(runId, await listVerdicts(runId));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load run.');
      }
    });
  }

  const busy = isRunning || isLoading;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1 text-sm">
          <span className="text-xs font-semibold uppercase tracking-wider text-foreground/50">
            Run name
          </span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. opus-exec-deterministic-v1"
            aria-label="Run name"
            className="w-64 border border-foreground/15 bg-background px-2 py-1.5 outline-none focus:border-foreground/40"
          />
        </label>

        <button
          type="button"
          onClick={run}
          disabled={busy || !readiness.ok}
          title={readiness.ok ? undefined : readiness.error}
          className="border border-foreground bg-foreground px-4 py-1.5 text-sm text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isRunning ? 'Running…' : 'Run'}
        </button>

        {!readiness.ok && <p className="text-xs text-foreground/50">{readiness.error}</p>}

        {runs.length > 0 && (
          <label className="ml-auto space-y-1 text-sm">
            <span className="text-xs font-semibold uppercase tracking-wider text-foreground/50">
              Load past run
            </span>
            <select
              value={currentRunId ?? ''}
              onChange={(e) => loadRun(e.target.value)}
              disabled={busy}
              aria-label="Load past run"
              className="w-64 border border-foreground/15 bg-background px-2 py-1.5 outline-none focus:border-foreground/40 disabled:opacity-50"
            >
              <option value="">Select a run…</option>
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} · {r.graderId} · {r.status} · {r.verdictCount} verdicts
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {isRunning && (
        <p className="border border-dashed border-foreground/15 px-4 py-3 text-sm text-foreground/60">
          Grading {selectedPids.length} participant{selectedPids.length === 1 ? '' : 's'} × 5 phases × 4
          scenarios sequentially through the model — this can take a while. Keep this tab open; the grid
          appears when the run completes.
        </p>
      )}

      {isLoading && <p className="text-sm text-foreground/40">Loading run…</p>}

      {error && (
        <p className="border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700">{error}</p>
      )}

      {verdicts && !busy && (
        <div className="space-y-2">
          {currentRunId && (
            <p className="text-xs text-foreground/50">
              {verdicts.length} verdict{verdicts.length === 1 ? '' : 's'} · run{' '}
              <span className="font-mono">{currentRunId}</span>
            </p>
          )}
          <VerdictGrid verdicts={verdicts} participants={participantCohorts} />
        </div>
      )}
    </div>
  );
}
