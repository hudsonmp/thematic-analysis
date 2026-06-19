import { describe, expect, it } from 'vitest';
import {
  currentScenarioIdx,
  retroPersistDecision,
  retroQuestionsAt,
  RETRO_NOT_DELIVERED_MSG,
  type RetroQuestionRow,
} from '@/lib/live/retro';

describe('retroPersistDecision (gate persistence on actual delivery)', () => {
  it('persists with no error when the broadcast DELIVERED', () => {
    expect(retroPersistDecision(true)).toEqual({ persist: true, error: null });
  });

  it('does NOT persist and surfaces the not-delivered error when undelivered', () => {
    // Covers BOTH the pushBusy early-return and a caught send/subscribe error:
    // onPush returns false in either case → no phantom "asked" row is written.
    expect(retroPersistDecision(false)).toEqual({
      persist: false,
      error: RETRO_NOT_DELIVERED_MSG,
    });
  });

  it('never reports persist:true alongside an error (mutually exclusive branch)', () => {
    for (const delivered of [true, false]) {
      const d = retroPersistDecision(delivered);
      expect(d.persist).toBe(d.error === null);
    }
  });
});

describe('currentScenarioIdx (live sender default target)', () => {
  it('returns null before any scenario has been entered', () => {
    expect(currentScenarioIdx({ scenarios: [] })).toBeNull();
    expect(currentScenarioIdx({ requirements: 1000, scenarios: [] })).toBeNull();
  });

  it('returns the HIGHEST entered scenario index (the current one)', () => {
    // scenarios 0 and 1 entered → current is 1.
    expect(currentScenarioIdx({ scenarios: [1000, 2000] })).toBe(1);
    // only scenario 0 entered.
    expect(currentScenarioIdx({ scenarios: [1000] })).toBe(0);
  });

  it('skips sparse / unentered slots and returns the last defined index', () => {
    // index 0 unentered (undefined), index 2 entered → current is 2.
    expect(
      currentScenarioIdx({ scenarios: [undefined, undefined, 5000] }),
    ).toBe(2);
  });

  it('is robust to a missing scenarios array', () => {
    // Defensive: a malformed input must not throw.
    expect(
      currentScenarioIdx({ scenarios: undefined as unknown as (number | undefined)[] }),
    ).toBeNull();
  });
});

describe('retroQuestionsAt (spec-mode display, gated on the playhead)', () => {
  // anchor t=0; offsets are createdAt - anchor.
  const anchorMs = 1_000_000;
  const rows: RetroQuestionRow[] = [
    {
      id: 'a',
      body: 'Why did you add that entity?',
      retroQuestionScenarioIdx: 0,
      createdAt: new Date(anchorMs + 10_000).toISOString(), // +10s
    },
    {
      id: 'b',
      body: 'What was unclear in scenario 2?',
      retroQuestionScenarioIdx: 1,
      createdAt: new Date(anchorMs + 30_000).toISOString(), // +30s
    },
    // A non-retro observation (idx null) must be ignored entirely.
    {
      id: 'c',
      body: 'a plain note',
      retroQuestionScenarioIdx: null,
      createdAt: new Date(anchorMs + 5_000).toISOString(),
    },
  ];

  it('returns only retro-question rows asked AT or BEFORE the playhead', () => {
    // playhead at +20s → only the +10s question is "already asked".
    const out = retroQuestionsAt(rows, anchorMs, 20_000);
    expect(out.map((r) => r.id)).toEqual(['a']);
    expect(out[0].scenarioIdx).toBe(0);
    expect(out[0].offsetMs).toBe(10_000);
  });

  it('includes a question asked exactly at the playhead instant', () => {
    const out = retroQuestionsAt(rows, anchorMs, 10_000);
    expect(out.map((r) => r.id)).toEqual(['a']);
  });

  it('returns all asked questions time-ordered when the playhead is past them', () => {
    const out = retroQuestionsAt(rows, anchorMs, 60_000);
    expect(out.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('ignores rows whose retro_question_scenario_idx is null (not a retro row)', () => {
    const out = retroQuestionsAt(rows, anchorMs, 60_000);
    expect(out.find((r) => r.id === 'c')).toBeUndefined();
  });

  it('clamps pre-recording questions to offset 0 (still shown)', () => {
    const preRows: RetroQuestionRow[] = [
      {
        id: 'pre',
        body: 'asked before record start',
        retroQuestionScenarioIdx: 2,
        createdAt: new Date(anchorMs - 5_000).toISOString(), // before anchor
      },
    ];
    const out = retroQuestionsAt(preRows, anchorMs, 0);
    expect(out.map((r) => r.id)).toEqual(['pre']);
    expect(out[0].offsetMs).toBe(0);
  });

  it('returns nothing when the anchor is null (cannot place on the timeline)', () => {
    expect(retroQuestionsAt(rows, null, 60_000)).toEqual([]);
  });

  it('drops rows with an unparseable createdAt without throwing', () => {
    const bad: RetroQuestionRow[] = [
      {
        id: 'bad',
        body: 'q',
        retroQuestionScenarioIdx: 0,
        createdAt: 'not-a-date',
      },
    ];
    expect(retroQuestionsAt(bad, anchorMs, 60_000)).toEqual([]);
  });
});
