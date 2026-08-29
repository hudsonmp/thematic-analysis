import type { MyAnnotationView } from '@/app/actions/annotations';
import type { ActionCodingView } from '@/lib/actions/schema';

/**
 * optimisticCodings — the coding gesture's latency policy, as pure data.
 *
 * Assigning a code used to be three SERIALIZED server round-trips before the
 * chip appeared: the write, then a full re-list of the version's annotations,
 * then its comments. The coder sat on a dead modal for seconds per code, which
 * is the wrong cost model for an act performed hundreds of times per session —
 * the judgement is already made at the keystroke; the database is bookkeeping.
 *
 * So the write is moved OFF the interaction path. A pick immediately produces a
 * PENDING CHIP here, merged over the server's annotations for rendering, and the
 * real write runs behind it. Two invariants make that safe:
 *
 *   • an anchor is minted at most once. The first pick on a fresh selection
 *     mints a PENDING ANCHOR id; later picks hang off that same id and the
 *     writes are serialized, so the second pick cannot race the first into
 *     creating a second annotation for one span. When the write answers, the
 *     pending id is mapped to the real one and the chips re-target (`resolved`).
 *
 *   • a chip is never rendered twice. Chips settle (leave this list) in the SAME
 *     React batch as the refetch that contains their real rows, so no frame
 *     holds both. The one exception is a refetch triggered by someone else's
 *     realtime event landing between our write and our settle — a sub-second
 *     double chip, which we accept rather than pay for a client/server identity
 *     scheme that only exists to police it.
 *
 * Pure and player-agnostic on purpose: the merge is the part that can be wrong
 * in ways the eye cannot catch (dropped chip, duplicated chip, lost ordering),
 * so it is tested here rather than inline in a 4700-line component.
 */

const PENDING_PREFIX = 'pending:';

/** A client-minted id, distinguishable from any database id at a glance. */
export function pendingId(token: string): string {
  return `${PENDING_PREFIX}${token}`;
}

/** Is this an optimistic id (an anchor or a chip that the server has not seen)? */
export function isPendingId(id: string): boolean {
  return id.startsWith(PENDING_PREFIX);
}

/** What a not-yet-written anchor needs in order to paint. */
export type PendingAnchor = {
  segmentId: string;
  endSegmentId: string | null;
  charStart: number;
  charEnd: number;
  quoteText: string | null;
  tStartMs: number;
  tEndMs: number;
};

/** One code/action applied in the UI whose row is still in flight. */
export type PendingChip = {
  /** The optimistic coding id — the chip's React key until the server answers. */
  id: string;
  /** The anchor it hangs on: a real annotation id, or a pending anchor id. */
  annotationId: string;
  /** The label to show now (the refetch replaces it with the server's). */
  mnemonic: string;
  /** ACTION layer: the composition, so the chip expands like a real one. */
  actionCoding?: ActionCodingView;
  /** Set only on the chip that MINTED a pending anchor — what to paint until
   *  the annotation row exists. Chips added to an existing anchor leave it null. */
  anchor: PendingAnchor | null;
  /** When the coder picked it. Carried rather than read from the clock at merge
   *  time so the merge stays a pure function of its inputs. */
  createdAt: string;
};

/** pending anchor id → the real annotation id, once its write has answered. */
export type ResolvedAnchors = Record<string, string>;

/** Follow a pending anchor id to the real one (identity for ids already real). */
export function resolveAnchorId(resolved: ResolvedAnchors, id: string): string {
  let cur = id;
  // A chain longer than one hop cannot happen (a real id is never a key), but a
  // cycle in corrupt state must not hang the render.
  for (let i = 0; i < 4; i++) {
    const next = resolved[cur];
    if (next === undefined || next === cur) return cur;
    cur = next;
  }
  return cur;
}

/**
 * The annotations to RENDER: the server's, with every pending chip laid over
 * the anchor it belongs to, and a synthetic annotation for each anchor that
 * does not exist server-side yet.
 *
 * An anchor that gains a chip renders as kind 'code' — assigning onto a
 * bookmark is what resolves it, and the coder should see that immediately
 * rather than after the round-trip that promotes it server-side.
 */
export function mergePending(
  server: MyAnnotationView[],
  pending: PendingChip[],
  resolved: ResolvedAnchors = {},
): MyAnnotationView[] {
  if (pending.length === 0) return server;

  const byAnchor = new Map<string, PendingChip[]>();
  for (const chip of pending) {
    const key = resolveAnchorId(resolved, chip.annotationId);
    byAnchor.set(key, [...(byAnchor.get(key) ?? []), chip]);
  }

  const out = server.map((ann) => {
    const chips = byAnchor.get(ann.id);
    if (!chips) return ann;
    byAnchor.delete(ann.id);
    return { ...ann, kind: 'code', codes: [...ann.codes, ...chips.map(toCode)] };
  });

  // Whatever is left targets an anchor the server has not returned yet: either
  // still being written, or (if its write failed and its minting chip was
  // dropped) nothing we can paint — those chips are discarded, not guessed at.
  let synthesized = false;
  for (const [annotationId, chips] of byAnchor) {
    const minted = chips.find((c) => c.anchor);
    const anchor = minted?.anchor;
    if (!anchor) continue;
    synthesized = true;
    out.push({
      id: annotationId,
      segmentId: anchor.segmentId,
      endSegmentId: anchor.endSegmentId,
      charStart: anchor.charStart,
      charEnd: anchor.charEnd,
      quoteText: anchor.quoteText,
      tStartMs: anchor.tStartMs,
      tEndMs: anchor.tEndMs,
      kind: 'code',
      codes: chips.map(toCode),
      commentCount: 0,
      createdAt: minted.createdAt,
    });
  }

  // The server lists by (t_start_ms, id); a synthetic row has to land in that
  // order or the gutter packs it against the wrong turn. Array.sort is stable,
  // so the server's id tie-break survives.
  return synthesized ? [...out].sort((a, b) => a.tStartMs - b.tStartMs) : out;
}

function toCode(chip: PendingChip): MyAnnotationView['codes'][number] {
  return { id: chip.id, mnemonic: chip.mnemonic, actionCoding: chip.actionCoding };
}

/** Drop the chips whose rows have arrived (or whose writes failed). */
export function settleChips(pending: PendingChip[], ids: string[]): PendingChip[] {
  if (ids.length === 0) return pending;
  const drop = new Set(ids);
  const kept = pending.filter((c) => !drop.has(c.id));
  return kept.length === pending.length ? pending : kept;
}
