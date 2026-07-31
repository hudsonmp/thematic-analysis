import { describe, it, expect } from 'vitest';
import {
  buildTextAnchor,
  buildMultiAnchor,
  splitIntoPieces,
  sentenceSpans,
  snapToSentences,
  CONTEXT_CHARS,
  type Highlight,
} from '../selection';

describe('buildTextAnchor', () => {
  const text = 'The quick brown fox jumps over the lazy dog.';

  it('captures the substring, prefix, and suffix for a mid-string span', () => {
    // "quick" is at offsets [4, 9).
    const a = buildTextAnchor(text, 4, 9);
    expect(a).not.toBeNull();
    expect(a!.charStart).toBe(4);
    expect(a!.charEnd).toBe(9);
    expect(a!.quoteText).toBe('quick');
    expect(text.slice(a!.charStart, a!.charEnd)).toBe('quick');
    expect(a!.prefix).toBe('The ');
    expect(a!.suffix).toBe(' brown fox jumps over the lazy d'); // 32 chars
    expect(a!.suffix.length).toBe(CONTEXT_CHARS);
  });

  it('normalizes a backwards (end < start) selection to the same span', () => {
    const forward = buildTextAnchor(text, 4, 9);
    const backward = buildTextAnchor(text, 9, 4);
    expect(backward).toEqual(forward);
  });

  it('clamps offsets that run past the text and into [0, len]', () => {
    const a = buildTextAnchor(text, -5, text.length + 50);
    expect(a!.charStart).toBe(0);
    expect(a!.charEnd).toBe(text.length);
    expect(a!.quoteText).toBe(text);
    expect(a!.prefix).toBe('');
    expect(a!.suffix).toBe('');
  });

  it('truncates prefix/suffix to at most CONTEXT_CHARS', () => {
    const long = 'x'.repeat(100) + 'TARGET' + 'y'.repeat(100);
    const start = 100;
    const a = buildTextAnchor(long, start, start + 'TARGET'.length);
    expect(a!.quoteText).toBe('TARGET');
    expect(a!.prefix).toBe('x'.repeat(CONTEXT_CHARS));
    expect(a!.suffix).toBe('y'.repeat(CONTEXT_CHARS));
  });

  it('returns null for a collapsed/empty selection', () => {
    expect(buildTextAnchor(text, 5, 5)).toBeNull();
  });
});

describe('splitIntoPieces', () => {
  const text = 'abcdefghij'; // offsets 0..10

  function h(annotationId: string, charStart: number, charEnd: number, kind = 'code'): Highlight {
    return { annotationId, charStart, charEnd, kind };
  }

  it('returns a single uncovered piece when there are no highlights', () => {
    const pieces = splitIntoPieces(text, []);
    expect(pieces).toEqual([{ text, highlightIds: [], kinds: [] }]);
  });

  it('splits at one highlight into [before, covered, after]', () => {
    const pieces = splitIntoPieces(text, [h('a', 2, 5)]);
    expect(pieces.map((p) => p.text)).toEqual(['ab', 'cde', 'fghij']);
    expect(pieces[0].highlightIds).toEqual([]);
    expect(pieces[1].highlightIds).toEqual(['a']);
    expect(pieces[1].kinds).toEqual(['code']);
    expect(pieces[2].highlightIds).toEqual([]);
  });

  it('concatenates back to the original text exactly', () => {
    const pieces = splitIntoPieces(text, [h('a', 1, 4), h('b', 3, 7, 'quote')]);
    expect(pieces.map((p) => p.text).join('')).toBe(text);
  });

  it('carries BOTH ids on the overlapping region (layering)', () => {
    // a:[1,4) b:[3,7) overlap on [3,4).
    const pieces = splitIntoPieces(text, [h('a', 1, 4), h('b', 3, 7, 'quote')]);
    // Boundaries at 0,1,3,4,7,10 → pieces: [0,1) [1,3) [3,4) [4,7) [7,10)
    const overlap = pieces.find((p) => p.text === 'd'); // offset [3,4)
    expect(overlap).toBeDefined();
    expect(overlap!.highlightIds.sort()).toEqual(['a', 'b']);
    expect(overlap!.kinds.sort()).toEqual(['code', 'quote']);
  });

  it('ignores empty highlights and clamps out-of-range bounds', () => {
    const pieces = splitIntoPieces(text, [h('empty', 5, 5), h('over', -3, 100)]);
    // 'empty' contributes nothing; 'over' clamps to whole text.
    expect(pieces).toHaveLength(1);
    expect(pieces[0].text).toBe(text);
    expect(pieces[0].highlightIds).toEqual(['over']);
  });

  it('returns no pieces for empty text', () => {
    expect(splitIntoPieces('', [h('a', 0, 0)])).toEqual([]);
  });
});

describe('buildMultiAnchor', () => {
  it('single segment: matches buildTextAnchor (normalized, with context)', () => {
    const t = 'The quick brown fox jumps over the lazy dog.';
    const a = buildMultiAnchor([t], 4, 9); // "quick"
    expect(a).not.toBeNull();
    expect(a!.startChar).toBe(4);
    expect(a!.endChar).toBe(9);
    expect(a!.quoteText).toBe('quick');
    expect(a!.prefix).toBe('The ');
    expect(a!.suffix.startsWith(' brown')).toBe(true);
  });

  it('single segment: collapsed selection → null', () => {
    expect(buildMultiAnchor(['hello world'], 3, 3)).toBeNull();
  });

  it('single segment: normalizes a backwards offset pair', () => {
    const a = buildMultiAnchor(['hello world'], 9, 2); // swapped
    expect(a!.startChar).toBe(2);
    expect(a!.endChar).toBe(9);
    expect(a!.quoteText).toBe('llo wor');
  });

  it('empty input → null', () => {
    expect(buildMultiAnchor([], 0, 5)).toBeNull();
  });

  it('two segments: joins start-slice + end-slice with a single space', () => {
    // start: "...world" from index 6; end: "hello..." to index 5
    const a = buildMultiAnchor(['hello world', 'hello there'], 6, 5);
    expect(a).not.toBeNull();
    expect(a!.startChar).toBe(6);
    expect(a!.endChar).toBe(5);
    expect(a!.quoteText).toBe('world hello');
  });

  it('three+ segments: middle segments are included WHOLE, in order', () => {
    const a = buildMultiAnchor(['aaa end', 'MIDDLE', 'start bbb'], 4, 5);
    // first.slice(4)="end", middle whole="MIDDLE", last.slice(0,5)="start"
    expect(a!.quoteText).toBe('end MIDDLE start');
  });

  it('multi-segment: prefix from FIRST segment, suffix from LAST segment', () => {
    const first = 'x'.repeat(CONTEXT_CHARS + 10) + 'START';
    const startChar = first.length - 'START'.length; // select from "START"
    const last = 'ENDpart' + 'y'.repeat(CONTEXT_CHARS + 10);
    const endChar = 'ENDpart'.length;
    const a = buildMultiAnchor([first, 'mid', last], startChar, endChar);
    expect(a!.prefix.length).toBe(CONTEXT_CHARS);
    expect(a!.prefix.endsWith('x')).toBe(true);
    expect(a!.suffix.length).toBe(CONTEXT_CHARS);
    expect(a!.suffix.startsWith('y')).toBe(true);
    expect(a!.quoteText).toBe('START mid ENDpart');
  });

  it('multi-segment: clamps out-of-range offsets to each segment', () => {
    const a = buildMultiAnchor(['abc', 'def'], 99, 99);
    // startChar clamps to first.length (3) → start slice empty; endChar clamps to
    // last.length (3) → whole last. quoteText = "" + " " + "def".
    expect(a!.startChar).toBe(3);
    expect(a!.endChar).toBe(3);
    expect(a!.quoteText).toBe(' def');
  });
});

describe('sentenceSpans', () => {
  it('splits on . ! ? and tiles the whole string', () => {
    const t = 'First one. Second! Third?';
    const spans = sentenceSpans(t);
    // Spans must tile: each start equals the previous end, covering [0, len].
    expect(spans[0][0]).toBe(0);
    expect(spans[spans.length - 1][1]).toBe(t.length);
    for (let i = 1; i < spans.length; i++) expect(spans[i][0]).toBe(spans[i - 1][1]);
    expect(spans).toHaveLength(3);
    expect(t.slice(...spans[0]).trim()).toBe('First one.');
    expect(t.slice(...spans[1]).trim()).toBe('Second!');
    expect(t.slice(...spans[2]).trim()).toBe('Third?');
  });

  it('a cue with no terminal punctuation is one sentence', () => {
    expect(sentenceSpans('so remember to tell me what you')).toEqual([[0, 31]]);
  });

  it('empty / whitespace text yields one covering span', () => {
    expect(sentenceSpans('')).toEqual([[0, 0]]);
    expect(sentenceSpans('   ')).toEqual([[0, 3]]);
  });

  it('keeps trailing quote/bracket with the terminator', () => {
    const t = 'He said "go." Then left.';
    const spans = sentenceSpans(t);
    expect(t.slice(...spans[0]).trim()).toBe('He said "go."');
  });
});

describe('snapToSentences', () => {
  const t = 'First one. Second sentence here. Third.';
  //         0         10                 33

  it('expands a mid-sentence drag outward to whole sentences', () => {
    // select "cond sentence he" (inside the 2nd sentence) → whole 2nd sentence.
    const s = t.indexOf('cond');
    const e = t.indexOf('he') + 2;
    const out = snapToSentences(t, s, e);
    expect(t.slice(out.start, out.end).trim()).toBe('Second sentence here.');
  });

  it('a selection already on sentence boundaries is unchanged', () => {
    const start = t.indexOf('Second');
    const end = t.indexOf('here.') + 'here.'.length + 1; // include trailing space
    const out = snapToSentences(t, start, end);
    expect(out.start).toBe(start);
    expect(t.slice(out.start, out.end).trim()).toBe('Second sentence here.');
  });

  it('a selection spanning two sentences expands to cover both wholly', () => {
    const s = t.indexOf('one'); // inside sentence 1
    const e = t.indexOf('Second') + 3; // inside sentence 2
    const out = snapToSentences(t, s, e);
    expect(out.start).toBe(0);
    expect(t.slice(out.start, out.end).trim()).toBe('First one. Second sentence here.');
  });

  it('no-punctuation cue snaps to the whole cue', () => {
    const frag = 'just a fragment with no end';
    const out = snapToSentences(frag, 5, 9);
    expect(out).toEqual({ start: 0, end: frag.length });
  });
});
