import { describe, it, expect } from 'vitest';
import { splitDefinition, joinDefinition } from '@/lib/codebook/definition';

describe('splitDefinition', () => {
  it('returns the whole (trimmed) text as applied when there is no separator', () => {
    expect(splitDefinition('  Plain operational definition.  ')).toEqual({
      literature: null,
      applied: 'Plain operational definition.',
    });
  });

  it("splits on a '==' sitting on its own line", () => {
    const def = 'Theory from Smith (2020).\n==\nApply when the student restates.';
    expect(splitDefinition(def)).toEqual({
      literature: 'Theory from Smith (2020).',
      applied: 'Apply when the student restates.',
    });
  });

  it("splits on an inline 'a == b'", () => {
    expect(splitDefinition('a == b')).toEqual({ literature: 'a', applied: 'b' });
  });

  it("splits on the FIRST separator when multiple '==' appear", () => {
    expect(splitDefinition('lit == applied == trailing')).toEqual({
      literature: 'lit',
      applied: 'applied == trailing',
    });
  });

  it('returns literature null when the literature side is empty', () => {
    expect(splitDefinition('== only applied text')).toEqual({
      literature: null,
      applied: 'only applied text',
    });
    // Whitespace-only before the separator is also "empty".
    expect(splitDefinition('  \n== applied')).toEqual({
      literature: null,
      applied: 'applied',
    });
  });

  it('returns an empty applied side when nothing follows the separator', () => {
    expect(splitDefinition('lit only ==')).toEqual({
      literature: 'lit only',
      applied: '',
    });
  });

  it('handles null and undefined', () => {
    expect(splitDefinition(null)).toEqual({ literature: null, applied: '' });
    expect(splitDefinition(undefined)).toEqual({ literature: null, applied: '' });
  });
});

describe('joinDefinition', () => {
  it('joins literature + applied with == on its own line', () => {
    expect(joinDefinition('Theory', 'Applied rule')).toBe('Theory\n==\nApplied rule');
  });

  it('empty/null literature yields just the applied text (no separator)', () => {
    expect(joinDefinition('', 'Applied')).toBe('Applied');
    expect(joinDefinition('   ', 'Applied')).toBe('Applied');
    expect(joinDefinition(null, 'Applied')).toBe('Applied');
  });

  it('round-trips through splitDefinition', () => {
    for (const def of ['Theory\n==\nApplied', 'plain only', 'a == b']) {
      const { literature, applied } = splitDefinition(def);
      const joined = joinDefinition(literature, applied);
      const again = splitDefinition(joined);
      expect(again.literature).toBe(literature);
      expect(again.applied).toBe(applied);
    }
  });
});
