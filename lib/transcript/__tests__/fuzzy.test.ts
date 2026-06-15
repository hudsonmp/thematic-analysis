import { describe, it, expect } from 'vitest';
import { fuzzyScore, fuzzyRank, type FuzzyMatch } from '../fuzzy';

// The picker ranks plain code labels, so most tests use `string[]` with the
// identity haystack. A few use objects to prove `toSearchString` is honored.
const id = (s: string) => s;

/** Pull just the items (in ranked order) out of a FuzzyMatch list. */
function items<T>(matches: FuzzyMatch<T>[]): T[] {
  return matches.map((m) => m.item);
}

describe('fuzzyScore', () => {
  it('returns score 1 / no indices for an empty (or whitespace-only) query', () => {
    expect(fuzzyScore('', 'Specification')).toEqual({ score: 1, matchedIndices: [] });
    expect(fuzzyScore('   ', 'Specification')).toEqual({ score: 1, matchedIndices: [] });
  });

  it('returns null when the query is not a subsequence of the haystack', () => {
    expect(fuzzyScore('zzz', 'Specification')).toBeNull();
    // Right chars, wrong order — subsequence must be ORDERED.
    expect(fuzzyScore('cs', 'Specification')).toBeNull();
  });

  it('matches an ordered subsequence (s-p-c inside "Specification")', () => {
    const r = fuzzyScore('spc', 'Specification');
    expect(r).not.toBeNull();
    // Verify indices are strictly increasing and point at the right chars.
    const indices = r!.matchedIndices;
    expect(indices.length).toBe(3);
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBeGreaterThan(indices[i - 1]);
    }
    expect('Specification'[indices[0]].toLowerCase()).toBe('s');
    expect('Specification'[indices[1]].toLowerCase()).toBe('p');
    expect('Specification'[indices[2]].toLowerCase()).toBe('c');
  });

  it('matches a subsequence spread across words ("spc" in "writing specification")', () => {
    expect(fuzzyScore('spc', 'writing specification')).not.toBeNull();
  });

  it('is case-insensitive ("REQ" matches "requirements")', () => {
    const r = fuzzyScore('REQ', 'requirements');
    expect(r).not.toBeNull();
    // r=0, e=1, q=2 — a contiguous prefix run.
    expect(r!.matchedIndices).toEqual([0, 1, 2]);
  });

  it('ignores whitespace inside the query (spaces are separators, not matched)', () => {
    expect(fuzzyScore('s p c', 'Specification')).toEqual(fuzzyScore('spc', 'Specification'));
  });

  it('reports the correct greedy matched indices for a known case', () => {
    // "spec" in "Specification": greedy first-occurrence at/after prev.
    // S(0) p(1) e(2) c(3) i(4) ... → s=0, p=1, e=2, c=3.
    expect(fuzzyScore('spec', 'Specification')!.matchedIndices).toEqual([0, 1, 2, 3]);
  });

  it('awards the start bonus only at index 0 (prefix beats mid-string)', () => {
    const prefix = fuzzyScore('req', 'Requirements')!.score; // r at 0
    const mid = fuzzyScore('req', 'Inquire requests')!.score; // r,e,q all mid/word-start, none at 0
    expect(prefix).toBeGreaterThan(mid);
  });

  it('awards a word-boundary bonus (separator-led) above a mid-word match', () => {
    // "ws": W is a prefix in both, but the S differs.
    const wordStart = fuzzyScore('ws', 'Writing Specification')!.score; // S follows a space
    const midWord = fuzzyScore('ws', 'answers')!.score; // w and s both mid-word
    expect(wordStart).toBeGreaterThan(midWord);
  });

  it('awards a word-boundary bonus at a camelCase hump', () => {
    // "wS": 'w' mid-word, 'S' at the lower→upper hump in "lowerSpec".
    const camel = fuzzyScore('ws', 'lowerSpec')!.score; // w@2, S@5 hump
    const flat = fuzzyScore('ws', 'lowerspec')!.score; // same chars, no hump → no boundary bonus
    expect(camel).toBeGreaterThan(flat);
  });

  it('rewards a contiguous run over a spread-out match', () => {
    // Both are subsequence matches for "spec"; contiguous should score higher.
    const contiguous = fuzzyScore('spec', 'a spec note')!.score; // s,p,e,c adjacent
    const spread = fuzzyScore('spec', 'soup pile every cat')!.score; // s..p..e..c scattered
    expect(contiguous).toBeGreaterThan(spread);
  });
});

describe('fuzzyRank', () => {
  it('returns ALL items in original order with score 1 for an empty query', () => {
    const codes = ['Requirements', 'Specification', 'Testing'];
    const ranked = fuzzyRank('', codes, id);
    expect(items(ranked)).toEqual(codes);
    expect(ranked.every((m) => m.score === 1)).toBe(true);
    expect(ranked.every((m) => m.matchedIndices.length === 0)).toBe(true);
  });

  it('returns all items in original order for a whitespace-only query', () => {
    const codes = ['Requirements', 'Specification', 'Testing'];
    expect(items(fuzzyRank('   ', codes, id))).toEqual(codes);
  });

  it('excludes non-matching items (query "zzz")', () => {
    const codes = ['Requirements', 'Specification', 'Testing'];
    expect(fuzzyRank('zzz', codes, id)).toEqual([]);
  });

  it('ranks an exact prefix above a mid-string match', () => {
    const codes = ['Inquire requests', 'Requirements'];
    const ranked = fuzzyRank('req', codes, id);
    expect(items(ranked)).toEqual(['Requirements', 'Inquire requests']);
  });

  it('ranks a word-boundary match above a mid-word match', () => {
    const codes = ['answers', 'Writing Specification'];
    const ranked = fuzzyRank('ws', codes, id);
    expect(ranked[0].item).toBe('Writing Specification');
  });

  it('breaks score ties by shorter haystack (tighter match)', () => {
    // Both are pure prefixes of "spec"; equal per-char points, so length decides.
    const codes = ['specification', 'spec'];
    const ranked = fuzzyRank('spec', codes, id);
    expect(items(ranked)).toEqual(['spec', 'specification']);
  });

  it('is stable: equal-score, equal-length items keep original relative order', () => {
    // Two distinct haystacks that score identically for "ab" and are the same
    // length: "ab x" and "ab y" — both prefix "ab" + space + 1 char.
    const codes = ['ab x', 'ab y'];
    const ranked = fuzzyRank('ab', codes, id);
    expect(items(ranked)).toEqual(['ab x', 'ab y']);
    expect(ranked[0].score).toBe(ranked[1].score);
  });

  it('honors toSearchString for object items', () => {
    type Code = { id: number; name: string };
    const codes: Code[] = [
      { id: 1, name: 'Testing' },
      { id: 2, name: 'Specification' },
    ];
    const ranked = fuzzyRank('spec', codes, (c) => c.name);
    expect(ranked.map((m) => m.item.id)).toEqual([2]);
  });

  it('carries matchedIndices through to the ranked result', () => {
    const ranked = fuzzyRank('req', ['Requirements'], id);
    expect(ranked[0].matchedIndices).toEqual([0, 1, 2]);
  });
});
