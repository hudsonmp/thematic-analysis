import { describe, expect, it } from 'vitest';
import type { CodeWithRefs, FacetWithValues } from '@/app/actions/codebook';
import { queueStats, triageQueue } from '@/lib/codebook/triage';

// --- stubs -----------------------------------------------------------------
// Only the fields the pure layer reads are modelled; the rest of the row is
// noise for this module, so the stubs are cast rather than fully constructed.

const facet = (
  id: string,
  label: string,
  valueIds: string[],
  type = 'enum',
): FacetWithValues =>
  ({
    id,
    label,
    type,
    values: valueIds.map((vid) => ({ id: vid, facet_id: id })),
  }) as unknown as FacetWithValues;

const code = (
  id: string,
  mnemonic: string,
  facetValueIds: string[],
): CodeWithRefs => ({ id, mnemonic, facetValueIds }) as unknown as CodeWithRefs;

// SPACE has a NESTED taxonomy: s2a is a child of s2. Both are values OF the
// facet, so carrying either answers the facet's question.
const SPACE = facet('f-space', 'Space', ['s1', 's2', 's2a']);
const PHASE = facet('f-phase', 'Phase', ['p1', 'p2']);
const FACETS = [SPACE, PHASE];

describe('triageQueue — what lands in the queue', () => {
  it('excludes a code with zero gaps', () => {
    // A queue that shows finished work is a queue you stop trusting as a to-do
    // list. A fully-answered code has nothing left to be asked, so it is gone.
    const done = code('c1', 'DONE', ['s1', 'p1']);
    expect(triageQueue([done], FACETS)).toEqual([]);
  });

  it('queues a code that answers SOME facets but not others, naming only the unanswered ones', () => {
    // The common case: classification is partial. The item must carry only the
    // questions still owed — showing an answered facet as a gap would send the
    // researcher to re-decide something they already decided.
    const partial = code('c1', 'PART', ['s1']);
    const [item] = triageQueue([partial], FACETS);
    expect(item.gaps).toEqual([{ facetId: 'f-phase', facetLabel: 'Phase' }]);
  });

  it('counts a NESTED value as answering its facet', () => {
    // Values nest into a taxonomy INSIDE one dimension. A child value is still
    // a value of that facet, so a code tagged with the child has answered the
    // facet's question — treating it as a gap would demand an answer the code
    // has already, more precisely, given.
    const nested = code('c1', 'NEST', ['s2a', 'p1']);
    expect(triageQueue([nested], FACETS)).toEqual([]);
  });

  it('returns the code object itself, not a projection of it', () => {
    // The triage UI has to render and then WRITE the code (additive membership
    // actions key off its id). Handing back a copy would force the caller to
    // re-look-up the row it already had.
    const c = code('c1', 'AAA', []);
    expect(triageQueue([c], FACETS)[0].code).toBe(c);
  });
});

describe('triageQueue — ordering', () => {
  it('puts the MOST INCOMPLETE code first', () => {
    // Codes with the most gaps were captured fastest and thought about least —
    // they are where the SCHEME is most likely to be wrong, not merely
    // unapplied. Surfacing them first means the researcher meets the scheme's
    // real problems while there is still budget to fix them.
    const q = triageQueue(
      [
        code('c1', 'ONE', ['s1']), // 1 gap
        code('c2', 'TWO', []), // 2 gaps
        code('c3', 'THREE', ['p1']), // 1 gap
      ],
      FACETS,
    );
    expect(q.map((i) => i.code.id)).toEqual(['c2', 'c1', 'c3']);
    expect(q.map((i) => i.gaps.length)).toEqual([2, 1, 1]);
  });

  it('breaks ties alphabetically by mnemonic, so the list cannot reshuffle under the cursor', () => {
    // The researcher clicks straight down this list. An unstable tiebreak would
    // let equal-gap rows swap between renders — you answer one question and the
    // next row is no longer the row you were looking at.
    const q = triageQueue(
      [
        code('c1', 'ZED', []),
        code('c2', 'ALPHA', []),
        code('c3', 'MID', []),
      ],
      FACETS,
    );
    expect(q.map((i) => i.code.mnemonic)).toEqual(['ALPHA', 'MID', 'ZED']);
  });

  it('is a pure function of the data — input order does not change the output', () => {
    // Determinism is the whole point: the same codebook must yield the same
    // queue on every render, regardless of the order the rows came back in.
    const codes = [
      code('c1', 'BRAVO', ['s1']),
      code('c2', 'ALPHA', ['s1']),
      code('c3', 'CHARLIE', []),
    ];
    const forward = triageQueue(codes, FACETS).map((i) => i.code.mnemonic);
    const reversed = triageQueue([...codes].reverse(), FACETS).map(
      (i) => i.code.mnemonic,
    );
    expect(forward).toEqual(['CHARLIE', 'ALPHA', 'BRAVO']);
    expect(reversed).toEqual(forward);
  });

  it('poses a code’s gaps in SCHEME order, not in an order derived from the code', () => {
    // Facets arrive sorted by position — the order the researcher authored the
    // scheme in. Triage should ask the questions in that same order every time,
    // so the batch feels like one pass down a known form.
    const [item] = triageQueue([code('c1', 'NONE', [])], FACETS);
    expect(item.gaps.map((g) => g.facetLabel)).toEqual(['Space', 'Phase']);
  });
});

describe('triageQueue — which facets are answerable', () => {
  it('ignores non-enum facets', () => {
    // Only enum facets have values. A boolean/open_text facet carries its datum
    // elsewhere entirely, so it is not a question this queue can pose.
    const bool = facet('f-bool', 'Confirmed?', [], 'boolean');
    const text = facet('f-text', 'Notes', [], 'open_text');
    const q = triageQueue([code('c1', 'AAA', ['s1', 'p1'])], [
      ...FACETS,
      bool,
      text,
    ]);
    expect(q).toEqual([]);
  });

  it('ignores an enum facet with NO values defined', () => {
    // A facet with an empty taxonomy has no answer a researcher could give.
    // Counting it as a gap would create an unclearable debt — every code stuck
    // in the queue forever — which trains the researcher to ignore the queue.
    const empty = facet('f-empty', 'Unfinished dimension', []);
    expect(triageQueue([code('c1', 'AAA', ['s1', 'p1'])], [...FACETS, empty]))
      .toEqual([]);
  });
});

describe('triageQueue — empty inputs', () => {
  it('returns an empty queue when there are no codes', () => {
    expect(triageQueue([], FACETS)).toEqual([]);
  });

  it('returns an empty queue when the scheme has no answerable facet', () => {
    // With no question to ask, no code can be "uncategorized" — the notion is
    // meaningless, not true. Queueing everything would show alarming debt that
    // no amount of work could pay down.
    expect(triageQueue([code('c1', 'AAA', [])], [])).toEqual([]);
  });
});

describe('queueStats', () => {
  const CODES = [
    code('c1', 'DONE', ['s1', 'p1']), // 0 gaps
    code('c2', 'PART', ['s2a']), // 1 gap  (nested value answers Space)
    code('c3', 'RAW', []), // 2 gaps → fully uncategorized
    code('c4', 'ALSORAW', []), // 2 gaps → fully uncategorized
  ];

  it('separates partial debt from FULL debt', () => {
    // Fully-uncategorized codes are the pure capture-mode notes the scheme has
    // never touched. They are counted apart because they are hardest to classify
    // later — the reading context that produced them is furthest away. A rising
    // count here is the signal to stop reading and run a triage pass.
    expect(queueStats(CODES, FACETS)).toEqual({
      total: 4,
      uncategorized: 3,
      fullyUncategorized: 2,
    });
  });

  it('agrees with triageQueue about what "uncategorized" means', () => {
    // Two derivations of the same fact must never disagree — a progress meter
    // that contradicts the list beneath it destroys trust in both.
    expect(queueStats(CODES, FACETS).uncategorized).toBe(
      triageQueue(CODES, FACETS).length,
    );
  });

  it('reports zero debt (not total debt) when the scheme has no answerable facet', () => {
    // `total` still counts the codes — they exist — but nothing is owed on them.
    expect(queueStats(CODES, [])).toEqual({
      total: 4,
      uncategorized: 0,
      fullyUncategorized: 0,
    });
  });

  it('reports zeroes for an empty codebook', () => {
    expect(queueStats([], FACETS)).toEqual({
      total: 0,
      uncategorized: 0,
      fullyUncategorized: 0,
    });
  });

  it('does not count a fully-answered codebook as owing anything', () => {
    const all = [code('c1', 'A', ['s1', 'p1']), code('c2', 'B', ['s2', 'p2'])];
    expect(queueStats(all, FACETS)).toEqual({
      total: 2,
      uncategorized: 0,
      fullyUncategorized: 0,
    });
  });
});
