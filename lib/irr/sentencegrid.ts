/**
 * sentencegrid — SENTENCE-level inter-rater reliability (Method 3).
 *
 * The unit of agreement is the SENTENCE, not a time bin (timegrid, Method 4) or a
 * matched event (easydiag, Method 2). Both coders inherit the same sentence units
 * (enforced at coding time by snapToSentences), so boundary jitter — the ~80% of
 * disagreement diagnosed on session 548 — cannot arise. Sentences align with
 * think-aloud idea units (Chi 1997), which is why this is the recommended primary.
 *
 * Sentence agreement is TEXT-based (which sentence carries which code), not
 * time-based, so it needs no timestamps — important, because `cb_segments.words`
 * is empty and the cleaned tracks have multi-minute mega-segments that cannot be
 * time-split. The caller enumerates sentences from segment text (lib/transcript
 * `sentenceSpans`) and maps each annotation to the sentence indices it covers.
 *
 * Two coefficients, per the user's decision:
 *  - STRICT (primary): per (sentence x code) presence, standard Cohen's kappa. A
 *    both-inactive sentence is REAL agreement, so no structural zero.
 *  - RELAXED (secondary sensitivity): a strict disagreement on sentence S is
 *    UPGRADED to agreement iff the other coder applied the same code within +/-1
 *    sentence. This is a unitizing tolerance (Krippendorff u-alpha 2015; gamma,
 *    Mathet 2015) that credits off-by-one boundary splits of a multi-sentence
 *    code. It only turns disagreements into agreements (never the reverse), so it
 *    is a pure relaxation and inflates kappa relative to strict.
 *
 * Pure: presence lists in, numbers out.
 */

import { cohenKappaBinary, ac1Binary } from './easydiag';
import { sentenceSpans } from '../transcript/selection';

/** One coder marked sentence `sentence` (0-based global index) with `code`. */
export type SentencePresence = { code: string; sentence: number };

/** A global sentence unit: which segment it lives in and its char span there. */
export type SentenceUnit = {
  index: number;
  segmentOrdinal: number;
  charStart: number;
  charEnd: number;
};

/**
 * Enumerate the transcript's sentence units in reading order. Each segment's
 * text is split by `sentenceSpans`; sentences get consecutive global indices.
 * Returns the flat list plus an ordinal→sentences index for range mapping.
 */
export function enumerateSentences(
  segments: { ordinal: number; text: string }[],
): { units: SentenceUnit[]; byOrdinal: Map<number, SentenceUnit[]> } {
  const ordered = [...segments].sort((a, b) => a.ordinal - b.ordinal);
  const units: SentenceUnit[] = [];
  const byOrdinal = new Map<number, SentenceUnit[]>();
  let idx = 0;
  for (const seg of ordered) {
    const spans = sentenceSpans(seg.text);
    const here: SentenceUnit[] = [];
    for (const [cs, ce] of spans) {
      const u = { index: idx++, segmentOrdinal: seg.ordinal, charStart: cs, charEnd: ce };
      units.push(u);
      here.push(u);
    }
    byOrdinal.set(seg.ordinal, here);
  }
  return { units, byOrdinal };
}

/**
 * The global sentence indices an annotation covers. The annotation runs from
 * `startChar` in segment `startOrd` to `endChar` in segment `endOrd` (inclusive
 * of whole middle segments). A sentence counts as covered if the annotation's
 * char range in that segment overlaps the sentence's span at all — with
 * enforcement the overlap is whole-sentence, but partial overlap (the exempt
 * coded sessions) still maps to the touched sentences.
 */
export function sentencesForRange(
  byOrdinal: Map<number, SentenceUnit[]>,
  startOrd: number,
  startChar: number,
  endOrd: number,
  endChar: number,
): number[] {
  const out: number[] = [];
  for (let ord = startOrd; ord <= endOrd; ord++) {
    const sents = byOrdinal.get(ord);
    if (!sents) continue;
    for (const s of sents) {
      // The annotation's covered char window in THIS segment.
      const lo = ord === startOrd ? startChar : 0;
      const hi = ord === endOrd ? endChar : Number.MAX_SAFE_INTEGER;
      if (s.charStart < hi && s.charEnd > lo) out.push(s.index);
    }
  }
  return out;
}

export type SentenceGridOptions = {
  /** Codes active on fewer than this many sentences (either coder) are flagged
   *  underpowered. */
  minActiveSentences?: number;
};

export type SentenceGridPerCode = {
  code: string;
  /** Strict per-sentence Cohen's kappa. */
  kappa: number | null;
  /** Overlap-relaxed kappa (+/-1 sentence tolerance). */
  kappaRelaxed: number | null;
  ac1: number | null;
  prevalence: number;
  bothActive: number;
  aOnly: number;
  bOnly: number;
  inactive: number;
  underpowered: boolean;
};

export type SentenceGridResult = {
  nSentences: number;
  /** Any-code-active per sentence: do the coders agree WHICH sentences are
   *  codeable, chance-corrected. */
  segmentationKappa: number | null;
  segBothActive: number;
  segAOnly: number;
  segBOnly: number;
  segBothEmpty: number;
  perCode: SentenceGridPerCode[];
  meanKappaPowered: number | null;
};

/** sentences within +/-1 of any sentence in `set`. */
function dilate(set: Set<number>, nSentences: number): Set<number> {
  const out = new Set<number>();
  for (const s of set) {
    if (s - 1 >= 0) out.add(s - 1);
    out.add(s);
    if (s + 1 < nSentences) out.add(s + 1);
  }
  return out;
}

export function sentenceGridKappa(
  nSentences: number,
  aPres: SentencePresence[],
  bPres: SentencePresence[],
  opts: SentenceGridOptions = {},
): SentenceGridResult {
  const minActive = opts.minActiveSentences ?? 5;

  if (nSentences === 0) {
    return {
      nSentences: 0,
      segmentationKappa: null,
      segBothActive: 0,
      segAOnly: 0,
      segBOnly: 0,
      segBothEmpty: 0,
      perCode: [],
      meanKappaPowered: null,
    };
  }

  const setsFor = (pres: SentencePresence[]) => {
    const m = new Map<string, Set<number>>();
    for (const p of pres) {
      if (p.sentence < 0 || p.sentence >= nSentences) continue;
      let s = m.get(p.code);
      if (!s) m.set(p.code, (s = new Set()));
      s.add(p.sentence);
    }
    return m;
  };
  const aByCode = setsFor(aPres);
  const bByCode = setsFor(bPres);
  const codes = [...new Set([...aByCode.keys(), ...bByCode.keys()])].sort();

  const perCode: SentenceGridPerCode[] = codes.map((code) => {
    const a = aByCode.get(code) ?? new Set<number>();
    const b = bByCode.get(code) ?? new Set<number>();
    const aDil = dilate(a, nSentences);
    const bDil = dilate(b, nSentences);

    let n11 = 0;
    let n10 = 0;
    let n01 = 0;
    let n00 = 0;
    let r11 = 0;
    let r10 = 0;
    let r01 = 0;
    let r00 = 0;
    for (let s = 0; s < nSentences; s++) {
      const av = a.has(s);
      const bv = b.has(s);
      // strict
      if (av && bv) n11++;
      else if (av) n10++;
      else if (bv) n01++;
      else n00++;
      // relaxed: upgrade a one-sided cell to agreement if the OTHER coder has the
      // code within +/-1 sentence. Never downgrades.
      if (av && bv) r11++;
      else if (av) bDil.has(s) ? r11++ : r10++;
      else if (bv) aDil.has(s) ? r11++ : r01++;
      else r00++;
    }
    const active = n11 + n10 + n01;
    return {
      code,
      kappa: cohenKappaBinary(n11, n10, n01, n00),
      kappaRelaxed: cohenKappaBinary(r11, r10, r01, r00),
      ac1: ac1Binary(n11, n10, n01, n00),
      prevalence: active / nSentences,
      bothActive: n11,
      aOnly: n10,
      bOnly: n01,
      inactive: n00,
      underpowered: active < minActive,
    };
  });

  // Segmentation: any-code-active per sentence.
  const aAny = new Set<number>();
  const bAny = new Set<number>();
  for (const p of aPres) if (p.sentence >= 0 && p.sentence < nSentences) aAny.add(p.sentence);
  for (const p of bPres) if (p.sentence >= 0 && p.sentence < nSentences) bAny.add(p.sentence);
  let m11 = 0;
  let m10 = 0;
  let m01 = 0;
  let m00 = 0;
  for (let s = 0; s < nSentences; s++) {
    const av = aAny.has(s);
    const bv = bAny.has(s);
    if (av && bv) m11++;
    else if (av) m10++;
    else if (bv) m01++;
    else m00++;
  }

  const powered = perCode.filter((p) => !p.underpowered && p.kappa !== null);
  const meanKappaPowered =
    powered.length === 0 ? null : powered.reduce((s, p) => s + (p.kappa ?? 0), 0) / powered.length;

  return {
    nSentences,
    segmentationKappa: cohenKappaBinary(m11, m10, m01, m00),
    segBothActive: m11,
    segAOnly: m10,
    segBOnly: m01,
    segBothEmpty: m00,
    perCode: perCode.sort((a, b) => b.prevalence - a.prevalence || a.code.localeCompare(b.code)),
    meanKappaPowered,
  };
}
