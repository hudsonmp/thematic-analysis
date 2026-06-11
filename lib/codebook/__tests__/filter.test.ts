import { describe, it, expect } from 'vitest';
import {
  matchesQuery,
  matchesEpisode,
  matchesLabel,
  matchesCitation,
  isCodeVisible,
  filterCodes,
  type FilterableCode,
} from '@/lib/codebook/filter';

const codes: FilterableCode[] = [
  { mnemonic: 'SPEC-GAP', name: 'Specification gap', episodeIds: ['e1', 'e2'], labelIds: ['l1'], citationIds: ['c1', 'c2'] },
  { mnemonic: 'EDGE', name: 'Edge case', episodeIds: ['e2'], labelIds: ['l1', 'l2'], citationIds: ['c2'] },
  { mnemonic: 'NULL', name: 'Null handling', episodeIds: [], labelIds: [], citationIds: [] },
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

describe('matchesLabel', () => {
  it('matches everything when no label filter (null)', () => {
    expect(matchesLabel(codes[0], null)).toBe(true);
    expect(matchesLabel(codes[2], null)).toBe(true); // even an untagged code
  });

  it('passes only codes tagged with the label', () => {
    expect(matchesLabel(codes[0], 'l1')).toBe(true);
    expect(matchesLabel(codes[1], 'l1')).toBe(true);
    expect(matchesLabel(codes[0], 'l2')).toBe(false); // not tagged l2
    expect(matchesLabel(codes[1], 'l2')).toBe(true);
    expect(matchesLabel(codes[2], 'l1')).toBe(false); // untagged
  });
});

describe('matchesCitation', () => {
  it('matches everything when no citation filter (null)', () => {
    expect(matchesCitation(codes[0], null)).toBe(true);
    expect(matchesCitation(codes[2], null)).toBe(true); // even an untagged code
  });

  it('passes only codes linked to the citation (any role)', () => {
    expect(matchesCitation(codes[0], 'c1')).toBe(true);
    expect(matchesCitation(codes[1], 'c1')).toBe(false); // not linked to c1
    expect(matchesCitation(codes[0], 'c2')).toBe(true);
    expect(matchesCitation(codes[1], 'c2')).toBe(true);
    expect(matchesCitation(codes[2], 'c2')).toBe(false); // unlinked
  });
});

describe('isCodeVisible + filterCodes (composition)', () => {
  it('composes query AND episode AND label by logical AND', () => {
    // SPEC-GAP matches text "spec", is tagged e1, and is tagged l1 -> visible
    expect(isCodeVisible(codes[0], 'spec', 'e1', 'l1')).toBe(true);
    // EDGE matches text "edge" but is NOT tagged e1 -> hidden
    expect(isCodeVisible(codes[1], 'edge', 'e1', null)).toBe(false);
    // SPEC-GAP matches text + episode but is NOT tagged l2 -> hidden by label
    expect(isCodeVisible(codes[0], 'spec', 'e1', 'l2')).toBe(false);
  });

  it('composes the citation filter by logical AND too', () => {
    // SPEC-GAP linked to c1 -> visible; EDGE not linked to c1 -> hidden.
    expect(isCodeVisible(codes[0], '', null, null, 'c1')).toBe(true);
    expect(isCodeVisible(codes[1], '', null, null, 'c1')).toBe(false);
    // SPEC-GAP matches text + episode + label but NOT citation c-nope -> hidden.
    expect(isCodeVisible(codes[0], 'spec', 'e1', 'l1', 'c-nope')).toBe(false);
  });

  it('citation filter alone returns only linked codes', () => {
    expect(filterCodes(codes, '', null, null, 'c1').map((c) => c.mnemonic)).toEqual(['SPEC-GAP']);
    expect(filterCodes(codes, '', null, null, 'c2').map((c) => c.mnemonic)).toEqual([
      'SPEC-GAP',
      'EDGE',
    ]);
  });

  it('episode filter alone returns only matching codes', () => {
    expect(filterCodes(codes, '', 'e2', null).map((c) => c.mnemonic)).toEqual(['SPEC-GAP', 'EDGE']);
    expect(filterCodes(codes, '', 'e1', null).map((c) => c.mnemonic)).toEqual(['SPEC-GAP']);
  });

  it('label filter alone returns only matching codes', () => {
    expect(filterCodes(codes, '', null, 'l1').map((c) => c.mnemonic)).toEqual(['SPEC-GAP', 'EDGE']);
    expect(filterCodes(codes, '', null, 'l2').map((c) => c.mnemonic)).toEqual(['EDGE']);
  });

  it('no filters returns the full set in order', () => {
    expect(filterCodes(codes, '', null, null)).toHaveLength(3);
  });

  it('text + episode together narrow further', () => {
    // tagged e2 = {SPEC-GAP, EDGE}; of those, name/mnemonic contains "edge" = {EDGE}
    expect(filterCodes(codes, 'edge', 'e2', null).map((c) => c.mnemonic)).toEqual(['EDGE']);
  });

  it('episode + label together narrow further', () => {
    // tagged e2 = {SPEC-GAP, EDGE}; of those, tagged l2 = {EDGE}
    expect(filterCodes(codes, '', 'e2', 'l2').map((c) => c.mnemonic)).toEqual(['EDGE']);
  });
});
