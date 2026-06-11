import { describe, it, expect } from 'vitest';
import {
  FACET_TYPES,
  DEFAULT_FACET_TYPE,
  isFacetType,
  coerceFacetType,
  facetHasValues,
  facetRenderMode,
  slugifyValueKey,
} from '@/lib/codebook/facet-types';

describe('facet type narrowing', () => {
  it('exposes exactly the three kinds, enum as default', () => {
    expect([...FACET_TYPES]).toEqual(['enum', 'boolean', 'open_text']);
    expect(DEFAULT_FACET_TYPE).toBe('enum');
  });

  it('isFacetType accepts only the union members', () => {
    expect(isFacetType('enum')).toBe(true);
    expect(isFacetType('boolean')).toBe(true);
    expect(isFacetType('open_text')).toBe(true);
    expect(isFacetType('select')).toBe(false);
    expect(isFacetType('')).toBe(false);
  });

  it('coerceFacetType passes valid through and falls back otherwise', () => {
    expect(coerceFacetType('boolean')).toBe('boolean');
    expect(coerceFacetType('open_text')).toBe('open_text');
    expect(coerceFacetType('enum')).toBe('enum');
    // unknown / null / undefined → default (enum) so old rows + future kinds are safe
    expect(coerceFacetType('mystery')).toBe('enum');
    expect(coerceFacetType(null)).toBe('enum');
    expect(coerceFacetType(undefined)).toBe('enum');
  });
});

describe('facetHasValues', () => {
  it('is true only for enum', () => {
    expect(facetHasValues('enum')).toBe(true);
    expect(facetHasValues('boolean')).toBe(false);
    expect(facetHasValues('open_text')).toBe(false);
  });
});

describe('facetRenderMode', () => {
  it('maps enum by cardinality', () => {
    expect(facetRenderMode('enum', 'single')).toBe('enum-single');
    expect(facetRenderMode('enum', 'multi')).toBe('enum-multi');
  });

  it('ignores cardinality for boolean and open_text', () => {
    expect(facetRenderMode('boolean', 'single')).toBe('boolean');
    expect(facetRenderMode('boolean', 'multi')).toBe('boolean');
    expect(facetRenderMode('open_text', 'single')).toBe('open-text');
    expect(facetRenderMode('open_text', 'multi')).toBe('open-text');
  });
});

describe('slugifyValueKey', () => {
  it('lower-kebabs a normal label', () => {
    expect(slugifyValueKey('Surface Strategy')).toBe('surface-strategy');
    expect(slugifyValueKey('  Mixed   Methods  ')).toBe('mixed-methods');
  });

  it('collapses punctuation runs and trims dashes', () => {
    expect(slugifyValueKey('A/B — test!!')).toBe('a-b-test');
    expect(slugifyValueKey('---weird---')).toBe('weird');
  });

  it('falls back to "value" when nothing slug-able remains', () => {
    expect(slugifyValueKey('!!!')).toBe('value');
    expect(slugifyValueKey('   ')).toBe('value');
  });

  it('caps length and drops a trailing dash from the slice boundary', () => {
    const out = slugifyValueKey('abcdefghij klmnopqrst uvwxyz', 11);
    expect(out.length).toBeLessThanOrEqual(11);
    expect(out.endsWith('-')).toBe(false);
    expect(out).toBe('abcdefghij');
  });
});
