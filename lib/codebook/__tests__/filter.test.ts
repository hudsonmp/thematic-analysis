import { describe, it, expect } from 'vitest';
import {
  matchesQuery,
  matchesEpisode,
  isCodeVisible,
  filterCodes,
  type FilterableCode,
} from '@/lib/codebook/filter';

const codes: FilterableCode[] = [
  { mnemonic: 'SPEC-GAP', name: 'Specification gap', episodeIds: ['e1', 'e2'] },
  { mnemonic: 'EDGE', name: 'Edge case', episodeIds: ['e2'] },
  { mnemonic: 'NULL', name: 'Null handling', episodeIds: [] },
];

describe('matchesQuery', () => {
  it('matches everything on an empty / whitespace query', () => {
    expect(matchesQuery(codes[0], '')).toBe(true);
    expect(matchesQuery(codes[0], '   ')).toBe(true);
  });

  it('is case-insensitive over mnemonic OR name', () => {
    expect(matchesQuery(codes[0], 'spec')).toBe(true); // mnemonic
    expect(matchesQuery(codes[0], 'GAP')).toBe(true); // mnemonic, upper
    expect(matchesQuery(codes[0], 'specification')).toBe(true); // name
  });

  it('returns false when neither mnemonic nor name contains the query', () => {
    expect(matchesQuery(codes[0], 'zzz')).toBe(false);
  });
});

describe('matchesEpisode', () => {
  it('matches everything when no episode filter (null)', () => {
    expect(matchesEpisode(codes[0], null)).toBe(true);
    expect(matchesEpisode(codes[2], null)).toBe(true); // even an untagged code
  });

  it('passes only codes tagged with the episode', () => {
    expect(matchesEpisode(codes[0], 'e1')).toBe(true);
    expect(matchesEpisode(codes[1], 'e1')).toBe(false);
    expect(matchesEpisode(codes[2], 'e1')).toBe(false); // untagged
  });
});

describe('isCodeVisible + filterCodes (composition)', () => {
  it('composes query AND episode by logical AND', () => {
    // SPEC-GAP matches text "spec" and is tagged e1 -> visible
    expect(isCodeVisible(codes[0], 'spec', 'e1')).toBe(true);
    // EDGE matches text "edge" but is NOT tagged e1 -> hidden
    expect(isCodeVisible(codes[1], 'edge', 'e1')).toBe(false);
  });

  it('episode filter alone returns only matching codes', () => {
    expect(filterCodes(codes, '', 'e2').map((c) => c.mnemonic)).toEqual(['SPEC-GAP', 'EDGE']);
    expect(filterCodes(codes, '', 'e1').map((c) => c.mnemonic)).toEqual(['SPEC-GAP']);
  });

  it('no filters returns the full set in order', () => {
    expect(filterCodes(codes, '', null)).toHaveLength(3);
  });

  it('text + episode together narrow further', () => {
    // tagged e2 = {SPEC-GAP, EDGE}; of those, name/mnemonic contains "edge" = {EDGE}
    expect(filterCodes(codes, 'edge', 'e2').map((c) => c.mnemonic)).toEqual(['EDGE']);
  });
});
