import { describe, expect, it } from 'vitest';
import {
  computeSheetColumns,
  SHEET_COL_ORDER,
  type SheetColKey,
} from '@/lib/codebook/sheet';

function row(partial: Partial<Record<SheetColKey, string>>): Record<SheetColKey, string> {
  const base: Record<SheetColKey, string> = {
    code: '',
    definition: '',
    includeIf: '',
    excludeIf: '',
    exemplars: '',
    counter: '',
  notes: '',
    meta: '',
  };
  return { ...base, ...partial };
}

describe('computeSheetColumns', () => {
  it('always keeps code and definition, even with no rows', () => {
    const cols = computeSheetColumns([]);
    expect(cols.map((c) => c.key)).toEqual(['code', 'definition']);
  });

  it('drops columns that are empty across every row', () => {
    const cols = computeSheetColumns([
      row({ code: 'a-b', definition: 'x', exemplars: 'quoted text' }),
      row({ code: 'c-d', definition: 'y' }),
    ]);
    expect(cols.map((c) => c.key)).toEqual(['code', 'definition', 'exemplars']);
  });

  it('keeps a column present in ANY row (whitespace-only counts as empty)', () => {
    const cols = computeSheetColumns([
      row({ code: 'a', definition: 'x', counter: '   ' }),
      row({ code: 'b', definition: 'y', counter: 'a real counter-example' }),
    ]);
    expect(cols.map((c) => c.key)).toContain('counter');
  });

  it('widths sum to ~100 and respect ordering of SHEET_COL_ORDER', () => {
    const rows = [
      row({
        code: 'behavior-reason-identified',
        definition: 'Participants identify the cause of specific behaviors.',
        includeIf: 'names a cause',
        excludeIf: 'mere description',
        exemplars: 'Sees that ASCEND is a central location so there should be one.',
        counter: 'restates the behavior',
        meta: 'Origin: a priori · smith2021',
      }),
    ];
    const cols = computeSheetColumns(rows);
    const sum = cols.reduce((s, c) => s + c.width, 0);
    expect(sum).toBeCloseTo(100, 5);
    const order = cols.map((c) => SHEET_COL_ORDER.indexOf(c.key));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('holds the 34% ceiling STRICTLY even with few columns and one huge outlier', () => {
    // The naive clamp-then-renormalize failure mode: 3 visible columns, one
    // outlier — renormalizing after the clamp re-inflated the capped column to
    // ~70%. Waterfilling must keep every column at or under the ceiling.
    const long = 'x'.repeat(2000);
    const rows = [row({ code: 'a', definition: 'short', exemplars: long })];
    const cols = computeSheetColumns(rows);
    const sum = cols.reduce((s, c) => s + c.width, 0);
    expect(sum).toBeCloseTo(100, 5);
    for (const c of cols) {
      expect(c.width).toBeLessThanOrEqual(34 + 1e-9);
      expect(c.width).toBeGreaterThanOrEqual(7 - 1e-9);
    }
  });

  it('gives more width to content-heavier columns when the ceiling is not binding', () => {
    const rows = [
      row({
        code: 'a-b',
        definition: 'a middling definition of the code',
        includeIf: 'names a cause',
        excludeIf: 'mere description',
        exemplars:
          'a noticeably longer exemplar cell with several quoted utterances in it, ' +
          'the kind that accumulates from live coding sessions over time',
        counter: 'short',
        meta: 'Origin: a priori',
      }),
    ];
    const cols = computeSheetColumns(rows);
    const byKey = new Map(cols.map((c) => [c.key, c.width]));
    expect(byKey.get('exemplars')!).toBeGreaterThan(byKey.get('counter')!);
    expect(byKey.get('definition')!).toBeGreaterThan(byKey.get('code')!);
  });
});
