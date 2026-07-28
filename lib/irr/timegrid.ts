/**
 * timegrid — TIME-BASED inter-rater reliability (Bakeman, Quera & Gnisci 2009,
 * doi:10.3758/brm.41.1.137). The alternative to EasyDIAg's event matching.
 *
 * The session is sliced into fixed time bins; a code is "active" in a bin for a
 * coder if any of that coder's annotations for that code overlaps the bin. Then
 * standard Cohen's κ is computed per code over the bin grid (present/absent) and
 * over "any code active" (the segmentation analog).
 *
 * WHY offer this alongside EasyDIAg. Diagnosis on session 548 showed the coders'
 * disagreement is ~80% boundary jitter — they mark the SAME moments with
 * different span edges — which EasyDIAg's overlap-linking penalizes heavily
 * (well-sampled codes posted κ≈0). A fixed grid inherits the same units for both
 * coders, so boundary placement stops being a source of variance; the same codes
 * then post κ≈0.4–0.65. Time-grid is the right model when disagreement is
 * boundary-level; EasyDIAg is right when it is occurrence-level. The tool offers
 * both so the analyst can see which regime their data is in.
 *
 * Unlike the event-linked table, the "both coders inactive" bin is REAL
 * agreement (a stretch neither coded), not a structural zero — so plain Cohen's
 * κ applies (cohenKappaBinary), no IPF.
 *
 * Pure: intervals in, numbers out.
 */

import { cohenKappaBinary, ac1Binary, type Annotation } from './easydiag';

export type TimeGridOptions = {
  /** Bin width in ms (default 2000 = 2 s; robust across 1–5 s on our data). */
  binMs?: number;
  /** Codes with fewer than this many active bins (either coder) are flagged
   *  underpowered — too little signal for a trustworthy per-code κ. */
  minActiveBins?: number;
};

export type TimeGridPerCode = {
  code: string;
  kappa: number | null;
  ac1: number | null;
  /** Share of bins in which this code is active for either coder. */
  prevalence: number;
  bothActive: number;
  aOnly: number;
  bOnly: number;
  underpowered: boolean;
};

export type TimeGridResult = {
  binMs: number;
  nBins: number;
  /** Bin window used, ms (the coded envelope: min onset → max offset). */
  windowMs: [number, number];
  /** "Any code active" agreement — do the coders agree on WHICH TIME is
   *  codeable, chance-corrected. The segmentation analog. */
  segmentationKappa: number | null;
  segBothActive: number;
  segAOnly: number;
  segBOnly: number;
  segBothEmpty: number;
  perCode: TimeGridPerCode[];
  /** Mean per-code κ over adequately-sampled codes (≥ minActiveBins). */
  meanKappaPowered: number | null;
};

function activeBits(evs: Annotation[], code: string | null, lo: number, binMs: number, nBins: number): Uint8Array {
  const bits = new Uint8Array(nBins);
  for (const e of evs) {
    if (code !== null && e.code !== code) continue;
    // Half-open bins [b·binMs, (b+1)·binMs): a bin is active iff the interval
    // overlaps its interior. An interval ending exactly on a boundary must NOT
    // mark the bin it merely touches, so b1 uses ceil(offset)-1, not floor.
    const b0 = Math.max(0, Math.floor((e.onset - lo) / binMs));
    const b1 = Math.min(nBins - 1, Math.ceil((e.offset - lo) / binMs) - 1);
    for (let b = b0; b <= b1; b++) bits[b] = 1;
  }
  return bits;
}

export function timeGridKappa(
  coderA: Annotation[],
  coderB: Annotation[],
  opts: TimeGridOptions = {},
): TimeGridResult {
  const binMs = opts.binMs ?? 2000;
  const minActiveBins = opts.minActiveBins ?? 5;
  const all = [...coderA, ...coderB];

  if (all.length === 0) {
    return {
      binMs,
      nBins: 0,
      windowMs: [0, 0],
      segmentationKappa: null,
      segBothActive: 0,
      segAOnly: 0,
      segBOnly: 0,
      segBothEmpty: 0,
      perCode: [],
      meanKappaPowered: null,
    };
  }

  // Universe = the coded envelope (min onset → max offset). Bins outside the
  // envelope would be trivial both-empty agreement and inflate κ.
  const lo = Math.min(...all.map((e) => e.onset));
  const hi = Math.max(...all.map((e) => e.offset));
  const nBins = Math.max(1, Math.ceil((hi - lo) / binMs));

  const codes = [...new Set(all.map((e) => e.code))].sort();

  const perCode: TimeGridPerCode[] = codes.map((k) => {
    const aa = activeBits(coderA, k, lo, binMs, nBins);
    const bb = activeBits(coderB, k, lo, binMs, nBins);
    let n11 = 0;
    let n10 = 0;
    let n01 = 0;
    let n00 = 0;
    for (let b = 0; b < nBins; b++) {
      if (aa[b] && bb[b]) n11++;
      else if (aa[b]) n10++;
      else if (bb[b]) n01++;
      else n00++;
    }
    const active = n11 + n10 + n01;
    return {
      code: k,
      kappa: cohenKappaBinary(n11, n10, n01, n00),
      ac1: ac1Binary(n11, n10, n01, n00),
      prevalence: active / nBins,
      bothActive: n11,
      aOnly: n10,
      bOnly: n01,
      underpowered: active < minActiveBins,
    };
  });

  // Segmentation: any-code-active per coder.
  const aAny = activeBits(coderA, null, lo, binMs, nBins);
  const bAny = activeBits(coderB, null, lo, binMs, nBins);
  let m11 = 0;
  let m10 = 0;
  let m01 = 0;
  let m00 = 0;
  for (let b = 0; b < nBins; b++) {
    if (aAny[b] && bAny[b]) m11++;
    else if (aAny[b]) m10++;
    else if (bAny[b]) m01++;
    else m00++;
  }

  const powered = perCode.filter((p) => !p.underpowered && p.kappa !== null);
  const meanKappaPowered =
    powered.length === 0 ? null : powered.reduce((s, p) => s + (p.kappa ?? 0), 0) / powered.length;

  return {
    binMs,
    nBins,
    windowMs: [lo, hi],
    segmentationKappa: cohenKappaBinary(m11, m10, m01, m00),
    segBothActive: m11,
    segAOnly: m10,
    segBOnly: m01,
    segBothEmpty: m00,
    perCode: perCode.sort((a, b) => b.prevalence - a.prevalence || a.code.localeCompare(b.code)),
    meanKappaPowered,
  };
}
