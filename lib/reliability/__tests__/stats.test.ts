import { describe, it, expect } from 'vitest';
import { percentAgreement, cohenKappa, pabak, prevalenceIndex, biasIndex,
         krippendorffAlphaNominal, landisKochBand, type LabelPair } from '@/lib/reliability/stats';

const close = (a: number, b: number, eps = 1e-3) => Math.abs(a - b) < eps;

describe('reliability stats', () => {
  const perfect: LabelPair[] = [['a','a'],['b','b'],['a','a']];
  it('Po=1, kappa=1 on perfect', () => {
    expect(percentAgreement(perfect)).toBe(1);
    expect(cohenKappa(perfect)).toBe(1);
  });
  it('cohen kappa matches hand calc on 2x2 (Po=.80, Pe=.50, k=.60)', () => {
    const pairs: LabelPair[] = [
      ...Array(45).fill(['yes','yes']), ...Array(15).fill(['yes','no']),
      ...Array(5).fill(['no','yes']),  ...Array(35).fill(['no','no']),
    ] as LabelPair[];
    expect(close(percentAgreement(pairs), 0.80)).toBe(true);
    expect(close(cohenKappa(pairs), 0.60)).toBe(true);
  });
  it('kappa paradox: 85% agreement but only "fair" kappa (skewed prevalence)', () => {
    const pairs: LabelPair[] = [
      ...Array(80).fill(['yes','yes']), ...Array(5).fill(['yes','no']),
      ...Array(10).fill(['no','yes']), ...Array(5).fill(['no','no']),
    ] as LabelPair[];
    expect(close(percentAgreement(pairs), 0.85)).toBe(true);
    expect(cohenKappa(pairs)).toBeGreaterThan(0.28);
    expect(cohenKappa(pairs)).toBeLessThan(0.36);        // ~0.318 — pins the paradox
    expect(landisKochBand(cohenKappa(pairs))).toBe('fair');
    expect(close(pabak(pairs)!, 0.70)).toBe(true);
    expect(pabak(pairs)!).toBeGreaterThan(cohenKappa(pairs)); // PABAK rescues
  });
  it('prevalence and bias indices (binary 2x2)', () => {
    const pairs: LabelPair[] = [
      ...Array(45).fill(['yes','yes']), ...Array(15).fill(['yes','no']),
      ...Array(5).fill(['no','yes']),  ...Array(35).fill(['no','no']),
    ] as LabelPair[];
    expect(close(prevalenceIndex(pairs)!, 0.10)).toBe(true);
    expect(close(biasIndex(pairs)!, 0.10)).toBe(true);
    expect(prevalenceIndex([['a','a'],['b','c'],['c','c']])).toBeNull(); // non-binary
  });
  it('single-category input returns kappa=1 by convention (no possible disagreement)', () => {
    // Documented convention: with one category, Pe=1, code returns 1. Statistically
    // kappa is undefined here; callers should treat single-category runs as degenerate.
    expect(cohenKappa([['a','a'],['a','a']])).toBe(1);
  });
  it('pabak = 2*Po - 1 for binary', () => {
    const pairs: LabelPair[] = [...Array(8).fill(['a','a']), ...Array(2).fill(['a','b'])] as LabelPair[];
    expect(close(pabak(pairs)!, 2*0.8 - 1)).toBe(true);
  });
  it('pabak null for >2 categories', () => {
    const pairs: LabelPair[] = [['a','a'],['b','c'],['c','c']];
    expect(pabak(pairs)).toBeNull();
  });
  it('krippendorff alpha ~ kappa on nominal 2-coder complete data', () => {
    const pairs: LabelPair[] = [
      ...Array(45).fill(['yes','yes']), ...Array(15).fill(['yes','no']),
      ...Array(5).fill(['no','yes']),  ...Array(35).fill(['no','no']),
    ] as LabelPair[];
    expect(close(krippendorffAlphaNominal(pairs), 0.60, 0.05)).toBe(true);
  });
  it('landis-koch bands', () => {
    expect(landisKochBand(0.05)).toBe('slight');
    expect(landisKochBand(0.7)).toBe('substantial');
    expect(landisKochBand(0.9)).toBe('almost perfect');
  });
});
