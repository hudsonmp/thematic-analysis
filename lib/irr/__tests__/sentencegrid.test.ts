import { describe, it, expect } from 'vitest';
import {
  sentenceGridKappa,
  poolSentenceGrids,
  enumerateSentences,
  sentencesForRange,
  type SentencePresence,
} from '../sentencegrid';

const p = (code: string, sentence: number): SentencePresence => ({ code, sentence });

describe('sentenceGridKappa', () => {
  it('identical sentence coding → strict κ = 1', () => {
    const a = [p('X', 0), p('X', 1), p('Y', 5)];
    const b = [p('X', 0), p('X', 1), p('Y', 5)];
    const r = sentenceGridKappa(20, a, b, { minActiveSentences: 1 });
    for (const c of r.perCode) expect(c.kappa).toBeCloseTo(1, 6);
    expect(r.segmentationKappa).toBeCloseTo(1, 6);
  });

  it('multi-sentence split: strict penalizes S2, relaxed credits it', () => {
    // A codes X on sentences {3,4}; B codes X only on {3}. 20-sentence universe.
    const a = [p('X', 3), p('X', 4)];
    const b = [p('X', 3)];
    const r = sentenceGridKappa(20, a, b, { minActiveSentences: 1 });
    const x = r.perCode.find((c) => c.code === 'X')!;
    expect(x.bothActive).toBe(1); // S3
    expect(x.aOnly).toBe(1); // S4 (A only) — strict disagreement
    // Strict κ < relaxed κ: S4 is a disagreement strictly but B has X on S3 (±1),
    // so relaxed upgrades it to agreement.
    expect(x.kappaRelaxed! > x.kappa!).toBe(true);
  });

  it('disjoint coding of the same code → low κ, and relaxed does NOT rescue it', () => {
    // A codes X on {0}; B codes X on {10} — far apart, no ±1 overlap.
    const r = sentenceGridKappa(20, [p('X', 0)], [p('X', 10)], { minActiveSentences: 1 });
    const x = r.perCode.find((c) => c.code === 'X')!;
    expect(x.bothActive).toBe(0);
    expect(x.kappa!).toBeLessThanOrEqual(0);
    // relaxed leaves them disagreeing (10 is not within ±1 of 0).
    expect(x.kappaRelaxed!).toBeLessThanOrEqual(0);
  });

  it('relaxed never manufactures NEW disagreement (pure upgrade)', () => {
    // Whatever the coding, relaxed κ ≥ strict κ per code.
    const a = [p('X', 0), p('X', 2), p('Y', 5), p('Y', 6)];
    const b = [p('X', 1), p('Y', 6), p('Y', 8)];
    const r = sentenceGridKappa(15, a, b, { minActiveSentences: 1 });
    for (const c of r.perCode) {
      if (c.kappa !== null && c.kappaRelaxed !== null) {
        expect(c.kappaRelaxed).toBeGreaterThanOrEqual(c.kappa - 1e-9);
      }
    }
  });

  it('flags underpowered codes and averages over powered', () => {
    const a = [p('Common', 0), p('Common', 1), p('Common', 2), p('Rare', 9)];
    const b = [p('Common', 0), p('Common', 1), p('Common', 2), p('Rare', 9)];
    const r = sentenceGridKappa(30, a, b, { minActiveSentences: 3 });
    expect(r.perCode.find((c) => c.code === 'Rare')!.underpowered).toBe(true);
    expect(r.perCode.find((c) => c.code === 'Common')!.underpowered).toBe(false);
    expect(r.meanKappaPowered).toBeCloseTo(1, 6);
  });

  it('empty input is safe', () => {
    const r = sentenceGridKappa(0, [], [], {});
    expect(r.nSentences).toBe(0);
    expect(r.segmentationKappa).toBeNull();
    expect(r.perCode).toEqual([]);
  });

  it('a single-code, both-cover-everything case is κ-undefined (degenerate)', () => {
    // Both code X on all 3 sentences → no variance, pₑ=1, κ null.
    const a = [p('X', 0), p('X', 1), p('X', 2)];
    const b = [p('X', 0), p('X', 1), p('X', 2)];
    const r = sentenceGridKappa(3, a, b, { minActiveSentences: 1 });
    expect(r.perCode[0].kappa).toBeNull();
  });
});

describe('enumerateSentences / sentencesForRange', () => {
  const segs = [
    { ordinal: 0, text: 'First. Second.' }, // sentences 0,1
    { ordinal: 1, text: 'Third one here.' }, // sentence 2
    { ordinal: 2, text: 'Fourth. Fifth.' }, // sentences 3,4
  ];

  it('assigns consecutive global indices across segments', () => {
    const { units } = enumerateSentences(segs);
    expect(units.map((u) => u.index)).toEqual([0, 1, 2, 3, 4]);
    expect(units[2]).toMatchObject({ index: 2, segmentOrdinal: 1 });
  });

  it('maps a single-segment range to the touched sentence(s)', () => {
    const { byOrdinal } = enumerateSentences(segs);
    // In segment 0, cover "Second." (chars 7..14) → sentence 1 only.
    expect(sentencesForRange(byOrdinal, 0, 7, 0, 14)).toEqual([1]);
    // Cover the whole segment 0 → sentences 0 and 1.
    expect(sentencesForRange(byOrdinal, 0, 0, 0, 14)).toEqual([0, 1]);
  });

  it('maps a multi-segment range (whole middle segments included)', () => {
    const { byOrdinal } = enumerateSentences(segs);
    // From segment 0 char 7 ("Second.") through segment 2 char 7 ("Fourth.").
    const got = sentencesForRange(byOrdinal, 0, 7, 2, 7);
    expect(got).toEqual([1, 2, 3]);
  });
});

describe('poolSentenceGrids', () => {
  it('pooling one grid is the identity', () => {
    const a = [p('X', 0), p('X', 2), p('Y', 5)];
    const b = [p('X', 0), p('Y', 5), p('Y', 6)];
    const g = sentenceGridKappa(20, a, b, { minActiveSentences: 1 });
    const pooled = poolSentenceGrids([g], { minActiveSentences: 1 });
    expect(pooled.nSentences).toBe(g.nSentences);
    expect(pooled.segmentationKappa).toBeCloseTo(g.segmentationKappa!, 9);
    expect(pooled.perCode).toHaveLength(g.perCode.length);
    for (const gp of g.perCode) {
      const pp = pooled.perCode.find((x) => x.code === gp.code)!;
      expect(pp.kappa).toBeCloseTo(gp.kappa!, 9);
      expect(pp.kappaRelaxed).toBeCloseTo(gp.kappaRelaxed!, 9);
      expect(pp.prevalence).toBeCloseTo(gp.prevalence, 9);
    }
  });

  it('pooled κ equals κ of the concatenated transcript (cells sum)', () => {
    // Session 1: 10 sentences; session 2: 15 sentences. Concatenating by
    // offsetting session 2's indices by 10 must give the same strict κ as
    // pooling the two per-session grids — same summed contingency table.
    const a1 = [p('X', 1), p('X', 2)];
    const b1 = [p('X', 2), p('X', 7)];
    const a2 = [p('X', 0), p('X', 9)];
    const b2 = [p('X', 0)];
    const g1 = sentenceGridKappa(10, a1, b1, { minActiveSentences: 1 });
    const g2 = sentenceGridKappa(15, a2, b2, { minActiveSentences: 1 });
    const pooled = poolSentenceGrids([g1, g2], { minActiveSentences: 1 });

    const off = (ps: SentencePresence[], d: number) =>
      ps.map((q) => ({ ...q, sentence: q.sentence + d }));
    const concat = sentenceGridKappa(25, [...a1, ...off(a2, 10)], [...b1, ...off(b2, 10)], {
      minActiveSentences: 1,
    });
    const px = pooled.perCode.find((c) => c.code === 'X')!;
    const cx = concat.perCode.find((c) => c.code === 'X')!;
    expect(px.bothActive).toBe(cx.bothActive);
    expect(px.aOnly).toBe(cx.aOnly);
    expect(px.bOnly).toBe(cx.bOnly);
    expect(px.inactive).toBe(cx.inactive);
    expect(px.kappa).toBeCloseTo(cx.kappa!, 9);
    expect(pooled.segmentationKappa).toBeCloseTo(concat.segmentationKappa!, 9);
  });

  it('a code absent from one session counts that session as both-inactive', () => {
    // Y appears only in session 1 (both coders agree there). Session 2's 30
    // sentences must still enter Y's table as n00 — dropping them would
    // overstate Y's prevalence and change κ.
    const g1 = sentenceGridKappa(10, [p('Y', 3)], [p('Y', 3)], { minActiveSentences: 1 });
    const g2 = sentenceGridKappa(30, [p('X', 0)], [p('X', 0)], { minActiveSentences: 1 });
    const pooled = poolSentenceGrids([g1, g2], { minActiveSentences: 1 });
    const y = pooled.perCode.find((c) => c.code === 'Y')!;
    expect(y.bothActive).toBe(1);
    expect(y.inactive).toBe(9 + 30);
    expect(y.prevalence).toBeCloseTo(1 / 40, 9);
    expect(y.kappa).toBeCloseTo(1, 9);
  });

  it('the ±1 tolerance never crosses a session boundary', () => {
    // A marks X on the LAST sentence of session 1; B marks X on the FIRST
    // sentence of session 2. Adjacent if concatenated naively — but they are
    // different sessions, so relaxed must NOT credit agreement.
    const g1 = sentenceGridKappa(5, [p('X', 4)], [], { minActiveSentences: 1 });
    const g2 = sentenceGridKappa(5, [], [p('X', 0)], { minActiveSentences: 1 });
    const pooled = poolSentenceGrids([g1, g2], { minActiveSentences: 1 });
    const x = pooled.perCode.find((c) => c.code === 'X')!;
    expect(x.rBothActive).toBe(0); // no relaxed agreement manufactured
    expect(x.kappaRelaxed!).toBeLessThanOrEqual(0);
  });

  it('a code with no variance per session becomes estimable pooled', () => {
    // In each session alone the code covers EVERY sentence for both coders →
    // per-session κ is null (no variance). Pooled with a session where it is
    // absent, the table has variance and κ = 1 (perfect agreement throughout).
    const all = (n: number) => Array.from({ length: n }, (_, i) => p('Z', i));
    const g1 = sentenceGridKappa(4, all(4), all(4), { minActiveSentences: 1 });
    expect(g1.perCode.find((c) => c.code === 'Z')!.kappa).toBeNull();
    const g2 = sentenceGridKappa(6, [], [], { minActiveSentences: 1 });
    const pooled = poolSentenceGrids([g1, g2], { minActiveSentences: 1 });
    expect(pooled.perCode.find((c) => c.code === 'Z')!.kappa).toBeCloseTo(1, 9);
  });

  it('underpowered is judged on the POOLED active count', () => {
    // 2 active units per session, min 3: underpowered alone, powered pooled.
    const g1 = sentenceGridKappa(10, [p('X', 0), p('X', 1)], [p('X', 0), p('X', 1)], {
      minActiveSentences: 3,
    });
    expect(g1.perCode[0].underpowered).toBe(true);
    const g2 = sentenceGridKappa(10, [p('X', 5)], [p('X', 5)], { minActiveSentences: 3 });
    const pooled = poolSentenceGrids([g1, g2], { minActiveSentences: 3 });
    expect(pooled.perCode.find((c) => c.code === 'X')!.underpowered).toBe(false);
  });
});
