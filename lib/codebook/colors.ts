/**
 * colors — stable, distinct per-code colors for the compare screen.
 *
 * WHY: on the coding screen every code wash is the same emerald, which is fine
 * when the question is "is this coded?" — but the compare screen's question is
 * "did we apply the SAME code here?", and identical washes make same/different
 * unreadable. Each mnemonic gets a hue; the same code is the same color in both
 * panes and across reloads, and two different codes on one line are visibly
 * different.
 *
 * TWO layers:
 *  - `hueForCode` — the raw deterministic hash hue (golden-angle spread). Pure
 *    function of the mnemonic, but two arbitrary codes CAN collide.
 *  - `assignHues` — the registry pass the UI actually uses: given every
 *    mnemonic on screen, walk them in sorted order and nudge any hue that
 *    lands within `minSep`° of an already-assigned one along the golden angle
 *    until clear. Deterministic for a given code set, and it guarantees the
 *    codes that appear TOGETHER — including the confusable pairs the compare
 *    screen exists to separate — read as different colors.
 *
 * Pure: strings in, numbers/CSS strings out. No DOM, no React.
 */

const GOLDEN_ANGLE = 137.50776405003785;

/** FNV-1a 32-bit — tiny, stable string hash (not cryptographic). */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Raw deterministic hue in [0, 360) for a mnemonic (collisions possible). */
export function hueForCode(mnemonic: string): number {
  return Math.round((hashString(mnemonic) * GOLDEN_ANGLE) % 360);
}

/** Circular hue distance. */
function hueDist(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

/**
 * Registry assignment: every mnemonic gets a hue at least `minSep`° from all
 * previously assigned ones (sorted order → deterministic per set). 12° keeps
 * capacity at 30 well-separated codes; past capacity later codes take their
 * best-effort hue rather than looping forever.
 */
export function assignHues(mnemonics: string[], minSep = 12): Map<string, number> {
  const sorted = [...new Set(mnemonics)].sort();
  const out = new Map<string, number>();
  const taken: number[] = [];
  for (const m of sorted) {
    let h = hueForCode(m);
    let guard = 0;
    while (taken.some((t) => hueDist(h, t) < minSep) && guard < 60) {
      h = (h + GOLDEN_ANGLE) % 360;
      guard++;
    }
    const hue = Math.round(h);
    out.set(m, hue);
    taken.push(hue);
  }
  return out;
}

/** Translucent background wash for a coded span. */
export function washFor(hue: number): string {
  return `hsla(${hue}, 70%, 45%, 0.18)`;
}

/** A solid accent (chip border / overlap band) for the code. */
export function accentFor(hue: number): string {
  return `hsla(${hue}, 65%, 38%, 0.9)`;
}

/** Pale chip background. */
export function chipBgFor(hue: number): string {
  return `hsla(${hue}, 70%, 50%, 0.14)`;
}

/**
 * Layered CSS for a span carrying MULTIPLE codes: the first hue paints the
 * background wash; each additional hue contributes a 3px band along the bottom
 * via stacked inset box-shadows (up to `maxBands`), so overlap reads as
 * stacked color bars rather than a single mystery blend. CSS paints EARLIER
 * shadows on top, so the 3px band lists before the 6px band and the first
 * extra code stays visible at the very bottom.
 */
export function overlapStyle(
  hues: number[],
  maxBands = 3,
): { backgroundColor?: string; boxShadow?: string } {
  if (hues.length === 0) return {};
  const [first, ...rest] = hues;
  const bands = rest.slice(0, maxBands);
  const shadows = bands.map((h, i) => `inset 0 -${(i + 1) * 3}px 0 0 ${accentFor(h)}`);
  return {
    backgroundColor: washFor(first),
    boxShadow: shadows.length ? shadows.join(', ') : undefined,
  };
}
