import type { ProgressionParticipant } from '@/app/actions/progression';

// ---------------------------------------------------------------------------
// Pure selection set-ops for the playground cohort panel (Hudson's explicit
// ask: Select all · Deselect all · per-cohort select). No React, no I/O — every
// function is a total function over (Set<string>, ProgressionParticipant[]),
// returning a NEW set (never mutating the input) so callers can pass the result
// straight to setState. Fully unit-tested; the components are thin islands over
// these.
//
// Cohort ordering is null-LAST via an explicit comparator. A '~' sentinel does
// NOT sort last under ICU collation (localeCompare orders '~' BEFORE letters);
// ProgressionViewer documents the same trap. We keep the explicit numeric
// null-flag comparator here and reserve a high-code-point key only for the
// display label.
// ---------------------------------------------------------------------------

/** Display key for a cohort; null renders as a high-code-point "—" that also
 *  sorts after any real cohort label (defensive — orderCohorts is the primary
 *  ordering; this keeps key-based sorts correct too). */
export function cohortKey(cohort: string | null): string {
  return cohort ?? '￿—';
}

/** Stable cohort order: real cohorts alphabetical (pilot, study, …), then null
 *  ("—") LAST via the explicit null-flag comparator. */
export function orderCohorts(cohorts: (string | null)[]): (string | null)[] {
  const uniq = Array.from(new Set(cohorts));
  return uniq.sort((a, b) => {
    const an = a === null ? 1 : 0;
    const bn = b === null ? 1 : 0;
    return an - bn || (a ?? '').localeCompare(b ?? '');
  });
}

/** Group participants by cohort in display order. */
export function groupByCohort(
  ps: ProgressionParticipant[],
): { cohort: string | null; pids: string[] }[] {
  const order = orderCohorts(ps.map((p) => p.cohort));
  return order.map((cohort) => ({
    cohort,
    pids: ps.filter((p) => p.cohort === cohort).map((p) => p.pid),
  }));
}

export function selectAll(ps: ProgressionParticipant[]): Set<string> {
  return new Set(ps.map((p) => p.pid));
}

export function deselectAll(): Set<string> {
  return new Set();
}

export function toggle(sel: Set<string>, pid: string): Set<string> {
  const next = new Set(sel);
  if (next.has(pid)) {
    next.delete(pid);
  } else {
    next.add(pid);
  }
  return next;
}

/** Select every pid in one cohort WITHOUT touching other cohorts' selection. */
export function selectCohort(
  sel: Set<string>,
  ps: ProgressionParticipant[],
  cohort: string | null,
): Set<string> {
  const next = new Set(sel);
  ps.filter((p) => p.cohort === cohort).forEach((p) => next.add(p.pid));
  return next;
}

export function deselectCohort(
  sel: Set<string>,
  ps: ProgressionParticipant[],
  cohort: string | null,
): Set<string> {
  const next = new Set(sel);
  ps.filter((p) => p.cohort === cohort).forEach((p) => next.delete(p.pid));
  return next;
}

/** Tri-state for a per-cohort checkbox header. */
export function cohortSelectionState(
  sel: Set<string>,
  ps: ProgressionParticipant[],
  cohort: string | null,
): 'all' | 'none' | 'some' {
  const pids = ps.filter((p) => p.cohort === cohort).map((p) => p.pid);
  const n = pids.filter((p) => sel.has(p)).length;
  return n === 0 ? 'none' : n === pids.length ? 'all' : 'some';
}
