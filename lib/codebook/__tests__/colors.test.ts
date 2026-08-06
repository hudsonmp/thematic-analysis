import { describe, it, expect } from 'vitest';
import { hashString, hueForCode, assignHues, washFor, overlapStyle } from '../colors';

describe('code colors', () => {
  it('hashString and hueForCode are deterministic and in range', () => {
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashString('abc')).not.toBe(hashString('abd'));
    for (const m of ['new-components', 'prior-knowledge', 'tested-experiment']) {
      const h = hueForCode(m);
      expect(h).toBe(hueForCode(m));
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });

  it('assignHues separates every pair in a realistic codebook by ≥ minSep', () => {
    // The real most-confused pairs MUST be distinguishable for the compare
    // screen to work — raw hash hues can collide (that is why the registry
    // pass exists).
    const codebook = [
      'scenario-review-confirmation',
      'tested-experiment',
      'experiment-driven-change',
      'rule-space-spec',
      'familiarization-with-experiment',
      'experiment-goals',
      'new-components',
      'prior-knowledge',
      'structure-driven-goals',
      'instantiated-vague-concept',
      'special-case-specification',
      'structure-reconciliation',
      'second-pass',
      'reviewing-specification-space',
      'hypothesis-feasibility',
      'predict-output',
      'connected-ideas',
      'pose-problem',
      'idea-incubation',
      'structural-audit-req',
    ];
    const hues = assignHues(codebook, 12);
    const list = [...hues.entries()];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const d = Math.abs(list[i][1] - list[j][1]) % 360;
        expect(Math.min(d, 360 - d), `${list[i][0]} vs ${list[j][0]}`).toBeGreaterThanOrEqual(12);
      }
    }
  });

  it('assignHues is deterministic and order-insensitive (sorted internally)', () => {
    const a = assignHues(['x-code', 'y-code', 'z-code']);
    const b = assignHues(['z-code', 'x-code', 'y-code']);
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
  });

  it('overlapStyle: single hue = wash only; extras become stacked bands, capped', () => {
    expect(overlapStyle([])).toEqual({});
    const one = overlapStyle([120]);
    expect(one.backgroundColor).toBe(washFor(120));
    expect(one.boxShadow).toBeUndefined();
    const three = overlapStyle([10, 120, 240]);
    expect((three.boxShadow!.match(/inset/g) ?? []).length).toBe(2);
    expect(three.backgroundColor).toBe(washFor(10));
    const capped = overlapStyle([1, 2, 3, 4, 5, 6], 3);
    expect((capped.boxShadow!.match(/inset/g) ?? []).length).toBe(3);
  });
});
