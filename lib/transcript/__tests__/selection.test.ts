import { describe, it, expect } from 'vitest';
import {
  buildTextAnchor,
  splitIntoPieces,
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
