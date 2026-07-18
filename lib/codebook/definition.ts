/**
 * Literature/Applied definition split.
 *
 * A-priori codes are written with the theoretical (literature) description and
 * the applied (operational) definition in ONE stored field, separated by a
 * literal `==`:
 *
 *     Theoretical description from the paper == How we apply it to this corpus
 *
 * or, on its own line:
 *
 *     Theoretical description from the paper
 *     ==
 *     How we apply it to this corpus
 *
 * The split is POST HOC — the stored text stays verbatim (no schema change, no
 * migration; JSON/snapshot exports keep the raw definition). Surfaces choose
 * what to show:
 *
 *   CODING surfaces (the coding popup) show the APPLIED part only — a coder
 *   mid-transcript needs the operational rule, not the provenance essay.
 *   CODEBOOK surfaces (the document view, the code page, LaTeX export) show
 *   BOTH, with the literature part labeled and visually distinct.
 *
 * Pure and dependency-free so it runs identically on server and client.
 */

export type SplitDefinition = {
  /** The literature/theoretical part (text before the first `==`), trimmed.
   *  `null` when there is no separator or the part before it is blank. */
  literature: string | null;
  /** The applied/operational definition (text after the first `==`, or the
   *  whole definition when there is no separator), trimmed. */
  applied: string;
};

/**
 * Split a stored definition on the FIRST `==` separator — whether it sits on
 * its own line (with optional surrounding whitespace) or inline (`a == b`).
 * Both cases reduce to "the first literal `==` in the string": a line
 * consisting of `==` contains that literal, so one scan covers both.
 *
 * No separator → `{ literature: null, applied: <whole, trimmed> }`.
 * Null/undefined → `{ literature: null, applied: '' }`.
 */
export function splitDefinition(def: string | null | undefined): SplitDefinition {
  if (def == null) return { literature: null, applied: '' };

  const at = def.indexOf('==');
  if (at === -1) return { literature: null, applied: def.trim() };

  const before = def.slice(0, at).trim();
  const after = def.slice(at + 2).trim();
  return { literature: before === '' ? null : before, applied: after };
}

/**
 * The inverse: join an edited (literature, applied) pair back into the ONE
 * stored field. Empty/whitespace literature → just the applied text (no
 * separator is written, so a code without a literature description round-trips
 * unchanged). The canonical stored form puts `==` on its own line.
 *
 * `joinDefinition(splitDefinition(x).literature, splitDefinition(x).applied)`
 * normalizes whitespace but preserves both parts verbatim.
 */
export function joinDefinition(literature: string | null | undefined, applied: string): string {
  const lit = (literature ?? '').trim();
  const app = applied.trim();
  return lit === '' ? app : `${lit}\n==\n${app}`;
}
