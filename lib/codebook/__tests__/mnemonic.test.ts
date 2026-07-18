import { describe, expect, it } from 'vitest';
import {
  normalizeSlug,
  uniqueMnemonic,
  isRowEmpty,
  resolveRows,
  writeOnlyRowErrors,
  type CodebookRow,
} from '@/lib/codebook/mnemonic';

function row(slug: string, definition = ''): CodebookRow {
  return { slug, definition };
}

describe('normalizeSlug', () => {
  it('normalizes to UPPER-KEBAB', () => {
    expect(normalizeSlug('Spec gap')).toBe('SPEC-GAP');
    expect(normalizeSlug('  trailing  spaces  ')).toBe('TRAILING-SPACES');
    expect(normalizeSlug('weird!!chars##here')).toBe('WEIRD-CHARS-HERE');
    expect(normalizeSlug('already-KEBAB')).toBe('ALREADY-KEBAB');
  });

  it('caps length and never leaves a trailing dash', () => {
    const out = normalizeSlug('a'.repeat(40), 5);
    expect(out).toBe('AAAAA');
    expect(normalizeSlug('abcde fghij', 6)).toBe('ABCDE'); // slice would give "ABCDE-", trimmed
  });

  it('falls back to a placeholder when nothing is slug-able', () => {
    expect(normalizeSlug('!!!')).toBe('CODE');
    expect(normalizeSlug('   ')).toBe('CODE');
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
  it('is true only when both cells are blank', () => {
    expect(isRowEmpty(row('', ''))).toBe(true);
    expect(isRowEmpty(row('  ', '  '))).toBe(true);
    expect(isRowEmpty(row('M'))).toBe(false);
    expect(isRowEmpty(row('', 'def'))).toBe(false);
  });
});

describe('resolveRows', () => {
  it('drops empty rows, normalizes the slug, and trims the definition', () => {
    const { resolved, errors } = resolveRows(
      [row(' spec gap ', ' a def '), row('', ''), row('  ', '')],
      new Set(),
    );
    expect(errors).toEqual([]);
    expect(resolved).toEqual([{ index: 0, mnemonic: 'SPEC-GAP', definition: 'a def' }]);
  });

  it('errors a content row with no slug', () => {
    const { resolved, errors } = resolveRows([row('', 'def')], new Set());
    expect(resolved).toEqual([]);
    expect(errors).toEqual([{ index: 0, message: 'A slug is required.' }]);
  });

  it('errors a slug that duplicates an earlier one in the batch (never auto-suffixed)', () => {
    const { resolved, errors } = resolveRows(
      [row('Spec gap'), row('spec-gap'), row('SPEC GAP')],
      new Set(),
    );
    // First normalizes to SPEC-GAP; the other two collide with it in-batch.
    expect(resolved.map((r) => r.mnemonic)).toEqual(['SPEC-GAP']);
    expect(errors).toEqual([
      { index: 1, message: 'Slug "SPEC-GAP" already in use.' },
      { index: 2, message: 'Slug "SPEC-GAP" already in use.' },
    ]);
  });

  it('errors a slug that duplicates an EXISTING codebook mnemonic', () => {
    const { resolved, errors } = resolveRows([row('spec gap')], new Set(['SPEC-GAP']));
    expect(resolved).toEqual([]);
    expect(errors).toEqual([{ index: 0, message: 'Slug "SPEC-GAP" already in use.' }]);
  });

  it('preserves original indices across dropped empties (for error reporting)', () => {
    const { errors } = resolveRows(
      [row('', ''), row('ok'), row('', 'y')],
      new Set(),
    );
    // Row 2 has content but no slug → error keyed to its ORIGINAL index 2.
    expect(errors).toEqual([{ index: 2, message: 'A slug is required.' }]);
  });
});

describe('writeOnlyRowErrors (state-3: write-bearing but core-empty rows)', () => {
  it('errors a label-only / facet-only row that resolveRows dropped silently', () => {
    // Index 0 carries label/facet writes but its core is all-blank, so resolveRows
    // dropped it as empty: NOT resolved, NOT errored. It must surface here, never
    // be a silent no-op that loses the tags.
    const { resolved, errors } = resolveRows([row('', '')], new Set());
    expect(resolved).toEqual([]);
    expect(errors).toEqual([]); // resolveRows alone gives no feedback → the bug

    const out = writeOnlyRowErrors([0], resolved, errors);
    expect(out).toEqual([{ index: 0, message: 'A slug is required to save its labels/facets.' }]);
  });

  it('does NOT error a write-bearing row that DID yield a created code', () => {
    // Slugged row → resolved (its labels/facets are applied to the created code), so a
    // write on that index must not produce a spurious "slug is required" error.
    const { resolved, errors } = resolveRows([row('Alpha')], new Set());
    expect(resolved).toHaveLength(1);
    expect(writeOnlyRowErrors([0], resolved, errors)).toEqual([]);
  });

  it('does NOT double-report an index resolveRows already errored', () => {
    // A definition-only row is already a "slug is required." error from resolveRows;
    // even if it also bore writes, do not add a second one.
    const { resolved, errors } = resolveRows([row('', 'def')], new Set());
    expect(errors).toEqual([{ index: 0, message: 'A slug is required.' }]);
    expect(writeOnlyRowErrors([0], resolved, errors)).toEqual([]);
  });

  it('reports only the unaccounted write-bearing indices, de-duped + sorted', () => {
    // Batch: 0 = slugged (resolved), 1 = label-only core-empty (state 3),
    // 2 = slugged (resolved), 3 = facet-only core-empty (state 3).
    const { resolved, errors } = resolveRows(
      [row('A'), row('', ''), row('C'), row('', '')],
      new Set(),
    );
    expect(resolved.map((r) => r.index)).toEqual([0, 2]);
    // Pass indices out of order + a duplicate to assert sort + de-dup.
    const out = writeOnlyRowErrors([3, 1, 1], resolved, errors);
    expect(out).toEqual([
      { index: 1, message: 'A slug is required to save its labels/facets.' },
      { index: 3, message: 'A slug is required to save its labels/facets.' },
    ]);
  });

  it('is a no-op when no row bears writes', () => {
    const { resolved, errors } = resolveRows([row('A')], new Set());
    expect(writeOnlyRowErrors([], resolved, errors)).toEqual([]);
  });
});
