import { describe, it, expect } from 'vitest';
import {
  ANCHOR_CORRECTION_MS,
  computeAnchorMs,
  resolveRecordingAnchorMs,
} from '@/lib/live/anchor';

describe('ANCHOR_CORRECTION_MS', () => {
  it('is the single 2000ms record-start correction constant', () => {
    expect(ANCHOR_CORRECTION_MS).toBe(2000);
  });
});

describe('computeAnchorMs', () => {
  it('returns the task module_start epoch-ms plus the +2000ms correction', () => {
    // A known instant: 2026-06-11T15:53:02.197Z → epoch-ms, then +2000.
    const iso = '2026-06-11T15:53:02.197Z';
    const baseMs = Date.parse(iso);
    expect(computeAnchorMs(iso)).toBe(baseMs + 2000);
  });

  it('applies exactly ANCHOR_CORRECTION_MS (not a hardcoded literal)', () => {
    const iso = '2026-01-01T00:00:00.000Z';
    expect(computeAnchorMs(iso) - Date.parse(iso)).toBe(ANCHOR_CORRECTION_MS);
  });

  it('parses a Postgres timestamptz with a +00 offset to the same instant', () => {
    // The DB hands back `...+00`; it must parse to the same epoch as the Z form.
    const pg = '2026-06-11 15:53:02.197+00';
    const z = '2026-06-11T15:53:02.197Z';
    expect(computeAnchorMs(pg)).toBe(computeAnchorMs(z));
  });

  it('throws on an unparseable timestamp rather than returning NaN', () => {
    expect(() => computeAnchorMs('not-a-timestamp')).toThrow(/unparseable/);
  });
});

describe('resolveRecordingAnchorMs (manual over auto)', () => {
  const manual = '2026-06-11T15:53:00.000Z';
  const taskStart = '2026-06-11T15:53:02.197Z';

  it('prefers the MANUAL mark, used EXACTLY (no +correction)', () => {
    const r = resolveRecordingAnchorMs(manual, taskStart);
    expect(r).toEqual({ source: 'manual', recordingStartedAt: Date.parse(manual) });
    // Crucially: the manual anchor is NOT shifted by ANCHOR_CORRECTION_MS.
    expect(r?.recordingStartedAt).toBe(Date.parse(manual));
  });

  it('falls back to AUTO (task_start + correction) when no manual mark', () => {
    const r = resolveRecordingAnchorMs(null, taskStart);
    expect(r).toEqual({
      source: 'auto',
      recordingStartedAt: Date.parse(taskStart) + ANCHOR_CORRECTION_MS,
    });
  });

  it('manual wins even when it is EARLIER than the auto anchor', () => {
    // manual (15:53:00) < auto (15:53:02.197 + 2s); manual must still be chosen.
    const r = resolveRecordingAnchorMs(manual, taskStart);
    expect(r?.source).toBe('manual');
    expect(r?.recordingStartedAt).toBeLessThan(
      Date.parse(taskStart) + ANCHOR_CORRECTION_MS,
    );
  });

  it('returns null when NEITHER a manual mark nor a task start exists', () => {
    expect(resolveRecordingAnchorMs(null, null)).toBeNull();
  });

  it('ignores a malformed manual mark and falls through to auto', () => {
    const r = resolveRecordingAnchorMs('not-a-timestamp', taskStart);
    expect(r).toEqual({
      source: 'auto',
      recordingStartedAt: Date.parse(taskStart) + ANCHOR_CORRECTION_MS,
    });
  });

  it('throws on a malformed task start when it is the only source (no fallback)', () => {
    expect(() => resolveRecordingAnchorMs(null, 'not-a-timestamp')).toThrow(/unparseable/);
  });

  it('parses a Postgres timestamptz manual mark to the same instant as Z form', () => {
    const pg = '2026-06-11 15:53:00+00';
    const r = resolveRecordingAnchorMs(pg, taskStart);
    expect(r).toEqual({ source: 'manual', recordingStartedAt: Date.parse(manual) });
  });
});
