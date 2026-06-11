// ---------------------------------------------------------------------------
// Auto-assigned, maximally-distinct categorical colors — a pure helper so the
// researcher NEVER has to pick a color for a label / facet value / flag type.
//
// Three things carry a `color` field that was previously hand-picked: labels
// (cb_labels), facet values (cb_facet_values), and flag types (cb_flag_types).
// Within a single group (a codebook's labels, ONE facet's values, a codebook's
// flag types) two colors that are the same — or perceptually close — defeat the
// whole point of the swatch. We solve this WITHOUT a picker by keying the hue to
// the item's append `position` within its group via golden-angle spacing.
//
// Why the golden angle (≈137.508°)? Stepping the hue wheel by the golden angle
// is the classic "maximally-distinct sequence" trick: every prefix of the
// sequence is near-uniformly spread around the 360° circle, so consecutive items
// are far apart AND no early cluster forms as the list grows. For a run of 12 the
// minimum pairwise hue gap is ≈20°; for small lists (2–4) it is 53–137°. This
// beats a fixed palette (which repeats/clashes past its length) and beats random
// hues (which clump). Saturation and lightness are held fixed so the family reads
// as ONE categorical scale, only the hue varies.
//
// S/L tuning: fixed S=0.62, L=0.55. The spec's starting point was S≈0.62,
// L≈0.60; L is nudged down to 0.55 so the chips stay legible (not pastel) on the
// warm cream portal background (#fbfaf7) while keeping the warm, mid-saturation
// "portal palette" feel. At these values a run of 12 indices yields 12 distinct
// hexes, each with usable (>1.5:1) contrast against the cream as a filled chip.
//
// PURE (no I/O, deterministic) so it unit-tests cleanly; the server actions feed
// it the item's within-group position and the one-time backfill feeds it the
// per-group ordinal.
// ---------------------------------------------------------------------------

/** The golden angle in degrees — the hue step between consecutive indices. */
export const GOLDEN_ANGLE_DEG = 137.508;

/** Fixed saturation for the categorical family (0–1). */
export const AUTO_COLOR_SATURATION = 0.62;

/** Fixed lightness for the categorical family (0–1). */
export const AUTO_COLOR_LIGHTNESS = 0.55;

/**
 * Convert an HSL triple to a `#rrggbb` hex string.
 *
 * @param h hue in degrees (any real number; reduced mod 360)
 * @param s saturation 0–1 (clamped)
 * @param l lightness 0–1 (clamped)
 */
export function hslToHex(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  const sat = clamp01(s);
  const light = clamp01(l);

  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = light - c / 2;

  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 60) [r, g, b] = [c, x, 0];
  else if (hue < 120) [r, g, b] = [x, c, 0];
  else if (hue < 180) [r, g, b] = [0, c, x];
  else if (hue < 240) [r, g, b] = [0, x, c];
  else if (hue < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];

  return '#' + toHexByte(r + m) + toHexByte(g + m) + toHexByte(b + m);
}

/**
 * Deterministic categorical color for the item at `index` within its group.
 *
 * `hue = (index * GOLDEN_ANGLE) mod 360`, with fixed S/L. Because each group's
 * append position is its 0-based ordinal in that group (labels per codebook,
 * facet values per facet, flag types per codebook), keying the hue to `position`
 * makes every item in a group land on a different, well-spread hue — so no two
 * within the group are the same or perceptually close, with no picker involved.
 *
 * Negative or fractional indices are tolerated (the hue is reduced mod 360);
 * callers pass a non-negative integer position.
 */
export function autoColor(index: number): string {
  const hue = (index * GOLDEN_ANGLE_DEG) % 360;
  return hslToHex(hue, AUTO_COLOR_SATURATION, AUTO_COLOR_LIGHTNESS);
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Round a 0–1 channel to a 2-digit lowercase hex byte. */
function toHexByte(channel: number): string {
  const v = Math.round(clamp01(channel) * 255);
  return v.toString(16).padStart(2, '0');
}
