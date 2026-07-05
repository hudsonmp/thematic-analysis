import type { VerdictRow } from '@/app/actions/runs';

// ---------------------------------------------------------------------------
// grid.ts — pure verdict-grid assembly for the playground (Task B3-3).
//
// A RUN produces flat verdicts, one per (pid, phaseOrdinal, scenarioIdx) cell.
// The researcher reads them as a participant × phase table with a per-phase
// improvement signal. This module is that pivot plus the delta math, kept pure
// and unit-tested so the contestable logic never lives in JSX.
//
// PHASE COLUMNS = the 5 progression ordinals (0 = requirement, 1–4 = after each
// scenario). `final` (slot 5) is not a gradable phase (runs.ts) so it never
// appears here.
//
// COHORT JOIN: ParticipantProgression carries NO cohort (app/actions/progression
// documents this); cohort lives ONLY on the participant LIST. So a row's cohort
// is joined by pid from the `participants` arg — never read off a verdict.
//
// PER-PHASE MEAN (v1, metric-agnostic): the per-phase score is the mean of the
// NON-NULL scenario scores at that phase. Grading is fixed-target (runs.ts):
// every phase is scored against ALL FOUR authored scenarios, so the four
// scenario scores at a phase are like-for-like and their mean is a comparable
// per-phase number. A phase with zero gradable (all-null) cells has no mean —
// it is `null`, not 0, because "we could not measure" ≠ "measured zero".
//
// IMPROVEMENT DELTA (the honest-signal rule): delta_k = mean_k − mean_{k-1}.
// delta_0 is null (no prior phase). delta_k is null whenever EITHER neighbor's
// mean is null — an ungradable phase produces a null delta, NEVER 0. A 0 delta
// means "measured, unchanged"; a null delta means "cannot measure change". The
// UI must render these differently (— vs 0.00), so the distinction is enforced
// here, in tested code, not left to a render-time truthiness slip.
// ---------------------------------------------------------------------------

/** The five gradable phase ordinals (0..4). `final` (5) is not gradable. */
const PHASE_COUNT = 5;

export type GridCell = {
  pid: string;
  phaseOrdinal: number;
  scenarioIdx: number | null;
  pass: boolean | null;
  score: number | null;
  verdictId: string;
};

export type GridRow = {
  pid: string;
  cohort: string | null;
  cells: GridCell[];
  phaseDeltas: (number | null)[];
};

/**
 * Mean score per phase ordinal (0..4). For each ordinal, average the NON-NULL
 * scores of the cells at that ordinal; a phase with zero gradable cells (all
 * null, or no cells) is `null` — an honest "unmeasured", never a fabricated 0.
 * Returns a length-5 array indexed by ordinal.
 */
export function meanScorePerPhase(cells: GridCell[]): (number | null)[] {
  const sums = new Array<number>(PHASE_COUNT).fill(0);
  const counts = new Array<number>(PHASE_COUNT).fill(0);
  for (const c of cells) {
    if (c.phaseOrdinal < 0 || c.phaseOrdinal >= PHASE_COUNT) continue;
    if (c.score === null) continue; // ungradable cell — excluded from the mean.
    sums[c.phaseOrdinal] += c.score;
    counts[c.phaseOrdinal] += 1;
  }
  return sums.map((sum, ordinal) => (counts[ordinal] === 0 ? null : sum / counts[ordinal]));
}

/**
 * Per-phase improvement deltas from a per-phase mean vector.
 *   deltas[0] = null            (no prior phase to compare against)
 *   deltas[k] = mean[k] − mean[k-1]   when BOTH neighbors are gradable
 *   deltas[k] = null            when EITHER neighbor's mean is null
 * The last clause is the honest-signal rule: an ungradable phase never yields a
 * 0 delta. Returns a vector the same length as `means`.
 */
export function phaseDeltas(means: (number | null)[]): (number | null)[] {
  return means.map((cur, k) => {
    if (k === 0) return null;
    const prev = means[k - 1];
    if (cur === null || prev === null) return null;
    return cur - prev;
  });
}

/**
 * Pivot flat verdicts into participant rows × phase columns for ONE grader run.
 * One row per pid PRESENT IN THE VERDICTS (a listed participant with no verdicts
 * gets no row — the run simply did not grade them). Each row's `cells` are all
 * of that pid's verdicts; `cohort` is joined by pid from `participants` (null
 * when the pid is absent from the list); `phaseDeltas` is the improvement signal
 * over `meanScorePerPhase`. Row order follows first-appearance in `verdicts`
 * (listVerdicts already orders by pid, then phase, then scenario).
 */
export function buildGrid(
  verdicts: VerdictRow[],
  participants: { pid: string; cohort: string | null }[],
): GridRow[] {
  const cohortByPid = new Map<string, string | null>();
  for (const p of participants) cohortByPid.set(p.pid, p.cohort);

  // Group verdicts by pid, preserving first-appearance order.
  const cellsByPid = new Map<string, GridCell[]>();
  for (const v of verdicts) {
    const cell: GridCell = {
      pid: v.pid,
      phaseOrdinal: v.phaseOrdinal,
      scenarioIdx: v.scenarioIdx,
      pass: v.pass,
      score: v.score,
      verdictId: v.id,
    };
    const list = cellsByPid.get(v.pid);
    if (list) list.push(cell);
    else cellsByPid.set(v.pid, [cell]);
  }

  return [...cellsByPid.entries()].map(([pid, cells]) => ({
    pid,
    cohort: cohortByPid.get(pid) ?? null,
    cells,
    phaseDeltas: phaseDeltas(meanScorePerPhase(cells)),
  }));
}
