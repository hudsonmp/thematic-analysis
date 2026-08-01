import { describe, it, expect } from 'vitest';
import {
  sentenceGridKappa,
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
