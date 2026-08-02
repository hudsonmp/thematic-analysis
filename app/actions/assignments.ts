'use server';

import { cbFrom } from '@/lib/supabase/guard';
import { requireEditor } from '@/lib/auth/roles';
import { requireAuthUser } from '@/lib/auth/supabase-auth';
import { logEvent } from '@/app/actions/buckets';
import {
  checkFulfillment,
  evaluateOrder,
  resolveFork,
  subsumption,
  type ChildLink,
  type DefItem,
  type ForkDelta,
} from '@/lib/codebook/combinatorial';
import type { Json } from '@/lib/types/cb-db';

/**
 * Assignment lifecycle for combinatorial codes (v2 spec).
 *
 * A code-on-span assignment (one cb_annotation_codes row) carries a STATUS:
 *   attested   — coder asserts the parent holds; evidence optional. Counts for
 *                IRR; implicitly asserts mandatory codes and ordering.
 *   decomposed — children LINKED with sub-spans (cb_assignment_children).
 *                Partial decomposition is attested-with-some-evidence.
 *   pending    — NOT yet asserted. Blocks IRR until resolved; resolving to
 *                deletion logs the partially fulfilled buckets.
 *
 * Promotion is the same write path: the UI creates/reuses the parent
 * annotation, then links EXISTING child assignments here (links, never
 * copies). Order is evaluated on every (re)link by first evidence — the
 * `order_violated` flag warns, never blocks.
 */

export type AssignmentChildInput = {
  childAnnotationId: string;
  childCodeId: string;
  /** Which AND-item of the parent this child fulfills. */
  itemId: string;
  /** Subsumption provenance ("via c₁") when entailment auto-checked it. */
  viaCodeId?: string | null;
};

export type AssignmentStatus = 'attested' | 'decomposed' | 'pending';

/** Sentence indices (segment ordinals) covered by a set of annotations. */
async function ordinalsFor(annotationIds: string[]): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (annotationIds.length === 0) return out;
  const annRes = await cbFrom('cb_annotations')
    .select('id, version_id, segment_id, end_segment_id')
    .in('id', annotationIds);
  if (annRes.error) throw new Error(`ordinalsFor failed: ${annRes.error.message}`);
  const rows = annRes.data ?? [];
  const segIds = [...new Set(rows.flatMap((r) => [r.segment_id, r.end_segment_id].filter(Boolean)))] as string[];
  if (segIds.length === 0) return out;
  const segRes = await cbFrom('cb_segments').select('id, ordinal').in('id', segIds);
  if (segRes.error) throw new Error(`ordinalsFor failed: ${segRes.error.message}`);
  const ordById = new Map((segRes.data ?? []).map((s) => [s.id, s.ordinal]));
  for (const r of rows) {
    const a = ordById.get(r.segment_id ?? '');
    const b = r.end_segment_id ? ordById.get(r.end_segment_id) : a;
    if (a === undefined) continue;
    const lo = Math.min(a, b ?? a);
    const hi = Math.max(a, b ?? a);
    const sentences: number[] = [];
    for (let s = lo; s <= hi; s++) sentences.push(s);
    out.set(r.id, sentences);
  }
  return out;
}

/** The parent's def items, engine-shaped. */
async function defItemsOf(codeId: string): Promise<DefItem[]> {
  const res = await cbFrom('cb_code_bucket_items').select('*').eq('code_id', codeId).order('position');
  if (res.error) throw new Error(`defItemsOf failed: ${res.error.message}`);
  return (res.data ?? []).map((r) =>
    r.bucket_id !== null
      ? ({ id: r.id, position: r.position, interchangeGroup: r.interchange_group, kind: 'bucket', bucketId: r.bucket_id } as DefItem)
      : ({ id: r.id, position: r.position, interchangeGroup: r.interchange_group, kind: 'singleton', codeId: r.singleton_code_id! } as DefItem),
  );
}

/**
 * Two member views, both needed:
 *   fork    — the CODER'S effective view (modular + their Δ): the admissibility
 *             the popup offered, so fulfillment is judged by what the coder saw.
 *   modular — the canonical view: subsumption's PARENT side (unpushed fork
 *             codes must not substitute into standard slots).
 */
async function memberViews(userId: string): Promise<{
  fork: (bucketId: string) => { codeId: string; mandatory: boolean }[];
  modular: (bucketId: string) => { codeId: string; mandatory: boolean }[];
}> {
  const [mRes, fRes, bRes] = await Promise.all([
    cbFrom('cb_bucket_codes').select('*'),
    cbFrom('cb_bucket_forks').select('*').eq('owner_id', userId),
    cbFrom('cb_buckets').select('id, name, caption'),
  ]);
  const err = mRes.error || fRes.error || bRes.error;
  if (err) throw new Error(`memberViews failed: ${err.message}`);
  const modularBy = new Map<string, { codeId: string; mandatory: boolean }[]>();
  for (const m of mRes.data ?? []) {
    const arr = modularBy.get(m.bucket_id) ?? [];
    arr.push({ codeId: m.code_id, mandatory: m.mandatory });
    modularBy.set(m.bucket_id, arr);
  }
  const deltaBy = new Map<string, ForkDelta>(
    (fRes.data ?? []).map((f) => [f.bucket_id, (f.delta ?? {}) as ForkDelta]),
  );
  const metaBy = new Map((bRes.data ?? []).map((b) => [b.id, b]));
  const forkCache = new Map<string, { codeId: string; mandatory: boolean }[]>();
  const fork = (bucketId: string) => {
    const hit = forkCache.get(bucketId);
    if (hit) return hit;
    const meta = metaBy.get(bucketId);
    const eff = resolveFork(
      {
        id: bucketId,
        name: meta?.name ?? bucketId,
        caption: meta?.caption ?? null,
        members: modularBy.get(bucketId) ?? [],
      },
      deltaBy.get(bucketId) ?? null,
    ).members;
    forkCache.set(bucketId, eff);
    return eff;
  };
  return { fork, modular: (b) => modularBy.get(b) ?? [] };
}

/**
 * Set/replace the child links of a parent assignment (decomposition OR
 * promotion — promotion passes links to already-existing child assignments).
 * Recomputes order_violated from first evidence and stamps status:
 * 'decomposed' when links remain, back to 'attested' when emptied (an
 * attested assignment whose decomposition was withdrawn is still an
 * assertion — flagged in the log, never silently deleted).
 */
export async function setAssignmentChildren(input: {
  parentAnnotationId: string;
  parentCodeId: string;
  links: AssignmentChildInput[];
}): Promise<{ orderViolated: boolean; complete: boolean; missingItemIds: string[] }> {
  await requireEditor();
  const user = await requireAuthUser();

  const items = await defItemsOf(input.parentCodeId);
  const views = await memberViews(user.id);

  // VERIFY subsumption provenance BEFORE any write: a via-link claims its
  // child (the subsuming code c₁) covers the target item by entailment. Rerun
  // the entailment server-side — sub under the CODER'S fork view, parent under
  // MODULAR — and reject links whose claimed item is not in the mapping. This
  // is what makes the engine's trust of `via` sound.
  const viaLinks = input.links.filter((l) => l.viaCodeId);
  if (viaLinks.length) {
    const viaCodeIds = [...new Set(viaLinks.map((l) => l.viaCodeId!))];
    const viaDefs = new Map<string, DefItem[]>();
    for (const vc of viaCodeIds) viaDefs.set(vc, await defItemsOf(vc));
    for (const l of viaLinks) {
      if (l.childCodeId !== l.viaCodeId) {
        throw new Error('setAssignmentChildren: a subsumption link must carry the subsuming code itself.');
      }
      const subItems = viaDefs.get(l.viaCodeId!) ?? [];
      const mapping = subItems.length
        ? subsumption(
            { codeId: l.viaCodeId!, items: subItems },
            { codeId: input.parentCodeId, items },
            views.fork,
            views.modular,
          )
        : null;
      if (!mapping || !mapping.some((m) => m.parentItemId === l.itemId)) {
        throw new Error(
          `setAssignmentChildren: subsumption via ${l.viaCodeId} no longer covers that step — reopen the panel.`,
        );
      }
    }
  }

  // Replace links.
  const del = await cbFrom('cb_assignment_children')
    .delete()
    .eq('parent_annotation_id', input.parentAnnotationId)
    .eq('parent_code_id', input.parentCodeId);
  if (del.error) throw new Error(`setAssignmentChildren failed: ${del.error.message}`);
  if (input.links.length) {
    const ins = await cbFrom('cb_assignment_children').insert(
      input.links.map((l) => ({
        parent_annotation_id: input.parentAnnotationId,
        parent_code_id: input.parentCodeId,
        child_annotation_id: l.childAnnotationId,
        child_code_id: l.childCodeId,
        item_id: l.itemId,
        via_code_id: l.viaCodeId ?? null,
      })),
    );
    if (ins.error) throw new Error(`setAssignmentChildren failed: ${ins.error.message}`);
  }

  // Evaluate fulfillment + order by first evidence (engine). Admissibility is
  // judged under the CODER'S fork view — the same member set the popup offered.
  const ords = await ordinalsFor(input.links.map((l) => l.childAnnotationId));
  const engineLinks: ChildLink[] = input.links.map((l) => ({
    itemId: l.itemId,
    childCodeId: l.childCodeId,
    sentences: ords.get(l.childAnnotationId) ?? [],
    via: l.viaCodeId ?? null,
  }));
  const ful = checkFulfillment({ codeId: input.parentCodeId, items }, engineLinks, views.fork);
  const order = evaluateOrder(items, ful.firstEvidence);

  const status: AssignmentStatus = input.links.length > 0 ? 'decomposed' : 'attested';
  const up = await cbFrom('cb_annotation_codes')
    .update({ status, order_violated: order.violated })
    .eq('annotation_id', input.parentAnnotationId)
    .eq('code_id', input.parentCodeId);
  if (up.error) throw new Error(`setAssignmentChildren failed: ${up.error.message}`);

  await logEvent(input.links.length ? 'assignment_decomposed' : 'assignment_decomposition_cleared', {
    by: user.id,
    parentAnnotationId: input.parentAnnotationId,
    parentCodeId: input.parentCodeId,
    links: input.links as unknown as Json,
    // Sentence indices per bucket-fulfillment (spec: event log records them).
    firstEvidence: Object.fromEntries(ful.firstEvidence),
    orderViolated: order.violated,
    conflicts: order.conflicts as unknown as Json,
    complete: ful.complete,
    missingItemIds: ful.missingItemIds,
    mandatoryMissing: ful.mandatoryMissing as unknown as Json,
  });

  return { orderViolated: order.violated, complete: ful.complete, missingItemIds: ful.missingItemIds };
}

/** Transition an assignment's status (attest / mark pending / resolve). */
export async function setAssignmentStatus(input: {
  annotationId: string;
  codeId: string;
  status: AssignmentStatus;
}): Promise<void> {
  await requireEditor();
  const user = await requireAuthUser();
  const up = await cbFrom('cb_annotation_codes')
    .update({ status: input.status })
    .eq('annotation_id', input.annotationId)
    .eq('code_id', input.codeId);
  if (up.error) throw new Error(`setAssignmentStatus failed: ${up.error.message}`);
  await logEvent('assignment_status', {
    by: user.id,
    annotationId: input.annotationId,
    codeId: input.codeId,
    status: input.status,
  });
}

/**
 * Delete a parent assignment (the code-link) WITHOUT cascading to children:
 * child assignments are independent codings — only the links go. A pending
 * deletion logs the partially fulfilled buckets (spec) via `partialState`
 * passed from the popup (which knows the in-progress bucket fills).
 */
export async function deleteAssignment(input: {
  annotationId: string;
  codeId: string;
  partialState?: Record<string, unknown> | null;
}): Promise<void> {
  await requireEditor();
  const user = await requireAuthUser();

  const cur = await cbFrom('cb_annotation_codes')
    .select('status')
    .eq('annotation_id', input.annotationId)
    .eq('code_id', input.codeId)
    .maybeSingle();
  if (cur.error) throw new Error(`deleteAssignment failed: ${cur.error.message}`);

  // Capture the partially fulfilled buckets BEFORE destroying the links —
  // spec: deletions log the partial state (which items had which children).
  const parentLinks = await cbFrom('cb_assignment_children')
    .select('item_id, child_annotation_id, child_code_id, via_code_id')
    .eq('parent_annotation_id', input.annotationId)
    .eq('parent_code_id', input.codeId);
  if (parentLinks.error) throw new Error(`deleteAssignment failed: ${parentLinks.error.message}`);

  const delLinks = await cbFrom('cb_assignment_children')
    .delete()
    .eq('parent_annotation_id', input.annotationId)
    .eq('parent_code_id', input.codeId);
  if (delLinks.error) throw new Error(`deleteAssignment failed: ${delLinks.error.message}`);

  // Mirror of removeCodeFromAnnotation: where this assignment served as a
  // CHILD elsewhere, drop those evidence links and flag any parent left empty.
  const childSide = await cbFrom('cb_assignment_children')
    .select('parent_annotation_id, parent_code_id')
    .eq('child_annotation_id', input.annotationId)
    .eq('child_code_id', input.codeId);
  if (childSide.error) throw new Error(`deleteAssignment failed: ${childSide.error.message}`);
  const affectedParents = [
    ...new Map(
      (childSide.data ?? []).map((r) => [
        `${r.parent_annotation_id}|${r.parent_code_id}`,
        { annotationId: r.parent_annotation_id, codeId: r.parent_code_id },
      ]),
    ).values(),
  ];
  if ((childSide.data ?? []).length > 0) {
    const delChild = await cbFrom('cb_assignment_children')
      .delete()
      .eq('child_annotation_id', input.annotationId)
      .eq('child_code_id', input.codeId);
    if (delChild.error) throw new Error(`deleteAssignment failed: ${delChild.error.message}`);
  }

  const del = await cbFrom('cb_annotation_codes')
    .delete()
    .eq('annotation_id', input.annotationId)
    .eq('code_id', input.codeId);
  if (del.error) throw new Error(`deleteAssignment failed: ${del.error.message}`);

  for (const p of affectedParents) {
    const left = await cbFrom('cb_assignment_children')
      .select('id')
      .eq('parent_annotation_id', p.annotationId)
      .eq('parent_code_id', p.codeId)
      .limit(1);
    if (left.error || (left.data ?? []).length > 0) continue;
    await cbFrom('cb_annotation_codes')
      .update({ status: 'attested', order_violated: false })
      .eq('annotation_id', p.annotationId)
      .eq('code_id', p.codeId)
      .eq('status', 'decomposed');
    await logEvent('decomposition_broken', {
      parentAnnotationId: p.annotationId,
      parentCodeId: p.codeId,
      removedChild: { annotationId: input.annotationId, codeId: input.codeId },
    });
  }

  await logEvent('assignment_deleted', {
    by: user.id,
    annotationId: input.annotationId,
    codeId: input.codeId,
    priorStatus: cur.data?.status ?? null,
    // The linked children at deletion time — the spec's partial-state record —
    // merged with whatever in-progress bucket fills the popup passed.
    partialState: {
      linkedChildren: parentLinks.data ?? [],
      ...(input.partialState ?? {}),
    } as Json,
  });
}

export type AssignmentChildRow = {
  id: string;
  parentAnnotationId: string;
  parentCodeId: string;
  childAnnotationId: string;
  childCodeId: string;
  childMnemonic: string;
  itemId: string | null;
  viaCodeId: string | null;
};

/** All child links for a set of annotations (the player's parent/child chips). */
export async function listAssignmentChildren(
  annotationIds: string[],
): Promise<AssignmentChildRow[]> {
  await requireAuthUser();
  if (annotationIds.length === 0) return [];
  const res = await cbFrom('cb_assignment_children')
    .select('id, parent_annotation_id, parent_code_id, child_annotation_id, child_code_id, item_id, via_code_id, cb_codes!cb_assignment_children_child_code_id_fkey(mnemonic)')
    .in('parent_annotation_id', annotationIds);
  if (res.error) throw new Error(`listAssignmentChildren failed: ${res.error.message}`);
  type Row = {
    id: string;
    parent_annotation_id: string;
    parent_code_id: string;
    child_annotation_id: string;
    child_code_id: string;
    item_id: string | null;
    via_code_id: string | null;
    cb_codes: { mnemonic: string } | null;
  };
  return ((res.data ?? []) as unknown as Row[]).map((r) => ({
    id: r.id,
    parentAnnotationId: r.parent_annotation_id,
    parentCodeId: r.parent_code_id,
    childAnnotationId: r.child_annotation_id,
    childCodeId: r.child_code_id,
    childMnemonic: r.cb_codes?.mnemonic ?? '(code)',
    itemId: r.item_id,
    viaCodeId: r.via_code_id,
  }));
}

/** Pending assignments for a session+coder — the IRR gate reads this. */
export async function countPendingAssignments(sessionId: string): Promise<number> {
  await requireAuthUser();
  const res = await cbFrom('cb_annotations')
    .select('id, cb_annotation_codes!inner(status)')
    .eq('session_id', sessionId)
    .eq('kind', 'code')
    .eq('cb_annotation_codes.status', 'pending');
  if (res.error) throw new Error(`countPendingAssignments failed: ${res.error.message}`);
  return (res.data ?? []).length;
}
