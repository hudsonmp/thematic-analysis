import { describe, expect, it } from 'vitest';
import { annotationHasRailCard, cardsByTurn, type RailAnnotation } from '../rail';

describe('annotationHasRailCard', () => {
  const empty = new Set<string>();

  it('shows a card for a quote even with no comments', () => {
    expect(annotationHasRailCard({ id: 'a', segmentId: 's1', kind: 'quote' }, empty)).toBe(true);
  });

  it('shows a card for a commented annotation regardless of kind', () => {
    expect(
      annotationHasRailCard({ id: 'a', segmentId: 's1', kind: 'code' }, new Set(['a'])),
    ).toBe(true);
  });

  it('hides a bare code anchor with no comments', () => {
    expect(annotationHasRailCard({ id: 'a', segmentId: 's1', kind: 'code' }, empty)).toBe(false);
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

  it('buckets cards into their anchor turn', () => {
    const anns: RailAnnotation[] = [
      { id: 'q1', segmentId: 's1', kind: 'quote' },
      { id: 'c1', segmentId: 's2', kind: 'code' }, // has a comment
      { id: 'q2', segmentId: 's3', kind: 'quote' },
    ];
    const map = cardsByTurn(anns, new Set(['c1']), segIndexById, turnIndexBySegIdx);
    expect(map.get(0)?.map((c) => c.annId)).toEqual(['q1', 'c1']);
    expect(map.get(1)?.map((c) => c.annId)).toEqual(['q2']);
  });

  it('omits bare code anchors with no comments', () => {
    const anns: RailAnnotation[] = [{ id: 'c0', segmentId: 's1', kind: 'code' }];
    const map = cardsByTurn(anns, new Set(), segIndexById, turnIndexBySegIdx);
    expect(map.size).toBe(0);
  });

  it('drops an annotation whose start segment is not in the active version', () => {
    const anns: RailAnnotation[] = [{ id: 'q', segmentId: 'gone', kind: 'quote' }];
    const map = cardsByTurn(anns, new Set(), segIndexById, turnIndexBySegIdx);
    expect(map.size).toBe(0);
  });

  it('preserves input order within a turn (playback order)', () => {
    const anns: RailAnnotation[] = [
      { id: 'first', segmentId: 's1', kind: 'quote' },
      { id: 'second', segmentId: 's2', kind: 'quote' },
    ];
    const map = cardsByTurn(anns, new Set(), segIndexById, turnIndexBySegIdx);
    expect(map.get(0)?.map((c) => c.annId)).toEqual(['first', 'second']);
  });
});
