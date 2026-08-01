/**
 * cooccurrence — code × code co-occurrence over coding UNITS (segments/sentences).
 *
 * David Smith's Tuesday guidance: alongside per-code agreement, plot a heat map of
 * "codebook correlated to the codebook" over co-occurrences. When two codes are
 * highly correlated AND agree poorly, that is a signal they should be MERGED or
 * that a definition lacks clarity. The diagonal is 1 (a code always co-occurs with
 * itself); off-diagonal cells are the phi correlation of the two codes' per-unit
 * presence vectors, pooled across coders.
 *
 * Pooling: a unit "has" a code if EITHER coder applied it there (union). So the
 * matrix answers "do these two codes tend to land on the same unit", independent of
 * who coded — which is the redundancy question a merge decision needs.
 *
 * phi (the Pearson correlation of two binary vectors):
 *   phi = (n·n11 − n1·n1') / sqrt(n1·n0·n1'·n0')
 * where n11 = units with both, n1/n1' = units with each, n0/n0' = complements,
 * n = unit count. A code present on every unit or no unit has zero variance, so its
 * correlations are undefined (null) — surfaced as blank cells, not fake zeros.
 *
 * Pure: unit-code pairs in, numbers out. No DB, no DOM.
 */

/** One code applied on one unit (segment/sentence index) by SOME coder. */
export type UnitCode = { unit: number; code: string };

export type CooccurrenceResult = {
  /** Codes in row/column order (prevalence desc, then name). */
  codes: string[];
  /** phi correlation; diagonal = 1; null where a code has no variance. */
  matrix: (number | null)[][];
  /** Co-occurrence counts: units where BOTH codes are present. Diagonal = the
   *  code's own unit count (its prevalence numerator). */
  counts: number[][];
  /** Per-code unit count (how many units carry the code, pooled). */
  unitCount: number[];
  /** Total units. */
  nUnits: number;
};

/**
 * Build the co-occurrence result. `codeFilter`, when given, restricts the matrix to
 * those code mnemonics (and their order is preserved for the axes if all are
 * present; otherwise prevalence order). Codes never applied to any unit are dropped.
 */
export function codeCooccurrence(
  nUnits: number,
  pooled: UnitCode[],
  opts: { codeFilter?: string[] | null } = {},
): CooccurrenceResult {
  // unit-presence set per code.
  const byCode = new Map<string, Set<number>>();
  for (const { unit, code } of pooled) {
    if (unit < 0 || unit >= nUnits) continue;
    let s = byCode.get(code);
    if (!s) byCode.set(code, (s = new Set()));
    s.add(unit);
  }

  let codes = [...byCode.keys()];
  if (opts.codeFilter && opts.codeFilter.length) {
    const allow = new Set(opts.codeFilter);
    codes = codes.filter((c) => allow.has(c));
  }
  // Order: prevalence desc, then name — matches the per-code table so rows line up.
  codes.sort((a, b) => (byCode.get(b)!.size - byCode.get(a)!.size) || a.localeCompare(b));

  const sets = codes.map((c) => byCode.get(c)!);
  const unitCount = sets.map((s) => s.size);

  const counts: number[][] = codes.map(() => codes.map(() => 0));
  const matrix: (number | null)[][] = codes.map(() => codes.map(() => null));

  for (let i = 0; i < codes.length; i++) {
    for (let j = i; j < codes.length; j++) {
      const a = sets[i];
      const b = sets[j];
      // n11 = |a ∩ b|
      let n11 = 0;
      const [small, big] = a.size <= b.size ? [a, b] : [b, a];
      for (const u of small) if (big.has(u)) n11++;
      counts[i][j] = counts[j][i] = n11;
      if (i === j) {
        matrix[i][j] = 1;
        continue;
      }
      const n1 = a.size;
      const n1p = b.size;
      const n0 = nUnits - n1;
      const n0p = nUnits - n1p;
      const denom = Math.sqrt(n1 * n0 * n1p * n0p);
      const phi = denom === 0 ? null : (nUnits * n11 - n1 * n1p) / denom;
      matrix[i][j] = matrix[j][i] = phi;
    }
  }

  return { codes, matrix, counts, unitCount, nUnits };
}

/**
 * Merge candidates: code pairs that are highly correlated yet at least one has weak
 * agreement — David's "highly correlated + bad agreement → merge" signal. `kappaByCode`
 * maps mnemonic → strict per-code κ (null when undefined/underpowered). A pair is
 * flagged when |phi| ≥ `corrThreshold` and min(κ_a, κ_b) < `kappaThreshold` (a null κ
 * counts as weak, since an uncertifiable code that co-occurs is exactly the concern).
 */
export function mergeCandidates(
  co: CooccurrenceResult,
  kappaByCode: Record<string, number | null>,
  opts: { corrThreshold?: number; kappaThreshold?: number } = {},
): { a: string; b: string; corr: number; jointUnits: number; weakKappa: number | null }[] {
  const corrT = opts.corrThreshold ?? 0.5;
  const kT = opts.kappaThreshold ?? 0.6;
  const out: { a: string; b: string; corr: number; jointUnits: number; weakKappa: number | null }[] = [];
  for (let i = 0; i < co.codes.length; i++) {
    for (let j = i + 1; j < co.codes.length; j++) {
      const phi = co.matrix[i][j];
      if (phi === null || phi < corrT) continue;
      const ka = kappaByCode[co.codes[i]] ?? null;
      const kb = kappaByCode[co.codes[j]] ?? null;
      const weak = ka === null || kb === null ? null : Math.min(ka, kb);
      const isWeak = ka === null || kb === null || (weak !== null && weak < kT);
      if (!isWeak) continue;
      out.push({ a: co.codes[i], b: co.codes[j], corr: phi, jointUnits: co.counts[i][j], weakKappa: weak });
    }
  }
  return out.sort((x, y) => y.corr - x.corr);
}
