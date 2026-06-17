import { describe, it, expect } from 'vitest';
import { alignChat, activeChatIndex, type ChatTurn } from '../align';
import type { ChatMessage } from '@/app/actions/chat';

// A fixed recording anchor. created_at strings are placed at known +offsets so the
// offset math reads off the wall clock by inspection (anchor = 60s into the minute).
const ANCHOR_ISO = '2026-06-12T16:37:00.000Z';
const ANCHOR_MS = Date.parse(ANCHOR_ISO);

/** A minimal ChatMessage at `anchor + offsetMs`, with sane defaults. */
const msg = (
  id: string,
  offsetMs: number,
  role: 'user' | 'assistant' = 'user',
): ChatMessage => ({
  id,
  role,
  content: `c-${id}`,
  createdAt: new Date(ANCHOR_MS + offsetMs).toISOString(),
  moduleId: 'm1',
  scenarioIdx: null,
});

describe('alignChat', () => {
  it('computes offsetMs as created_at − anchorMs', () => {
    const out = alignChat([msg('a', 5_000)], ANCHOR_MS);
    expect(out).toHaveLength(1);
    expect(out[0].offsetMs).toBe(5_000);
    // carries through the display fields
    expect(out[0]).toMatchObject({ id: 'a', role: 'user', content: 'c-a' });
  });

  it('yields a NEGATIVE offset for a turn before the anchor', () => {
    const out = alignChat([msg('pre', -2_000)], ANCHOR_MS);
    expect(out[0].offsetMs).toBe(-2_000);
  });

  it('sorts by offsetMs ascending regardless of input order', () => {
    const out = alignChat([msg('c', 3_000), msg('a', 1_000), msg('b', 2_000)], ANCHOR_MS);
    expect(out.map((t) => t.id)).toEqual(['a', 'b', 'c']);
    expect(out.map((t) => t.offsetMs)).toEqual([1_000, 2_000, 3_000]);
  });

  it('breaks offsetMs ties by id for a stable, reproducible order', () => {
    // A fast user+assistant pair can share a created_at millisecond → equal offset.
    const out = alignChat([msg('b', 1_000), msg('a', 1_000)], ANCHOR_MS);
    expect(out.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('drops rows whose createdAt is unparseable (no NaN offsets)', () => {
    const bad: ChatMessage = {
      id: 'bad',
      role: 'assistant',
      content: 'x',
      createdAt: 'not-a-date',
      moduleId: 'm1',
      scenarioIdx: null,
    };
    const out = alignChat([msg('a', 1_000), bad, msg('b', 2_000)], ANCHOR_MS);
    expect(out.map((t) => t.id)).toEqual(['a', 'b']);
    expect(out.every((t) => Number.isFinite(t.offsetMs))).toBe(true);
  });

  it('returns [] for [] (empty input)', () => {
    expect(alignChat([], ANCHOR_MS)).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const input = [msg('c', 3_000), msg('a', 1_000)];
    const copy = [...input];
    alignChat(input, ANCHOR_MS);
    expect(input).toEqual(copy);
  });
});

describe('activeChatIndex', () => {
  // Three turns at offsets 1000, 2000, 3000 (ascending — alignChat's output shape).
  const TURNS: ChatTurn[] = alignChat(
    [msg('a', 1_000), msg('b', 2_000), msg('c', 3_000)],
    ANCHOR_MS,
  );

  it('returns -1 before the first turn', () => {
    expect(activeChatIndex(TURNS, 0)).toBe(-1);
    expect(activeChatIndex(TURNS, 999)).toBe(-1);
  });

  it('returns the turn EXACTLY on a boundary (offsetMs ≤ playhead)', () => {
    expect(activeChatIndex(TURNS, 1_000)).toBe(0);
    expect(activeChatIndex(TURNS, 2_000)).toBe(1);
    expect(activeChatIndex(TURNS, 3_000)).toBe(2);
  });

  it('returns the latest turn at or before the playhead (between turns)', () => {
    expect(activeChatIndex(TURNS, 1_500)).toBe(0);
    expect(activeChatIndex(TURNS, 2_999)).toBe(1);
  });

  it('returns the last turn after all turns', () => {
    expect(activeChatIndex(TURNS, 10_000)).toBe(2);
  });

  it('returns -1 for an empty turn list', () => {
    expect(activeChatIndex([], 5_000)).toBe(-1);
  });

  it('selects a pre-anchor (negative-offset) turn once the playhead reaches it', () => {
    // A turn before the recording anchor has a negative offset; it becomes active
    // as soon as the playhead is at or past it, even while still negative.
    const straddle = alignChat([msg('pre', -2_000), msg('post', 1_000)], ANCHOR_MS);
    expect(straddle.map((t) => t.id)).toEqual(['pre', 'post']);
    expect(activeChatIndex(straddle, 0)).toBe(0); // 0 ≥ pre's -2000, < post's 1000
    expect(activeChatIndex(straddle, -3_000)).toBe(-1); // before even the pre-anchor turn
  });
});
