/**
 * menu — the nav's information architecture as PURE data, so the grouping and
 * the active-link resolution are unit-testable without mounting the header.
 *
 * The chrome used to be thirteen flat links, which is past the point where a
 * researcher scans rather than reads. They collapse into three menus that name
 * the three *phases of the work*, not the three groups of screens:
 *
 *   Codebook  — author the instrument   (scheme, codes, citations, freeze/κ, export)
 *   Recording — collect + observe data  (live co-observation, sessions, events, flags)
 *   Eval      — analyse                 (progression, LLM grader runs)
 *
 * Reliability sits under CODEBOOK, not Eval, on purpose: κ from a pasted
 * two-coder table is an audit of the *instrument* against its frozen version
 * (README, §2.9) — it is not an analysis of participants. The LLM agreement view
 * under Eval is a different κ (human × model) and belongs to the grader.
 */

export type NavItem = { href: string; label: string; hint?: string; adminOnly?: boolean };
export type NavGroup = { key: string; label: string; items: NavItem[] };

export const NAV_GROUPS: NavGroup[] = [
  {
    key: 'codebook',
    label: 'Codebook',
    items: [
      { href: '/codebook', label: 'Codes', hint: 'Tree, codes, scheme' },
      { href: '/codebook/view', label: 'Document', hint: 'Readable list · print to PDF' },
      { href: '/codebook/merge', label: 'Merge', hint: 'Combine duplicate codes' },
      { href: '/labels', label: 'Labels', hint: 'Cross-cutting tags' },
      { href: '/', label: 'Scheme', hint: 'Facets and their values' },
      { href: '/citations', label: 'Citations', hint: 'BibTeX library' },
      { href: '/reliability', label: 'Reliability', hint: 'Freeze gate, κ audit' },
      { href: '/reliability/irr', label: 'IRR (live)', hint: 'EasyDIAg κ from coding' },
      { href: '/export', label: 'Export', hint: 'LaTeX, JSON' },
      { href: '/instructions', label: 'Instructions', hint: 'Coder guidance' },
      { href: '/drill', label: 'Drill', hint: 'Spaced practice on the codes' },
    ],
  },
  {
    key: 'recording',
    label: 'Recording',
    items: [
      { href: '/guide', label: 'Guide', hint: 'Onboarding walkthrough' },
      { href: '/sessions/live', label: 'Live', hint: 'Co-observation' },
      { href: '/sessions', label: 'Sessions', hint: 'Recorded playback' },
      { href: '/episodes', label: 'Events', hint: 'When it happened' },
      { href: '/flag-types', label: 'Flags', hint: 'In-session markers' },
    ],
  },
  {
    key: 'eval',
    label: 'Eval',
    items: [
      { href: '/progression-analysis', label: 'Progression', hint: 'Spec evolution' },
      { href: '/progression-analysis/llm', label: 'LLM Eval', hint: 'Grader runs, agreement' },
      { href: '/admin', label: 'Admin', hint: 'Invites · familiarization', adminOnly: true },
    ],
  },
];

/** Every item across every group, flattened — the resolution set for `activeHref`. */
export const ALL_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

/**
 * Which single nav href does `pathname` light up?
 *
 * Longest-prefix wins, so a more specific sibling never loses the highlight to a
 * shorter one that also prefixes it: `/sessions/live` resolves to Live, not
 * Sessions; `/progression-analysis/llm/run` resolves to LLM Eval, not
 * Progression. `/` is special-cased to an exact match — as a prefix it would
 * match everything.
 *
 * Returns `null` when nothing matches (a route with no nav entry, e.g.
 * `/codes/[id]` reached by drilling in), so nothing is falsely highlighted.
 */
export function activeHref(pathname: string): string | null {
  let best: string | null = null;
  for (const item of ALL_ITEMS) {
    if (item.href === '/') {
      if (pathname === '/') return '/';
      continue;
    }
    if (pathname === item.href || pathname.startsWith(`${item.href}/`)) {
      if (best === null || item.href.length > best.length) best = item.href;
    }
  }
  return best;
}

/** The group key containing `activeHref(pathname)`, or null when nothing matches. */
export function activeGroupKey(pathname: string): string | null {
  const href = activeHref(pathname);
  if (href === null) return null;
  return NAV_GROUPS.find((g) => g.items.some((i) => i.href === href))?.key ?? null;
}
