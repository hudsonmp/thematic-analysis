/**
 * cards — pure deck construction for the code drill. No I/O.
 *
 * The primary card type is CLASSIFY: a real coded excerpt on the front, "which
 * code applies?" as the task. Definition recall is the FALLBACK (codes with no
 * exemplars yet), because what a coder needs is category discrimination —
 * mapping utterances to codes — and exemplar-based classification practice
 * transfers to that where paired-associate recall of definitions doesn't
 * (category-learning work: interleaved exemplars beat blocked study precisely
 * because they force between-category discrimination).
 *
 * Two designed consequences of that framing:
 *  - DISTRACTORS are near-misses first: codes sharing scheme facet values with
 *    the target outrank arbitrary codes, so every wrong option is a genuine
 *    discrimination, not a giveaway.
 *  - The EXEMPLAR shown rotates with the card's rep count, so a card is never
 *    answerable by remembering one surface string — the scheduling unit is the
 *    code, not the excerpt.
 */

export type DrillCode = {
  id: string;
  mnemonic: string;
  definition: string | null;
  counterExample: string | null;
  exemplars: string[];
  facetValueIds: string[];
  codebookName: string;
};

export type CardType = 'classify' | 'recall';

export type QueueItem = {
  code: DrillCode;
  cardType: CardType;
  /** Serialized FSRS card, or null for a never-drilled code. */
  fsrs: unknown | null;
  /** Rep count, used to rotate the exemplar shown. 0 for new cards. */
  reps: number;
};

/** Classify when there is material to classify; otherwise definition→code. */
export function cardTypeFor(code: DrillCode): CardType {
  return code.exemplars.length > 0 ? 'classify' : 'recall';
}

/** Deterministic 32-bit PRNG — same seed, same session order, so a re-render
 *  never reshuffles options under the learner's cursor. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable small hash for seeding from ids. */
export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function shuffled<T>(items: T[], rand: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** How many facet values two codes share — the near-miss metric. */
function sharedFacetValues(a: DrillCode, b: DrillCode): number {
  const set = new Set(a.facetValueIds);
  let n = 0;
  for (const id of b.facetValueIds) if (set.has(id)) n++;
  return n;
}

/**
 * Pick `n` distractors for `target` from `pool`: rank by shared facet values
 * (descending), seeded-shuffle within equal ranks, take the top n. The pool is
 * assumed same-codebook — cross-instrument distractors would be nonsense
 * discriminations.
 */
export function pickDistractors(
  target: DrillCode,
  pool: DrillCode[],
  n: number,
  seed: number,
): DrillCode[] {
  const rand = mulberry32(seed);
  const candidates = shuffled(
    pool.filter((c) => c.id !== target.id),
    rand,
  );
  return candidates
    .map((c, i) => ({ c, score: sharedFacetValues(target, c), tiebreak: i }))
    .sort((x, y) => y.score - x.score || x.tiebreak - y.tiebreak)
    .slice(0, n)
    .map((x) => x.c);
}

/** The exemplar to show for this rep — rotates so no single string is "the"
 *  card. Empty string only for exemplar-less codes (recall cards don't call
 *  this). */
export function exemplarFor(code: DrillCode, reps: number): string {
  if (code.exemplars.length === 0) return '';
  return code.exemplars[reps % code.exemplars.length];
}

/**
 * Assemble one session's queue: every DUE card (oldest due first), then up to
 * `newCap` never-drilled codes, the whole thing seeded-shuffled so due and new
 * cards interleave — interleaving is where the discrimination benefit lives.
 */
export function buildQueue(
  codes: DrillCode[],
  states: { codeId: string; cardType: string; due: string; fsrs: unknown; reps: number }[],
  now: Date,
  newCap: number,
  seed: number,
): QueueItem[] {
  const byCode = new Map(states.map((s) => [s.codeId, s]));

  const due: QueueItem[] = [];
  const fresh: QueueItem[] = [];
  for (const code of codes) {
    const st = byCode.get(code.id);
    if (st) {
      if (new Date(st.due).getTime() <= now.getTime()) {
        due.push({ code, cardType: st.cardType as CardType, fsrs: st.fsrs, reps: st.reps });
      }
    } else {
      fresh.push({ code, cardType: cardTypeFor(code), fsrs: null, reps: 0 });
    }
  }

  due.sort((a, b) => {
    const sa = byCode.get(a.code.id)!;
    const sb = byCode.get(b.code.id)!;
    return new Date(sa.due).getTime() - new Date(sb.due).getTime();
  });

  const rand = mulberry32(seed);
  const intake = shuffled(fresh, rand).slice(0, Math.max(0, newCap));
  return shuffled([...due, ...intake], rand);
}
