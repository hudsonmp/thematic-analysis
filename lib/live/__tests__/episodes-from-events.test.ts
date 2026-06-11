import { describe, it, expect } from 'vitest';
import {
  deriveEpisodeMarks,
  type DerivableEvent,
} from '@/lib/live/episodes-from-events';

// A fixed recording anchor for the offset math. All `createdAt`s below are
// expressed relative to this so the expected `tStartMs` reads obviously.
const ANCHOR_ISO = '2026-06-11T15:53:02.197Z';
const ANCHOR_MS = Date.parse(ANCHOR_ISO);

/** Build a `step_advance` event at `anchor + offsetMs`, advancing `to` a step. */
function advance(to: string, offsetMs: number, from = 'x'): DerivableEvent {
  return {
    eventType: 'step_advance',
    payload: { from, to },
    createdAt: new Date(ANCHOR_MS + offsetMs).toISOString(),
  };
}

/** Build a `module_start` event at `anchor + offsetMs`. */
function moduleStart(offsetMs: number): DerivableEvent {
  return {
    eventType: 'module_start',
    payload: { moduleType: 'task', total: 4 },
    createdAt: new Date(ANCHOR_MS + offsetMs).toISOString(),
  };
}

describe('deriveEpisodeMarks', () => {
  it('derives a normal read → ponder → revise sequence with correct offsets', () => {
    const events: DerivableEvent[] = [
      moduleStart(0), // → intro at t=0
      advance('initial_spec', 5_000, 'intro'), // → initial-spec at 5s
      advance('scenario_0_read', 10_000, 'initial_spec'), // → read at 10s
      advance('scenario_0_ponder', 20_000, 'scenario_0_read'), // → ponder at 20s
      advance('scenario_0_revise', 30_000, 'scenario_0_ponder'), // → revise at 30s
      advance('scenario_0_retro_0', 40_000, 'scenario_0_revise'), // → retrospective at 40s
    ];

    expect(deriveEpisodeMarks(events, ANCHOR_MS)).toEqual([
      { stepLabel: 'intro', tStartMs: 0 },
      { stepLabel: 'initial-spec', tStartMs: 5_000 },
      { stepLabel: 'read', tStartMs: 10_000 },
      { stepLabel: 'ponder', tStartMs: 20_000 },
      { stepLabel: 'revise', tStartMs: 30_000 },
      { stepLabel: 'retrospective', tStartMs: 40_000 },
    ]);
  });

  it('clamps negative offsets (events before record start) to 0', () => {
    const events: DerivableEvent[] = [
      moduleStart(-3_000), // 3s BEFORE the anchor → clamped to 0
      advance('scenario_0_read', 12_000, 'initial_spec'), // 12s after → 12000
    ];

    expect(deriveEpisodeMarks(events, ANCHOR_MS)).toEqual([
      { stepLabel: 'intro', tStartMs: 0 },
      { stepLabel: 'read', tStartMs: 12_000 },
    ]);
  });

  it('de-dups consecutive identical step labels (keeps the first)', () => {
    // Two reads back-to-back across scenarios collapse to one read mark; the
    // intervening revise is its own mark.
    const events: DerivableEvent[] = [
      advance('scenario_0_read', 1_000),
      advance('scenario_1_read', 2_000), // same canonical 'read' → deduped
      advance('scenario_1_revise', 3_000),
      advance('scenario_2_read', 4_000), // 'read' again, but not consecutive → kept
    ];

    expect(deriveEpisodeMarks(events, ANCHOR_MS)).toEqual([
      { stepLabel: 'read', tStartMs: 1_000 },
      { stepLabel: 'revise', tStartMs: 3_000 },
      { stepLabel: 'read', tStartMs: 4_000 },
    ]);
  });

  it('drops non-canonical step destinations (context / done / body)', () => {
    const events: DerivableEvent[] = [
      moduleStart(0), // → intro
      advance('context', 1_000, 'intro'), // non-canonical → dropped
      advance('initial_spec', 2_000, 'context'), // → initial-spec
      advance('done', 3_000, 'body'), // non-canonical → dropped
    ];

    expect(deriveEpisodeMarks(events, ANCHOR_MS)).toEqual([
      { stepLabel: 'intro', tStartMs: 0 },
      { stepLabel: 'initial-spec', tStartMs: 2_000 },
    ]);
  });

  it('maps a standalone retro_<m> step to retrospective', () => {
    const events: DerivableEvent[] = [advance('retro_1', 5_000, 'retro_0')];
    expect(deriveEpisodeMarks(events, ANCHOR_MS)).toEqual([
      { stepLabel: 'retrospective', tStartMs: 5_000 },
    ]);
  });

  it('ignores non-boundary events and malformed payloads without throwing', () => {
    const events: DerivableEvent[] = [
      { eventType: 'spec_edit', payload: { foo: 1 }, createdAt: new Date(ANCHOR_MS + 1_000).toISOString() },
      { eventType: 'step_advance', payload: null, createdAt: new Date(ANCHOR_MS + 2_000).toISOString() },
      advance('scenario_0_read', 3_000),
    ];
    expect(deriveEpisodeMarks(events, ANCHOR_MS)).toEqual([
      { stepLabel: 'read', tStartMs: 3_000 },
    ]);
  });

  it('returns no marks for an empty event list', () => {
    expect(deriveEpisodeMarks([], ANCHOR_MS)).toEqual([]);
  });
});
