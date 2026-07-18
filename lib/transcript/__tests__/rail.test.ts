import { describe, expect, it } from 'vitest';
import { annotationHasRailCard, cardsByTurn, type RailAnnotation } from '../rail';

describe('annotationHasRailCard', () => {
  const empty = new Set<string>();

  it('shows an entry for a commented annotation', () => {
    expect(
      annotationHasRailCard({ id: 'a', segmentId: 's1' }, new Set(['a'])),
    ).toBe(true);
  });

  it('hides a bare quote with no notes — its yellow span is its presence', () => {
    // Marginalia ARE the notes: an empty entry beside a quote would be chrome
    // saying nothing. The span still opens the thread (with the add-note line).
    expect(annotationHasRailCard({ id: 'q', segmentId: 's1' }, empty)).toBe(false);
  });

  it('hides a bare code anchor with no notes', () => {
    expect(annotationHasRailCard({ id: 'a', segmentId: 's1' }, empty)).toBe(false);
  });
});

describe('cardsByTurn', () => {
  // Segments s1,s2 → turn 0; s3 → turn 1.
  const segIndexById = new Map([
    ['s1', 0],
    ['s2', 1],
    ['s3', 2],
  ]);
  const turnIndexBySegIdx = new Map([
    [0, 0],
    [1, 0],
    [2, 1],
  ]);

  it('buckets commented annotations into their anchor turn', () => {
    const anns: RailAnnotation[] = [
      { id: 'q1', segmentId: 's1' },
      { id: 'c1', segmentId: 's2' },
      { id: 'q2', segmentId: 's3' },
    ];
    const map = cardsByTurn(
      anns,
      new Set(['q1', 'c1', 'q2']),
      segIndexById,
      turnIndexBySegIdx,
    );
    expect(map.get(0)?.map((c) => c.annId)).toEqual(['q1', 'c1']);
    expect(map.get(1)?.map((c) => c.annId)).toEqual(['q2']);
  });

  it('omits annotations with no notes (bare quotes and bare code anchors alike)', () => {
    const anns: RailAnnotation[] = [
      { id: 'c0', segmentId: 's1' },
      { id: 'q0', segmentId: 's2' },
    ];
    const map = cardsByTurn(anns, new Set(), segIndexById, turnIndexBySegIdx);
    expect(map.size).toBe(0);
  });

  it('drops an annotation whose start segment is not in the active version', () => {
    const anns: RailAnnotation[] = [{ id: 'q', segmentId: 'gone' }];
    const map = cardsByTurn(anns, new Set(['q']), segIndexById, turnIndexBySegIdx);
    expect(map.size).toBe(0);
  });

  it('preserves input order within a turn (playback order)', () => {
    const anns: RailAnnotation[] = [
      { id: 'first', segmentId: 's1' },
      { id: 'second', segmentId: 's2' },
    ];
    const map = cardsByTurn(
      anns,
      new Set(['first', 'second']),
      segIndexById,
      turnIndexBySegIdx,
    );
    expect(map.get(0)?.map((c) => c.annId)).toEqual(['first', 'second']);
  });
});
