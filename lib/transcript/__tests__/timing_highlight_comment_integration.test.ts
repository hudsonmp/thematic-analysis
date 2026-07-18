// Cross-feature CONSISTENCY tests for the session player's pure logic. The unit
// tests in this folder each pin ONE helper; this file threads the SAME realistic
// multi-track fixture through the WHOLE pipeline the player runs — parse →
// orderByTime → groupIntoTurns → segIndexById/turnIndexBySegIdx → cardsByTurn —
// plus findActiveIndex / nearestCueIndex / buildMultiAnchor / splitIntoPieces, and
// asserts they MUTUALLY AGREE: the cue a highlight tracks, the index an anchor
// resolves to, and the turn a comment card hangs in are the same cue/index/turn.
//
// We import and COMPOSE the real helpers (never reimplement them), and we rebuild
// segIndexById / turnIndexBySegIdx EXACTLY the way SessionPlayer.tsx does
// (segIndexById = id→array index over the ordered array; turnIndexBySegIdx = for
// each turn, each segIndex→turnIdx) so this is a faithful proof of the wiring.

import { describe, it, expect } from 'vitest';
import { parseSrt, type Segment } from '../srt';
import { orderByTime } from '../order';
import { groupIntoTurns, type TurnSegment } from '../turns';
import { findActiveIndex, nearestCueIndex, type TimedCue } from '../active';
import { buildMultiAnchor, splitIntoPieces, type Highlight } from '../selection';
import { cardsByTurn, type RailAnnotation } from '../rail';

// ---------------------------------------------------------------------------
// Fixture: a realistic multi-track SRT modeled on a Zoom per-speaker export.
//
//   • David (speaker A) has ONE 80s track-level blob cue spanning 70..79640ms
//     (~15 words) — the classic "interjection inflated to the next utterance" cue.
//   • Hudson (speaker B) has 12 SHORT phrase cues (5..10s each) whose start AND end
//     times all fall INSIDE David's 70..79640 span.
//   • David then has a later cue at 79640..92600ms.
//
// In SRT BLOCK order the tracks are clustered by speaker (all of David's, then all
// of Hudson's, then David's tail) — i.e. NOT temporal order. orderByTime must
// interleave them; groupIntoTurns over the ordered array must yield A, B-monologue,
// A. We build it as an SRT string so parseSrt's multi-track speaker vote is also
// exercised end to end.
// ---------------------------------------------------------------------------

function tc(ms: number): string {
  const hh = Math.floor(ms / 3_600_000);
  const mm = Math.floor((ms % 3_600_000) / 60_000);
  const ss = Math.floor((ms % 60_000) / 1000);
  const mmm = ms % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(hh)}:${p(mm)}:${p(ss)},${p(mmm, 3)}`;
}

// Hudson's 12 phrase cues, each entirely inside David's 70..79640 blob.
const HUDSON_PHRASES: Array<{ start: number; end: number; text: string }> = [
  { start: 3750, end: 9000, text: 'so the first thing I tried' },
  { start: 9000, end: 13770, text: 'was reading the requirements' },
  { start: 13770, end: 20010, text: 'and then I wrote a test case' },
  { start: 20010, end: 26000, text: 'but it failed on the edge input' },
  { start: 26820, end: 31400, text: 'so I had to rethink the spec' },
  { start: 31400, end: 37000, text: 'maybe the boundary is off by one' },
  { start: 37000, end: 42500, text: 'let me check the example again' },
  { start: 42500, end: 48000, text: 'okay that makes more sense now' },
  { start: 48000, end: 54000, text: 'I think the issue was my assumption' },
  { start: 54000, end: 61000, text: 'about how the function returns' },
  { start: 61000, end: 68000, text: 'so I will add another assertion' },
  { start: 68000, end: 75000, text: 'and verify it covers both cases' },
];

// David's two cues (the 80s blob, then a tail cue after Hudson's monologue).
const DAVID_BLOB = {
  start: 70,
  end: 79640,
  text: 'okay go ahead and walk me through your reasoning take your time it is fine',
};
const DAVID_TAIL = { start: 79640, end: 92600, text: 'great that all makes sense to me' };

/** Build the multi-track SRT in BLOCK order: all of David first (blob), then all
 *  of Hudson's phrases, then David's tail. This is deliberately NON-temporal so the
 *  test proves orderByTime actually reinterleaves. (Indices 1, 14 = David.) */
function buildSrt(): string {
  const blocks: string[] = [];
  let n = 1;
  const add = (start: number, end: number, line: string) => {
    blocks.push(`${n}\n${tc(start)} --> ${tc(end)}\n${line}`);
    n += 1;
  };
  add(DAVID_BLOB.start, DAVID_BLOB.end, `David: ${DAVID_BLOB.text}`); // block 1
  for (const p of HUDSON_PHRASES) add(p.start, p.end, `Hudson: ${p.text}`); // blocks 2..13
  add(DAVID_TAIL.start, DAVID_TAIL.end, `David: ${DAVID_TAIL.text}`); // block 14
  return blocks.join('\n\n') + '\n';
}

/** parseSrt then attach a stable DB-style id per cue (the player anchors on the
 *  cb_segments.id, not the SRT ordinal). Returns the BLOCK-ORDER segments. */
function parsedBlockOrder(): Array<Segment & { id: string }> {
  return parseSrt(buildSrt()).map((s) => ({ ...s, id: `seg-${s.idx}` }));
}

describe('multi-track fixture sanity (parse)', () => {
  it('parses as multi-track with the expected speakers and counts', () => {
    const segs = parsedBlockOrder();
    expect(segs).toHaveLength(14); // 1 blob + 12 phrases + 1 tail
    // Multi-track vote succeeded: every block had a "Speaker: text" prefix.
    expect(segs.every((s) => s.speaker !== null)).toBe(true);
    expect(segs[0].speaker).toBe('David');
    expect(segs[13].speaker).toBe('David');
    expect(segs.filter((s) => s.speaker === 'Hudson')).toHaveLength(12);
    // The blob's span really does contain every Hudson phrase.
    const blob = segs[0];
    for (const h of segs.filter((s) => s.speaker === 'Hudson')) {
      expect(h.startMs).toBeGreaterThanOrEqual(blob.startMs);
      expect(h.endMs).toBeLessThanOrEqual(blob.endMs);
    }
  });
});

// ---------------------------------------------------------------------------
// PROPERTY 1 — TIMING / ORDER
// ---------------------------------------------------------------------------
describe('Property 1: orderByTime + groupIntoTurns yield the temporal A / B / A shape', () => {
  it('orderByTime sorts cues into video order (blob first, phrases by start, tail last)', () => {
    const ordered = orderByTime(parsedBlockOrder());
    // Start times must be non-decreasing.
    for (let i = 1; i < ordered.length; i++) {
      expect(ordered[i].startMs).toBeGreaterThanOrEqual(ordered[i - 1].startMs);
    }
    // The 80s blob (start 70) sorts FIRST even though phrases have shorter spans.
    expect(ordered[0].speaker).toBe('David');
    expect(ordered[0].startMs).toBe(70);
    // David's tail (start 79640) sorts LAST — after all 12 phrases.
    expect(ordered[ordered.length - 1].speaker).toBe('David');
    expect(ordered[ordered.length - 1].startMs).toBe(79640);
  });

  it('groupIntoTurns over the ordered array is exactly [David, Hudson-monologue(12), David]', () => {
    const ordered = orderByTime(parsedBlockOrder());
    const turns = groupIntoTurns(ordered as TurnSegment[]);
    expect(turns.map((t) => t.speaker)).toEqual(['David', 'Hudson', 'David']);
    expect(turns[0].segIndices).toHaveLength(1); // blob
    expect(turns[1].segIndices).toHaveLength(12); // the whole monologue coalesced
    expect(turns[2].segIndices).toHaveLength(1); // tail
    // The Hudson turn's index range is contiguous (1..12) over the ordered array.
    expect(turns[1].segIndices).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    // Turn time bounds come from first-start / last-end of the run.
    expect(turns[1].startMs).toBe(3750);
    expect(turns[1].endMs).toBe(75000);
  });
});

// ---------------------------------------------------------------------------
// PROPERTY 2 — TIMING / ACTIVE CUE (tightest containing, not the blob)
// ---------------------------------------------------------------------------
describe('Property 2: findActiveIndex returns the TIGHT phrase, not the 80s blob', () => {
  const ordered = orderByTime(parsedBlockOrder());

  it('inside a phrase returns that phrase index (not the containing blob at idx 0)', () => {
    // 8000 ∈ blob(70..79640) AND phrase "so the first thing I tried"(3750..9000).
    const i8 = findActiveIndex(ordered, 8000);
    expect(ordered[i8].speaker).toBe('Hudson');
    expect(ordered[i8].text).toBe('so the first thing I tried');
    expect(i8).not.toBe(0); // emphatically NOT the blob

    const i15 = findActiveIndex(ordered, 15000);
    expect(ordered[i15].text).toBe('and then I wrote a test case'); // 13770..20010

    const i40 = findActiveIndex(ordered, 40000);
    expect(ordered[i40].text).toBe('let me check the example again'); // 37000..42500
  });

  it('a time only the blob covers (before phrases start) returns the blob', () => {
    // 2000 < first phrase start (3750); only the blob contains it.
    expect(findActiveIndex(ordered, 2000)).toBe(0);
    expect(ordered[0].speaker).toBe('David');
  });

  it('a true gap (after the blob, before the tail) returns -1', () => {
    // blob ends 79640; tail starts 79640 → exclusive end means (79640-ε) is a gap,
    // and there is a real gap region only if blob.end < tail.start. They are equal
    // here, so pick a time strictly after the tail to get a no-container -1.
    expect(findActiveIndex(ordered, 200000)).toBe(-1);
  });

  it('constructed adversarial gap: a hole between the blob and tail returns -1', () => {
    // Move the tail later so there IS a [79640, 85000) hole no cue covers.
    const cues: TimedCue[] = ordered.map((s) => ({ startMs: s.startMs, endMs: s.endMs }));
    // blob = cues[0] (70..79640); last cue = the tail (79640..92600). Carve a hole
    // by shrinking the blob's end to 78000 and lifting the tail to start at 85000.
    cues[0] = { startMs: 70, endMs: 78000 };
    cues[cues.length - 1] = { startMs: 85000, endMs: 92600 };
    // 80000 is now after every phrase (last ends 75000), after the shrunk blob, and
    // before the tail → no container.
    expect(findActiveIndex(cues, 80000)).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// PROPERTY 3 — HIGHLIGHT / FLAG MAPPING (nearestCueIndex never -1 on a non-empty
// transcript; tight when containing, nearest-by-gap otherwise)
// ---------------------------------------------------------------------------
describe('Property 3: nearestCueIndex maps every flag onto some cue', () => {
  const ordered = orderByTime(parsedBlockOrder());

  it('agrees with findActiveIndex when a cue contains the flag time', () => {
    for (const t of [8000, 15000, 40000]) {
      expect(nearestCueIndex(ordered, t)).toBe(findActiveIndex(ordered, t));
    }
  });

  it('never returns -1 for a non-empty transcript across the whole timeline + beyond', () => {
    for (let t = -5000; t <= 100000; t += 250) {
      expect(nearestCueIndex(ordered, t)).toBeGreaterThanOrEqual(0);
    }
  });

  it('an inter-phrase gap attaches to the nearer phrase by time distance', () => {
    // There is a real hole between phrase[4] (..26000) and phrase[5] (26820..) —
    // i.e. ordered indices for "but it failed on the edge input" (20010..26000)
    // and "so I had to rethink the spec" (26820..31400). BUT the 80s David blob
    // (70..79640) CONTAINS that whole hole, so containment wins and the tight cue
    // is the blob. Assert that explicitly — this is the subtle multi-track reality.
    const idx = nearestCueIndex(ordered, 26400); // 26000 < 26400 < 26820
    expect(idx).toBe(0); // the blob contains 26400, so it's the tightest container
    expect(ordered[idx].speaker).toBe('David');
  });

  it('gap mapping (no container) falls to the nearest cue by gap, ties to earliest', () => {
    // Pure single-track fixture so there is no covering blob: a flag in the hole.
    const single: TimedCue[] = [
      { startMs: 0, endMs: 1000 },
      { startMs: 2000, endMs: 3000 },
    ];
    expect(nearestCueIndex(single, 1300)).toBe(0); // 300 to cue0.end < 700 to cue1.start
    expect(nearestCueIndex(single, 1700)).toBe(1); // 300 to cue1.start < 700 to cue0.end
    // Equidistant midpoint (1500): gap 500 to both → ties resolve to earliest.
    expect(nearestCueIndex(single, 1500)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PROPERTY 4 — HIGHLIGHT / ANCHOR (buildMultiAnchor reconstructs; splitIntoPieces
// concatenates back EXACTLY, the no-injected-glyph invariant)
// ---------------------------------------------------------------------------
describe('Property 4: anchors reconstruct and pieces concatenate to the exact text', () => {
  const ordered = orderByTime(parsedBlockOrder());

  it('single-cue anchor: quoteText equals the selected slice of the phrase text', () => {
    const phrase = ordered.find((s) => s.text === 'and then I wrote a test case')!;
    // Select "wrote a test" within the phrase.
    const start = phrase.text.indexOf('wrote');
    const end = phrase.text.indexOf('test') + 'test'.length;
    const a = buildMultiAnchor([phrase.text], start, end);
    expect(a).not.toBeNull();
    expect(a!.quoteText).toBe('wrote a test');
    expect(phrase.text.slice(a!.startChar, a!.endChar)).toBe('wrote a test');
  });

  it('multi-cue anchor across three consecutive phrases reconstructs with single-space joins', () => {
    // Phrases at ordered indices 1,2,3: span from mid-phrase1 to mid-phrase3.
    const p1 = ordered[1].text; // 'so the first thing I tried'
    const p2 = ordered[2].text; // 'was reading the requirements'
    const p3 = ordered[3].text; // 'and then I wrote a test case'
    const startChar = p1.indexOf('first'); // start mid-first-phrase
    const endChar = p3.indexOf('wrote'); // end mid-third-phrase (exclusive)
    const a = buildMultiAnchor([p1, p2, p3], startChar, endChar);
    expect(a).not.toBeNull();
    // first.slice(start) + whole middle + last.slice(0,end), joined by single space.
    const expected = [p1.slice(startChar), p2, p3.slice(0, endChar)].join(' ');
    expect(a!.quoteText).toBe(expected);
    expect(a!.quoteText).toBe('first thing I tried was reading the requirements and then I ');
  });

  it('splitIntoPieces over overlapping highlights concatenates back to the EXACT text (no glyph injected/dropped)', () => {
    const phrase = ordered.find((s) => s.text === 'but it failed on the edge input')!;
    const text = phrase.text;
    // Two overlapping highlights: a code over [4,20), a quote over [12,28).
    const highlights: Highlight[] = [
      { annotationId: 'code-1', charStart: 4, charEnd: 20, kind: 'code' },
      { annotationId: 'quote-1', charStart: 12, charEnd: 28, kind: 'quote' },
    ];
    const pieces = splitIntoPieces(text, highlights);
    // INVARIANT: no injected/dropped chars — pieces rejoin to the original byte-for-byte.
    expect(pieces.map((p) => p.text).join('')).toBe(text);
    // The overlap region [12,20) must carry BOTH ids and BOTH kinds (layering).
    const overlap = pieces.find((p) => p.highlightIds.length === 2);
    expect(overlap).toBeDefined();
    expect(overlap!.highlightIds.sort()).toEqual(['code-1', 'quote-1']);
    expect(overlap!.kinds.sort()).toEqual(['code', 'quote']);
    // A piece covered by exactly one highlight carries exactly that id/kind.
    const codeOnly = pieces.find(
      (p) => p.highlightIds.length === 1 && p.highlightIds[0] === 'code-1',
    );
    expect(codeOnly).toBeDefined();
    expect(codeOnly!.kinds).toEqual(['code']);
  });

  it('splitIntoPieces with NO highlights is a single uncovered piece equal to the text', () => {
    const text = ordered[0].text;
    expect(splitIntoPieces(text, [])).toEqual([{ text, highlightIds: [], kinds: [] }]);
  });
});

// ---------------------------------------------------------------------------
// PROPERTY 5 — COMMENT/QUOTE RAIL (eligibility + bucketing)
// ---------------------------------------------------------------------------
describe('Property 5: rail eligibility and turn bucketing', () => {
  const ordered = orderByTime(parsedBlockOrder());
  const turns = groupIntoTurns(ordered as TurnSegment[]);
  // Rebuild the two index maps EXACTLY as SessionPlayer does.
  const segIndexById = new Map<string, number>();
  ordered.forEach((s, i) => segIndexById.set(s.id, i));
  const turnIndexBySegIdx = new Map<number, number>();
  turns.forEach((t, ti) => t.segIndices.forEach((si) => turnIndexBySegIdx.set(si, ti)));

  it('only annotations with notes are eligible; bare quotes and bare codes are not', () => {
    // (annotationHasRailCard is exercised via cardsByTurn here.) Marginalia ARE
    // the notes: a bare quote's yellow span is its presence, so it renders no
    // margin entry — same as a bare code anchor (whose brace is its rendering).
    const anns: RailAnnotation[] = [
      { id: 'q-bare-quote', segmentId: ordered[1].id }, // NOT eligible (no notes)
      { id: 'c-commented', segmentId: ordered[2].id }, // eligible (has a note)
      { id: 'c-bare', segmentId: ordered[3].id }, // NOT eligible
    ];
    const map = cardsByTurn(anns, new Set(['c-commented']), segIndexById, turnIndexBySegIdx);
    const allIds = [...map.values()].flat().map((c) => c.annId);
    expect(allIds).not.toContain('q-bare-quote');
    expect(allIds).toContain('c-commented');
    expect(allIds).not.toContain('c-bare');
  });

  it('buckets each eligible annotation into the turn of its START segment', () => {
    const anns: RailAnnotation[] = [
      { id: 'on-blob', segmentId: ordered[0].id }, // David turn 0
      { id: 'on-phrase', segmentId: ordered[5].id }, // Hudson turn 1
      { id: 'on-tail', segmentId: ordered[13].id }, // David turn 2
    ];
    const map = cardsByTurn(
      anns,
      new Set(['on-blob', 'on-phrase', 'on-tail']),
      segIndexById,
      turnIndexBySegIdx,
    );
    expect(map.get(0)?.map((c) => c.annId)).toEqual(['on-blob']);
    expect(map.get(1)?.map((c) => c.annId)).toEqual(['on-phrase']);
    expect(map.get(2)?.map((c) => c.annId)).toEqual(['on-tail']);
  });

  it('drops an annotation whose start segment is not in the active version', () => {
    const anns: RailAnnotation[] = [{ id: 'stale', segmentId: 'seg-999' }];
    const map = cardsByTurn(anns, new Set(['stale']), segIndexById, turnIndexBySegIdx);
    expect(map.size).toBe(0);
  });

  it('preserves input (time) order within a turn', () => {
    // Three noted excerpts all on Hudson phrases (turn 1), in playback/time order.
    const anns: RailAnnotation[] = [
      { id: 'first', segmentId: ordered[1].id },
      { id: 'second', segmentId: ordered[6].id },
      { id: 'third', segmentId: ordered[11].id },
    ];
    const map = cardsByTurn(
      anns,
      new Set(['first', 'second', 'third']),
      segIndexById,
      turnIndexBySegIdx,
    );
    expect(map.get(1)?.map((c) => c.annId)).toEqual(['first', 'second', 'third']);
  });
});

// ---------------------------------------------------------------------------
// PROPERTY 6 — END-TO-END COMPOSITION ("everything matches up")
//
// Thread the SAME fixture through the full pipeline and assert that for a quote
// anchored to a B (Hudson) phrase:
//   (a) the highlight's start segment resolves (segIndexById) to that phrase's
//       ordered index,
//   (b) findActiveIndex at that phrase's mid-time returns the SAME ordered index,
//   (c) the rail card lands in the Hudson-monologue turn (turnIndexBySegIdx of that
//       same index) — the turn cardsByTurn buckets it into.
// The cue the highlight tracks, the index the anchor resolves to, and the turn the
// comment hangs in are therefore one and the same.
// ---------------------------------------------------------------------------
describe('Property 6: end-to-end — highlight cue, anchor index, and card turn all agree', () => {
  it('a quote on a B phrase is mutually consistent across active cue / anchor / rail', () => {
    // 1. parse → 2. orderByTime → 3. groupIntoTurns
    const ordered = orderByTime(parsedBlockOrder());
    const turns = groupIntoTurns(ordered as TurnSegment[]);

    // 4. Build the SessionPlayer maps the SAME way the component does.
    const segIndexById = new Map<string, number>();
    ordered.forEach((s, i) => segIndexById.set(s.id, i));
    const turnIndexBySegIdx = new Map<number, number>();
    turns.forEach((t, ti) => t.segIndices.forEach((si) => turnIndexBySegIdx.set(si, ti)));

    // Pick a specific B phrase to anchor a quote on.
    const targetText = 'I think the issue was my assumption'; // phrase 48000..54000
    const phrase = ordered.find((s) => s.text === targetText)!;
    const orderedIdx = segIndexById.get(phrase.id)!;

    // (a) The annotation's start segment id resolves to the phrase's ordered index.
    const ann: RailAnnotation = { id: 'q-consistent', segmentId: phrase.id };
    const resolvedIdx = segIndexById.get(ann.segmentId);
    expect(resolvedIdx).toBe(orderedIdx);

    // (b) findActiveIndex at the phrase's mid-time returns that SAME index — i.e.
    //     the follow-along highlight tracking this cue and the anchor agree, and the
    //     long blob does NOT steal it.
    const midMs = Math.floor((phrase.startMs + phrase.endMs) / 2); // 51000
    const activeIdx = findActiveIndex(ordered, midMs);
    expect(activeIdx).toBe(orderedIdx);
    expect(ordered[activeIdx].text).toBe(targetText);

    // The flag-mapping path (nearestCueIndex) lands on the same cue at that time.
    expect(nearestCueIndex(ordered, midMs)).toBe(orderedIdx);

    // (c) The rail card (the excerpt carries a note) buckets into the Hudson-
    //     monologue turn — the same turn turnIndexBySegIdx assigns to that index.
    const expectedTurnIdx = turnIndexBySegIdx.get(orderedIdx)!;
    expect(turns[expectedTurnIdx].speaker).toBe('Hudson');
    const map = cardsByTurn([ann], new Set(['q-consistent']), segIndexById, turnIndexBySegIdx);
    expect(map.get(expectedTurnIdx)?.map((c) => c.annId)).toEqual(['q-consistent']);
    // And it appears in NO other turn.
    for (const [ti, cards] of map) {
      if (ti !== expectedTurnIdx) expect(cards.map((c) => c.annId)).not.toContain('q-consistent');
    }

    // And the anchor reconstructs the exact phrase text the highlight covers.
    const anchor = buildMultiAnchor([phrase.text], 0, phrase.text.length);
    expect(anchor!.quoteText).toBe(targetText);
  });

  it('the highlight expansion path (segIndexById) and the rail path use the SAME index basis', () => {
    // SessionPlayer expands a multi-cue annotation by looking start/end segment ids
    // up in segIndexById (ARRAY INDEX over the ordered array), and buckets rail cards
    // through the SAME segIndexById. Prove both agree for a multi-cue quote: its
    // start cue's index is what BOTH the highlight range and the card resolve to.
    const ordered = orderByTime(parsedBlockOrder());
    const turns = groupIntoTurns(ordered as TurnSegment[]);
    const segIndexById = new Map<string, number>();
    ordered.forEach((s, i) => segIndexById.set(s.id, i));
    const turnIndexBySegIdx = new Map<number, number>();
    turns.forEach((t, ti) => t.segIndices.forEach((si) => turnIndexBySegIdx.set(si, ti)));

    const startSeg = ordered[3]; // a Hudson phrase
    const endSeg = ordered[5]; // a later Hudson phrase (multi-cue span)
    const startIdx = segIndexById.get(startSeg.id)!;
    const endIdx = segIndexById.get(endSeg.id)!;
    expect(endIdx).toBeGreaterThan(startIdx); // ordered range is well-formed

    // The rail card anchors to the START segment id → start index → its turn.
    const ann: RailAnnotation = { id: 'q-multi', segmentId: startSeg.id };
    const map = cardsByTurn([ann], new Set(['q-multi']), segIndexById, turnIndexBySegIdx);
    const cardTurn = turnIndexBySegIdx.get(startIdx)!;
    expect(map.get(cardTurn)?.map((c) => c.annId)).toEqual(['q-multi']);
    // The whole multi-cue span lives in ONE turn (the Hudson monologue), so the
    // card's turn equals the end cue's turn too — no cross-turn ambiguity.
    expect(turnIndexBySegIdx.get(endIdx)).toBe(cardTurn);
  });
});
