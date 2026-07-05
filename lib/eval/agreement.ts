// PURE agreement math for the eval harness (Task B2-4). No I/O, no server-only,
// no LLM — it takes two rater vectors (or a list of verdict pairs) and returns
// Cohen's κ and the discordant pairs. Kept pure so vitest pins the arithmetic
// directly (lib/eval/__tests__/agreement.test.ts) and the run executor
// (runs.ts) can import it into a 'use server' file without dragging any
// server-only dependency into the test path.
//
// WHY Cohen's κ (not raw % agreement): two graders scoring the SAME binary
// pass/fail can agree by chance, and how much chance buys depends on how
// lopsided the pass rate is. κ is agreement corrected for that chance
// expectation — the standard inter-rater statistic for two raters over a
// nominal label. Raw observed agreement is ALSO returned (it is what a reader
// intuits) but κ is the headline.
//
// SCOPE: binary labels only (boolean|null). `null` = "this rater could not
// grade this cell" (a Verdict with pass:null) and is EXCLUDED pairwise — a cell
// counts toward κ only when BOTH raters produced a boolean. This is listwise
// deletion on the pair, the honest default: a κ computed over cells where one
// rater abstained would not be measuring agreement.

/** Result of comparing two binary rater vectors.
 *  - `n` = number of PAIRWISE-COMPLETE cells (both raters non-null).
 *  - `agreement` = raw observed proportion of agreeing complete cells, or null
 *    when n === 0.
 *  - `kappa` = Cohen's κ over the complete cells, or null when n === 0.
 *    In the constant-rater edge (see below) κ resolves to a NUMBER (0 or 1) per
 *    the documented convention, never null. */
export type KappaResult = { kappa: number | null; agreement: number | null; n: number };

/**
 * Cohen's κ between two aligned binary rater vectors.
 *
 * PAIRWISE-COMPLETE ONLY: a cell where either `a[i]` or `b[i]` is null is
 * dropped; `n` is the count of surviving cells. n === 0 ⇒ nothing to measure ⇒
 * `{ kappa: null, agreement: null, n: 0 }`.
 *
 * CONSTANT-RATER EDGE (documented convention): κ = (p_o − p_e) / (1 − p_e) is
 * undefined when a denominator collapses — this happens exactly when at least
 * one rater is CONSTANT over the complete cells (all-true or all-false), which
 * pins its marginal and can drive p_e to 1 (0/0). The standard formula gives
 * NaN there. Convention adopted (and asserted in tests): when EITHER rater is
 * constant, return κ = 1 if observed agreement is also 1 (they agree on every
 * cell — perfect concordance deserves κ = 1), else κ = 0 (no chance-corrected
 * credit is defensible when one rater has no variance). This is the widely-used
 * "degenerate → {0,1} by observed agreement" convention; the alternative
 * (return null) is rejected here because the run executor wants a comparable
 * number, and a constant-and-agreeing pair genuinely IS perfect agreement.
 *
 * Throws when the two vectors differ in length: a length mismatch means the
 * caller failed to align cells by (pid, phase, scenario), and silently zipping
 * the shorter length would fabricate a comparison over mismatched cells.
 */
export function cohensKappa(a: (boolean | null)[], b: (boolean | null)[]): KappaResult {
  if (a.length !== b.length) {
    throw new Error(
      `cohensKappa: rater vectors differ in length (${a.length} vs ${b.length}) — cells must be aligned before comparison.`,
    );
  }

  // Pairwise-complete filter: keep only cells where BOTH raters produced a
  // boolean. This is where `null` (ungradable) leaves the computation.
  const pairs: { a: boolean; b: boolean }[] = [];
  for (let i = 0; i < a.length; i++) {
    const ai = a[i];
    const bi = b[i];
    if (ai === null || bi === null) continue;
    pairs.push({ a: ai, b: bi });
  }

  const n = pairs.length;
  if (n === 0) return { kappa: null, agreement: null, n: 0 };

  // 2×2 confusion over {true,false}. `count[X][Y]` = # cells where A said X and
  // B said Y (index 1 = true, 0 = false).
  let both1 = 0; // A true,  B true
  let a1b0 = 0; // A true,  B false
  let a0b1 = 0; // A false, B true
  let both0 = 0; // A false, B false
  for (const p of pairs) {
    if (p.a && p.b) both1++;
    else if (p.a && !p.b) a1b0++;
    else if (!p.a && p.b) a0b1++;
    else both0++;
  }

  const observed = (both1 + both0) / n;

  // Marginals (per-rater proportion of `true`).
  const aTrue = (both1 + a1b0) / n;
  const aFalse = 1 - aTrue;
  const bTrue = (both1 + a0b1) / n;
  const bFalse = 1 - bTrue;

  // A rater is constant ⇔ its `true` marginal is exactly 0 or 1 (no variance).
  const aConstant = aTrue === 0 || aTrue === 1;
  const bConstant = bTrue === 0 || bTrue === 1;
  if (aConstant || bConstant) {
    // Documented convention (see JSDoc): degenerate marginal ⇒ κ by observed
    // agreement, never NaN, never null.
    return { kappa: observed === 1 ? 1 : 0, agreement: observed, n };
  }

  const expected = aTrue * bTrue + aFalse * bFalse;
  // Neither rater is constant here, so 0 < aTrue,bTrue < 1 ⇒ expected < 1 ⇒
  // (1 − expected) > 0: the division is always well-defined at this point.
  const kappa = (observed - expected) / (1 - expected);
  return { kappa, agreement: observed, n };
}

/** One discordant cell: its grouping `key` plus the two raters' labels. */
export type Disagreement<TVal = boolean | null> = { key: string; a: TVal; b: TVal };

/**
 * Discordant-cell helper for the run executor's comparison report. Given a list
 * of already-JOINED verdict pairs, `key` maps each to its cell identity (the
 * executor uses `pid|phaseOrdinal|scenarioIdx`), and `passA`/`passB` extract the
 * two raters' pass labels. Returns the pairs whose labels DIFFER, in input
 * order (the caller controls ordering; this helper does not sort).
 *
 * Concordance rule: `a === b` (so null === null is concordant — both raters
 * abstained on the same cell, which is agreement about ungradability, not a
 * disagreement to surface). Every other combination — true/false, true/null,
 * false/null — is a disagreement. This matches κ's pairwise-complete filter
 * only loosely on purpose: κ DROPS null cells from its denominator, whereas the
 * disagreement list SURFACES a null-vs-boolean cell, because "one grader could
 * grade this and the other couldn't" is exactly the kind of cell a researcher
 * wants to inspect even though it does not enter the κ arithmetic.
 */
export function disagreements<T, TVal = boolean | null>(
  items: T[],
  key: (t: T) => string,
  passA: (t: T) => TVal,
  passB: (t: T) => TVal,
): Disagreement<TVal>[] {
  const out: Disagreement<TVal>[] = [];
  for (const item of items) {
    const a = passA(item);
    const b = passB(item);
    if (a !== b) out.push({ key: key(item), a, b });
  }
  return out;
}
