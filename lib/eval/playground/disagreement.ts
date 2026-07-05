// PURE formatter/sorter over the agreement report (Task B3-5). No I/O, no
// server-only — it takes an already-computed AgreementReport and orders its
// discordant cells for reading. Kept pure so vitest pins the ordering directly
// and AgreementView (a client island) stays a thin presenter.
//
// WHY THIS MODULE DOES NOT RE-PAIR: compareRuns (app/actions/runs.ts, B2-4)
// already joins two runs' verdicts on (pid, phaseOrdinal, scenarioIdx), computes
// Cohen's κ, and returns report.disagreements[] — the cells where passA !== passB
// (concordant cells, INCLUDING null===null "both abstained", are already
// excluded server-side). Re-pairing here would duplicate the join and risk
// drifting from the executor's own cell identity. So this module's only job is
// to ORDER those discordant cells so the sharpest empirical fork surfaces first.
//
// The κ arithmetic and the raw agreement % are OWNED by compareRuns/cohensKappa;
// this module never recomputes them (κ null vs κ 0 is an honest-signal
// distinction the view must preserve — see AgreementView).

import type { AgreementReport } from '@/app/actions/runs';

/** One discordant cell, annotated with its disagreement `kind` for the reader.
 *  Extends the raw report row (pid, phaseOrdinal, scenarioIdx, passA, passB)
 *  with the tier used to sort it. */
export type DiscordantCell = AgreementReport['disagreements'][number] & {
  /** 'hard' = true-vs-false (both graders produced a boolean and they DISAGREE —
   *  the sharpest fork, and the only kind that entered the κ arithmetic).
   *  'soft' = boolean-vs-null (one grader graded the cell, the other abstained —
   *  real signal that κ dropped, but a weaker divergence). */
  kind: 'hard' | 'soft';
};

/** Classify a discordant cell. Both non-null (and, by construction of the input,
 *  unequal) ⇒ hard; exactly one null ⇒ soft. (null-vs-null never appears — it is
 *  concordant and excluded upstream.) */
function classify(passA: boolean | null, passB: boolean | null): 'hard' | 'soft' {
  return passA !== null && passB !== null ? 'hard' : 'soft';
}

/** Rank for the primary sort key: hard cells (0) before soft cells (1). */
const KIND_RANK: Record<'hard' | 'soft', number> = { hard: 0, soft: 1 };

/**
 * Order an AgreementReport's discordant cells for reading, SHARPEST DIVERGENCE
 * FIRST. Pure: returns a NEW array, never mutates report.disagreements.
 *
 * ORDER (the pinned contract — see disagreement.test.ts):
 *   1. by kind: HARD (true-vs-false) before SOFT (boolean-vs-null).
 *   2. then a STABLE secondary order by pid (locale), phaseOrdinal (numeric),
 *      scenarioIdx (numeric, with null LAST).
 *
 * The empirical-fork discipline (B spec §3): this PRESENTS the cells a researcher
 * reads before deciding which grader to trust; it never adjudicates which grader
 * is right — passA/passB pass through untouched.
 */
export function sortDisagreements(report: AgreementReport): DiscordantCell[] {
  const annotated: DiscordantCell[] = report.disagreements.map((d) => ({
    ...d,
    kind: classify(d.passA, d.passB),
  }));

  return annotated.sort((a, b) => {
    // 1. hard before soft.
    const kindDelta = KIND_RANK[a.kind] - KIND_RANK[b.kind];
    if (kindDelta !== 0) return kindDelta;

    // 2. stable secondary: pid, phaseOrdinal, scenarioIdx (null last).
    const pidDelta = a.pid.localeCompare(b.pid);
    if (pidDelta !== 0) return pidDelta;

    const phaseDelta = a.phaseOrdinal - b.phaseOrdinal;
    if (phaseDelta !== 0) return phaseDelta;

    // null scenarioIdx sorts LAST within a (pid, phase).
    const aNull = a.scenarioIdx === null ? 1 : 0;
    const bNull = b.scenarioIdx === null ? 1 : 0;
    if (aNull !== bNull) return aNull - bNull;
    return (a.scenarioIdx ?? 0) - (b.scenarioIdx ?? 0);
  });
}
