import { describe, expect, it } from 'vitest';
import { contextLabel, parseAnnotationIds, type PendingAnnotation } from '../annotations';

describe('parseAnnotationIds', () => {
  it('splits on commas, whitespace, and newlines', () => {
    expect(parseAnnotationIds('a, b\nc  d,e')).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('trims and drops empty tokens (trailing separators, double commas)', () => {
    expect(parseAnnotationIds(' a , , b, ')).toEqual(['a', 'b']);
  });

  it('DE-DUPES while preserving first-seen order (mirrors the action Set count)', () => {
    // The fold action refuses a partial fold when resolved-count !== Set size,
    // so the client MUST collapse duplicates the same way or a double-paste
    // would spuriously trip the refusal.
    expect(parseAnnotationIds('x, y, x, z, y')).toEqual(['x', 'y', 'z']);
  });

  it('returns [] for empty / whitespace-only / nullish input', () => {
    expect(parseAnnotationIds('')).toEqual([]);
    expect(parseAnnotationIds('   \n  ')).toEqual([]);
    // @ts-expect-error — guard against a nullish blob defensively.
    expect(parseAnnotationIds(undefined)).toEqual([]);
  });
});

describe('contextLabel', () => {
  function a(over: Partial<PendingAnnotation>): PendingAnnotation {
    return { note: 'n', localKey: 'k', ...over };
  }

  it('prefers the pid · phase · scenario coordinates when known', () => {
    expect(contextLabel(a({ pid: 'P07', phaseOrdinal: 2, scenarioIdx: 1 }))).toBe('P07 · phase 2 · sc 1');
  });

  it('omits a null scenario coordinate', () => {
    expect(contextLabel(a({ pid: 'P07', phaseOrdinal: 0, scenarioIdx: null }))).toBe('P07 · phase 0');
  });

  it('falls back to verdict id, then run id, then unscoped', () => {
    expect(contextLabel(a({ verdictId: 'v1' }))).toBe('verdict v1');
    expect(contextLabel(a({ runId: 'r1' }))).toBe('run r1');
    expect(contextLabel(a({}))).toBe('unscoped');
  });
});
