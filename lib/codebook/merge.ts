/**
 * merge — PURE prefill logic for the code-MERGE screen (/codebook/merge).
 *
 * A merge collapses N live codes into one SURVIVOR: the DB function
 * `cb_merge_codes` re-points every reference and retires the absorbed codes,
 * and the survivor gets a NEW current version the researcher authors on the
 * merge screen. This module computes the DRAFT that editor opens with:
 *
 *   - the survivor's own anatomy (definition halves, include/exclude,
 *     counter-example) carries over verbatim — the survivor is the code that
 *     WINS, so its operational rule is the starting text, not a mixture; and
 *   - the exemplars are the UNION across every merged code — quotes are
 *     evidence, and evidence from an absorbed duplicate is exactly what the
 *     surviving code inherits.
 *
 * Typed structurally (not against CodeWithRefs) so it is testable — and
 * reusable — without the generated DB row types: anything carrying a
 * `.current` with the version fields qualifies.
 */

import { splitDefinition } from '@/lib/codebook/definition';

/** The minimum an exemplar needs for the union: its quote text. The generic
 *  parameter keeps whatever else rides along (`source_pid`, `episode_ref`)
 *  intact on the rows that survive dedupe. */
export type ExemplarLike = { text: string };

/** The version fields the prefill reads. All optional/nullable — a code whose
 *  `current` is a full `cb_code_versions` row satisfies this, and so does a
 *  bare test fixture. The list-typed columns are `unknown` because they are
 *  jsonb in the DB (`Json` on the row type) and must be coerced defensively. */
export type MergeSourceVersion = {
  definition?: string | null;
  include_if?: unknown;
  exclude_if?: unknown;
  exemplars?: unknown;
  disconfirming_pattern?: string | null;
};

/** A mergeable code: `current` may be null/absent (a pathological code whose
 *  version pointer was never set) — the prefill then starts blank. */
export type MergeSource = { current?: MergeSourceVersion | null };

export type MergePrefill = {
  /** Literature half of the survivor's definition ('' when none). */
  literature: string;
  /** Applied half of the survivor's definition ('' when none). */
  applied: string;
  includeIf: string[];
  excludeIf: string[];
  /** The survivor's disconfirming pattern ('' when none). */
  counterExample: string;
  /** Union of exemplars across survivor + absorbed, survivor's first. */
  exemplars: ExemplarLike[];
};

/**
 * Union exemplar lists, deduping by EXACT trimmed text. The first occurrence
 * wins and keeps its full object (its `source_pid`, `episode_ref`, …); later
 * duplicates are dropped even when their extras differ — the earlier list is
 * the more authoritative one (callers pass the survivor first). Order is
 * preserved: lists in the order given, each list's rows in their own order.
 * Rows whose text is empty/whitespace-only are dropped (nothing to dedupe on,
 * and the version schema rejects empty exemplar text anyway).
 */
export function unionExemplars<E extends ExemplarLike>(lists: E[][]): E[] {
  const seen = new Set<string>();
  const out: E[] = [];
  for (const list of lists) {
    for (const ex of list) {
      const key = ex.text.trim();
      if (key === '' || seen.has(key)) continue;
      seen.add(key);
      out.push(ex);
    }
  }
  return out;
}

/** Coerce a jsonb list column back into string[] (mirrors the anatomy editor's
 *  defensive read — a malformed row must not throw). */
export function asStringList(j: unknown): string[] {
  return Array.isArray(j) ? j.filter((x): x is string => typeof x === 'string') : [];
}

/** Coerce a jsonb exemplars column into rows carrying at least `text`. Rows
 *  without a string text are dropped; everything else on the object survives. */
export function asExemplarList(j: unknown): ExemplarLike[] {
  if (!Array.isArray(j)) return [];
  return j.filter(
    (e): e is ExemplarLike =>
      e !== null && typeof e === 'object' && typeof (e as { text?: unknown }).text === 'string',
  );
}

/**
 * The merge editor's opening draft. Anatomy (definition halves, include /
 * exclude, counter-example) comes from the SURVIVOR ONLY — its operational
 * rule is the one being kept, and mixing prose from N codes would produce a
 * definition nobody wrote. Exemplars are the union (survivor's first, then
 * each absorbed code's in the order given), because quotes are evidence and
 * the absorbed codes' evidence is precisely what the merge preserves.
 */
export function buildMergePrefill(survivor: MergeSource, absorbed: MergeSource[]): MergePrefill {
  const cur = survivor.current ?? null;
  const def = splitDefinition(cur?.definition);
  return {
    literature: def.literature ?? '',
    applied: def.applied,
    includeIf: asStringList(cur?.include_if),
    excludeIf: asStringList(cur?.exclude_if),
    counterExample: cur?.disconfirming_pattern ?? '',
    exemplars: unionExemplars([
      asExemplarList(cur?.exemplars),
      ...absorbed.map((a) => asExemplarList(a.current?.exemplars)),
    ]),
  };
}
