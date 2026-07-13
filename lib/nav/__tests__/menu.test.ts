import { describe, expect, it } from 'vitest';
import { ALL_ITEMS, NAV_GROUPS, activeGroupKey, activeHref } from '@/lib/nav/menu';

describe('NAV_GROUPS', () => {
  it('is the three phases of the work', () => {
    expect(NAV_GROUPS.map((g) => g.key)).toEqual(['codebook', 'recording', 'eval']);
  });

  it('routes every href exactly once (no item lives in two menus)', () => {
    const hrefs = ALL_ITEMS.map((i) => i.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('puts the instrument-audit κ under Codebook and the grader κ under Eval', () => {
    // /reliability is a human×human audit of the FROZEN instrument (README §2.9);
    // the agreement view under /progression-analysis/llm is human×model. Two
    // different κs — filing them in one menu is the mistake this pins against.
    expect(activeGroupKey('/reliability')).toBe('codebook');
    expect(activeGroupKey('/progression-analysis/llm')).toBe('eval');
  });
});

describe('activeHref', () => {
  it('matches / exactly, never as a prefix', () => {
    expect(activeHref('/')).toBe('/');
    expect(activeHref('/sessions')).toBe('/sessions');
  });

  it('lets the longest prefix win over a shorter sibling', () => {
    // /sessions/live must not lose the highlight to /sessions.
    expect(activeHref('/sessions/live')).toBe('/sessions/live');
    // …and a deeper unlisted route resolves up to its nearest listed ancestor.
    expect(activeHref('/sessions/abc-123')).toBe('/sessions');
    expect(activeHref('/sessions/abc-123/compare')).toBe('/sessions');
  });

  it('resolves the LLM run screen to LLM Eval, not Progression', () => {
    expect(activeHref('/progression-analysis/llm/run')).toBe('/progression-analysis/llm');
    expect(activeHref('/progression-analysis')).toBe('/progression-analysis');
  });

  it('matches on a path SEGMENT, so a same-prefix sibling route cannot steal it', () => {
    // '/labels-archive' starts with '/labels' as a STRING but is a different
    // route; segment-aware matching is why this is null rather than '/labels'.
    expect(activeHref('/labels-archive')).toBeNull();
  });

  it('returns null for a route with no nav entry', () => {
    expect(activeHref('/codes/abc-123')).toBeNull();
  });
});

describe('activeGroupKey', () => {
  it('opens the owning menu for a drilled-in route', () => {
    expect(activeGroupKey('/sessions/live')).toBe('recording');
    expect(activeGroupKey('/progression-analysis/llm/run')).toBe('eval');
    expect(activeGroupKey('/citations')).toBe('codebook');
  });

  it('is null when nothing matches', () => {
    expect(activeGroupKey('/codes/abc-123')).toBeNull();
  });
});
