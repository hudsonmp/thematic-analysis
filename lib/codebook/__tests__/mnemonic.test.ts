import { describe, expect, it } from 'vitest';
import {
  deriveMnemonic,
  uniqueMnemonic,
  isRowEmpty,
  resolveRows,
  type CodebookRow,
} from '@/lib/codebook/mnemonic';

function row(name: string, mnemonic = '', definition = ''): CodebookRow {
  return { name, mnemonic, definition };
}

describe('deriveMnemonic', () => {
  it('slugifies to upper-kebab', () => {
    expect(deriveMnemonic('Spec gap')).toBe('SPEC-GAP');
    expect(deriveMnemonic('  trailing  spaces  ')).toBe('TRAILING-SPACES');
    expect(deriveMnemonic('weird!!chars##here')).toBe('WEIRD-CHARS-HERE');
  });

  it('caps length and never leaves a trailing dash', () => {
    const out = deriveMnemonic('a'.repeat(40), 5);
    expect(out).toBe('AAAAA');
    expect(deriveMnemonic('abcde fghij', 6)).toBe('ABCDE'); // slice would give "ABCDE-", trimmed
  });

  it('falls back to CODE when nothing is slug-able', () => {
    expect(deriveMnemonic('!!!')).toBe('CODE');
    expect(deriveMnemonic('   ')).toBe('CODE');
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
    expect(resolved.map((r) => r.mnemonic)).toEqual(['SPEC-GAP', 'SPEC-GAP-2', 'SPEC-GAP-3']);
  });

  it('derives around an EXISTING codebook mnemonic too', () => {
    const { resolved } = resolveRows([row('Spec gap')], new Set(['SPEC-GAP']));
    expect(resolved[0].mnemonic).toBe('SPEC-GAP-2');
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
