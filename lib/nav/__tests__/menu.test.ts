import { describe, expect, it } from 'vitest';
import {
  ALL_ITEMS,
  NAV_GROUPS,
  activeGroupKey,
  activeHref,
  visibleNavGroups,
} from '@/lib/nav/menu';

describe('NAV_GROUPS', () => {
  it('contains only the retained authoring and recording workflows', () => {
    expect(NAV_GROUPS.map((g) => g.key)).toEqual(['codebook', 'recording']);
  });

  it('routes every href exactly once (no item lives in two menus)', () => {
    const hrefs = ALL_ITEMS.map((i) => i.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('does not expose retired tools', () => {
    const hrefs = ALL_ITEMS.map((item) => item.href);
    expect(hrefs).not.toContain('/drill');
    expect(hrefs).not.toContain('/export');
    expect(hrefs).not.toContain('/instructions');
    expect(hrefs).not.toContain('/reliability');
    expect(hrefs).not.toContain('/progression-analysis');
  });

  it('carries the admin console as an admin-only item', () => {
    const admin = ALL_ITEMS.find((item) => item.href === '/admin');
    expect(admin?.adminOnly).toBe(true);
  });
});

/**
 * The admin console mints the invite links that add coders to the study, so it
 * has to be REACHABLE by the admin — but it must never render for a coder. The
 * page re-gates with requireAdmin() regardless; this only decides what the nav
 * shows, so the filter lives here as pure data rather than inline in the chrome.
 */
describe('visibleNavGroups', () => {
  it('shows the admin console to an admin', () => {
    const hrefs = visibleNavGroups(true).flatMap((g) => g.items.map((i) => i.href));
    expect(hrefs).toContain('/admin');
  });

  it('hides the admin console from a non-admin', () => {
    const hrefs = visibleNavGroups(false).flatMap((g) => g.items.map((i) => i.href));
    expect(hrefs).not.toContain('/admin');
  });

  it('leaves every non-admin item alone for both roles', () => {
    const asAdmin = visibleNavGroups(true).flatMap((g) => g.items.map((i) => i.href));
    const asCoder = visibleNavGroups(false).flatMap((g) => g.items.map((i) => i.href));
    expect(asAdmin.filter((h) => h !== '/admin')).toEqual(asCoder);
  });

  it('keeps both menus present even when nothing admin-only is shown', () => {
    expect(visibleNavGroups(false).map((g) => g.key)).toEqual(['codebook', 'recording']);
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
    // /codebook/merge is a sibling under /codebook, like /codebook/view — it
    // must light up its own entry, not the canvas's.
    expect(activeHref('/codebook/merge')).toBe('/codebook/merge');
    expect(activeGroupKey('/codebook/merge')).toBe('codebook');
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
    expect(activeGroupKey('/citations')).toBe('codebook');
  });

  it('is null when nothing matches', () => {
    expect(activeGroupKey('/codes/abc-123')).toBeNull();
  });

  it('resolves the admin console to its owning menu', () => {
    expect(activeHref('/admin')).toBe('/admin');
    expect(activeGroupKey('/admin')).toBe('codebook');
  });
});
