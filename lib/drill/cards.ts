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

export type CardType = 'classify' | 'recall' | 'name';

/**
 * The two practice DIRECTIONS. Quiz = recognition (excerpt/definition front,
 * pick among 4 near-miss options). Name = production (definition + exemplars
 * front, produce the code from the full list). Each direction schedules its
 * own FSRS card per code — recognition strength does not imply production
 * strength, so the two must not share a memory state.
 */
export type DrillMode = 'quiz' | 'name';

const MODE_CARD_TYPES: Record<DrillMode, CardType[]> = {
  quiz: ['classify', 'recall'],
  name: ['name'],
};

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

type StateRow = { codeId: string; cardType: string; due: string; fsrs: unknown; reps: number };

/** The card type a code takes in `mode`. Null when the code can't be drilled
 *  in that mode (name cards need SOMETHING on the front). */
export function cardTypeIn(mode: DrillMode, code: DrillCode): CardType | null {
  if (mode === 'quiz') return cardTypeFor(code);
  return code.definition !== null || code.exemplars.length > 0 ? 'name' : null;
}

/** This mode's scheduling state for a code, if any. */
function stateIn(mode: DrillMode, states: StateRow[], codeId: string): StateRow | undefined {
  return states.find(
    (s) => s.codeId === codeId && MODE_CARD_TYPES[mode].includes(s.cardType as CardType),
  );
}

/** Due / new / learned counts for the overview, per mode. */
export function deckStats(
  mode: DrillMode,
  codes: DrillCode[],
  states: StateRow[],
  now: Date,
): { due: number; fresh: number; scheduled: number; nextDueMs: number | null } {
  let due = 0;
  let fresh = 0;
  let scheduled = 0;
  let nextDueMs: number | null = null;
  for (const code of codes) {
    if (cardTypeIn(mode, code) === null) continue;
    const st = stateIn(mode, states, code.id);
    if (!st) {
      fresh++;
    } else if (new Date(st.due).getTime() <= now.getTime()) {
      due++;
    } else {
      scheduled++;
      const t = new Date(st.due).getTime();
      if (nextDueMs === null || t < nextDueMs) nextDueMs = t;
    }
  }
  return { due, fresh, scheduled, nextDueMs };
}

/**
 * Assemble one session's queue for `mode`: every DUE card (oldest due first),
 * then up to `newCap` never-drilled codes, the whole thing seeded-shuffled so
 * due and new cards interleave — interleaving is where the discrimination
 * benefit lives.
 *
 * `ahead: true` is the "practice anyway" session: cards not yet due are
 * admitted too (FSRS handles early reviews natively — the shorter elapsed
 * time just earns a smaller stability bump).
 */
export function buildQueue(
  mode: DrillMode,
  codes: DrillCode[],
  states: StateRow[],
  now: Date,
  newCap: number,
  seed: number,
  ahead = false,
): QueueItem[] {
  const due: { item: QueueItem; dueAt: number }[] = [];
  const fresh: QueueItem[] = [];
  for (const code of codes) {
    const type = cardTypeIn(mode, code);
    if (type === null) continue;
    const st = stateIn(mode, states, code.id);
    if (st) {
      const dueAt = new Date(st.due).getTime();
      if (ahead || dueAt <= now.getTime()) {
        due.push({
          item: { code, cardType: st.cardType as CardType, fsrs: st.fsrs, reps: st.reps },
          dueAt,
        });
      }
    } else {
      fresh.push({ code, cardType: type, fsrs: null, reps: 0 });
    }
  }

  due.sort((a, b) => a.dueAt - b.dueAt);

  const rand = mulberry32(seed);
  const intake = shuffled(fresh, rand).slice(0, Math.max(0, newCap));
  return shuffled([...due.map((d) => d.item), ...intake], rand);
}

/**
 * Rank codes against a typed query for the NAME-mode answer field: prefix
 * hits first, then any substring, ties alphabetical — deterministic, so the
 * list never reshuffles under the cursor. Empty query returns everything
 * (the full code list IS the answer space; browsing it is allowed — the
 * retrieval act is recognizing the right slug, not spelling it).
 */
export function rankCodesForQuery(codes: DrillCode[], query: string): DrillCode[] {
  const q = query.trim().toLowerCase();
  return codes
    .map((c) => {
      const m = c.mnemonic.toLowerCase();
      const rank = q === '' ? 3 : m.startsWith(q) ? 0 : m.includes(q) ? 2 : -1;
      return { c, rank };
    })
    .filter((x) => x.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.c.mnemonic.localeCompare(b.c.mnemonic))
    .map((x) => x.c);
}
