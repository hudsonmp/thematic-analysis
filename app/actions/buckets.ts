'use server';

import { cbFrom } from '@/lib/supabase/guard';
import { requireEditor } from '@/lib/auth/roles';
import { requireAuthUser } from '@/lib/auth/supabase-auth';
import {
  resolveFork,
  serializeSnapshot,
  type BucketMember,
  type DefItem,
  type ForkDelta,
} from '@/lib/codebook/combinatorial';
import type { Json } from '@/lib/types/cb-db';

/**
 * Modular buckets + per-coder forks + snapshots (combinatorial codebook v2).
 *
 * The modular bucket is the shared canonical; a coder's fork is an overlay
 * (fork = modular + Δ). Pull is AUTOMATIC for any attribute not in Δ because
 * the effective view is computed at read time (resolveFork); the explicit
 * "batch pull" records the member list into Δ.seen — the deletion detector —
 * and cuts a snapshot. Push (double-confirmed in the UI) mutates the modular
 * bucket, clears the pushed attrs from the pusher's Δ, cuts a snapshot, and
 * logs; conflicts are last-write-wins at modular, visible in the event log.
 *
 * All writes go through cbFrom (cb_ prefix guard) after requireEditor; fork
 * rows are additionally pinned to the caller's uid app-side (service role
 * bypasses RLS, so the .eq/insert owner scoping here is the real gate).
 */

// ---------------------------------------------------------------------------
// Types the UI consumes
// ---------------------------------------------------------------------------

export type BucketView = {
  id: string;
  name: string;
  caption: string | null;
  /** Effective members under MY fork (modular when I have no fork). */
  members: BucketMember[];
  /** Modular members (the canonical list — subsumption parent-side view). */
  modularMembers: BucketMember[];
  /** My Δ, null when I code straight off the modular bucket. */
  myDelta: ForkDelta | null;
  /** Members deleted at modular since my last pull (never auto-pulled). */
  pendingDeletions: BucketMember[];
};

export type CombinatorialContext = {
  buckets: BucketView[];
  /** code id → ordered AND items (present ⇔ combinatorial). */
  defs: Record<string, DefItem[]>;
  latestSnapshotId: string | null;
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

type ItemRow = {
  id: string;
  code_id: string;
  bucket_id: string | null;
  singleton_code_id: string | null;
  position: number;
  interchange_group: number | null;
};

function toDefItem(r: ItemRow): DefItem {
  return r.bucket_id !== null
    ? { id: r.id, position: r.position, interchangeGroup: r.interchange_group, kind: 'bucket', bucketId: r.bucket_id }
    : {
        id: r.id,
        position: r.position,
        interchangeGroup: r.interchange_group,
        kind: 'singleton',
        codeId: r.singleton_code_id!,
      };
}

/** Everything the coding popup + bucket manager need, in one call. */
export async function getCombinatorialContext(codebookId: string): Promise<CombinatorialContext> {
  const user = await requireAuthUser();

  const [bucketsRes, membersRes, forksRes, itemsRes, snapRes] = await Promise.all([
    cbFrom('cb_buckets').select('*').eq('codebook_id', codebookId).order('name'),
    cbFrom('cb_bucket_codes').select('*').order('position'),
    cbFrom('cb_bucket_forks').select('*').eq('owner_id', user.id),
    cbFrom('cb_code_bucket_items').select('*').order('position'),
    cbFrom('cb_codebook_snapshots')
      .select('id, seq')
      .eq('codebook_id', codebookId)
      .order('seq', { ascending: false })
      .limit(1),
  ]);
  const err = bucketsRes.error || membersRes.error || forksRes.error || itemsRes.error || snapRes.error;
  if (err) throw new Error(`getCombinatorialContext failed: ${err.message}`);

  const bucketRows = bucketsRes.data ?? [];
  const bucketIds = new Set(bucketRows.map((b) => b.id));
  const membersByBucket = new Map<string, BucketMember[]>();
  for (const m of membersRes.data ?? []) {
    if (!bucketIds.has(m.bucket_id)) continue;
    const arr = membersByBucket.get(m.bucket_id) ?? [];
    arr.push({ codeId: m.code_id, mandatory: m.mandatory });
    membersByBucket.set(m.bucket_id, arr);
  }
  const deltaByBucket = new Map<string, ForkDelta>();
  for (const f of forksRes.data ?? []) {
    if (bucketIds.has(f.bucket_id)) deltaByBucket.set(f.bucket_id, (f.delta ?? {}) as ForkDelta);
  }

  const buckets: BucketView[] = bucketRows.map((b) => {
    const modularMembers = membersByBucket.get(b.id) ?? [];
    const delta = deltaByBucket.get(b.id) ?? null;
    const eff = resolveFork(
      { id: b.id, name: b.name, caption: b.caption, members: modularMembers },
      delta,
    );
    return {
      id: b.id,
      name: b.name,
      caption: eff.caption,
      members: eff.members,
      modularMembers,
      myDelta: delta,
      pendingDeletions: eff.pendingDeletions,
    };
  });

  // Defs: restrict to codes of this codebook's buckets OR any code with items.
  const defs: Record<string, DefItem[]> = {};
  for (const r of (itemsRes.data ?? []) as ItemRow[]) {
    (defs[r.code_id] ??= []).push(toDefItem(r));
  }
  for (const k of Object.keys(defs)) defs[k].sort((a, b) => a.position - b.position);

  return { buckets, defs, latestSnapshotId: snapRes.data?.[0]?.id ?? null };
}

// ---------------------------------------------------------------------------
// Modular bucket CRUD (direct editing of the canonical; forks pull it
// automatically unless overridden)
// ---------------------------------------------------------------------------

export async function upsertBucket(input: {
  codebookId: string;
  id?: string;
  name: string;
  caption?: string | null;
}): Promise<string> {
  await requireEditor();
  const user = await requireAuthUser();
  const name = input.name.trim();
  if (!name) throw new Error('upsertBucket: name is required');

  if (input.id) {
    const res = await cbFrom('cb_buckets')
      .update({ name, caption: input.caption ?? null })
      .eq('id', input.id)
      .select('id')
      .single();
    if (res.error) throw new Error(`upsertBucket failed: ${res.error.message}`);
    await logEvent('bucket_modular_edit', { bucketId: input.id, name });
    return res.data.id;
  }
  const res = await cbFrom('cb_buckets')
    .insert({ codebook_id: input.codebookId, name, caption: input.caption ?? null, created_by: user.id })
    .select('id')
    .single();
  if (res.error) throw new Error(`upsertBucket failed: ${res.error.message}`);
  await logEvent('bucket_created', { bucketId: res.data.id, name });
  return res.data.id;
}

/** Delete a modular bucket. Refused while any combinatorial definition
 *  references it — deleting a slot out from under a parent is the
 *  empty-bucket/out-of-grammar configuration the spec rejects. */
export async function deleteBucket(bucketId: string): Promise<void> {
  await requireEditor();
  const refs = await cbFrom('cb_code_bucket_items').select('id').eq('bucket_id', bucketId).limit(1);
  if (refs.error) throw new Error(`deleteBucket failed: ${refs.error.message}`);
  if ((refs.data ?? []).length > 0) {
    throw new Error('deleteBucket: bucket is referenced by a combinatorial code — detach it there first.');
  }
  const res = await cbFrom('cb_buckets').delete().eq('id', bucketId);
  if (res.error) throw new Error(`deleteBucket failed: ${res.error.message}`);
  await logEvent('bucket_deleted', { bucketId });
}

/** Replace the MODULAR member list (position-ordered, mandatory flags). */
export async function setBucketMembers(
  bucketId: string,
  members: { codeId: string; mandatory: boolean }[],
): Promise<void> {
  await requireEditor();
  const del = await cbFrom('cb_bucket_codes').delete().eq('bucket_id', bucketId);
  if (del.error) throw new Error(`setBucketMembers failed: ${del.error.message}`);
  if (members.length) {
    const ins = await cbFrom('cb_bucket_codes').insert(
      members.map((m, i) => ({ bucket_id: bucketId, code_id: m.codeId, mandatory: m.mandatory, position: i })),
    );
    if (ins.error) throw new Error(`setBucketMembers failed: ${ins.error.message}`);
  }
  await logEvent('bucket_members_set', { bucketId, members });
}

// ---------------------------------------------------------------------------
// Forks
// ---------------------------------------------------------------------------

/** Upsert MY fork's Δ for a bucket. Owner scoping is app-side (service role). */
export async function saveMyForkDelta(bucketId: string, delta: ForkDelta): Promise<void> {
  await requireEditor();
  const user = await requireAuthUser();
  const res = await cbFrom('cb_bucket_forks').upsert(
    {
      bucket_id: bucketId,
      owner_id: user.id,
      delta: delta as unknown as Json,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'bucket_id,owner_id' },
  );
  if (res.error) throw new Error(`saveMyForkDelta failed: ${res.error.message}`);
}

/**
 * PUSH my fork to the modular bucket (UI double-confirms first). Applies my Δ's
 * addedCodes / mandatoryOverrides / caption to modular, clears them from my Δ
 * (they are now the canonical), refreshes Δ.seen, cuts a 'push' snapshot, and
 * logs prior modular state (last-write-wins is visible, not silent).
 */
export async function pushForkToModular(codebookId: string, bucketId: string): Promise<void> {
  await requireEditor();
  const user = await requireAuthUser();

  const [bRes, mRes, fRes] = await Promise.all([
    cbFrom('cb_buckets').select('*').eq('id', bucketId).single(),
    cbFrom('cb_bucket_codes').select('*').eq('bucket_id', bucketId).order('position'),
    cbFrom('cb_bucket_forks').select('*').eq('bucket_id', bucketId).eq('owner_id', user.id).maybeSingle(),
  ]);
  if (bRes.error || mRes.error || fRes.error) {
    throw new Error(`pushForkToModular failed: ${(bRes.error || mRes.error || fRes.error)!.message}`);
  }
  if (!fRes.data) throw new Error('pushForkToModular: you have no fork on this bucket.');
  const delta = (fRes.data.delta ?? {}) as ForkDelta;
  const modularMembers: BucketMember[] = (mRes.data ?? []).map((x) => ({
    codeId: x.code_id,
    mandatory: x.mandatory,
  }));

  // Snapshot BEFORE the push (mandated boundary).
  await cutSnapshot(codebookId, 'push');

  // Apply: caption + member adds + mandatory flips.
  const priorState = { caption: bRes.data.caption, members: modularMembers };
  if (delta.caption !== undefined) {
    const up = await cbFrom('cb_buckets').update({ caption: delta.caption }).eq('id', bucketId);
    if (up.error) throw new Error(`pushForkToModular failed: ${up.error.message}`);
  }
  const overrides = delta.mandatoryOverrides ?? {};
  for (const [codeId, mandatory] of Object.entries(overrides)) {
    const up = await cbFrom('cb_bucket_codes')
      .update({ mandatory })
      .eq('bucket_id', bucketId)
      .eq('code_id', codeId);
    if (up.error) throw new Error(`pushForkToModular failed: ${up.error.message}`);
  }
  const existing = new Set(modularMembers.map((x) => x.codeId));
  const adds = (delta.addedCodes ?? []).filter((a) => !existing.has(a.codeId));
  if (adds.length) {
    const ins = await cbFrom('cb_bucket_codes').insert(
      adds.map((a, i) => ({
        bucket_id: bucketId,
        code_id: a.codeId,
        mandatory: a.mandatory,
        position: modularMembers.length + i,
      })),
    );
    if (ins.error) throw new Error(`pushForkToModular failed: ${ins.error.message}`);
  }

  // My Δ shrinks to what stays fork-local (removals) + refreshed seen.
  const nextSeen = [
    ...modularMembers.map((x) => ({
      codeId: x.codeId,
      mandatory: overrides[x.codeId] ?? x.mandatory,
    })),
    ...adds,
  ];
  const nextDelta: ForkDelta = {
    ...(delta.removedCodeIds?.length ? { removedCodeIds: delta.removedCodeIds } : {}),
    seen: nextSeen,
  };
  await saveMyForkDelta(bucketId, nextDelta);

  await logEvent('bucket_push', { bucketId, by: user.id, pushed: delta, prior: priorState });
}

/**
 * BATCH PULL all my forks in a codebook (between coding sessions): refresh
 * every Δ.seen to the current modular member list (deletion flags derive from
 * the gap), cut a 'pull' snapshot, log. Overridden attributes stay fork-local.
 */
export async function batchPullMyForks(codebookId: string): Promise<{ pulled: number }> {
  await requireEditor();
  const user = await requireAuthUser();

  const [bucketsRes, membersRes, forksRes] = await Promise.all([
    cbFrom('cb_buckets').select('id').eq('codebook_id', codebookId),
    cbFrom('cb_bucket_codes').select('*'),
    cbFrom('cb_bucket_forks').select('*').eq('owner_id', user.id),
  ]);
  if (bucketsRes.error || membersRes.error || forksRes.error) {
    throw new Error(
      `batchPullMyForks failed: ${(bucketsRes.error || membersRes.error || forksRes.error)!.message}`,
    );
  }
  const inBook = new Set((bucketsRes.data ?? []).map((b) => b.id));
  const byBucket = new Map<string, BucketMember[]>();
  for (const m of membersRes.data ?? []) {
    if (!inBook.has(m.bucket_id)) continue;
    (byBucket.get(m.bucket_id) ?? byBucket.set(m.bucket_id, []).get(m.bucket_id)!).push({
      codeId: m.code_id,
      mandatory: m.mandatory,
    });
  }

  await cutSnapshot(codebookId, 'pull');

  let pulled = 0;
  for (const f of forksRes.data ?? []) {
    if (!inBook.has(f.bucket_id)) continue;
    const delta = (f.delta ?? {}) as ForkDelta;
    const nextDelta: ForkDelta = { ...delta, seen: byBucket.get(f.bucket_id) ?? [] };
    await saveMyForkDelta(f.bucket_id, nextDelta);
    pulled++;
  }
  await logEvent('bucket_batch_pull', { codebookId, by: user.id, forks: pulled });
  return { pulled };
}

// ---------------------------------------------------------------------------
// Snapshots + event log
// ---------------------------------------------------------------------------

/** Serialize full codebook state (codes+defs, buckets, forks/Δ, captions) and
 *  append it with the next monotonic seq. Returns the snapshot id. */
export async function cutSnapshot(
  codebookId: string,
  reason: 'irr' | 'pull' | 'push' | 'manual',
): Promise<string> {
  await requireEditor();
  const user = await requireAuthUser();

  const [codesRes, bucketsRes, membersRes, forksRes, itemsRes, lastRes] = await Promise.all([
    cbFrom('cb_codes').select('id, mnemonic, origin, status, current_version_id').eq('codebook_id', codebookId),
    cbFrom('cb_buckets').select('*').eq('codebook_id', codebookId),
    cbFrom('cb_bucket_codes').select('*'),
    cbFrom('cb_bucket_forks').select('*'),
    cbFrom('cb_code_bucket_items').select('*'),
    cbFrom('cb_codebook_snapshots')
      .select('seq')
      .eq('codebook_id', codebookId)
      .order('seq', { ascending: false })
      .limit(1),
  ]);
  const err =
    codesRes.error || bucketsRes.error || membersRes.error || forksRes.error || itemsRes.error || lastRes.error;
  if (err) throw new Error(`cutSnapshot failed: ${err.message}`);

  const bucketIds = new Set((bucketsRes.data ?? []).map((b) => b.id));
  const state = {
    codes: codesRes.data ?? [],
    buckets: (bucketsRes.data ?? []).map((b) => ({
      ...b,
      members: (membersRes.data ?? []).filter((m) => m.bucket_id === b.id),
    })),
    forks: (forksRes.data ?? []).filter((f) => bucketIds.has(f.bucket_id)),
    items: ((itemsRes.data ?? []) as ItemRow[]).filter(
      (i) => i.bucket_id === null || bucketIds.has(i.bucket_id),
    ),
  };
  const payload = serializeSnapshot(state);
  const seq = (lastRes.data?.[0]?.seq ?? 0) + 1;

  const ins = await cbFrom('cb_codebook_snapshots')
    .insert({
      codebook_id: codebookId,
      seq,
      reason,
      payload: JSON.parse(payload) as Json,
      created_by: user.id,
    })
    .select('id')
    .single();
  if (ins.error) throw new Error(`cutSnapshot failed: ${ins.error.message}`);
  return ins.data.id;
}

/** Append to the event log (append-only; no update/delete path exists). */
export async function logEvent(kind: string, payload: Record<string, unknown>): Promise<void> {
  const user = await requireAuthUser();
  const res = await cbFrom('cb_assignment_events').insert({
    actor_id: user.id,
    kind,
    payload: payload as Json,
  });
  if (res.error) throw new Error(`logEvent failed: ${res.error.message}`);
}
