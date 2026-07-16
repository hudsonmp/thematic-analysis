// ---------------------------------------------------------------------------
// triage — PURE derivation of the "what is still unclassified?" work queue.
//
// WHY THIS EXISTS
//
// Capture and classification are DIFFERENT COGNITIVE MODES, and the tool should
// not pretend they are one.
//
// To capture a code you are reading a transcript: your attention is on the
// participant, and the code is a fast, cheap note — "they didn't know what
// 'done' meant here". To classify a code you are working the SCHEME: which
// space is this about, which phase, which cardinality. Those questions are only
// answerable if you are holding the whole scheme in working memory.
//
// Forcing classification AT CAPTURE TIME therefore taxes the wrong moment: you
// must load the entire scheme into working memory *while reading*, and the
// scheme's load is paid again on every single code. The predictable outcome is
// not better-classified codes — it is FEWER codes, because the researcher stops
// capturing the marginal observation rather than pay the tax. Capture is the
// step that cannot be redone later (the reading happened once); classification
// is the step that can. So the cheap step must never be gated on the expensive
// one.
//
// Batching inverts the arithmetic. Load the scheme ONCE, then apply it N times
// down a list. The per-code cost collapses to the comparison itself, and the
// researcher gets the side benefit that only batching gives: seeing the codes
// side by side is what exposes that two facet values mean the same thing, or
// that a facet is missing a value entirely. You cannot notice that one code at
// a time.
//
// That is the whole rationale for the queue: capture is unblocked, and the
// classification debt it accrues is made VISIBLE and WORKABLE rather than
// silently lost. This module is the debt ledger.
//
// It is PURE (no I/O, no React) so it unit-tests cleanly and so the same
// derivation backs both the triage view and any progress indicator, with no
// chance of the two disagreeing about what "uncategorized" means.
// ---------------------------------------------------------------------------

import type { CodeWithRefs, FacetWithValues } from '@/app/actions/codebook';
import { coerceFacetType, facetHasValues } from './facet-types';

/**
 * One unanswered QUESTION about a code.
 *
 * A facet is a dimension — a question askable of every code ("which space is
 * this about?"). Its values are the answers, and they nest into a taxonomy
 * inside that one dimension. A gap is therefore not "a missing field" but "a
 * question this code has not yet been asked", which is why it carries the
 * facet's LABEL: the triage UI has to pose the question in the researcher's own
 * words, not show a column header.
 */
export type FacetGap = {
  facetId: string;
  facetLabel: string;
};

/** A code that owes at least one answer, with the questions it still owes. */
export type TriageItem = {
  code: CodeWithRefs;
  gaps: FacetGap[];
};

/**
 * The facets that can actually BE answered.
 *
 * Only 'enum' facets have values (`facetHasValues`), and a facet with zero
 * values defined has no answer a researcher could give — the taxonomy inside it
 * is empty. Counting such a facet as a gap would put every code in the queue
 * with a question that has no possible answer: an infinite, unclearable debt
 * that trains the researcher to ignore the queue. So both conditions are
 * required, and the queue is only ever as large as the scheme can discharge.
 *
 * Facet ORDER is preserved from the input, which arrives sorted by
 * `cb_facets.position` — the order the researcher authored the scheme in. The
 * gaps on a code are thus posed in scheme order, not in some order derived from
 * the code's own accidents.
 */
function answerableFacets(facets: FacetWithValues[]): FacetWithValues[] {
  return facets.filter(
    (f) => facetHasValues(coerceFacetType(f.type)) && f.values.length > 0,
  );
}

/** The gaps a single code carries, given the already-filtered facet list. */
function gapsFor(code: CodeWithRefs, facets: FacetWithValues[]): FacetGap[] {
  // A code carries values many-to-many (cb_code_facet_values). Membership on a
  // facet means it carries ANY value belonging to that facet — including a
  // nested one, since a child value is still a value OF the facet. Set lookup
  // keeps this O(values) per code rather than O(values × carried).
  const carried = new Set(code.facetValueIds);

  return facets
    .filter((f) => !f.values.some((v) => carried.has(v.id)))
    .map((f) => ({ facetId: f.id, facetLabel: f.label }));
}

/**
 * The triage queue: every code with at least one unanswered facet, MOST
 * INCOMPLETE FIRST.
 *
 * Most-incomplete-first is not cosmetic. The codes with the most gaps are the
 * ones captured fastest and thought about least — they are where the scheme is
 * most likely to be wrong, not merely unapplied. Surfacing them first means the
 * researcher hits the scheme's real problems while they still have budget to
 * fix them, instead of grinding through the nearly-done codes and discovering
 * a missing facet value at the end.
 *
 * Ties break ALPHABETICALLY BY MNEMONIC, which makes the order a pure function
 * of the data. This matters for a reason that has nothing to do with tidiness:
 * the researcher is clicking down this list, and an unstable sort would let the
 * list reshuffle under the cursor between renders — you answer a question and
 * the next row is no longer the row you were looking at. Determinism is what
 * makes the queue safe to work down at speed.
 *
 * A code with zero gaps is NOT in the queue. It has nothing to be asked, and a
 * queue that shows finished work is a queue you stop trusting to be a to-do
 * list.
 */
export function triageQueue(
  codes: CodeWithRefs[],
  facets: FacetWithValues[],
): TriageItem[] {
  const answerable = answerableFacets(facets);
  if (answerable.length === 0) return [];

  return codes
    .map((code) => ({ code, gaps: gapsFor(code, answerable) }))
    .filter((item) => item.gaps.length > 0)
    .sort((a, b) =>
      a.gaps.length !== b.gaps.length
        ? b.gaps.length - a.gaps.length // most gaps first
        : a.code.mnemonic.localeCompare(b.code.mnemonic),
    );
}

/**
 * Headline counts for the triage view.
 *
 *   total               — every code in the codebook (the denominator).
 *   uncategorized       — codes with ≥1 gap; i.e. `triageQueue(...).length`.
 *                         This is the debt: how much classification is owed.
 *   fullyUncategorized  — codes carrying NO value on ANY answerable facet.
 *                         These are the pure capture-mode notes, never yet
 *                         touched by the scheme. They are worth counting apart
 *                         from the partially-classified because they are the
 *                         ones that will be hardest to classify later: the
 *                         reading context that produced them is furthest away.
 *                         A rising fully-uncategorized count is the signal to
 *                         stop reading and run a triage pass.
 *
 * When the scheme has no answerable facet, both debt counts are 0 rather than
 * `total`. With no question to ask, "uncategorized" is not true of a code — it
 * is meaningless — and reporting every code as uncategorized would show alarming
 * debt that no amount of work could pay down.
 */
export function queueStats(
  codes: CodeWithRefs[],
  facets: FacetWithValues[],
): { total: number; uncategorized: number; fullyUncategorized: number } {
  const answerable = answerableFacets(facets);
  const total = codes.length;

  if (answerable.length === 0) {
    return { total, uncategorized: 0, fullyUncategorized: 0 };
  }

  let uncategorized = 0;
  let fullyUncategorized = 0;

  for (const code of codes) {
    const gaps = gapsFor(code, answerable);
    if (gaps.length === 0) continue;
    uncategorized++;
    // Gaps on EVERY answerable facet ⇒ the code carries no value at all.
    if (gaps.length === answerable.length) fullyUncategorized++;
  }

  return { total, uncategorized, fullyUncategorized };
}
