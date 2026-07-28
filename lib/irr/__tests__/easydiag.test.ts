import { describe, it, expect } from 'vitest';
import {
  overlapRatio,
  linkAnnotations,
  ipfExpected,
  kappaFromTable,
  ac1Binary,
  easyDiag,
  VOID,
  type Annotation,
} from '../easydiag';

const ann = (id: string, onset: number, offset: number, code: string): Annotation => ({
  id,
  onset,
  offset,
  code,
});

describe('overlapRatio (overlap / longer, per Holle & Rein / ELAN)', () => {
  it('identical intervals ratio 1', () => {
    expect(overlapRatio(ann('a', 0, 10, 'x'), ann('b', 0, 10, 'y'))).toBe(1);
  });
  it('denominator is the LONGER interval, not union', () => {
    // a=[0,10] (dur 10), b=[0,4] (dur 4). overlap=4. longer=10 → 0.4.
    // (union-based would be 4/10=0.4 here too; use asymmetric case to separate.)
    // a=[0,10], b=[8,20]: overlap=2, longer=12 → 2/12≈.1667; union=[0,20]=20 → .1.
    expect(overlapRatio(ann('a', 0, 10, 'x'), ann('b', 8, 20, 'y'))).toBeCloseTo(2 / 12, 6);
  });
  it('no overlap → 0', () => {
    expect(overlapRatio(ann('a', 0, 5, 'x'), ann('b', 6, 9, 'y'))).toBe(0);
  });
});

describe('linkAnnotations', () => {
  it('links the best-overlapping partner one-to-one', () => {
    const A = [ann('a1', 0, 10, 'X')];
    const B = [ann('b1', 1, 9, 'X'), ann('b2', 0, 3, 'X')];
    const { links, unmatchedA, unmatchedB } = linkAnnotations(A, B, 0.6);
    expect(links).toHaveLength(1);
    expect(links[0].b.id).toBe('b1'); // 8/10=0.8 beats 3/10=0.3 (and b2 fails threshold)
    expect(unmatchedA).toHaveLength(0);
    expect(unmatchedB.map((b) => b.id)).toEqual(['b2']);
  });
  it('below-threshold overlaps do not link', () => {
    const { links, unmatchedA, unmatchedB } = linkAnnotations(
      [ann('a', 0, 10, 'X')],
      [ann('b', 7, 20, 'X')], // overlap 3 / longer 13 ≈ .23 < .6
      0.6,
    );
    expect(links).toHaveLength(0);
    expect(unmatchedA).toHaveLength(1);
    expect(unmatchedB).toHaveLength(1);
  });
  it('is deterministic and does not double-use an annotation', () => {
    const A = [ann('a1', 0, 10, 'X'), ann('a2', 0, 10, 'X')];
    const B = [ann('b1', 0, 10, 'X')];
    const r1 = linkAnnotations(A, B, 0.6);
    const r2 = linkAnnotations(A, B, 0.6);
    expect(r1.links).toHaveLength(1);
    expect(r1.links.map((l) => l.a.id)).toEqual(r2.links.map((l) => l.a.id));
    expect(r1.unmatchedA).toHaveLength(1);
  });
});

describe('ipfExpected honours structural zeros', () => {
  it('keeps the structural-zero cell at 0 while matching marginals', () => {
    // 2x2 with (1,1) structural zero. Observed marginals must be reproduced.
    const observed = [
      [4, 2],
      [3, 0],
    ];
    const E = ipfExpected(observed, [[1, 1]]);
    expect(E[1][1]).toBe(0);
    // Row marginals preserved.
    expect(E[0][0] + E[0][1]).toBeCloseTo(6, 6);
    expect(E[1][0] + E[1][1]).toBeCloseTo(3, 6);
    // Column marginals preserved.
    expect(E[0][0] + E[1][0]).toBeCloseTo(7, 6);
    expect(E[0][1] + E[1][1]).toBeCloseTo(2, 6);
  });
});

describe('kappaFromTable', () => {
  it('perfect agreement (diagonal only) → κ = 1', () => {
    const t = [
      [5, 0, 0],
      [0, 7, 0],
      [0, 0, 0], // Void-Void structural zero
    ];
    expect(kappaFromTable(t, [[2, 2]])).toBeCloseTo(1, 6);
  });
  it('a 2-category table with a structural zero returns a finite κ ≤ 1', () => {
    const t = [
      [8, 2, 1],
      [1, 6, 2],
      [2, 1, 0],
    ];
    const k = kappaFromTable(t, [[2, 2]]);
    expect(k).not.toBeNull();
    expect(k!).toBeLessThanOrEqual(1);
    expect(k!).toBeGreaterThan(0);
  });
});

describe('ac1Binary', () => {
  it('perfect agreement → 1', () => {
    expect(ac1Binary(5, 0, 0, 5)).toBeCloseTo(1, 6);
  });
  it('is finite (not paradoxically zero) under high prevalence skew', () => {
    // Rare code: agree on absence 95 times, present twice, one miss each way.
    const ac1 = ac1Binary(2, 1, 1, 96)!;
    // Cohen's κ would be depressed here; AC1 stays high because agreement is real.
    expect(ac1).toBeGreaterThan(0.9);
  });
});

describe('easyDiag end-to-end', () => {
  it('perfect coders: segmentation and categorization both 1, κ = 1', () => {
    const A = [ann('a1', 0, 10, 'X'), ann('a2', 20, 30, 'Y')];
    const B = [ann('b1', 0, 10, 'X'), ann('b2', 20, 30, 'Y')];
    const r = easyDiag(A, B, { threshold: 0.6, minInstances: 1 });
    expect(r.nLinked).toBe(2);
    expect(r.segmentationAgreement).toBe(1);
    expect(r.categorizationAgreement).toBe(1);
    expect(r.overallKappa).toBeCloseTo(1, 6);
    expect(r.categories).toEqual(['X', 'Y', VOID]);
  });

  it('collapses the mic/echo duplicate-track split (the core reason for time-domain)', () => {
    // Same spoken moment ~[100,110]; coder A anchored the mic-track copy, coder B
    // the echo-track copy at a slightly shifted time. In SEGMENT-ordinal space
    // these are different units (phantom disagreement); in TIME they overlap and
    // link, so the coders AGREE. (Two codes so κ is well-defined — a single
    // category makes pₑ=1 and κ undefined, which never happens with 37 codes.)
    const A = [ann('a1', 100, 110, 'X'), ann('a2', 200, 210, 'Y')]; // mic track
    const B = [ann('b1', 101, 111, 'X'), ann('b2', 201, 211, 'Y')]; // echo track, ~1s shifted
    const r = easyDiag(A, B, { threshold: 0.6, minInstances: 1 });
    expect(r.nLinked).toBe(2);
    expect(r.categorizationAgreement).toBe(1);
    expect(r.overallKappa).toBeCloseTo(1, 6);
  });

  it('a single real category makes κ undefined (degenerate) but agreement is still reported', () => {
    const A = [ann('a', 0, 10, 'X')];
    const B = [ann('b', 0, 10, 'X')];
    const r = easyDiag(A, B, { threshold: 0.6, minInstances: 1 });
    expect(r.segmentationAgreement).toBe(1);
    expect(r.categorizationAgreement).toBe(1);
    expect(r.overallKappa).toBeNull(); // pₑ = 1 with one category
  });

  it('a code one coder never used lowers segmentation but is reported per-code', () => {
    const A = [ann('a1', 0, 10, 'X'), ann('a2', 20, 30, 'Z')];
    const B = [ann('b1', 0, 10, 'X')]; // never used Z
    const r = easyDiag(A, B, { threshold: 0.6, minInstances: 1 });
    expect(r.nLinked).toBe(1);
    expect(r.nUnmatchedA).toBe(1); // Z had no partner
    const z = r.perCode.find((p) => p.code === 'Z')!;
    expect(z.byCoderA).toBe(1);
    expect(z.byCoderB).toBe(0);
    expect(z.linkedBoth).toBe(0);
  });

  it('flags underpowered codes below minInstances', () => {
    const A = [ann('a1', 0, 10, 'X'), ann('a2', 20, 30, 'Rare')];
    const B = [ann('b1', 0, 10, 'X'), ann('b2', 20, 30, 'Rare')];
    const r = easyDiag(A, B, { threshold: 0.6, minInstances: 10 });
    expect(r.perCode.find((p) => p.code === 'Rare')!.underpowered).toBe(true);
    expect(r.perCode.find((p) => p.code === 'X')!.underpowered).toBe(true); // 2 < 10
  });

  it('disagreement on category with agreement on segmentation', () => {
    // Both mark an event at [0,10] but assign different codes.
    const A = [ann('a', 0, 10, 'X')];
    const B = [ann('b', 0, 10, 'Y')];
    const r = easyDiag(A, B, { threshold: 0.6, minInstances: 1 });
    expect(r.segmentationAgreement).toBe(1); // agreed there IS an event
    expect(r.categorizationAgreement).toBe(0); // disagreed on WHICH code
  });
});
