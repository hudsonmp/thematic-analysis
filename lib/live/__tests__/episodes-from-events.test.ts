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
  it('derives a realistic requirements → specification → scenario → editing → retro sequence', () => {
    // module_start enters requirements analysis; the spec/scenario/edit/retro
    // step_advances map onto the 8 preset phases. `ponder` has no preset and is
    // DROPPED, so the scenario read flows straight into editing.
    const events: DerivableEvent[] = [
      moduleStart(0), // → requirements at t=0
      advance('initial_spec', 5_000, 'intro'), // → specification at 5s
      advance('scenario_0_read', 10_000, 'initial_spec'), // → scenario at 10s
      advance('scenario_0_ponder', 15_000, 'scenario_0_read'), // ponder → DROPPED
      advance('scenario_0_revise', 20_000, 'scenario_0_ponder'), // → editing at 20s
      advance('scenario_0_retro_0', 30_000, 'scenario_0_revise'), // → scenario_retro at 30s
      advance('retro_0', 40_000, 'scenario_0_retro_0'), // → general_retro_1 at 40s
      advance('retro_1', 50_000, 'retro_0'), // → general_retro_2 at 50s
      advance('retro_2', 60_000, 'retro_1'), // → general_retro_3 at 60s
    ];

    expect(deriveEpisodeMarks(events, ANCHOR_MS)).toEqual([
      { stepLabel: 'requirements', tStartMs: 0 },
      { stepLabel: 'specification', tStartMs: 5_000 },
      { stepLabel: 'scenario', tStartMs: 10_000 },
      { stepLabel: 'editing', tStartMs: 20_000 },
      { stepLabel: 'scenario_retro', tStartMs: 30_000 },
      { stepLabel: 'general_retro_1', tStartMs: 40_000 },
      { stepLabel: 'general_retro_2', tStartMs: 50_000 },
      { stepLabel: 'general_retro_3', tStartMs: 60_000 },
    ]);
  });

  it('maps module_start to requirements', () => {
    expect(deriveEpisodeMarks([moduleStart(0)], ANCHOR_MS)).toEqual([
      { stepLabel: 'requirements', tStartMs: 0 },
    ]);
  });

  it('maps step_advance destinations onto the preset phases (and drops the unmapped)', () => {
    const cases: Array<[string, string | null]> = [
      ['intro', 'requirements'],
      ['initial_spec', 'specification'],
      ['initial-spec', 'specification'],
      ['scenario_0_read', 'scenario'],
      ['scenario_1_revise', 'editing'],
      ['scenario_0_ponder', null], // no preset for ponder → dropped
      ['scenario_2_retro_0', 'scenario_retro'],
      ['retro_0', 'general_retro_1'],
      ['retro_1', 'general_retro_2'],
      ['retro_2', 'general_retro_3'],
      ['retro_3', null], // only three general questions exist → dropped
      ['done', null],
      ['body', null],
      ['context', null],
    ];

    for (const [to, expected] of cases) {
      const marks = deriveEpisodeMarks([advance(to, 1_000)], ANCHOR_MS);
      if (expected === null) {
        expect(marks, `step "${to}" should be dropped`).toEqual([]);
      } else {
        expect(marks, `step "${to}" → ${expected}`).toEqual([
          { stepLabel: expected, tStartMs: 1_000 },
        ]);
      }
    }
  });

  it('keeps the three standalone general retros as distinct marks (no de-dup collapse)', () => {
    // general_retro_1/2/3 are DISTINCT labels, so the three back-to-back retros
    // stay as three marks even though they're consecutive.
    const events: DerivableEvent[] = [
      advance('retro_0', 1_000),
      advance('retro_1', 2_000),
      advance('retro_2', 3_000),
    ];

    expect(deriveEpisodeMarks(events, ANCHOR_MS)).toEqual([
      { stepLabel: 'general_retro_1', tStartMs: 1_000 },
      { stepLabel: 'general_retro_2', tStartMs: 2_000 },
      { stepLabel: 'general_retro_3', tStartMs: 3_000 },
    ]);
  });

  it('clamps negative offsets (events before record start) to 0', () => {
    const events: DerivableEvent[] = [
      moduleStart(-3_000), // 3s BEFORE the anchor → clamped to 0
      advance('scenario_0_read', 12_000, 'initial_spec'), // 12s after → 12000
    ];

    expect(deriveEpisodeMarks(events, ANCHOR_MS)).toEqual([
      { stepLabel: 'requirements', tStartMs: 0 },
      { stepLabel: 'scenario', tStartMs: 12_000 },
    ]);
  });

  it('de-dups consecutive identical step labels (keeps the first)', () => {
    // Two reads back-to-back across scenarios collapse to one `scenario` mark; the
    // intervening edit is its own mark, so the later read is kept (not consecutive).
    const events: DerivableEvent[] = [
      advance('scenario_0_read', 1_000),
      advance('scenario_1_read', 2_000), // same canonical 'scenario' → deduped
      advance('scenario_1_revise', 3_000),
      advance('scenario_2_read', 4_000), // 'scenario' again, but not consecutive → kept
    ];

    expect(deriveEpisodeMarks(events, ANCHOR_MS)).toEqual([
      { stepLabel: 'scenario', tStartMs: 1_000 },
      { stepLabel: 'editing', tStartMs: 3_000 },
      { stepLabel: 'scenario', tStartMs: 4_000 },
    ]);
  });

  it('drops non-canonical step destinations (context / done / body)', () => {
    const events: DerivableEvent[] = [
      moduleStart(0), // → requirements
      advance('context', 1_000, 'intro'), // non-canonical → dropped
      advance('initial_spec', 2_000, 'context'), // → specification
      advance('done', 3_000, 'body'), // non-canonical → dropped
    ];

    expect(deriveEpisodeMarks(events, ANCHOR_MS)).toEqual([
      { stepLabel: 'requirements', tStartMs: 0 },
      { stepLabel: 'specification', tStartMs: 2_000 },
    ]);
  });

  it('maps a per-scenario retro step to scenario_retro', () => {
    const events: DerivableEvent[] = [
      advance('scenario_2_retro_0', 5_000, 'scenario_2_revise'),
    ];
    expect(deriveEpisodeMarks(events, ANCHOR_MS)).toEqual([
      { stepLabel: 'scenario_retro', tStartMs: 5_000 },
    ]);
  });

  it('ignores non-boundary events and malformed payloads without throwing', () => {
    const events: DerivableEvent[] = [
      { eventType: 'spec_edit', payload: { foo: 1 }, createdAt: new Date(ANCHOR_MS + 1_000).toISOString() },
      { eventType: 'step_advance', payload: null, createdAt: new Date(ANCHOR_MS + 2_000).toISOString() },
      advance('scenario_0_read', 3_000),
    ];
    expect(deriveEpisodeMarks(events, ANCHOR_MS)).toEqual([
      { stepLabel: 'scenario', tStartMs: 3_000 },
    ]);
  });

  it('returns no marks for an empty event list', () => {
    expect(deriveEpisodeMarks([], ANCHOR_MS)).toEqual([]);
  });
});
