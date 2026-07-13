import { describe, it, expect } from 'vitest';
import type { AgreementReport } from '@/app/actions/runs';
import { sortDisagreements, type DiscordantCell } from '@/lib/eval/playground/disagreement';

// ---------------------------------------------------------------------------
// disagreement.ts — PURE formatter/sorter over compareRuns' AgreementReport.
//
// compareRuns (app/actions/runs.ts, B2-4) ALREADY pairs verdicts across two
// runs on (pid, phaseOrdinal, scenarioIdx) and returns report.disagreements[]:
// { pid, phaseOrdinal, scenarioIdx, passA, passB } — every element is a
// DISCORDANT cell (passA !== passB; concordant cells, including null===null, are
// never present). So this module does NOT re-pair; it only ORDERS the discordant
// cells for reading, sharpest divergence first.
//
// ORDERING RULE (pinned here — this is the contract):
//   1. HARD disagreement first — a true-vs-false cell, where BOTH graders
//      produced a boolean and they DISAGREE. This is the sharpest empirical
//      fork: two graders confidently split on the same cell. It is also the only
//      kind of disagreement that entered the κ arithmetic (pairwise-complete),
//      so it is what a reader must resolve first.
//   2. SOFT disagreement second — a boolean-vs-null cell, where one grader could
//      grade the cell and the other abstained (pass:null). Real signal (worth
//      surfacing — κ dropped it), but a weaker fork: it is "one couldn't grade",
//      not "they contradict".
//   3. Within a tier, STABLE secondary order by (pid, phaseOrdinal, scenarioIdx)
//      with a null scenarioIdx sorted LAST — deterministic, reproducible reads.
// ---------------------------------------------------------------------------

/** A report skeleton; only `disagreements` matters for sorting. */
function report(
  disagreements: AgreementReport['disagreements'],
): AgreementReport {
  return {
    runA: 'A',
    runB: 'B',
    kappa: 0.5,
    agreement: 0.7,
    n: 10,
    disagreements,
  };
}

describe('sortDisagreements', () => {
  it('ranks a hard (true-vs-false) disagreement BEFORE a soft (boolean-vs-null) one', () => {
    // Deliberately fed in the WRONG reading order (soft first) so the sort has
    // to move the hard cell to the front.
    const r = report([
      { pid: 'P1', phaseOrdinal: 0, scenarioIdx: 0, passA: true, passB: null }, // soft
      { pid: 'P2', phaseOrdinal: 3, scenarioIdx: 1, passA: true, passB: false }, // hard
    ]);
    const sorted = sortDisagreements(r);
    expect(sorted).toHaveLength(2);
    expect(sorted[0].pid).toBe('P2'); // hard first
    expect(sorted[0].kind).toBe('hard');
    expect(sorted[1].pid).toBe('P1'); // soft second
    expect(sorted[1].kind).toBe('soft');
  });

  it('classifies false-vs-null and null-vs-true as soft, true-vs-false as hard', () => {
    const r = report([
      { pid: 'P1', phaseOrdinal: 0, scenarioIdx: 0, passA: false, passB: null },
      { pid: 'P1', phaseOrdinal: 1, scenarioIdx: 0, passA: null, passB: true },
      { pid: 'P1', phaseOrdinal: 2, scenarioIdx: 0, passA: false, passB: true },
    ]);
    const byCell = new Map(
      sortDisagreements(r).map((d) => [`${d.pid}|${d.phaseOrdinal}`, d.kind]),
    );
    expect(byCell.get('P1|0')).toBe('soft'); // false vs null
    expect(byCell.get('P1|1')).toBe('soft'); // null vs true
    expect(byCell.get('P1|2')).toBe('hard'); // false vs true
  });

  it('within a tier, orders stably by (pid, phaseOrdinal, scenarioIdx)', () => {
    // Four HARD cells fed out of order — expect (pid, phase, scenario) ascending.
    const r = report([
      { pid: 'P2', phaseOrdinal: 1, scenarioIdx: 0, passA: true, passB: false },
      { pid: 'P1', phaseOrdinal: 2, scenarioIdx: 1, passA: false, passB: true },
      { pid: 'P1', phaseOrdinal: 2, scenarioIdx: 0, passA: true, passB: false },
      { pid: 'P1', phaseOrdinal: 0, scenarioIdx: 0, passA: true, passB: false },
    ]);
    const sorted = sortDisagreements(r);
    expect(sorted.map((d) => `${d.pid}|${d.phaseOrdinal}|${d.scenarioIdx}`)).toEqual([
      'P1|0|0',
      'P1|2|0',
      'P1|2|1',
      'P2|1|0',
    ]);
  });

  it('sorts a null scenarioIdx LAST within the same (pid, phase)', () => {
    const r = report([
      { pid: 'P1', phaseOrdinal: 0, scenarioIdx: null, passA: true, passB: false },
      { pid: 'P1', phaseOrdinal: 0, scenarioIdx: 2, passA: true, passB: false },
    ]);
    const sorted = sortDisagreements(r);
    expect(sorted.map((d) => d.scenarioIdx)).toEqual([2, null]);
  });

  it('mixes tiers and secondary order: all hard cells (sorted) precede all soft cells (sorted)', () => {
    const r = report([
      { pid: 'P2', phaseOrdinal: 0, scenarioIdx: 0, passA: true, passB: null }, // soft
      { pid: 'P2', phaseOrdinal: 1, scenarioIdx: 0, passA: false, passB: true }, // hard
      { pid: 'P1', phaseOrdinal: 0, scenarioIdx: 0, passA: null, passB: false }, // soft
      { pid: 'P1', phaseOrdinal: 0, scenarioIdx: 0, passA: true, passB: false }, // hard
    ]);
    const sorted = sortDisagreements(r);
    expect(sorted.map((d) => d.kind)).toEqual(['hard', 'hard', 'soft', 'soft']);
    // hard tier ordered by (pid, phase): P1/0 then P2/1
    expect(`${sorted[0].pid}|${sorted[0].phaseOrdinal}`).toBe('P1|0');
    expect(`${sorted[1].pid}|${sorted[1].phaseOrdinal}`).toBe('P2|1');
    // soft tier ordered by (pid, phase): P1/0 then P2/0
    expect(`${sorted[2].pid}|${sorted[2].phaseOrdinal}`).toBe('P1|0');
    expect(`${sorted[3].pid}|${sorted[3].phaseOrdinal}`).toBe('P2|0');
  });

  it('returns [] for an empty disagreements list', () => {
    expect(sortDisagreements(report([]))).toEqual([]);
  });

  it('is pure — does not mutate the input report.disagreements array', () => {
    const disagreements: AgreementReport['disagreements'] = [
      { pid: 'P1', phaseOrdinal: 0, scenarioIdx: 0, passA: true, passB: null },
      { pid: 'P2', phaseOrdinal: 3, scenarioIdx: 1, passA: true, passB: false },
    ];
    const snapshot = JSON.stringify(disagreements);
    sortDisagreements(report(disagreements));
    expect(JSON.stringify(disagreements)).toBe(snapshot);
  });

  it('carries passA/passB through unchanged onto each DiscordantCell', () => {
    const r = report([
      { pid: 'P1', phaseOrdinal: 0, scenarioIdx: 0, passA: true, passB: false },
    ]);
    const [cell]: DiscordantCell[] = sortDisagreements(r);
    expect(cell.passA).toBe(true);
    expect(cell.passB).toBe(false);
  });
});
