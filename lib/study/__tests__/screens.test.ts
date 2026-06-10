import { describe, it, expect } from 'vitest';
import { enumerateScreens } from '@/lib/study/screens';

describe('vendored enumerateScreens', () => {
  // enumerateScreens does NOT return [] for empty content: it unconditionally
  // emits 3 module-independent "global" pre-study screens (pre_system, login,
  // questionnaire) BEFORE iterating modules. With zero modules, exactly those
  // 3 globals are produced. Asserting [] (as the task template guessed) would
  // be wrong; we assert the real contract.
  it('returns exactly the 3 global pre-study screens for empty content', () => {
    const screens = enumerateScreens({ modules: [] });
    expect(screens).toHaveLength(3);
    expect(screens.map((s) => s.kind)).toEqual([
      'pre_system',
      'login',
      'questionnaire',
    ]);
    // All globals carry the sentinel module id and 'global' module type.
    expect(screens.every((s) => s.moduleId === '_global')).toBe(true);
    expect(screens.every((s) => s.moduleType === 'global')).toBe(true);
  });
});
