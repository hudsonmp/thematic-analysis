import { describe, it, expect } from 'vitest';
import type { MyAnnotationView } from '@/app/actions/annotations';
import {
  isPendingId,
  mergePending,
  pendingId,
  resolveAnchorId,
  settleChips,
  type PendingAnchor,
  type PendingChip,
} from '../optimisticCodings';

const anchor = (over: Partial<PendingAnchor> = {}): PendingAnchor => ({
  segmentId: 'seg-1',
  endSegmentId: null,
  charStart: 0,
  charEnd: 10,
  quoteText: 'the quote',
  tStartMs: 5_000,
  tEndMs: 6_000,
  ...over,
});

const ann = (over: Partial<MyAnnotationView> = {}): MyAnnotationView => ({
  id: 'ann-1',
  segmentId: 'seg-1',
  endSegmentId: null,
  charStart: 0,
  charEnd: 10,
  quoteText: 'the quote',
  tStartMs: 5_000,
  tEndMs: 6_000,
  kind: 'code',
  codes: [],
  commentCount: 0,
  createdAt: '2026-08-01T00:00:00.000Z',
  ...over,
});

const chip = (over: Partial<PendingChip> = {}): PendingChip => ({
  id: pendingId('c1'),
  annotationId: 'ann-1',
  mnemonic: 'CREATE',
  anchor: null,
  createdAt: '2026-08-02T00:00:00.000Z',
  ...over,
});

describe('pendingId / isPendingId', () => {
  it('marks client-minted ids apart from database ids', () => {
    expect(isPendingId(pendingId('abc'))).toBe(true);
    expect(isPendingId('9d3f0c2e-0000-4000-8000-000000000000')).toBe(false);
  });
});

describe('resolveAnchorId', () => {
  it('is the identity for an unmapped (already real) id', () => {
    expect(resolveAnchorId({}, 'ann-7')).toBe('ann-7');
  });

  it('follows a pending anchor to the row the server created for it', () => {
    expect(resolveAnchorId({ [pendingId('a')]: 'ann-7' }, pendingId('a'))).toBe('ann-7');
  });

  it('terminates on a cyclic map rather than hanging the render', () => {
    const cyclic = { a: 'b', b: 'a' };
    expect(['a', 'b']).toContain(resolveAnchorId(cyclic, 'a'));
  });
});

describe('mergePending', () => {
  it('returns the server list untouched when nothing is in flight', () => {
    const server = [ann()];
    expect(mergePending(server, [])).toBe(server);
  });

  it('lays a chip over the existing anchor it targets', () => {
    const server = [ann({ codes: [{ id: 'coding-1', mnemonic: 'REVISE' }] })];
    const [merged] = mergePending(server, [chip()]);
    expect(merged.codes.map((c) => c.mnemonic)).toEqual(['REVISE', 'CREATE']);
    // The server row itself is not mutated — the merge is a projection.
    expect(server[0].codes).toHaveLength(1);
  });

  it('shows an anchor gaining its first code as coded, not as a bookmark', () => {
    const server = [ann({ kind: 'bookmark' })];
    expect(mergePending(server, [chip()])[0].kind).toBe('code');
  });

  it('synthesizes an annotation for an anchor the server has not returned yet', () => {
    const merged = mergePending([], [chip({ annotationId: pendingId('a'), anchor: anchor() })]);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe(pendingId('a'));
    expect(merged[0].quoteText).toBe('the quote');
    // Carried from the chip, not read from the clock — the merge is pure.
    expect(merged[0].createdAt).toBe('2026-08-02T00:00:00.000Z');
    expect(merged[0].codes).toEqual([{ id: pendingId('c1'), mnemonic: 'CREATE', actionCoding: undefined }]);
  });

  it('groups every chip on one pending anchor into a single synthetic annotation', () => {
    const merged = mergePending(
      [],
      [
        chip({ id: pendingId('c1'), annotationId: pendingId('a'), anchor: anchor() }),
        chip({ id: pendingId('c2'), annotationId: pendingId('a'), mnemonic: 'TRACE' }),
      ],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].codes.map((c) => c.mnemonic)).toEqual(['CREATE', 'TRACE']);
  });

  it('re-targets chips onto the real row once the anchor write has answered', () => {
    const server = [ann({ id: 'ann-real' })];
    const merged = mergePending(
      server,
      [chip({ annotationId: pendingId('a'), anchor: anchor() })],
      { [pendingId('a')]: 'ann-real' },
    );
    // One annotation, not the real row PLUS a synthetic duplicate of it.
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe('ann-real');
    expect(merged[0].codes).toHaveLength(1);
  });

  it('keys the synthetic annotation by the RESOLVED id, before the refetch lands', () => {
    // The anchor write has answered (pending → ann-real) but the re-list has
    // not. The player looks the anchor up by the id it now holds, so the
    // stand-in has to carry the real id or the next pick mints a second anchor.
    const merged = mergePending(
      [],
      [chip({ annotationId: pendingId('a'), anchor: anchor() })],
      { [pendingId('a')]: 'ann-real' },
    );
    expect(merged[0].id).toBe('ann-real');
  });

  it('discards chips whose anchor is unknown rather than painting a guess', () => {
    // The minting chip was dropped (its write failed); the follow-up chip has no
    // anchor of its own, so there is nothing to render it against.
    expect(mergePending([], [chip({ annotationId: pendingId('a') })])).toEqual([]);
  });

  it('keeps a synthetic annotation in the server list order (by t_start_ms)', () => {
    const server = [ann({ id: 'early', tStartMs: 1_000 }), ann({ id: 'late', tStartMs: 9_000 })];
    const merged = mergePending(
      server,
      [chip({ annotationId: pendingId('a'), anchor: anchor({ tStartMs: 5_000 }) })],
    );
    expect(merged.map((a) => a.id)).toEqual(['early', pendingId('a'), 'late']);
  });
});

describe('settleChips', () => {
  it('drops exactly the settled chips', () => {
    const chips = [chip({ id: pendingId('c1') }), chip({ id: pendingId('c2') })];
    expect(settleChips(chips, [pendingId('c1')]).map((c) => c.id)).toEqual([pendingId('c2')]);
  });

  it('returns the same array reference when nothing settles (no wasted re-render)', () => {
    const chips = [chip()];
    expect(settleChips(chips, [])).toBe(chips);
    expect(settleChips(chips, ['not-a-chip'])).toBe(chips);
  });
});
