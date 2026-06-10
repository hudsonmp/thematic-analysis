import { describe, it, expect } from 'vitest';
import { parseBibtex } from '@/lib/bibtex/parse';

describe('parseBibtex', () => {
  it('parses one entry', () => {
    const out = parseBibtex(`@article{hsieh2005directed,
      title = {Three Approaches to Qualitative Content Analysis},
      author = {Hsieh, Hsiu-Fang and Shannon, Sarah E.},
      year = {2005}, doi = {10.1177/1049732305276687}}`);
    expect(out).toHaveLength(1);
    expect(out[0].bibtex_key).toBe('hsieh2005directed');
    expect(out[0].year).toBe(2005);
    expect(out[0].title).toMatch(/Three Approaches/);
    expect(out[0].authors).toMatch(/Hsieh/);
    expect(out[0].doi).toBe('10.1177/1049732305276687');
  });

  it('parses multiple entries from one blob', () => {
    const out = parseBibtex(`@book{a, title={A}, year={1990}} @article{b, title={B}, year={2001}}`);
    expect(out.map((e) => e.bibtex_key)).toEqual(['a', 'b']);
  });

  it('handles quoted-string field values', () => {
    const out = parseBibtex(`@article{c, title = "Quoted Title", year = "2010"}`);
    expect(out[0].title).toBe('Quoted Title');
    expect(out[0].year).toBe(2010);
  });

  it('keeps the raw entry and tolerates unknown fields', () => {
    const out = parseBibtex(`@misc{d, title={D}, publisher={X}, note={ignored-ok}}`);
    expect(out[0].bibtex_key).toBe('d');
    expect(out[0].bibtex_raw).toContain('@misc{d');
    expect(out[0].title).toBe('D');
  });

  it('returns [] for empty / non-bibtex input', () => {
    expect(parseBibtex('')).toEqual([]);
    expect(parseBibtex('not bibtex at all')).toEqual([]);
  });
});
