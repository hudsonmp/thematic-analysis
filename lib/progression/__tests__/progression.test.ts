import { describe, expect, it } from 'vitest';
import {
  buildSteps,
  diffEntities,
  orderSnapshots,
  stepCount,
  type PhaseSnapshot,
} from '@/lib/progression/progression';

const E = (name: string, elements: string[] = []) => ({
  id: name.trim() || 'x',
  name,
  elements: elements.map((n) => ({ id: n, name: n })),
});

const snap = (over: Partial<PhaseSnapshot>): PhaseSnapshot => ({
  phase: 'initial',
  scenarioIdx: null,
  spec: '',
  entities: [],
  clientTs: '2026-06-21T15:00:00Z',
  createdAt: '2026-06-21T15:00:00Z',
  ...over,
});

describe('orderSnapshots', () => {
  it('dedupes to the LATEST row per (phase, scenarioIdx) by clientTs', () => {
    const rows = [
      snap({ phase: 'initial', spec: 'old', clientTs: '2026-06-21T15:00:00Z' }),
      snap({ phase: 'initial', spec: 'newer', clientTs: '2026-06-21T15:05:00Z' }),
    ];
    const out = orderSnapshots(rows);
    expect(out).toHaveLength(1);
    expect(out[0].spec).toBe('newer');
  });

  it('orders by slot ordinal (scenario_idx), NOT clientTs — the non-monotonic user', () => {
    const rows = [
      snap({ phase: 'after_scenario', scenarioIdx: 2, spec: 's2', clientTs: '2026-06-21T16:00:00Z' }),
      snap({ phase: 'after_scenario', scenarioIdx: 1, spec: 's1', clientTs: '2026-06-21T16:30:00Z' }),
      snap({ phase: 'initial', spec: 'req', clientTs: '2026-06-21T15:00:00Z' }),
    ];
    expect(orderSnapshots(rows).map((r) => r.spec)).toEqual(['req', 's1', 's2']);
  });

  it('falls back to createdAt when clientTs is null', () => {
    const rows = [
      snap({ spec: 'a', clientTs: null, createdAt: '2026-06-21T15:00:00Z' }),
      snap({ spec: 'b', clientTs: null, createdAt: '2026-06-21T15:10:00Z' }),
    ];
    expect(orderSnapshots(rows)[0].spec).toBe('b');
  });

  it('tie on clientTs: newer createdAt wins deterministically regardless of input order', () => {
    const a = snap({ spec: 'older-created', clientTs: '2026-06-21T15:00:00Z', createdAt: '2026-06-21T15:00:01Z' });
    const b = snap({ spec: 'newer-created', clientTs: '2026-06-21T15:00:00Z', createdAt: '2026-06-21T15:00:02Z' });
    expect(orderSnapshots([a, b]).map((r) => r.spec)).toEqual(['newer-created']);
    expect(orderSnapshots([b, a]).map((r) => r.spec)).toEqual(['newer-created']);
  });

  it('mixed dedupe: later {clientTs:null, newer createdAt} beats earlier {older clientTs} (best-available timestamp)', () => {
    const rows = [
      snap({ spec: 'older-client', clientTs: '2026-06-21T15:00:00Z', createdAt: '2026-06-21T15:00:00Z' }),
      snap({ spec: 'newer-created', clientTs: null, createdAt: '2026-06-21T15:10:00Z' }),
    ];
    expect(orderSnapshots(rows)[0].spec).toBe('newer-created');
  });

  it('non-null but unparseable clientTs falls back to createdAt (not -Infinity)', () => {
    const rows = [
      snap({ spec: 'valid', clientTs: '2026-06-21T15:10:00Z', createdAt: '2026-06-21T15:10:00Z' }),
      snap({ spec: 'garbage-ts', clientTs: 'not-a-date', createdAt: '2026-06-21T15:20:00Z' }),
    ];
    expect(orderSnapshots(rows)[0].spec).toBe('garbage-ts');
  });
});

describe('buildSteps', () => {
  const full = [
    snap({ phase: 'initial', spec: 'v0' }),
    snap({ phase: 'after_scenario', scenarioIdx: 0, spec: 'v1', entities: [E('Vehicle ')] }),
    snap({ phase: 'after_scenario', scenarioIdx: 1, spec: 'v2', entities: [E('Vehicle'), E('Rider')] }),
    snap({ phase: 'after_scenario', scenarioIdx: 2, spec: 'v3', entities: [E('Rider')] }),
    snap({ phase: 'after_scenario', scenarioIdx: 3, spec: 'v4', entities: [E('Rider')] }),
    snap({ phase: 'final', spec: 'v4', entities: [E('Rider')] }),
  ];

  it('produces exactly 5 steps with 1-based scenario labels; final → submitted badge', () => {
    const steps = buildSteps(full);
    expect(steps.map((s) => s.label)).toEqual([
      'Requirement', 'Scenario 1', 'Scenario 2', 'Scenario 3', 'Scenario 4',
    ]);
    expect(steps[4].submitted).toBe(true);
    expect(steps.every((s) => s.snapshot !== null)).toBe(true);
  });

  it('truncated tail: missing s3 (+final) → null snapshots, submitted=false', () => {
    const steps = buildSteps(full.slice(0, 4));
    expect(steps[4].snapshot).toBeNull();
    expect(steps[4].submitted).toBe(false);
    expect(steps[3].snapshot?.spec).toBe('v3');
  });

  it('diff is vs the previous NON-NULL step and null on the Requirement step', () => {
    const steps = buildSteps(full);
    expect(steps[0].diff).toBeNull();
    expect(steps[1].diff?.addedEntities).toEqual(['Vehicle']);
    expect(steps[2].diff?.addedEntities).toEqual(['Rider']);
    expect(steps[2].diff?.removedEntities).toEqual([]);
    expect(steps[3].diff?.removedEntities).toEqual(['Vehicle']);
  });

  it('stepCount counts filled step slots (final not a slot)', () => {
    expect(stepCount(full)).toBe(5);
    expect(stepCount(full.slice(0, 4))).toBe(4);
  });

  it('submitted-without-s4: {initial,s0,s1,s2,final} → null Scenario-4 snapshot but submitted=true', () => {
    // The 2-real-user shape: a final flush exists with NO Scenario-4 snapshot.
    // They submitted — they are NOT dropouts.
    const rows = [
      snap({ phase: 'initial', spec: 'v0' }),
      snap({ phase: 'after_scenario', scenarioIdx: 0, spec: 'v1' }),
      snap({ phase: 'after_scenario', scenarioIdx: 1, spec: 'v2' }),
      snap({ phase: 'after_scenario', scenarioIdx: 2, spec: 'v3' }),
      snap({ phase: 'final', spec: 'v3' }),
    ];
    const steps = buildSteps(rows);
    expect(steps[4].snapshot).toBeNull();
    expect(steps[4].submitted).toBe(true);
  });

  it('scenarioIdx=4 row is dropped; does not displace final or flip submitted', () => {
    const rows = [
      ...full,
      snap({ phase: 'after_scenario', scenarioIdx: 4, spec: 'phantom', clientTs: '2026-06-21T17:00:00Z' }),
    ];
    expect(orderSnapshots(rows).some((r) => r.spec === 'phantom')).toBe(false);
    const steps = buildSteps(rows);
    expect(steps).toHaveLength(5);
    expect(steps[4].snapshot?.spec).toBe('v4');
    expect(steps[4].submitted).toBe(true);
  });
});

describe('diffEntities', () => {
  it('matches by TRIMMED name so "Vehicle " == "Vehicle" (no phantom diffs)', () => {
    const d = diffEntities([E('Vehicle ')], [E('Vehicle')]);
    expect(d.addedEntities).toEqual([]);
    expect(d.removedEntities).toEqual([]);
    expect(d.changedEntities).toEqual([]);
  });

  it('reports element-level adds/removes on a persisting entity', () => {
    const d = diffEntities([E('Vehicle', ['Battery'])], [E('Vehicle', ['Battery', 'Location'])]);
    expect(d.changedEntities).toEqual([
      { name: 'Vehicle', addedElements: ['Location'], removedElements: [] },
    ]);
  });

  it('ignores entities whose trimmed name is empty (unmatchable)', () => {
    const d = diffEntities([], [E('  ')]);
    expect(d.addedEntities).toEqual([]);
  });
});
