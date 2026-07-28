import { describe, it, expect } from 'vitest';
import { cohenKappaBinary, type Annotation } from '../easydiag';
import { timeGridKappa } from '../timegrid';

const ann = (id: string, onset: number, offset: number, code: string): Annotation => ({
  id,
  onset,
  offset,
  code,
});

describe('cohenKappaBinary', () => {
  it('perfect agreement → 1', () => {
    expect(cohenKappaBinary(10, 0, 0, 10)).toBeCloseTo(1, 6);
  });
  it('chance-level agreement → ~0', () => {
    // Independent coders each active half the time: po = .5, pe = .5 → κ = 0.
    expect(cohenKappaBinary(25, 25, 25, 25)).toBeCloseTo(0, 6);
  });
  it('both-no is real agreement (not a structural zero)', () => {
    // 8 both-yes, 0 disagree, 90 both-no → near-perfect κ (unlike EasyDIAg where
    // both-no would be excluded).
    const k = cohenKappaBinary(8, 1, 1, 90)!;
    expect(k).toBeGreaterThan(0.8);
  });
});

describe('timeGridKappa', () => {
  it('identical coding → segmentation κ = 1 and per-code κ = 1', () => {
    const A = [ann('a1', 0, 10000, 'X'), ann('a2', 20000, 30000, 'Y')];
    const B = [ann('b1', 0, 10000, 'X'), ann('b2', 20000, 30000, 'Y')];
    const r = timeGridKappa(A, B, { binMs: 1000, minActiveBins: 1 });
    expect(r.segmentationKappa).toBeCloseTo(1, 6);
    for (const p of r.perCode) expect(p.kappa).toBeCloseTo(1, 6);
  });

  it('boundary jitter still agrees on the grid (the whole point)', () => {
    // Two coded regions with an uncoded gap between (so κ is well-defined via
    // real both-empty bins). Edges jitter by <1 bin; the shared bins dominate.
    const A = [ann('a1', 2000, 6000, 'X'), ann('a2', 12000, 16000, 'X')];
    const B = [ann('b1', 2300, 6200, 'X'), ann('b2', 12100, 15800, 'X')];
    const r = timeGridKappa(A, B, { binMs: 2000, minActiveBins: 1 });
    expect(r.perCode[0].kappa).not.toBeNull();
    // Moderate-to-high κ preserved despite jitter — contrast EasyDIAg, where the
    // same boundary offset collapses well-sampled codes toward 0.
    expect(r.perCode[0].kappa!).toBeGreaterThan(0.6);
  });

  it('disjoint coding on the same code → low κ', () => {
    const A = [ann('a', 0, 10000, 'X')];
    const B = [ann('b', 40000, 50000, 'X')];
    const r = timeGridKappa(A, B, { binMs: 1000, minActiveBins: 1 });
    // No shared active bin → κ ≤ 0.
    expect(r.perCode[0].bothActive).toBe(0);
    expect(r.perCode[0].kappa!).toBeLessThanOrEqual(0);
  });

  it('counts one-sided coding time (the density asymmetry)', () => {
    // A codes a long stretch, B a short one inside it.
    const A = [ann('a', 0, 20000, 'X')];
    const B = [ann('b', 0, 5000, 'X')];
    const r = timeGridKappa(A, B, { binMs: 1000, minActiveBins: 1 });
    expect(r.perCode[0].bothActive).toBe(5); // 0–5s shared
    expect(r.perCode[0].aOnly).toBe(15); // 5–20s A only
    expect(r.perCode[0].bOnly).toBe(0);
  });

  it('flags underpowered codes and computes mean over powered ones', () => {
    const A = [ann('a1', 0, 10000, 'Common'), ann('a2', 20000, 21000, 'Rare')];
    const B = [ann('b1', 0, 10000, 'Common'), ann('b2', 20000, 21000, 'Rare')];
    const r = timeGridKappa(A, B, { binMs: 1000, minActiveBins: 5 });
    expect(r.perCode.find((p) => p.code === 'Rare')!.underpowered).toBe(true);
    expect(r.perCode.find((p) => p.code === 'Common')!.underpowered).toBe(false);
    expect(r.meanKappaPowered).toBeCloseTo(1, 6); // only Common counts, κ=1
  });

  it('empty input is safe', () => {
    const r = timeGridKappa([], [], {});
    expect(r.nBins).toBe(0);
    expect(r.segmentationKappa).toBeNull();
    expect(r.perCode).toEqual([]);
  });
});
