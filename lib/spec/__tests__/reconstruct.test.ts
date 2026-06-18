import { describe, it, expect } from 'vitest';
import { specStateAt, type SpecTimeline } from '../reconstruct';
import type { Entity } from '../reconstruct';

// A fixed clock. Edit `createdAt`s are placed at known absolute instants so the
// last-write-≤-t resolution reads off the wall clock by inspection. `atMs` is an
// absolute epoch instant (the caller passes `anchorMs + playheadMs`), so the test
// queries with absolute instants too.
const T0 = Date.parse('2026-06-12T16:37:00.000Z');
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

/** Build a SpecTimeline from offset-keyed spec/entity edits (ms from T0). */
const timeline = (
  specEdits: { offsetMs: number; value: string }[],
  entityEdits: { offsetMs: number; value: string }[],
): SpecTimeline => ({
  specEdits: specEdits.map((e) => ({ createdAt: at(e.offsetMs), value: e.value })),
  entityEdits: entityEdits.map((e) => ({ createdAt: at(e.offsetMs), value: e.value })),
});

const ENT: Entity[] = [
  {
    id: 'e1',
    name: 'Vehicle',
    elements: [
      { id: 'el1', name: 'color' },
      { id: 'el2', name: 'capacity' },
    ],
  },
  { id: 'e2', name: 'Rider', elements: [] },
];

describe('specStateAt — spec stream (last write ≤ t)', () => {
  it('returns the LAST spec edit at or before t', () => {
    const tl = timeline(
      [
        { offsetMs: 1_000, value: 'spec v1' },
        { offsetMs: 3_000, value: 'spec v2' },
        { offsetMs: 5_000, value: 'spec v3' },
      ],
      [],
    );
    // At t = 4s, the latest spec ≤ t is v2 (3s); v3 (5s) is in the future.
    expect(specStateAt(tl, T0 + 4_000).spec).toBe('spec v2');
  });

  it('before the first spec edit → empty string', () => {
    const tl = timeline([{ offsetMs: 5_000, value: 'spec v1' }], []);
    expect(specStateAt(tl, T0 + 1_000).spec).toBe('');
  });

  it('an exactly-on-boundary instant is INCLUSIVE (≤, not <)', () => {
    const tl = timeline(
      [
        { offsetMs: 2_000, value: 'spec early' },
        { offsetMs: 4_000, value: 'spec boundary' },
      ],
      [],
    );
    // Querying exactly at the 4s edit must see it (inclusive).
    expect(specStateAt(tl, T0 + 4_000).spec).toBe('spec boundary');
  });
});

describe('specStateAt — entities stream (last write ≤ t)', () => {
  it('returns the LAST entities edit at or before t, JSON.parsed', () => {
    const tl = timeline(
      [],
      [
        { offsetMs: 1_000, value: JSON.stringify([]) },
        { offsetMs: 3_000, value: JSON.stringify(ENT) },
      ],
    );
    expect(specStateAt(tl, T0 + 4_000).entities).toEqual(ENT);
  });

  it('round-trips nested elements through JSON.parse', () => {
    const tl = timeline([], [{ offsetMs: 1_000, value: JSON.stringify(ENT) }]);
    const out = specStateAt(tl, T0 + 2_000).entities;
    expect(out).toEqual(ENT);
    // nested elements survive
    expect(out[0].elements).toEqual([
      { id: 'el1', name: 'color' },
      { id: 'el2', name: 'capacity' },
    ]);
  });

  it('before the first entities edit → empty array', () => {
    const tl = timeline([], [{ offsetMs: 5_000, value: JSON.stringify(ENT) }]);
    expect(specStateAt(tl, T0 + 1_000).entities).toEqual([]);
  });

  it('an exactly-on-boundary entities instant is INCLUSIVE', () => {
    const tl = timeline(
      [],
      [
        { offsetMs: 2_000, value: JSON.stringify([]) },
        { offsetMs: 4_000, value: JSON.stringify(ENT) },
      ],
    );
    expect(specStateAt(tl, T0 + 4_000).entities).toEqual(ENT);
  });

  it('malformed entities JSON → [] (never throws)', () => {
    const tl = timeline([], [{ offsetMs: 1_000, value: '{not valid json' }]);
    expect(() => specStateAt(tl, T0 + 2_000)).not.toThrow();
    expect(specStateAt(tl, T0 + 2_000).entities).toEqual([]);
  });

  it('non-array (but valid) entities JSON → [] (shape guard)', () => {
    const tl = timeline([], [{ offsetMs: 1_000, value: JSON.stringify({ id: 'x' }) }]);
    expect(specStateAt(tl, T0 + 2_000).entities).toEqual([]);
  });
});

describe('specStateAt — both streams together', () => {
  it('resolves spec and entities independently at the same t', () => {
    const tl = timeline(
      [
        { offsetMs: 1_000, value: 'spec A' },
        { offsetMs: 6_000, value: 'spec B' },
      ],
      [
        { offsetMs: 2_000, value: JSON.stringify([]) },
        { offsetMs: 4_000, value: JSON.stringify(ENT) },
      ],
    );
    // At t = 5s: spec = A (last ≤ 5s, since B is at 6s); entities = ENT (4s).
    const out = specStateAt(tl, T0 + 5_000);
    expect(out.spec).toBe('spec A');
    expect(out.entities).toEqual(ENT);
  });

  it('empty timeline → { spec: "", entities: [] }', () => {
    const out = specStateAt({ specEdits: [], entityEdits: [] }, T0 + 10_000);
    expect(out).toEqual({ spec: '', entities: [] });
  });

  it('before BOTH first edits → { spec: "", entities: [] }', () => {
    const tl = timeline(
      [{ offsetMs: 5_000, value: 'spec' }],
      [{ offsetMs: 5_000, value: JSON.stringify(ENT) }],
    );
    expect(specStateAt(tl, T0 + 1_000)).toEqual({ spec: '', entities: [] });
  });
});
