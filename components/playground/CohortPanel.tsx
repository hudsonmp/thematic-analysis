'use client';

import { useEffect, useRef } from 'react';
import type { ProgressionParticipant } from '@/app/actions/progression';
import {
  cohortSelectionState,
  deselectAll,
  deselectCohort,
  groupByCohort,
  selectAll,
  selectCohort,
  toggle,
} from '@/lib/eval/playground/selection';

// ---------------------------------------------------------------------------
// Cohort multiselect (Hudson's explicit ask). Renders groupByCohort() — pilot,
// study, then "—" (null) LAST — with a global Select all · Deselect all pair
// and a per-cohort tri-state header checkbox that touches ONLY that cohort's
// pids. Each pid is a checkbox row with the n/5 stepCount hint (mirrors
// ProgressionViewer's row) and its cohort label. All set-ops are the pure
// helpers in lib/eval/playground/selection; this component is a thin island
// that lifts the resulting Set via onSelectedChange.
// ---------------------------------------------------------------------------

/** A checkbox whose indeterminate flag is a DOM property (not an attribute) —
 *  set imperatively via a ref + effect, per React's checkbox indeterminate
 *  pattern. checked reflects 'all'; indeterminate reflects 'some'. */
function TriStateCheckbox({
  state,
  onChange,
  ariaLabel,
}: {
  state: 'all' | 'none' | 'some';
  onChange: (checked: boolean) => void;
  ariaLabel: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'some';
  }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={state === 'all'}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.currentTarget.checked)}
      className="h-3.5 w-3.5 accent-foreground"
    />
  );
}

export default function CohortPanel({
  participants,
  selected,
  onSelectedChange,
}: {
  participants: ProgressionParticipant[];
  selected: Set<string>;
  onSelectedChange: (next: Set<string>) => void;
}) {
  const groups = groupByCohort(participants);
  const byPid = new Map(participants.map((p) => [p.pid, p]));

  return (
    <section className="w-64 shrink-0 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-foreground/50">
          Participants · {selected.size}/{participants.length}
        </h2>
      </div>

      <div className="flex items-center gap-3 text-xs">
        <button
          type="button"
          onClick={() => onSelectedChange(selectAll(participants))}
          className="text-foreground/60 underline underline-offset-2 transition hover:text-foreground"
        >
          Select all
        </button>
        <span className="text-foreground/25" aria-hidden>
          ·
        </span>
        <button
          type="button"
          onClick={() => onSelectedChange(deselectAll())}
          className="text-foreground/60 underline underline-offset-2 transition hover:text-foreground"
        >
          Deselect all
        </button>
      </div>

      {participants.length === 0 && (
        <p className="text-sm text-foreground/60">No participants with snapshots.</p>
      )}

      {groups.map((group) => {
        const label = group.cohort ?? '—';
        const state = cohortSelectionState(selected, participants, group.cohort);
        return (
          <div key={label} className="space-y-1">
            <div className="flex items-center gap-2 border-b border-foreground/15 pb-1">
              <TriStateCheckbox
                state={state}
                ariaLabel={`Select all in ${label}`}
                onChange={(checked) =>
                  onSelectedChange(
                    checked
                      ? selectCohort(selected, participants, group.cohort)
                      : deselectCohort(selected, participants, group.cohort),
                  )
                }
              />
              <span className="text-xs font-semibold uppercase tracking-wider text-foreground/50">
                {label} · {group.pids.length}
              </span>
            </div>
            <ul className="divide-y divide-foreground/10">
              {group.pids.map((pid) => {
                const participant = byPid.get(pid);
                const checked = selected.has(pid);
                return (
                  <li key={pid}>
                    <label className="flex cursor-pointer items-center justify-between gap-2 px-1 py-1.5 text-sm transition hover:bg-foreground/5">
                      <span className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => onSelectedChange(toggle(selected, pid))}
                          className="h-3.5 w-3.5 accent-foreground"
                        />
                        <span className="font-mono">{pid}</span>
                      </span>
                      <span className="text-xs text-foreground/40">
                        {participant?.stepCount ?? 0}/5
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
