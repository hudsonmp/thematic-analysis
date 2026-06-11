import { describe, expect, it } from 'vitest';
import {
  emptyFacetCell,
  emptyRow,
  isFacetCellSet,
  isGridRowEmpty,
  rowToFacetWrites,
  bufferedRowCount,
  lastFilledIndex,
  nextRowFocusIndex,
  DEFAULT_BUFFER,
  INITIAL_ROWS,
  type FacetColumn,
  type RowData,
} from '@/lib/codebook/grid';

const COLS: FacetColumn[] = [
  { facetId: 'f-enum1', label: 'Single', mode: 'enum-single', valueIds: ['v1', 'v2'] },
  { facetId: 'f-enumN', label: 'Multi', mode: 'enum-multi', valueIds: ['m1', 'm2', 'm3'] },
  { facetId: 'f-bool', label: 'Flag', mode: 'boolean', valueIds: [] },
  { facetId: 'f-text', label: 'Note', mode: 'open-text', valueIds: [] },
];

function row(over: Partial<RowData> = {}): RowData {
  const base = emptyRow(COLS);
  return { core: { ...base.core, ...over.core }, facets: { ...base.facets, ...over.facets } };
}

describe('emptyFacetCell', () => {
  it('builds the unset cell for each render mode', () => {
    expect(emptyFacetCell('enum-single')).toEqual({ kind: 'enum', valueIds: [] });
    expect(emptyFacetCell('enum-multi')).toEqual({ kind: 'enum', valueIds: [] });
    expect(emptyFacetCell('boolean')).toEqual({ kind: 'boolean', bool: null });
    expect(emptyFacetCell('open-text')).toEqual({ kind: 'open_text', text: '' });
  });
});

describe('emptyRow', () => {
  it('has blank core cells and an unset cell per column', () => {
    const r = emptyRow(COLS);
    expect(r.core).toEqual({ name: '', mnemonic: '', definition: '' });
    expect(Object.keys(r.facets).sort()).toEqual(['f-bool', 'f-enum1', 'f-enumN', 'f-text']);
    expect(r.facets['f-bool']).toEqual({ kind: 'boolean', bool: null });
  });
});

describe('isFacetCellSet', () => {
  it('treats unset cells as not set', () => {
    expect(isFacetCellSet(undefined)).toBe(false);
    expect(isFacetCellSet({ kind: 'enum', valueIds: [] })).toBe(false);
    expect(isFacetCellSet({ kind: 'boolean', bool: null })).toBe(false);
    expect(isFacetCellSet({ kind: 'open_text', text: '   ' })).toBe(false);
  });
  it('treats any value as set', () => {
    expect(isFacetCellSet({ kind: 'enum', valueIds: ['v1'] })).toBe(true);
    expect(isFacetCellSet({ kind: 'boolean', bool: false })).toBe(true);
    expect(isFacetCellSet({ kind: 'boolean', bool: true })).toBe(true);
    expect(isFacetCellSet({ kind: 'open_text', text: 'x' })).toBe(true);
  });
});

describe('isGridRowEmpty', () => {
  it('is empty when core is blank and no facet cell is set', () => {
    expect(isGridRowEmpty(emptyRow(COLS))).toBe(true);
  });
  it('is non-empty when a core cell has content', () => {
    expect(isGridRowEmpty(row({ core: { name: 'Alpha', mnemonic: '', definition: '' } }))).toBe(false);
  });
  it('is non-empty when only a facet cell is set (so facet-only rows are not silently dropped)', () => {
    expect(isGridRowEmpty(row({ facets: { 'f-bool': { kind: 'boolean', bool: true } } }))).toBe(false);
    expect(isGridRowEmpty(row({ facets: { 'f-enum1': { kind: 'enum', valueIds: ['v1'] } } }))).toBe(false);
  });
});

describe('rowToFacetWrites', () => {
  it('drops unset cells entirely', () => {
    expect(rowToFacetWrites(emptyRow(COLS), COLS)).toEqual({ enumValueIds: [], fields: [] });
  });

  it('flattens + de-dupes enum value ids across enum facets', () => {
    const r = row({
      facets: {
        'f-enum1': { kind: 'enum', valueIds: ['v1'] },
        'f-enumN': { kind: 'enum', valueIds: ['m1', 'm2', 'v1'] }, // v1 dup across facets
      },
    });
    expect(rowToFacetWrites(r, COLS).enumValueIds.sort()).toEqual(['m1', 'm2', 'v1']);
  });

  it('emits boolean and open_text as fields, trimming text', () => {
    const r = row({
      facets: {
        'f-bool': { kind: 'boolean', bool: false },
        'f-text': { kind: 'open_text', text: '  hello  ' },
      },
    });
    const { fields } = rowToFacetWrites(r, COLS);
    expect(fields).toContainEqual({ facetId: 'f-bool', bool_value: false });
    expect(fields).toContainEqual({ facetId: 'f-text', text_value: 'hello' });
    expect(fields).toHaveLength(2);
  });

  it('ignores facet keys not present in columns (a removed facet cannot leak a write)', () => {
    const r = row({ facets: { 'f-ghost': { kind: 'enum', valueIds: ['gone'] } } });
    expect(rowToFacetWrites(r, COLS)).toEqual({ enumValueIds: [], fields: [] });
  });
});

describe('bufferedRowCount', () => {
  it('keeps the initial floor when nothing is filled', () => {
    expect(bufferedRowCount(-1)).toBe(INITIAL_ROWS);
  });
  it('keeps the floor until the buffer would be eaten into', () => {
    // last filled at 400 needs 400+1+50=451 < 500 → still floor.
    expect(bufferedRowCount(400)).toBe(INITIAL_ROWS);
  });
  it('extends past the floor to preserve the buffer', () => {
    // last filled at 480 needs 480+1+50=531.
    expect(bufferedRowCount(480)).toBe(531);
    expect(bufferedRowCount(700)).toBe(751);
  });
  it('honors custom floor + buffer', () => {
    expect(bufferedRowCount(-1, 10, 5)).toBe(10);
    expect(bufferedRowCount(8, 10, 5)).toBe(14); // 8+1+5
  });
  it('exposes a non-zero default buffer', () => {
    expect(DEFAULT_BUFFER).toBeGreaterThan(0);
  });
});

describe('lastFilledIndex', () => {
  it('is -1 when all rows are empty', () => {
    expect(lastFilledIndex([emptyRow(COLS), emptyRow(COLS)])).toBe(-1);
  });
  it('finds the last non-empty row even with empty rows after it', () => {
    const rows = [
      row({ core: { name: 'a', mnemonic: '', definition: '' } }),
      emptyRow(COLS),
      row({ core: { name: 'b', mnemonic: '', definition: '' } }),
      emptyRow(COLS),
      emptyRow(COLS),
    ];
    expect(lastFilledIndex(rows)).toBe(2);
  });
});

describe('nextRowFocusIndex', () => {
  it('targets the row after the current one', () => {
    expect(nextRowFocusIndex(0)).toBe(1);
    expect(nextRowFocusIndex(498)).toBe(499);
  });
});
