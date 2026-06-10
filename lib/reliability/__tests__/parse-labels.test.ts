import { describe, it, expect } from 'vitest';
import { parseLabelTable } from '@/lib/reliability/parse-labels';

describe('parseLabelTable', () => {
  it('CSV with a header row: skips the header, parses unit,coderA,coderB', () => {
    const text = 'unit,coderA,coderB\nu1,yes,yes\nu2,yes,no\nu3,no,no';
    const { pairs, units } = parseLabelTable(text);
    expect(pairs).toEqual([
      ['yes', 'yes'],
      ['yes', 'no'],
      ['no', 'no'],
    ]);
    expect(units).toEqual(['u1', 'u2', 'u3']);
  });

  it('TSV without a header: parses all rows as data', () => {
    const text = 'u1\tyes\tyes\nu2\tno\tyes';
    const { pairs, units } = parseLabelTable(text);
    expect(pairs).toEqual([
      ['yes', 'yes'],
      ['no', 'yes'],
    ]);
    expect(units).toEqual(['u1', 'u2']);
  });

  it('tolerates blank lines and trims cells', () => {
    const text = '\nu1, yes , yes \n\n u2 ,no,no\n';
    const { pairs, units } = parseLabelTable(text);
    expect(pairs).toEqual([
      ['yes', 'yes'],
      ['no', 'no'],
    ]);
    expect(units).toEqual(['u1', 'u2']);
  });

  it('2-column fallback: treats columns as labelA,labelB with auto unit index', () => {
    const text = 'yes,yes\nno,yes\nyes,no';
    const { pairs, units } = parseLabelTable(text);
    expect(pairs).toEqual([
      ['yes', 'yes'],
      ['no', 'yes'],
      ['yes', 'no'],
    ]);
    // auto unit ids are 1-based positional indices as strings
    expect(units).toEqual(['1', '2', '3']);
  });

  it('detects header case-insensitively (a,b variant) and skips it', () => {
    const text = 'A,B\nyes,yes\nno,no';
    const { pairs, units } = parseLabelTable(text);
    expect(pairs).toEqual([
      ['yes', 'yes'],
      ['no', 'no'],
    ]);
    expect(units).toEqual(['1', '2']);
  });

  it('does NOT treat a data first-row as a header', () => {
    const text = 'u1,yes,no\nu2,no,no';
    const { pairs } = parseLabelTable(text);
    expect(pairs).toEqual([
      ['yes', 'no'],
      ['no', 'no'],
    ]);
  });

  it('empty / whitespace-only input yields no pairs', () => {
    expect(parseLabelTable('').pairs).toEqual([]);
    expect(parseLabelTable('   \n  \n').pairs).toEqual([]);
  });
});
