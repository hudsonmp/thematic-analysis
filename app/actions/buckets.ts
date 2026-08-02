'use server';

import { cbFrom } from '@/lib/supabase/guard';
import { requireEditor } from '@/lib/auth/roles';
import { requireAuthUser } from '@/lib/auth/supabase-auth';
import {
  resolveFork,
  serializeSnapshot,
  validateDefinition,
  type BucketMember,
  type CodeDef,
  type DefItem,
  type ForkDelta,
} from '@/lib/codebook/combinatorial';
import type { ComboCode } from '@/components/codebook/CodeCombobox';
import type { Json } from '@/lib/types/cb-db';

/**
 * Modular buckets + PER-SLOT forks + snapshots (combinatorial codebook v2).
 *
 * The modular bucket is the shared canonical list. A FORK is an overlay on ONE
 * combinatorial code's step slot (a cb_code_bucket_items row): fork = modular
 * + Δ, resolved at read time, so pull is automatic for anything the slot never
 * overrode. Hudson's example: code `experimental-identification`'s Structure
 * slot APPENDS queue-added-to-structure (mandatory) — that slot MUST include
 * it, the modular Structure bucket is untouched, and pushing later adds the
 * code to modular NON-mandatory (the mandatory flag stays slot-local).
 *
 * The slot belongs to the shared instrument, so any editor edits any slot fork
 * (RLS editor-scoped; owner_id is provenance only). Deletions at modular never
 * auto-pull into slots — they surface as pending-deletion flags with explicit
 * keep/accept resolution in the code editor's STEPS section.
 *
 * All writes go through cbFrom (cb_ prefix guard) after requireEditor.
 */

// ---------------------------------------------------------------------------
// Types the UI consumes
// ---------------------------------------------------------------------------

/** The MODULAR bucket, as a reference view (no fork math). */
export type BucketView = {
  id: string;
  name: string;
  caption: string | null;
  members: BucketMember[];
};

/** One step slot of a combinatorial code, ready to render: the DefItem plus
 *  its slot fork and the RESOLVED effective member set. Assignable wherever
 *  DefItem[] is expected, so the engine consumes these rows directly. */
export type SlotItem = DefItem & {
  fork: ForkDelta | null;
  /** modular + this slot's Δ (empty for singleton items). */
  effectiveMembers: BucketMember[];
  /** Modular deletions this slot has not resolved (kept in effectiveMembers). */
  pendingDeletions: BucketMember[];
  /** Display conveniences (bucket items only). */
  bucketName?: string;
  bucketCaption?: string | null;
};

export type CombinatorialContext = {
  buckets: BucketView[];
  /** code id → ordered step slots (present ⇔ combinatorial). */
  defs: Record<string, SlotItem[]>;
  /** The codebook's live codes with picker metadata (search + hover expand). */
  codes: ComboCode[];
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

/** Defensive exemplar-text extraction (jsonb `{ text, … }[]`) — same policy as
 *  the session page: a malformed row must not throw. */
function exemplarTexts(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((e) =>
      e && typeof e === 'object' && typeof (e as { text?: unknown }).text === 'string'
        ? (e as { text: string }).text
        : '',
    )
    .filter((t) => t !== '');
}

/** Everything the STEPS section, coding popup and /buckets page need. */
export async function getCombinatorialContext(codebookId: string): Promise<CombinatorialContext> {
  await requireAuthUser();

  const [bucketsRes, membersRes, forksRes, itemsRes, snapRes, codesRes] = await Promise.all([
    cbFrom('cb_buckets').select('*').eq('codebook_id', codebookId).order('name'),
    cbFrom('cb_bucket_codes').select('*').order('position'),
    cbFrom('cb_bucket_forks').select('*'),
    cbFrom('cb_code_bucket_items').select('*').order('position'),
    cbFrom('cb_codebook_snapshots')
      .select('id, seq')
      .eq('codebook_id', codebookId)
      .order('seq', { ascending: false })
      .limit(1),
    cbFrom('cb_codes')
      .select('id, mnemonic, origin, current_version_id')
      .eq('codebook_id', codebookId)
      .is('retired_at', null)
      .order('mnemonic'),
  ]);
  const err =
    bucketsRes.error || membersRes.error || forksRes.error || itemsRes.error || snapRes.error || codesRes.error;
  if (err) throw new Error(`getCombinatorialContext failed: ${err.message}`);

  const bucketRows = bucketsRes.data ?? [];
  const bucketIds = new Set(bucketRows.map((b) => b.id));
  const bucketMeta = new Map(bucketRows.map((b) => [b.id, b]));
  const membersByBucket = new Map<string, BucketMember[]>();
  for (const mem of membersRes.data ?? []) {
    if (!bucketIds.has(mem.bucket_id)) continue;
    const arr = membersByBucket.get(mem.bucket_id) ?? [];
    arr.push({ codeId: mem.code_id, mandatory: mem.mandatory });
    membersByBucket.set(mem.bucket_id, arr);
  }
  const forkByItem = new Map<string, ForkDelta>();
  for (const f of forksRes.data ?? []) {
    if (f.item_id) forkByItem.set(f.item_id, (f.delta ?? {}) as ForkDelta);
  }

  const buckets: BucketView[] = bucketRows.map((b) => ({
    id: b.id,
    name: b.name,
    caption: b.caption,
    members: membersByBucket.get(b.id) ?? [],
  }));

  // Defs: each item resolved through ITS OWN slot fork.
  const defs: Record<string, SlotItem[]> = {};
  for (const r of (itemsRes.data ?? []) as ItemRow[]) {
    const base = toDefItem(r);
    let slot: SlotItem;
    if (base.kind === 'bucket') {
      const meta = bucketMeta.get(base.bucketId);
      const fork = forkByItem.get(r.id) ?? null;
      const eff = resolveFork(
        {
          id: base.bucketId,
          name: meta?.name ?? base.bucketId,
          caption: meta?.caption ?? null,
          members: membersByBucket.get(base.bucketId) ?? [],
        },
        fork,
      );
      slot = {
        ...base,
        fork,
        effectiveMembers: eff.members,
        pendingDeletions: eff.pendingDeletions,
        bucketName: meta?.name ?? '(bucket)',
        bucketCaption: fork?.caption !== undefined ? fork.caption : meta?.caption ?? null,
      };
    } else {
      slot = { ...base, fork: null, effectiveMembers: [], pendingDeletions: [] };
    }
    (defs[r.code_id] ??= []).push(slot);
  }
  for (const k of Object.keys(defs)) defs[k].sort((a, b) => a.position - b.position);

  // Picker metadata (search + hover expand) from the codes' CURRENT versions.
  const codeRows = codesRes.data ?? [];
  const versionIds = codeRows.map((c) => c.current_version_id).filter((x): x is string => !!x);
  const versionsRes = versionIds.length
    ? await cbFrom('cb_code_versions')
        .select('id, definition, exemplars, disconfirming_pattern')
        .in('id', versionIds)
    : { data: [], error: null };
  if (versionsRes.error) throw new Error(`getCombinatorialContext failed: ${versionsRes.error.message}`);
  const vById = new Map((versionsRes.data ?? []).map((v) => [v.id, v]));
  const codes: ComboCode[] = codeRows.map((c) => {
    const v = c.current_version_id ? vById.get(c.current_version_id) : undefined;
    return {
      id: c.id,
      mnemonic: c.mnemonic,
      origin: c.origin,
      definition: v?.definition ?? null,
      exemplars: exemplarTexts(v?.exemplars),
      counterExample: v?.disconfirming_pattern ?? null,
    };
  });

  return { buckets, defs, codes, latestSnapshotId: snapRes.data?.[0]?.id ?? null };
}

// ---------------------------------------------------------------------------
// Modular bucket CRUD (the canonical; every slot that never overrode an
// attribute pulls modular edits automatically at read time)
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

/** Replace the MODULAR member list (position-ordered, mandatory flags).
 *
 *  GRAMMAR GUARD (spec §Guards): a bucket referenced by any combinatorial
 *  definition must stay valid under the NEW member list — emptying it, or
 *  adding a member that closes a cycle through a referencing parent, is the
 *  out-of-grammar configuration the spec rejects. Re-validated per referencing
 *  code with the candidate list substituted UNDER EACH SLOT'S FORK, before any
 *  write. */
export async function setBucketMembers(
  bucketId: string,
  members: { codeId: string; mandatory: boolean }[],
): Promise<void> {
  await requireEditor();

  const refs = await cbFrom('cb_code_bucket_items').select('*').eq('bucket_id', bucketId);
  if (refs.error) throw new Error(`setBucketMembers failed: ${refs.error.message}`);
  const referencingCodes = [...new Set((refs.data ?? []).map((r) => r.code_id))];
  if (referencingCodes.length > 0) {
    if (members.length === 0) {
      throw new Error(
        'setBucketMembers: this bucket is referenced by a combinatorial code — it cannot be emptied (detach it there first).',
      );
    }
    const [allItemsRes, allMembersRes, forksRes] = await Promise.all([
      cbFrom('cb_code_bucket_items').select('*'),
      cbFrom('cb_bucket_codes').select('*'),
      cbFrom('cb_bucket_forks').select('*'),
    ]);
    const err = allItemsRes.error || allMembersRes.error || forksRes.error;
    if (err) throw new Error(`setBucketMembers failed: ${err.message}`);

    const defsById = new Map<string, CodeDef>();
    for (const r of (allItemsRes.data ?? []) as ItemRow[]) {
      const d = defsById.get(r.code_id) ?? { codeId: r.code_id, items: [] };
      d.items.push(toDefItem(r));
      defsById.set(r.code_id, d);
    }
    const membersBy = new Map<string, BucketMember[]>();
    for (const mem of allMembersRes.data ?? []) {
      const arr = membersBy.get(mem.bucket_id) ?? [];
      arr.push({ codeId: mem.code_id, mandatory: mem.mandatory });
      membersBy.set(mem.bucket_id, arr);
    }
    membersBy.set(bucketId, members); // the CANDIDATE list under test
    const forkByItem = new Map<string, ForkDelta>();
    for (const f of forksRes.data ?? []) {
      if (f.item_id) forkByItem.set(f.item_id, (f.delta ?? {}) as ForkDelta);
    }
    const membersOfItem = (item: DefItem): BucketMember[] => {
      if (item.kind !== 'bucket') return [];
      const modular = membersBy.get(item.bucketId) ?? [];
      const fork = forkByItem.get(item.id) ?? null;
      return resolveFork({ id: item.bucketId, name: '', caption: null, members: modular }, fork).members;
    };
    for (const codeId of referencingCodes) {
      const d = defsById.get(codeId);
      if (!d) continue;
      const errors = validateDefinition(d, defsById, membersOfItem);
      if (errors.length) {
        throw new Error(
          `setBucketMembers rejected — it would break the definition of a referencing code: ${errors.join('; ')}`,
        );
      }
    }
  }

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
// Slot forks
// ---------------------------------------------------------------------------

/** The item row + its bucket's modular members — shared by the fork writes. */
async function loadSlot(itemId: string): Promise<{
  item: ItemRow;
  bucket: { id: string; codebook_id: string; name: string; caption: string | null };
  modularMembers: BucketMember[];
}> {
  const itemRes = await cbFrom('cb_code_bucket_items').select('*').eq('id', itemId).single();
  if (itemRes.error) throw new Error(`loadSlot failed: ${itemRes.error.message}`);
  const item = itemRes.data as ItemRow;
  if (item.bucket_id === null) {
    throw new Error('loadSlot: singleton steps carry no fork — only bucket slots do.');
  }
  const [bRes, mRes] = await Promise.all([
    cbFrom('cb_buckets').select('id, codebook_id, name, caption').eq('id', item.bucket_id).single(),
    cbFrom('cb_bucket_codes').select('*').eq('bucket_id', item.bucket_id).order('position'),
  ]);
  if (bRes.error || mRes.error) throw new Error(`loadSlot failed: ${(bRes.error || mRes.error)!.message}`);
  return {
    item,
    bucket: bRes.data,
    modularMembers: (mRes.data ?? []).map((x) => ({ codeId: x.code_id, mandatory: x.mandatory })),
  };
}

/** True when a Δ changes nothing — the fork row can be dropped. */
function deltaIsEmpty(delta: ForkDelta, pendingDeletions: BucketMember[]): boolean {
  return (
    (delta.addedCodes?.length ?? 0) === 0 &&
    (delta.removedCodeIds?.length ?? 0) === 0 &&
    Object.keys(delta.mandatoryOverrides ?? {}).length === 0 &&
    delta.caption === undefined &&
    pendingDeletions.length === 0
  );
}

/**
 * Upsert a SLOT's fork Δ (any editor — the slot belongs to the shared
 * instrument; owner_id records who touched it last, provenance only).
 * GRAMMAR GUARD: removals may not empty the slot's effective view. A Δ that
 * changes nothing deletes the fork row instead of storing noise.
 */
export async function saveItemForkDelta(itemId: string, delta: ForkDelta): Promise<void> {
  await requireEditor();
  const user = await requireAuthUser();
  const { item, bucket, modularMembers } = await loadSlot(itemId);

  // First fork on this slot: seed `seen` with the current modular list so
  // future modular deletions are detectable. An existing `seen` is preserved
  // verbatim — refreshing it here would clobber unresolved deletion flags.
  const existing = await cbFrom('cb_bucket_forks').select('id, delta').eq('item_id', itemId).maybeSingle();
  if (existing.error) throw new Error(`saveItemForkDelta failed: ${existing.error.message}`);
  const next: ForkDelta = { ...delta };
  if (next.seen === undefined) {
    const prior = (existing.data?.delta ?? null) as ForkDelta | null;
    next.seen = prior?.seen ?? modularMembers;
  }

  const eff = resolveFork(
    { id: bucket.id, name: bucket.name, caption: bucket.caption, members: modularMembers },
    next,
  );
  if (eff.members.length === 0) {
    throw new Error('saveItemForkDelta rejected: the removals would empty this step — a slot cannot reference an empty bucket.');
  }

  if (deltaIsEmpty(next, eff.pendingDeletions)) {
    if (existing.data) {
      const del = await cbFrom('cb_bucket_forks').delete().eq('item_id', itemId);
      if (del.error) throw new Error(`saveItemForkDelta failed: ${del.error.message}`);
    }
    return;
  }

  const res = await cbFrom('cb_bucket_forks').upsert(
    {
      item_id: itemId,
      bucket_id: item.bucket_id!,
      owner_id: user.id,
      delta: next as unknown as Json,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'item_id' },
  );
  if (res.error) throw new Error(`saveItemForkDelta failed: ${res.error.message}`);
}

/**
 * PUSH a slot fork's ADDED codes to the modular bucket (UI double-confirms).
 * Hudson's rule: the code lands at modular NON-mandatory — the mandatory flag
 * is meaning local to THIS slot, so it converts into a slot-local
 * mandatoryOverride. Cuts a 'push' snapshot first; logs prior state
 * (last-write-wins is visible, not silent). Unresolved deletion flags survive
 * the seen-refresh.
 */
export async function pushItemForkToModular(itemId: string): Promise<void> {
  await requireEditor();
  const user = await requireAuthUser();
  const { item, bucket, modularMembers } = await loadSlot(itemId);

  const fRes = await cbFrom('cb_bucket_forks').select('*').eq('item_id', itemId).maybeSingle();
  if (fRes.error) throw new Error(`pushItemForkToModular failed: ${fRes.error.message}`);
  if (!fRes.data) throw new Error('pushItemForkToModular: this step has no fork to push.');
  const delta = (fRes.data.delta ?? {}) as ForkDelta;
  const modularIds = new Set(modularMembers.map((x) => x.codeId));
  const adds = (delta.addedCodes ?? []).filter((a) => !modularIds.has(a.codeId));
  if (adds.length === 0) {
    throw new Error('pushItemForkToModular: the fork adds no new codes — nothing to push.');
  }

  // Snapshot BEFORE the push (mandated boundary).
  await cutSnapshot(bucket.codebook_id, 'push');

  const ins = await cbFrom('cb_bucket_codes').insert(
    adds.map((a, i) => ({
      bucket_id: item.bucket_id!,
      code_id: a.codeId,
      // NON-mandatory at modular — the mandatory meaning stays slot-local.
      mandatory: false,
      position: modularMembers.length + i,
    })),
  );
  if (ins.error) throw new Error(`pushItemForkToModular failed: ${ins.error.message}`);

  // Δ shrinks: pushed adds leave addedCodes; a slot-mandatory add becomes a
  // mandatoryOverride on the (now-modular) member. Unresolved deletions stay.
  const overrides = { ...(delta.mandatoryOverrides ?? {}) };
  for (const a of adds) if (a.mandatory) overrides[a.codeId] = true;
  const removedSet = new Set(delta.removedCodeIds ?? []);
  const addIds = new Set(adds.map((a) => a.codeId));
  const unresolvedDeletions = (delta.seen ?? []).filter(
    (x) => !modularIds.has(x.codeId) && !removedSet.has(x.codeId) && !addIds.has(x.codeId),
  );
  const nextDelta: ForkDelta = {
    ...(delta.removedCodeIds?.length ? { removedCodeIds: delta.removedCodeIds } : {}),
    ...(Object.keys(overrides).length ? { mandatoryOverrides: overrides } : {}),
    ...(delta.caption !== undefined ? { caption: delta.caption } : {}),
    seen: [
      ...modularMembers,
      ...adds.map((a) => ({ codeId: a.codeId, mandatory: false })),
      ...unresolvedDeletions,
    ],
  };
  await saveItemForkDelta(itemId, nextDelta);

  await logEvent('slot_fork_push', {
    itemId,
    bucketId: item.bucket_id,
    codeId: item.code_id,
    by: user.id,
    pushed: adds as unknown as Json,
    prior: { members: modularMembers } as unknown as Json,
  });
}

// ---------------------------------------------------------------------------
// Snapshots + event log
// ---------------------------------------------------------------------------

/** Serialize full codebook state (codes+defs, buckets, slot forks/Δ, captions)
 *  and append it with the next monotonic seq. Returns the snapshot id. */
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
  const inBookItems = ((itemsRes.data ?? []) as ItemRow[]).filter(
    (i) => i.bucket_id === null || bucketIds.has(i.bucket_id),
  );
  const itemIds = new Set(inBookItems.map((i) => i.id));
  const state = {
    codes: codesRes.data ?? [],
    buckets: (bucketsRes.data ?? []).map((b) => ({
      ...b,
      members: (membersRes.data ?? []).filter((m) => m.bucket_id === b.id),
    })),
    forks: (forksRes.data ?? []).filter((f) => f.item_id && itemIds.has(f.item_id)),
    items: inBookItems,
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
