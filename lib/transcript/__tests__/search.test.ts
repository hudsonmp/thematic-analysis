import { describe, it, expect } from 'vitest';
import { findPhraseMatches, MIN_QUERY_LEN } from '../search';

const segs = (texts: string[]) => texts.map((text) => ({ text }));

describe('findPhraseMatches', () => {
  it('returns [] for a blank or too-short query', () => {
    const s = segs(['the rider and the vehicle']);
    expect(findPhraseMatches(s, '')).toEqual([]);
    expect(findPhraseMatches(s, '   ')).toEqual([]);
    expect(findPhraseMatches(s, 'a')).toEqual([]); // below MIN_QUERY_LEN
    expect(MIN_QUERY_LEN).toBe(2);
  });

  it('finds a case-insensitive match with correct char offsets', () => {
    // "Rider" at offset 4..9 in "the Rider and the vehicle".
    const s = segs(['the Rider and the vehicle']);
    expect(findPhraseMatches(s, 'rider')).toEqual([{ segIdx: 0, charStart: 4, charEnd: 9 }]);
    expect(s[0].text.slice(4, 9)).toBe('Rider');
  });

  it('finds multiple NON-overlapping matches within one cue, left to right', () => {
    // "aa" in "aaaa": offsets [0,2) and [2,4), not [1,3).
    const s = segs(['aaaa']);
    expect(findPhraseMatches(s, 'aa')).toEqual([
      { segIdx: 0, charStart: 0, charEnd: 2 },
      { segIdx: 0, charStart: 2, charEnd: 4 },
    ]);
  });

  it('returns matches across cues in reading order', () => {
    const s = segs(['the vehicle moves', 'no match here', 'another vehicle stops']);
    expect(findPhraseMatches(s, 'vehicle')).toEqual([
      { segIdx: 0, charStart: 4, charEnd: 11 },
      { segIdx: 2, charStart: 8, charEnd: 15 },
    ]);
  });

  it('matches a multi-word phrase literally (spaces included)', () => {
    const s = segs(['pickup location of the rider']);
    const m = findPhraseMatches(s, 'location of');
    expect(m).toHaveLength(1);
    expect(s[0].text.slice(m[0].charStart, m[0].charEnd)).toBe('location of');
  });

  it('treats regex metacharacters as literal text', () => {
    const s = segs(['the ratio is 3:1 today', 'no colon here']);
    expect(findPhraseMatches(s, '3:1')).toEqual([{ segIdx: 0, charStart: 13, charEnd: 16 }]);
    // '.' is literal, not "any char"
    expect(findPhraseMatches(segs(['a.b axb']), 'a.b')).toEqual([
      { segIdx: 0, charStart: 0, charEnd: 3 },
    ]);
  });

  it('trims the query before matching', () => {
    const s = segs(['the vehicle']);
    expect(findPhraseMatches(s, '  vehicle  ')).toEqual([{ segIdx: 0, charStart: 4, charEnd: 11 }]);
  });

  it('returns [] when nothing matches', () => {
    expect(findPhraseMatches(segs(['hello world']), 'zzz')).toEqual([]);
  });
});
