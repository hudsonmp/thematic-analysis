import { describe, it, expect } from 'vitest';
import {
  SESSION_COLLECTIONS,
  DEFAULT_SESSION_COLLECTION,
  collectionOptions,
} from '../collections';

describe('SESSION_COLLECTIONS', () => {
  it('is exactly {pilot, study} and the default is one of them', () => {
    expect([...SESSION_COLLECTIONS]).toEqual(['pilot', 'study']);
    expect(SESSION_COLLECTIONS).toContain(DEFAULT_SESSION_COLLECTION);
  });
});

describe('collectionOptions', () => {
  it('returns the canonical set for a canonical current value', () => {
    expect(collectionOptions('pilot')).toEqual(['pilot', 'study']);
    expect(collectionOptions('study')).toEqual(['pilot', 'study']);
  });

  it('returns the canonical set for a blank/nullish current value', () => {
    expect(collectionOptions('')).toEqual(['pilot', 'study']);
    expect(collectionOptions('   ')).toEqual(['pilot', 'study']);
    expect(collectionOptions(null)).toEqual(['pilot', 'study']);
    expect(collectionOptions(undefined)).toEqual(['pilot', 'study']);
  });

  it('appends a legacy/non-canonical current value so it stays visible & selectable', () => {
    // The existing corpus uses "pilots" — it must still render as the row's value.
    expect(collectionOptions('pilots')).toEqual(['pilot', 'study', 'pilots']);
    expect(collectionOptions('uncategorized')).toEqual([
      'pilot',
      'study',
      'uncategorized',
    ]);
  });

  it('trims the current value when deciding canonicality', () => {
    // A padded canonical value is treated as canonical (not appended as legacy).
    expect(collectionOptions('  study  ')).toEqual(['pilot', 'study']);
  });
});
