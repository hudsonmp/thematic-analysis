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
  it('kappa paradox: high Po, depressed kappa, PABAK rescues', () => {
    const pairs: LabelPair[] = [
      ...Array(85).fill(['yes','yes']), ...Array(5).fill(['yes','no']),
      ...Array(5).fill(['no','yes']),  ...Array(5).fill(['no','no']),
    ] as LabelPair[];
    expect(percentAgreement(pairs)).toBeGreaterThan(0.85);
    expect(cohenKappa(pairs)).toBeLessThan(0.5);
    expect(pabak(pairs)!).toBeGreaterThan(cohenKappa(pairs));
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
