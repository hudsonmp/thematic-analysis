export type LabelPair = [string, string]; // [coderA, coderB] per unit

export function percentAgreement(pairs: LabelPair[]): number {
  if (!pairs.length) return NaN;
  const agree = pairs.filter(([a, b]) => a === b).length;
  return agree / pairs.length;
}
function categories(pairs: LabelPair[]): string[] { return [...new Set(pairs.flat())]; }

export function cohenKappa(pairs: LabelPair[]): number {
  const n = pairs.length; if (!n) return NaN;
  const po = percentAgreement(pairs);
  const cats = categories(pairs);
  const aCount: Record<string, number> = {}, bCount: Record<string, number> = {};
  for (const c of cats) { aCount[c] = 0; bCount[c] = 0; }
  for (const [a, b] of pairs) { aCount[a]++; bCount[b]++; }
  const pe = cats.reduce((s, c) => s + (aCount[c] / n) * (bCount[c] / n), 0);
  return pe === 1 ? 1 : (po - pe) / (1 - pe);
}

/** Binary-only (exactly 2 distinct labels). Returns null otherwise. */
export function pabak(pairs: LabelPair[]): number | null {
  if (categories(pairs).length !== 2) return null;
  return 2 * percentAgreement(pairs) - 1;
}

/** Prevalence index (binary 2x2): |n_bothX - n_bothY| / N ; null if non-binary. */
export function prevalenceIndex(pairs: LabelPair[]): number | null {
  const cats = categories(pairs); if (cats.length !== 2) return null;
  const [x, y] = cats; const n = pairs.length;
  const bothX = pairs.filter(([a, b]) => a === x && b === x).length;
  const bothY = pairs.filter(([a, b]) => a === y && b === y).length;
  return Math.abs(bothX - bothY) / n;
}

/** Bias index (binary): |a_X - b_X| / N ; null if non-binary. */
export function biasIndex(pairs: LabelPair[]): number | null {
  const cats = categories(pairs); if (cats.length !== 2) return null;
  const [x] = cats; const n = pairs.length;
  const aX = pairs.filter(([a]) => a === x).length;
  const bX = pairs.filter(([, b]) => b === x).length;
  return Math.abs(aX - bX) / n;
}

/** Krippendorff's alpha, nominal, complete data. Coincidence-matrix (Hayes &
 *  Krippendorff 2007). Input is 2-coder LabelPair[]; each pair is one unit. */
export function krippendorffAlphaNominal(pairs: LabelPair[]): number {
  const units = pairs.map((p) => [...p]);
  const cats = categories(pairs);
  const o: Record<string, Record<string, number>> = {};
  for (const c of cats) { o[c] = {}; for (const k of cats) o[c][k] = 0; }
  for (const unit of units) {
    const m = unit.length; if (m < 2) continue;
    for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) if (i !== j) o[unit[i]][unit[j]] += 1 / (m - 1);
  }
  const nc: Record<string, number> = {};
  for (const c of cats) nc[c] = cats.reduce((s, k) => s + o[c][k], 0);
  const n = cats.reduce((s, c) => s + nc[c], 0);
  let Do = 0; for (const c of cats) for (const k of cats) if (c !== k) Do += o[c][k];
  let De = 0; for (const c of cats) for (const k of cats) if (c !== k) De += nc[c] * nc[k];
  De = De / (n - 1);
  return De === 0 ? 1 : 1 - Do / De;
}

export type KappaBand = 'poor'|'slight'|'fair'|'moderate'|'substantial'|'almost perfect';
export function landisKochBand(k: number): KappaBand {
  if (k < 0) return 'poor';
  if (k <= 0.20) return 'slight';
  if (k <= 0.40) return 'fair';
  if (k <= 0.60) return 'moderate';
  if (k <= 0.80) return 'substantial';
  return 'almost perfect';
}

export const MIS_CARVED_THRESHOLD = 0.5;
export function isMisCarved(k: number): boolean { return k < MIS_CARVED_THRESHOLD; }
