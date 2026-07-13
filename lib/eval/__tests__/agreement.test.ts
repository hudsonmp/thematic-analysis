// Unit tests for the PURE agreement math (Task B2-4). Hand-computed Cohen's κ
// fixtures — the arithmetic is spelled out in each comment so a reviewer can
// re-derive κ without trusting the implementation. All fixtures are pairwise-
// complete-only (both non-null) unless a test is specifically probing null
// exclusion.

import { describe, expect, it } from 'vitest';
import { cohensKappa, disagreements } from '@/lib/eval/agreement';

describe('cohensKappa — core κ arithmetic', () => {
  it('perfect agreement over a balanced table → κ = 1', () => {
    // a = [T,T,F,F], b = [T,T,F,F].
    // p_o = 4/4 = 1. Marginals: A = {T:2,F:2}, B = {T:2,F:2}.
    // p_e = (2/4)(2/4) + (2/4)(2/4) = 0.25 + 0.25 = 0.5.
    // κ = (1 − 0.5) / (1 − 0.5) = 1.
    const r = cohensKappa([true, true, false, false], [true, true, false, false]);
    expect(r.n).toBe(4);
    expect(r.agreement).toBe(1);
    expect(r.kappa).toBeCloseTo(1, 12);
  });

  it('independence (p_o = p_e) → κ ≈ 0', () => {
    // a = [T,T,F,F], b = [T,F,T,F] — the raters are statistically independent.
    // Confusion cells each = 1 → p_o = (TT + FF)/4 = (1 + 1)/4 = 0.5.
    // Marginals: A = {T:2,F:2}, B = {T:2,F:2} → p_e = 0.25 + 0.25 = 0.5.
    // κ = (0.5 − 0.5) / (1 − 0.5) = 0.
    const r = cohensKappa([true, true, false, false], [true, false, true, false]);
    expect(r.n).toBe(4);
    expect(r.agreement).toBeCloseTo(0.5, 12);
    expect(r.kappa).toBeCloseTo(0, 12);
  });

  it('partial agreement → hand-computed κ', () => {
    // a = [T,T,T,T,F,F,F,F], b = [T,T,T,F,F,F,F,T]  (n = 8).
    // Cells: TT = 3, TF = 1, FT = 1, FF = 3.
    // p_o = (3 + 3)/8 = 0.75.
    // Marginals: A = {T:4,F:4}=0.5/0.5; B = {T:4,F:4}=0.5/0.5.
    // p_e = 0.25 + 0.25 = 0.5. κ = (0.75 − 0.5)/(1 − 0.5) = 0.5.
    const a = [true, true, true, true, false, false, false, false];
    const b = [true, true, true, false, false, false, false, true];
    const r = cohensKappa(a, b);
    expect(r.n).toBe(8);
    expect(r.agreement).toBeCloseTo(0.75, 12);
    expect(r.kappa).toBeCloseTo(0.5, 12);
  });

  it('asymmetric marginals → κ from the general formula', () => {
    // a = [T,T,T,F], b = [T,T,F,F]  (n = 4).
    // Cells: TT = 2, TF = 1, FT = 0, FF = 1.
    // p_o = (2 + 1)/4 = 0.75.
    // Marginals: A = {T:3,F:1}=0.75/0.25; B = {T:2,F:2}=0.5/0.5.
    // p_e = (0.75)(0.5) + (0.25)(0.5) = 0.375 + 0.125 = 0.5.
    // κ = (0.75 − 0.5)/(1 − 0.5) = 0.5.
    const r = cohensKappa([true, true, true, false], [true, true, false, false]);
    expect(r.n).toBe(4);
    expect(r.agreement).toBeCloseTo(0.75, 12);
    expect(r.kappa).toBeCloseTo(0.5, 12);
  });
});

describe('cohensKappa — constant-rater edge (documented convention)', () => {
  it('both raters constant AND agreeing → κ = 1 (not null)', () => {
    // a = b = [T,T,T]. p_o = 1, p_e = 1 (both marginals degenerate on T).
    // Raw formula is 0/0; convention: observed agreement is 1 ⇒ κ = 1.
    const r = cohensKappa([true, true, true], [true, true, true]);
    expect(r.n).toBe(3);
    expect(r.agreement).toBe(1);
    expect(r.kappa).toBe(1);
  });

  it('one rater constant, the raters disagree everywhere → κ = 0 (not null)', () => {
    // a = [T,T,T] (constant), b = [F,F,F]. p_o = 0.
    // A rater is constant ⇒ κ undefined in the standard sense; convention:
    // observed agreement is not 1 ⇒ κ = 0.
    const r = cohensKappa([true, true, true], [false, false, false]);
    expect(r.n).toBe(3);
    expect(r.agreement).toBe(0);
    expect(r.kappa).toBe(0);
  });

  it('one rater constant, mixed observed agreement → κ = 0 (not null)', () => {
    // a = [T,T,T] (constant), b = [T,F,T]. p_o = 2/3 ≠ 1 ⇒ convention κ = 0.
    const r = cohensKappa([true, true, true], [true, false, true]);
    expect(r.n).toBe(3);
    expect(r.agreement).toBeCloseTo(2 / 3, 12);
    expect(r.kappa).toBe(0);
  });
});

describe('cohensKappa — pairwise-complete-only (nulls excluded from n)', () => {
  it('excludes any pair where EITHER rater is null', () => {
    // Full arrays length 6; null on either side drops the pair.
    // a = [T,   T,    null, F,    F,    null]
    // b = [T,   null, F,    F,    F,    T   ]
    // Complete pairs (both non-null): idx0 (T,T), idx3 (F,F), idx4 (F,F).
    // n = 3, all agree ⇒ p_o = 1. Marginals both {F:2,T:1}... actually
    // A over kept = {T:1,F:2}, B = {T:1,F:2}: p_e = (1/3)(1/3)+(2/3)(2/3)
    // = 1/9 + 4/9 = 5/9. κ = (1 − 5/9)/(1 − 5/9) = 1.
    const a = [true, true, null, false, false, null];
    const b = [true, null, false, false, false, true];
    const r = cohensKappa(a, b);
    expect(r.n).toBe(3);
    expect(r.agreement).toBe(1);
    expect(r.kappa).toBe(1);
  });

  it('n === 0 (no complete pairs) → κ null, agreement null', () => {
    const r = cohensKappa([null, null], [true, null]);
    expect(r.n).toBe(0);
    expect(r.kappa).toBeNull();
    expect(r.agreement).toBeNull();
  });

  it('empty inputs → κ null, agreement null, n 0', () => {
    const r = cohensKappa([], []);
    expect(r).toEqual({ kappa: null, agreement: null, n: 0 });
  });

  it('throws when the two rater arrays differ in length (misaligned pairs)', () => {
    expect(() => cohensKappa([true], [true, false])).toThrow();
  });
});

describe('disagreements', () => {
  type Pair = { pid: string; phase: number; scenario: number; passA: boolean | null; passB: boolean | null };
  const key = (p: Pair) => `${p.pid}|${p.phase}|${p.scenario}`;

  it('returns only the discordant pairs, preserving input order', () => {
    const items: Pair[] = [
      { pid: '1', phase: 0, scenario: 0, passA: true, passB: true }, // concord
      { pid: '1', phase: 0, scenario: 1, passA: true, passB: false }, // discord
      { pid: '2', phase: 1, scenario: 0, passA: false, passB: false }, // concord
      { pid: '2', phase: 1, scenario: 1, passA: null, passB: true }, // discord (null vs T)
      { pid: '3', phase: 2, scenario: 3, passA: false, passB: null }, // discord (F vs null)
    ];
    const out = disagreements(
      items,
      key,
      (p) => p.passA,
      (p) => p.passB,
    );
    expect(out.map((o) => o.key)).toEqual(['1|0|1', '2|1|1', '3|2|3']);
    expect(out[0].a).toBe(true);
    expect(out[0].b).toBe(false);
    expect(out[1].a).toBeNull();
    expect(out[1].b).toBe(true);
  });

  it('treats null≠null as concordant only when both are null (null == null → concord)', () => {
    const items: Pair[] = [
      { pid: '1', phase: 0, scenario: 0, passA: null, passB: null }, // concord (both null)
    ];
    const out = disagreements(items, key, (p) => p.passA, (p) => p.passB);
    expect(out).toEqual([]);
  });

  it('empty input → empty output', () => {
    expect(disagreements([], key, () => true, () => true)).toEqual([]);
  });
});
