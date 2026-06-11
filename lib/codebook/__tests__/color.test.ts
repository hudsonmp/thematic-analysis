import { describe, expect, it } from 'vitest';
import {
  autoColor,
  hslToHex,
  GOLDEN_ANGLE_DEG,
  AUTO_COLOR_SATURATION,
  AUTO_COLOR_LIGHTNESS,
} from '@/lib/codebook/color';

const HEX_RE = /^#[0-9a-f]{6}$/;

// --- hue extraction helpers (test-only) -----------------------------------

function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/** Recover the hue (degrees) of a hex color, to compare against the intended one. */
function hexToHue(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return (h + 360) % 360;
}

/** Smallest circular distance between two hues in degrees. */
function hueGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

describe('hslToHex', () => {
  it('produces a well-formed lowercase #rrggbb string', () => {
    expect(hslToHex(0, 0.62, 0.55)).toMatch(HEX_RE);
    expect(hslToHex(200, 1, 0.5)).toMatch(HEX_RE);
  });

  it('hits known anchors', () => {
    expect(hslToHex(0, 0, 0)).toBe('#000000'); // black
    expect(hslToHex(0, 0, 1)).toBe('#ffffff'); // white
    expect(hslToHex(0, 1, 0.5)).toBe('#ff0000'); // pure red
    expect(hslToHex(120, 1, 0.5)).toBe('#00ff00'); // pure green
    expect(hslToHex(240, 1, 0.5)).toBe('#0000ff'); // pure blue
  });

  it('reduces hue mod 360 and clamps s/l', () => {
    expect(hslToHex(360, 1, 0.5)).toBe(hslToHex(0, 1, 0.5));
    expect(hslToHex(-120, 1, 0.5)).toBe(hslToHex(240, 1, 0.5));
    expect(hslToHex(0, 5, 0.5)).toBe(hslToHex(0, 1, 0.5)); // s clamped to 1
    expect(hslToHex(0, 0.5, -1)).toBe('#000000'); // l clamped to 0
  });
});

describe('autoColor', () => {
  it('is deterministic', () => {
    expect(autoColor(0)).toBe(autoColor(0));
    expect(autoColor(7)).toBe(autoColor(7));
  });

  it('returns a well-formed hex at the tuned S/L', () => {
    for (let i = 0; i < 12; i++) expect(autoColor(i)).toMatch(HEX_RE);
    // index 0 → hue 0 → a warm red at S=0.62, L=0.55
    expect(autoColor(0)).toBe(hslToHex(0, AUTO_COLOR_SATURATION, AUTO_COLOR_LIGHTNESS));
  });

  it('gives different colors for adjacent indices', () => {
    expect(autoColor(0)).not.toBe(autoColor(1));
    expect(autoColor(1)).not.toBe(autoColor(2));
  });

  it('separates consecutive hues by ~137.5° (golden angle)', () => {
    for (let i = 0; i < 6; i++) {
      const gap = hueGap(hexToHue(autoColor(i)), hexToHue(autoColor(i + 1)));
      // consecutive golden-angle step is 137.508°; equivalently 360-137.508=222.49
      // collapses to 137.51 under circular distance. Allow rounding slack.
      expect(gap).toBeGreaterThan(137.508 - 2);
      expect(gap).toBeLessThan(137.508 + 2);
    }
  });

  it('yields 12 distinct hexes with good min-hue separation over a run of 12', () => {
    const hexes = Array.from({ length: 12 }, (_, i) => autoColor(i));
    expect(new Set(hexes).size).toBe(12);

    const hues = hexes.map(hexToHue);
    let minGap = 360;
    for (let i = 0; i < hues.length; i++) {
      for (let j = i + 1; j < hues.length; j++) {
        minGap = Math.min(minGap, hueGap(hues[i], hues[j]));
      }
    }
    // Golden-angle packing of 12 hues has a min pairwise gap of ~20°; assert it
    // stays comfortably above a clash threshold so chips are distinguishable.
    expect(minGap).toBeGreaterThan(15);
  });

  it('exposes the golden angle as the step constant', () => {
    expect(GOLDEN_ANGLE_DEG).toBeCloseTo(137.508, 3);
  });
});
