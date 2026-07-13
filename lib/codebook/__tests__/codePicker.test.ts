import { describe, expect, it } from 'vitest';
import { searchCodes } from '@/lib/codebook/codePicker';

const CODES = [
  { id: 'c1', mnemonic: 'AMB', name: 'Ambiguity unresolved', labelIds: ['n1'] },
  { id: 'c2', mnemonic: 'SCOPE', name: 'Scope creep', labelIds: [] },
  { id: 'c3', mnemonic: 'UND', name: 'Ambiguous underspecification', labelIds: ['n1', 'n2'] },
  { id: 'c4', mnemonic: 'ZED', name: 'Zed', labelIds: ['n2'] },
];

const NAMES = new Map([
  ['n1', 'Impasse'],
  ['n2', 'Repair'],
]);

describe('searchCodes — placement status', () => {
  it("marks a code already on THIS node as 'here' rather than hiding it", () => {
    // Hiding it would make the researcher wonder why a code they know exists is
    // missing from the results. Attach is idempotent, so offering it would be a
    // no-op dressed up as an action — greying it is the honest option.
    const hits = searchCodes(CODES, 'AMB', 'n1', NAMES);
    expect(hits[0]).toMatchObject({ id: 'c1', status: 'here' });
  });

  it("marks a code placed under OTHER nodes as 'elsewhere', and names them", () => {
    // This is the duplicate warning: placing it here adds a SECOND placement.
    const hits = searchCodes(CODES, 'ZED', 'n1', NAMES);
    expect(hits[0]).toMatchObject({
      id: 'c4',
      status: 'elsewhere',
      otherNodes: ['Repair'],
    });
  });

  it("excludes the CURRENT node from otherNodes for a code placed both here and elsewhere", () => {
    // c3 sits on n1 and n2. Open on n1 → status 'here', and 'Impasse' (n1) must not
    // appear in otherNodes; only the genuinely-other placement does.
    const hits = searchCodes(CODES, 'UND', 'n1', NAMES);
    expect(hits[0]).toMatchObject({ status: 'here', otherNodes: ['Repair'] });
  });

  it("marks a code with no placements 'unplaced', with no other-node noise", () => {
    const hits = searchCodes(CODES, 'SCOPE', 'n1', NAMES);
    expect(hits[0]).toMatchObject({ id: 'c2', status: 'unplaced', otherNodes: [] });
  });

  it('treats every code as unplaced-or-elsewhere when no node is selected', () => {
    const hits = searchCodes(CODES, 'AMB', null, NAMES);
    // With labelId null nothing can be 'here' — c1 lives on n1, so: elsewhere.
    expect(hits.find((h) => h.id === 'c1')).toMatchObject({
      status: 'elsewhere',
      otherNodes: ['Impasse'],
    });
  });
});

describe('searchCodes — matching and ranking', () => {
  it('ranks a mnemonic prefix above a name substring', () => {
    // "amb" prefixes the mnemonic AMB (c1) and appears mid-name in c3
    // ("Ambiguous…" is a NAME prefix, so c3 outranks a mere substring but not c1).
    const hits = searchCodes(CODES, 'amb', null, NAMES);
    expect(hits.map((h) => h.id)).toEqual(['c1', 'c3']);
  });

  it('is case-insensitive on both mnemonic and name', () => {
    expect(searchCodes(CODES, 'sCoPe', null).map((h) => h.id)).toEqual(['c2']);
    expect(searchCodes(CODES, 'CREEP', null).map((h) => h.id)).toEqual(['c2']);
  });

  it('returns EVERYTHING on an empty query — the picker opens browsable, not blank', () => {
    const hits = searchCodes(CODES, '', null);
    expect(hits).toHaveLength(4);
    // Ties all rank 3, so the order is alphabetical by mnemonic — deterministic, so
    // the list cannot reshuffle under the cursor between renders.
    expect(hits.map((h) => h.mnemonic)).toEqual(['AMB', 'SCOPE', 'UND', 'ZED']);
  });

  it('returns nothing for a query that matches nothing', () => {
    expect(searchCodes(CODES, 'qqq', null)).toEqual([]);
  });
});
