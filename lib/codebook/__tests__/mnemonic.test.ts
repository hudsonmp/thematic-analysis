import { describe, expect, it } from 'vitest';
import {
  deriveMnemonic,
  uniqueMnemonic,
  isRowEmpty,
  resolveRows,
  writeOnlyRowErrors,
  type CodebookRow,
} from '@/lib/codebook/mnemonic';

function row(name: string, mnemonic = '', definition = ''): CodebookRow {
  return { name, mnemonic, definition };
}

describe('deriveMnemonic', () => {
  it('slugifies to lower-kebab', () => {
    expect(deriveMnemonic('Spec gap')).toBe('spec-gap');
    expect(deriveMnemonic('  trailing  spaces  ')).toBe('trailing-spaces');
    expect(deriveMnemonic('weird!!chars##here')).toBe('weird-chars-here');
  });

  it('caps length and never leaves a trailing dash', () => {
    const out = deriveMnemonic('a'.repeat(40), 5);
    expect(out).toBe('aaaaa');
    expect(deriveMnemonic('abcde fghij', 6)).toBe('abcde'); // slice would give "abcde-", trimmed
  });

  it('falls back to a placeholder when nothing is slug-able', () => {
    expect(deriveMnemonic('!!!')).toBe('code');
    expect(deriveMnemonic('   ')).toBe('code');
  });
});

describe('uniqueMnemonic', () => {
  it('returns base when free, else suffixes -2, -3, …', () => {
    expect(uniqueMnemonic('X', new Set())).toBe('X');
    expect(uniqueMnemonic('X', new Set(['X']))).toBe('X-2');
    expect(uniqueMnemonic('X', new Set(['X', 'X-2', 'X-3']))).toBe('X-4');
  });
});

describe('isRowEmpty', () => {
  it('is true only when all cells are blank', () => {
    expect(isRowEmpty(row('', '', ''))).toBe(true);
    expect(isRowEmpty(row('  ', ' ', '  '))).toBe(true);
    expect(isRowEmpty(row('n'))).toBe(false);
    expect(isRowEmpty(row('', 'M'))).toBe(false);
    expect(isRowEmpty(row('', '', 'def'))).toBe(false);
  });
});

describe('resolveRows', () => {
  it('drops empty rows and trims cells', () => {
    const { resolved, errors } = resolveRows(
      [row('Alpha', ' AL ', ' a def '), row('', '', ''), row('  ', '', '')],
      new Set(),
    );
    expect(errors).toEqual([]);
    expect(resolved).toEqual([{ index: 0, name: 'Alpha', mnemonic: 'AL', definition: 'a def' }]);
  });

  it('errors a content row with no name', () => {
    const { resolved, errors } = resolveRows([row('', 'MN', 'def')], new Set());
    expect(resolved).toEqual([]);
    expect(errors).toEqual([{ index: 0, message: 'Name is required.' }]);
  });

  it('derives unique mnemonics for blank-mnemonic rows (no in-batch collision)', () => {
    const { resolved, errors } = resolveRows(
      [row('Spec gap'), row('Spec gap'), row('Spec gap')],
      new Set(),
    );
    expect(errors).toEqual([]);
    expect(resolved.map((r) => r.mnemonic)).toEqual(['spec-gap', 'spec-gap-2', 'spec-gap-3']);
  });

  it('derives around an EXISTING codebook mnemonic too', () => {
    const { resolved } = resolveRows([row('Spec gap')], new Set(['spec-gap']));
    expect(resolved[0].mnemonic).toBe('spec-gap-2');
  });

  it('errors an explicit mnemonic that duplicates an existing or earlier one', () => {
    const { resolved, errors } = resolveRows(
      [row('A', 'DUP'), row('B', 'DUP')],
      new Set(['EXIST']),
    );
    // First DUP is fine; the second collides in-batch.
    expect(resolved.map((r) => r.mnemonic)).toEqual(['DUP']);
    expect(errors).toEqual([{ index: 1, message: 'Mnemonic "DUP" already in use.' }]);

    const existing = resolveRows([row('A', 'EXIST')], new Set(['EXIST']));
    expect(existing.resolved).toEqual([]);
    expect(existing.errors).toEqual([{ index: 0, message: 'Mnemonic "EXIST" already in use.' }]);
  });

  it('preserves original indices across dropped empties (for error reporting)', () => {
    const { errors } = resolveRows(
      [row('', '', ''), row('ok'), row('', 'X', 'y')],
      new Set(),
    );
    // Row 2 has content but no name → error keyed to its ORIGINAL index 2.
    expect(errors).toEqual([{ index: 2, message: 'Name is required.' }]);
  });
});

describe('writeOnlyRowErrors (state-3: write-bearing but core-empty rows)', () => {
  it('errors a label-only / facet-only row that resolveRows dropped silently', () => {
    // Index 0 carries label/facet writes but its core is all-blank, so resolveRows
    // dropped it as empty: NOT resolved, NOT errored. It must surface here, never
    // be a silent no-op that loses the tags.
    const { resolved, errors } = resolveRows([row('', '', '')], new Set());
    expect(resolved).toEqual([]);
    expect(errors).toEqual([]); // resolveRows alone gives no feedback → the bug

    const out = writeOnlyRowErrors([0], resolved, errors);
    expect(out).toEqual([{ index: 0, message: 'Name is required to save its labels/facets.' }]);
  });

  it('does NOT error a write-bearing row that DID yield a created code', () => {
    // Named row → resolved (its labels/facets are applied to the created code), so a
    // write on that index must not produce a spurious "Name is required" error.
    const { resolved, errors } = resolveRows([row('Alpha')], new Set());
    expect(resolved).toHaveLength(1);
    expect(writeOnlyRowErrors([0], resolved, errors)).toEqual([]);
  });

  it('does NOT double-report an index resolveRows already errored', () => {
    // A nameless row WITH a core cell (mnemonic) is already a "Name is required."
    // error from resolveRows; even if it also bore writes, do not add a second one.
    const { resolved, errors } = resolveRows([row('', 'MN', '')], new Set());
    expect(errors).toEqual([{ index: 0, message: 'Name is required.' }]);
    expect(writeOnlyRowErrors([0], resolved, errors)).toEqual([]);
  });

  it('reports only the unaccounted write-bearing indices, de-duped + sorted', () => {
    // Batch: 0 = named (resolved), 1 = label-only core-empty (state 3),
    // 2 = named (resolved), 3 = facet-only core-empty (state 3).
    const { resolved, errors } = resolveRows(
      [row('A'), row('', '', ''), row('C'), row('', '', '')],
      new Set(),
    );
    expect(resolved.map((r) => r.index)).toEqual([0, 2]);
    // Pass indices out of order + a duplicate to assert sort + de-dup.
    const out = writeOnlyRowErrors([3, 1, 1], resolved, errors);
    expect(out).toEqual([
      { index: 1, message: 'Name is required to save its labels/facets.' },
      { index: 3, message: 'Name is required to save its labels/facets.' },
    ]);
  });

  it('is a no-op when no row bears writes', () => {
    const { resolved, errors } = resolveRows([row('A')], new Set());
    expect(writeOnlyRowErrors([], resolved, errors)).toEqual([]);
  });
});
