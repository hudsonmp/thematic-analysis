import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatElapsed,
  formatDate,
  mmss,
  resolveClockStart,
} from '@/lib/live/clock';

describe('mmss', () => {
  it('formats sub-minute, minute, and >60-minute spans', () => {
    expect(mmss(0)).toBe('00:00');
    expect(mmss(5_000)).toBe('00:05');
    expect(mmss(65_000)).toBe('01:05');
    expect(mmss(3_661_000)).toBe('61:01'); // minutes uncapped past 60
  });
});

describe('resolveClockStart (manual over task-start)', () => {
  const manual = '2026-06-11T15:53:00.000Z';
  const task = '2026-06-11T15:53:02.197Z';

  it('counts from the MANUAL recording start when present', () => {
    expect(resolveClockStart(manual, task)).toEqual({
      source: 'manual',
      startedAt: manual,
    });
  });

  it('falls back to the task start when there is no manual mark', () => {
    expect(resolveClockStart(null, task)).toEqual({ source: 'task', startedAt: task });
  });

  it('manual wins even over a present task start', () => {
    expect(resolveClockStart(manual, task).source).toBe('manual');
  });

  it('is "none" (not started) when neither anchor exists', () => {
    expect(resolveClockStart(null, null)).toEqual({ source: 'none', startedAt: null });
  });
});

describe('formatElapsed', () => {
  afterEach(() => vi.useRealTimers());

  it('returns null without a task-start anchor', () => {
    expect(formatElapsed(null, null)).toBeNull();
    expect(formatElapsed(null, '2026-05-28T15:15:46Z')).toBeNull();
  });

  it('ticks off Date.now() while running (no end)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-28T15:13:27Z')); // 60s after start
    expect(formatElapsed('2026-05-28T15:12:27Z', null)).toBe('01:00');
  });

  it('FREEZES at end − start once finished (ignores Date.now)', () => {
    vi.useFakeTimers();
    // Wall clock is far past the end; frozen elapsed must still be end − start.
    vi.setSystemTime(new Date('2026-05-28T18:00:00Z'));
    expect(
      formatElapsed('2026-05-28T15:12:27.356Z', '2026-05-28T15:15:46.994Z'),
    ).toBe('03:19'); // PID 411 round-trip: 199s ≈ 03:19
  });

  it('clamps a negative span (end before start, or clock skew) to 0', () => {
    expect(formatElapsed('2026-05-28T15:15:46Z', '2026-05-28T15:12:27Z')).toBe('00:00');
  });

  it('falls back to live ticking when taskEndedAt is unparseable', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-28T15:12:37Z')); // 10s after start
    expect(formatElapsed('2026-05-28T15:12:27Z', 'not-a-date')).toBe('00:10');
  });
});

describe('formatDate', () => {
  it('formats an ISO timestamp as YYYY-MM-DD (UTC)', () => {
    expect(formatDate('2026-05-28T15:12:27.356Z')).toBe('2026-05-28');
  });

  it('returns null for null/empty/unparseable input', () => {
    expect(formatDate(null)).toBeNull();
    expect(formatDate('')).toBeNull();
    expect(formatDate('nonsense')).toBeNull();
  });
});
