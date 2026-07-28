/**
 * easydiag — inter-rater reliability for TIME-ANCHORED, open-span code
 * annotations, following Holle & Rein's EasyDIAg method (Behavior Research
 * Methods, 2014; doi:10.3758/s13428-014-0506-7).
 *
 * ── Why this method, for this data ──────────────────────────────────────────
 * Our coders highlight arbitrary character/time spans and attach codes; they
 * never select identical ranges, so agreement is undefined until the two
 * codings are reconciled onto a shared frame. Two families exist (Bakeman,
 * Quera & Gnisci 2009, doi:10.3758/brm.41.1.137): a TIME-BASED grid (slice the
 * session into fixed units, agree per unit) and an EVENT-BASED match (pair the
 * coders' events, then score). We use the event-based family because:
 *
 *   1. The transcript has a THREE-TRACK structure — participant mic, interviewer
 *      mic, and an un-named "Speaker" room-audio track that duplicates both.
 *      41% of our code anchors sit on the echo track. Snapping to segment
 *      ORDINALS would record phantom disagreement whenever two coders anchored
 *      the same spoken moment to different tracks. Working in the TIME domain
 *      collapses the duplicate tracks automatically: a mic-track code and an
 *      echo-track code for the same moment overlap in time and therefore link.
 *
 *   2. A fixed onset tolerance ("±5 s") is scale-dependent — 5 s is loose for a
 *      one-second exclamation code and strict for a thirty-second reasoning
 *      code, and our scheme spans both. EasyDIAg's proportional overlap
 *      criterion is scale-invariant, so one threshold is fair across the whole
 *      codebook (Holle & Rein 2014).
 *
 * ── The algorithm (faithful to Holle & Rein / the ELAN implementation) ──────
 *  A) Each annotation is an interval [onset, offset] carrying one category
 *     (the code). Overlap of two intervals a, b is
 *         ov(a,b) = max(0, min(a.off,b.off) − max(a.on,b.on)).
 *  B) LINKING criterion: a (coder-1) and b (coder-2) may link iff
 *         ov(a,b) / max(dur(a), dur(b)) ≥ threshold        (default 0.60).
 *     Denominator is the LONGER of the two annotations — the ELAN/EasyDIAg
 *     definition, NOT intersection-over-union. One-to-one matching is resolved
 *     greedily by descending overlap ratio (each annotation links at most once);
 *     this is a deterministic approximation of EasyDIAg's global assignment and
 *     agrees with it on all non-pathological cases.
 *  C) CONFUSION TABLE over categories, plus a "Void" row and column for
 *     annotations one coder made and the other did not ("unmatched"). A linked
 *     pair increments (catA, catB); an unmatched coder-1 event increments
 *     (catA, Void); an unmatched coder-2 event increments (Void, catB). The
 *     (Void, Void) cell is a STRUCTURAL ZERO — an event marked by neither coder
 *     cannot exist — so it is never filled.
 *  D) CHANCE-CORRECTED κ via ITERATIVE PROPORTIONAL FITTING (Deming & Stephan
 *     1940). Because (Void, Void) is a structural zero, standard Cohen's pₑ
 *     (product of marginals) is invalid; IPF fits an independence-model expected
 *     table to the observed marginals while holding the structural-zero cell at
 *     0. κ = (pₒ − pₑ)/(1 − pₑ) from that fitted table. This is the core reason
 *     EasyDIAg exists and the detail a naive κ gets wrong.
 *
 * ── What we add on top (grounded in the reliability-statistics synthesis) ───
 *  • PER-CODE reliability, never a single pooled number: a pooled κ averages
 *    high-prevalence codes with rare ones and hides which are unreliable
 *    (Feinstein & Cicchetti 1990). Per code we collapse the table to
 *    {k, ¬k, Void} and run the same IPF-κ.
 *  • Each per-code κ is reported beside PREVALENCE, raw categorization
 *    agreement, and Gwet's AC1 (doi:10.1348/000711006X126600) — a
 *    paradox-robust coefficient — so a low κ next to high agreement and low
 *    prevalence is legible as a base-rate artifact, not real disagreement.
 *  • An INSTANCE-COUNT guard flags codes with too few linked+unmatched events to
 *    estimate reliability at all (Hallgren 2012, doi:10.20982/tqmp.08.1.p023).
 *
 * Pure: intervals in, numbers out. No I/O, no DB, no dates.
 */

export type Annotation = {
  /** Stable id (for debugging / matching provenance). */
  id: string;
  /** Interval start / end in ms on the recording clock (post track-collapse:
   *  both tracks are on the same anchorMs timeline, so overlap is meaningful). */
  onset: number;
  offset: number;
  /** The code applied. A single annotation carrying several codes is expanded
   *  to one Annotation per code by the caller, so category is singular here. */
  code: string;
};

export type EasyDiagOptions = {
  /** Minimal overlap ratio to link two annotations (Holle & Rein default 0.60). */
  threshold?: number;
  /** Codes below this many total events (linked + unmatched, either coder) are
   *  flagged `underpowered` — too few instances for a trustworthy estimate. */
  minInstances?: number;
};

export type LinkedPair = { a: Annotation; b: Annotation; overlap: number };

export type PerCodeResult = {
  code: string;
  /** IPF-κ for the binary {this code vs. not} decision, incl. the Void margin. */
  kappa: number | null;
  /** Gwet's AC1 over linked pairs (paradox-robust). */
  ac1: number | null;
  /** Raw categorization agreement over linked pairs where either coder used k. */
  rawAgreement: number | null;
  /** Prevalence = share of all events (either coder) that carry this code. */
  prevalence: number;
  /** Counts feeding the estimate. */
  byCoderA: number;
  byCoderB: number;
  linkedBoth: number; // linked pairs where BOTH said k
  /** True when total instances < minInstances — estimate not trustworthy. */
  underpowered: boolean;
};

export type EasyDiagResult = {
  threshold: number;
  /** Events per coder (after per-code expansion). */
  nEventsA: number;
  nEventsB: number;
  /** Linked pairs and the leftovers. */
  nLinked: number;
  nUnmatchedA: number;
  nUnmatchedB: number;
  /** SEGMENTATION agreement: share of all events that found a partner —
   *  agreement on WHERE events are, ignoring which code. */
  segmentationAgreement: number;
  /** Overall multi-category IPF-κ (segmentation + categorization jointly). */
  overallKappa: number | null;
  /** CATEGORIZATION agreement: raw share of LINKED pairs whose codes match —
   *  agreement on WHICH code, given both saw an event there. */
  categorizationAgreement: number | null;
  /** Ordered category axis used for the confusion matrix (codes then 'Void'). */
  categories: string[];
  /** confusion[i][j] = count where coderA=categories[i], coderB=categories[j];
   *  the last index is 'Void'. confusion[last][last] is the structural zero. */
  confusion: number[][];
  perCode: PerCodeResult[];
};

export const VOID = 'Void';

export function overlap(a: Annotation, b: Annotation): number {
  return Math.max(0, Math.min(a.offset, b.offset) - Math.max(a.onset, b.onset));
}

export function duration(a: Annotation): number {
  return Math.max(0, a.offset - a.onset);
}

/** Overlap ratio per Holle & Rein / ELAN: overlap / duration of the LONGER
 *  annotation. Zero-duration guards to 0 (a point event can still be handled
 *  by the caller; here it simply never clears a positive threshold). */
export function overlapRatio(a: Annotation, b: Annotation): number {
  const ov = overlap(a, b);
  if (ov <= 0) return 0;
  const denom = Math.max(duration(a), duration(b));
  return denom <= 0 ? 0 : ov / denom;
}

/**
 * Greedy one-to-one linking: build all candidate pairs clearing the threshold,
 * sort by descending overlap ratio (ties by earlier onset then id for
 * determinism), and accept a pair only if neither side is already linked.
 */
export function linkAnnotations(
  coderA: Annotation[],
  coderB: Annotation[],
  threshold: number,
): { links: LinkedPair[]; unmatchedA: Annotation[]; unmatchedB: Annotation[] } {
  type Cand = { a: Annotation; b: Annotation; r: number };
  const cands: Cand[] = [];
  for (const a of coderA) {
    for (const b of coderB) {
      const r = overlapRatio(a, b);
      if (r >= threshold && r > 0) cands.push({ a, b, r });
    }
  }
  cands.sort(
    (x, y) =>
      y.r - x.r ||
      x.a.onset - y.a.onset ||
      x.b.onset - y.b.onset ||
      x.a.id.localeCompare(y.a.id) ||
      x.b.id.localeCompare(y.b.id),
  );
  const usedA = new Set<string>();
  const usedB = new Set<string>();
  const links: LinkedPair[] = [];
  for (const c of cands) {
    if (usedA.has(c.a.id) || usedB.has(c.b.id)) continue;
    usedA.add(c.a.id);
    usedB.add(c.b.id);
    links.push({ a: c.a, b: c.b, overlap: c.r });
  }
  return {
    links,
    unmatchedA: coderA.filter((a) => !usedA.has(a.id)),
    unmatchedB: coderB.filter((b) => !usedB.has(b.id)),
  };
}

/**
 * Iterative proportional fitting (Deming & Stephan 1940). Fit an expected table
 * to the observed row/column marginals, holding `structuralZeros` cells at 0.
 * Returns the fitted expected table; its diagonal / N is the chance-agreement
 * used in κ. Seeded with 1s (0 at structural zeros); converges when marginals
 * match within `tol` or `maxIter` is hit.
 */
export function ipfExpected(
  observed: number[][],
  structuralZeros: ReadonlyArray<readonly [number, number]>,
  maxIter = 1000,
  tol = 1e-9,
): number[][] {
  const n = observed.length;
  const rowTarget = observed.map((row) => row.reduce((s, v) => s + v, 0));
  const colTarget = Array.from({ length: n }, (_, j) =>
    observed.reduce((s, row) => s + row[j], 0),
  );
  const zero = new Set(structuralZeros.map(([i, j]) => `${i},${j}`));
  const E: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (zero.has(`${i},${j}`) ? 0 : 1)),
  );
  for (let iter = 0; iter < maxIter; iter++) {
    let maxDelta = 0;
    // Row scaling.
    for (let i = 0; i < n; i++) {
      const rs = E[i].reduce((s, v) => s + v, 0);
      if (rs > 0) {
        const f = rowTarget[i] / rs;
        for (let j = 0; j < n; j++) E[i][j] *= f;
      }
    }
    // Column scaling.
    for (let j = 0; j < n; j++) {
      let cs = 0;
      for (let i = 0; i < n; i++) cs += E[i][j];
      if (cs > 0) {
        const f = colTarget[j] / cs;
        for (let i = 0; i < n; i++) E[i][j] *= f;
      }
    }
    // Convergence: max row-marginal error.
    for (let i = 0; i < n; i++) {
      const rs = E[i].reduce((s, v) => s + v, 0);
      maxDelta = Math.max(maxDelta, Math.abs(rs - rowTarget[i]));
    }
    if (maxDelta < tol) break;
  }
  return E;
}

/** κ from an observed table with structural zeros, chance corrected by IPF. */
export function kappaFromTable(
  observed: number[][],
  structuralZeros: ReadonlyArray<readonly [number, number]>,
): number | null {
  const n = observed.length;
  const N = observed.reduce((s, row) => s + row.reduce((a, v) => a + v, 0), 0);
  if (N === 0) return null;
  const po = observed.reduce((s, row, i) => s + row[i], 0) / N;
  const E = ipfExpected(observed, structuralZeros);
  const pe = E.reduce((s, row, i) => s + row[i], 0) / N;
  if (1 - pe === 0) return null; // pₑ = 1 → κ undefined (no room to exceed chance)
  return (po - pe) / (1 - pe);
}

/** Gwet's AC1 for a binary agreement table over LINKED pairs only.
 *  n11=both k, n12=A k / B ¬k, n21=A ¬k / B k, n22=both ¬k. */
export function ac1Binary(n11: number, n12: number, n21: number, n22: number): number | null {
  const N = n11 + n12 + n21 + n22;
  if (N === 0) return null;
  const pa = (n11 + n22) / N;
  // π = share of the 'k' class averaged over the two coders.
  const pk = (2 * n11 + n12 + n21) / (2 * N);
  const pe = 2 * pk * (1 - pk); // AC1 chance term
  if (1 - pe === 0) return null;
  return (pa - pe) / (1 - pe);
}

/** The full EasyDIAg computation for one coder pair. */
export function easyDiag(
  coderA: Annotation[],
  coderB: Annotation[],
  opts: EasyDiagOptions = {},
): EasyDiagResult {
  const threshold = opts.threshold ?? 0.6;
  const minInstances = opts.minInstances ?? 10;

  const { links, unmatchedA, unmatchedB } = linkAnnotations(coderA, coderB, threshold);

  // Category axis: every code either coder used, sorted, then Void last.
  const codeSet = new Set<string>();
  for (const a of coderA) codeSet.add(a.code);
  for (const b of coderB) codeSet.add(b.code);
  const codes = [...codeSet].sort();
  const categories = [...codes, VOID];
  const idx = new Map(categories.map((c, i) => [c, i]));
  const V = categories.length - 1;

  const confusion = Array.from({ length: categories.length }, () =>
    Array.from({ length: categories.length }, () => 0),
  );
  for (const { a, b } of links) confusion[idx.get(a.code)!][idx.get(b.code)!]++;
  for (const a of unmatchedA) confusion[idx.get(a.code)!][V]++;
  for (const b of unmatchedB) confusion[V][idx.get(b.code)!]++;

  const structuralZero: ReadonlyArray<readonly [number, number]> = [[V, V]];
  const overallKappa = kappaFromTable(confusion, structuralZero);

  const nEventsA = coderA.length;
  const nEventsB = coderB.length;
  const segmentationAgreement =
    nEventsA + nEventsB === 0 ? 0 : (2 * links.length) / (nEventsA + nEventsB);
  const categorizationAgreement =
    links.length === 0
      ? null
      : links.filter((l) => l.a.code === l.b.code).length / links.length;

  // Per-code: collapse the axis to {k, ¬k, Void} and re-run the IPF-κ; AC1 and
  // raw agreement over linked pairs touching k.
  const perCode: PerCodeResult[] = codes.map((k) => {
    const K = 0;
    const NK = 1;
    const VD = 2;
    const t = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    for (const { a, b } of links) {
      const i = a.code === k ? K : NK;
      const j = b.code === k ? K : NK;
      t[i][j]++;
    }
    for (const a of unmatchedA) t[a.code === k ? K : NK][VD]++;
    for (const b of unmatchedB) t[VD][b.code === k ? K : NK]++;

    const kappa = kappaFromTable(t, [[VD, VD]]);

    // Binary linked-pairs table for AC1 / raw agreement (Void excluded).
    const n11 = t[K][K];
    const n12 = t[K][NK];
    const n21 = t[NK][K];
    const n22 = t[NK][NK];
    const linkedTouchingK = n11 + n12 + n21;
    const ac1 = n11 + n12 + n21 + n22 > 0 ? ac1Binary(n11, n12, n21, n22) : null;
    const rawAgreement = linkedTouchingK > 0 ? n11 / linkedTouchingK : null;

    const byCoderA = coderA.filter((a) => a.code === k).length;
    const byCoderB = coderB.filter((b) => b.code === k).length;
    const totalInstances = byCoderA + byCoderB;
    const prevalence =
      nEventsA + nEventsB === 0 ? 0 : totalInstances / (nEventsA + nEventsB);

    return {
      code: k,
      kappa,
      ac1,
      rawAgreement,
      prevalence,
      byCoderA,
      byCoderB,
      linkedBoth: n11,
      underpowered: totalInstances < minInstances,
    };
  });

  return {
    threshold,
    nEventsA,
    nEventsB,
    nLinked: links.length,
    nUnmatchedA: unmatchedA.length,
    nUnmatchedB: unmatchedB.length,
    segmentationAgreement,
    overallKappa,
    categorizationAgreement,
    categories,
    confusion,
    perCode: perCode.sort((a, b) => b.prevalence - a.prevalence || a.code.localeCompare(b.code)),
  };
}
