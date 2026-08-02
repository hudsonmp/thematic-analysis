/**
 * combinatorial — the PURE grammar engine for the combinatorial codebook
 * (spec: docs/superpowers/specs/2026-08-02-composite-codes-design.md).
 *
 * A code is primitive (no items) or combinatorial: an ordered AND of items,
 * each item a modular-bucket reference or a mandatory singleton code. No OR in
 * the grammar — apparent disjunction is subsumption. Everything here is pure
 * (data in, verdicts out): fork overlay resolution, definition validation
 * (DAG + empty-bucket + interchange contiguity), series-parallel order
 * evaluation by first evidence, fulfillment checking, subsumption entailment,
 * and deterministic snapshot serialization. No DB, no DOM — fully unit-tested.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BucketMember = { codeId: string; mandatory: boolean };

export type ModularBucket = {
  id: string;
  name: string;
  caption: string | null;
  members: BucketMember[];
};

/** A fork's Δ: ONLY explicitly changed attributes. `seen` is the member list at
 *  the fork's last batch pull — the deletion detector: a member in `seen` but
 *  missing at modular was deleted at modular, and deletions never auto-pull. */
export type ForkDelta = {
  addedCodes?: BucketMember[];
  mandatoryOverrides?: Record<string, boolean>;
  caption?: string;
  removedCodeIds?: string[];
  seen?: BucketMember[];
};

export type EffectiveBucket = ModularBucket & {
  /** Members deleted at modular since the fork last pulled, not removed by the
   *  fork itself — kept in `members` and flagged here for manual resolution. */
  pendingDeletions: BucketMember[];
};

export type DefItem = {
  id: string;
  position: number;
  /** Contiguous positions sharing a non-null group are interchangeable. */
  interchangeGroup: number | null;
} & ({ kind: 'bucket'; bucketId: string } | { kind: 'singleton'; codeId: string });

/** items.length > 0 ⇔ combinatorial. */
export type CodeDef = { codeId: string; items: DefItem[] };

export type MembersFn = (bucketId: string) => BucketMember[];

// ---------------------------------------------------------------------------
// Fork overlay: effective = modular − removed + added, with mandatory
// overrides; pull is automatic for any attribute not in Δ.
// ---------------------------------------------------------------------------

export function resolveFork(modular: ModularBucket, delta: ForkDelta | null): EffectiveBucket {
  if (!delta) return { ...modular, members: [...modular.members], pendingDeletions: [] };

  const removed = new Set(delta.removedCodeIds ?? []);
  const overrides = delta.mandatoryOverrides ?? {};

  const applyOverride = (mem: BucketMember): BucketMember =>
    mem.codeId in overrides ? { ...mem, mandatory: overrides[mem.codeId] } : mem;

  const modularIds = new Set(modular.members.map((x) => x.codeId));
  const members: BucketMember[] = modular.members
    .filter((x) => !removed.has(x.codeId))
    .map(applyOverride);

  // Deletions never auto-pull: a `seen` member gone from modular (and not
  // removed by the fork) stays in the effective view, flagged for resolution.
  const pendingDeletions: BucketMember[] = [];
  for (const mem of delta.seen ?? []) {
    if (modularIds.has(mem.codeId) || removed.has(mem.codeId)) continue;
    const kept = applyOverride(mem);
    members.push(kept);
    pendingDeletions.push(kept);
  }

  for (const add of delta.addedCodes ?? []) {
    if (!members.some((x) => x.codeId === add.codeId)) members.push(applyOverride(add));
  }

  return {
    ...modular,
    caption: delta.caption !== undefined ? delta.caption : modular.caption,
    members,
    pendingDeletions,
  };
}

// ---------------------------------------------------------------------------
// Definition validation: DAG guard (cycles rejected at definition time),
// empty-bucket guard, contiguous interchange groups, unique positions.
// ---------------------------------------------------------------------------

export function validateDefinition(
  def: CodeDef,
  defsById: Map<string, CodeDef>,
  membersOf: MembersFn,
): string[] {
  const errors: string[] = [];
  const items = [...def.items].sort((a, b) => a.position - b.position);

  // positions unique
  const seenPos = new Set<number>();
  for (const it of items) {
    if (seenPos.has(it.position)) {
      errors.push(`duplicate position ${it.position} — item order must be unambiguous`);
      break;
    }
    seenPos.add(it.position);
  }

  // interchange groups contiguous: the positions of a group must be an
  // unbroken run in the sorted order.
  const groupIdx = new Map<number, number[]>();
  items.forEach((it, i) => {
    if (it.interchangeGroup !== null) {
      const arr = groupIdx.get(it.interchangeGroup) ?? [];
      arr.push(i);
      groupIdx.set(it.interchangeGroup, arr);
    }
  });
  for (const [g, idxs] of groupIdx) {
    if (idxs[idxs.length - 1] - idxs[0] !== idxs.length - 1) {
      errors.push(`interchange group ${g} is not contiguous — only adjacent positions may be interchangeable`);
    }
  }

  // empty buckets
  for (const it of items) {
    if (it.kind === 'bucket' && membersOf(it.bucketId).length === 0) {
      errors.push(`item at position ${it.position} references an empty bucket (${it.bucketId})`);
    }
  }

  // DAG guard. Edges: def → each singleton code; def → every member of each
  // referenced bucket. Reaching def.codeId again = cycle. Iterative DFS with a
  // visited set; combinatorial members recurse through THEIR defs.
  const target = def.codeId;
  const visited = new Set<string>();
  const stack: string[] = [];
  const pushChildren = (d: CodeDef) => {
    for (const it of d.items) {
      if (it.kind === 'singleton') stack.push(it.codeId);
      else for (const mem of membersOf(it.bucketId)) stack.push(mem.codeId);
    }
  };
  pushChildren(def);
  let cyclic = false;
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === target) {
      cyclic = true;
      break;
    }
    if (visited.has(cur)) continue;
    visited.add(cur);
    const sub = defsById.get(cur);
    if (sub) pushChildren(sub);
  }
  if (cyclic) errors.push('cycle detected — code definitions must form a DAG');

  return errors;
}

// ---------------------------------------------------------------------------
// Series-parallel order: stages in position order, contiguous interchange
// groups collapse to one stage. Evaluated by FIRST EVIDENCE (min sentence
// index); ties permitted; missing evidence skipped; warn, never block.
// ---------------------------------------------------------------------------

export type Stage = { itemIds: string[] };

export function stagesOf(items: DefItem[]): Stage[] {
  const sorted = [...items].sort((a, b) => a.position - b.position);
  const stages: Stage[] = [];
  let i = 0;
  while (i < sorted.length) {
    const g = sorted[i].interchangeGroup;
    if (g === null) {
      stages.push({ itemIds: [sorted[i].id] });
      i++;
    } else {
      const ids: string[] = [];
      while (i < sorted.length && sorted[i].interchangeGroup === g) {
        ids.push(sorted[i].id);
        i++;
      }
      stages.push({ itemIds: ids });
    }
  }
  return stages;
}

export type OrderResult = {
  violated: boolean;
  conflicts: { earlierItemId: string; laterItemId: string }[];
};

export function evaluateOrder(items: DefItem[], firstEvidence: Map<string, number>): OrderResult {
  const stages = stagesOf(items);
  const conflicts: OrderResult['conflicts'] = [];
  // For consecutive evidenced stages: every evidenced item of stage k must have
  // first evidence ≤ every evidenced item of stage k+1 … generalized across
  // gaps: compare each evidenced stage with the NEXT evidenced stage.
  const evidenced = stages
    .map((s) => ({
      items: s.itemIds.filter((id) => firstEvidence.has(id)),
    }))
    .filter((s) => s.items.length > 0);
  for (let k = 0; k + 1 < evidenced.length; k++) {
    for (const a of evidenced[k].items) {
      for (const b of evidenced[k + 1].items) {
        if (firstEvidence.get(a)! > firstEvidence.get(b)!) {
          conflicts.push({ earlierItemId: a, laterItemId: b });
        }
      }
    }
  }
  return { violated: conflicts.length > 0, conflicts };
}

// ---------------------------------------------------------------------------
// Fulfillment: AND across items; a bucket item needs ≥1 ADMISSIBLE linked
// child; a singleton item needs its exact code. Mandatory members of a
// fulfilled bucket that were not assigned are surfaced (warn, never block —
// attestation implicitly asserts them).
// ---------------------------------------------------------------------------

export type ChildLink = {
  itemId: string;
  childCodeId: string;
  /** Sentence indices of the child's span (evidence). */
  sentences: number[];
  /** Subsumption provenance ("via c₁") when auto-checked by entailment. */
  via?: string | null;
};

export type FulfillmentResult = {
  complete: boolean;
  missingItemIds: string[];
  mandatoryMissing: { itemId: string; codeIds: string[] }[];
  /** Per-item min sentence index across its links (first evidence). */
  firstEvidence: Map<string, number>;
};

export function checkFulfillment(
  def: CodeDef,
  links: ChildLink[],
  membersOf: MembersFn,
): FulfillmentResult {
  const byItem = new Map<string, ChildLink[]>();
  for (const l of links) {
    const arr = byItem.get(l.itemId) ?? [];
    arr.push(l);
    byItem.set(l.itemId, arr);
  }

  const missingItemIds: string[] = [];
  const mandatoryMissing: FulfillmentResult['mandatoryMissing'] = [];
  const firstEvidence = new Map<string, number>();

  for (const it of def.items) {
    const itemLinks = byItem.get(it.id) ?? [];
    let admissible: ChildLink[];
    if (it.kind === 'singleton') {
      admissible = itemLinks.filter((l) => l.childCodeId === it.codeId);
    } else {
      const memberIds = new Set(membersOf(it.bucketId).map((x) => x.codeId));
      admissible = itemLinks.filter((l) => memberIds.has(l.childCodeId));
      // mandatory check only applies when the bucket item is being fulfilled
      if (admissible.length > 0) {
        const assigned = new Set(admissible.map((l) => l.childCodeId));
        const missing = membersOf(it.bucketId)
          .filter((x) => x.mandatory && !assigned.has(x.codeId))
          .map((x) => x.codeId);
        if (missing.length) mandatoryMissing.push({ itemId: it.id, codeIds: missing });
      }
    }
    if (admissible.length === 0) {
      missingItemIds.push(it.id);
    } else {
      const min = Math.min(...admissible.flatMap((l) => l.sentences));
      if (Number.isFinite(min)) firstEvidence.set(it.id, min);
    }
  }

  return {
    complete: missingItemIds.length === 0,
    missingItemIds,
    mandatoryMissing,
    firstEvidence,
  };
}

// ---------------------------------------------------------------------------
// Subsumption (entailment, not stored lists). c₁ substitutes for a subset S of
// the parent's bucket items iff EVERY bucket item of c₁ maps injectively to a
// distinct parent bucket item with admissible(c₁-item) ⊆ admissible(parent-item),
// and the mapped parent items are one item or one interchange group.
//
// The sub's members are read under the CODER'S fork view (`subMembers`), the
// parent's under MODULAR (`parentMembers`) — so a fork with unpushed added
// codes fails ⊆ against standard slots, which IS the spec's push-first rule.
// Transitivity comes free: the DAG guard covers chains, and entailment is
// re-evaluated per popup, not stored.
// ---------------------------------------------------------------------------

export type SubsumptionMapping = { parentItemId: string; viaSubItemId: string }[];

export function subsumption(
  sub: CodeDef,
  parent: CodeDef,
  subMembers: MembersFn,
  parentMembers: MembersFn,
): SubsumptionMapping | null {
  const subBuckets = sub.items.filter((i) => i.kind === 'bucket');
  if (subBuckets.length === 0) return null; // primitive / singleton-only: nothing to map
  const parentBuckets = parent.items.filter((i) => i.kind === 'bucket');
  if (parentBuckets.length < subBuckets.length) return null;

  const subSets = subBuckets.map((i) => ({
    id: i.id,
    set: new Set(subMembers((i as DefItem & { kind: 'bucket' }).bucketId).map((x) => x.codeId)),
  }));
  const parSets = parentBuckets.map((i) => ({
    id: i.id,
    group: i.interchangeGroup,
    set: new Set(parentMembers((i as DefItem & { kind: 'bucket' }).bucketId).map((x) => x.codeId)),
  }));

  const isSubset = (a: Set<string>, b: Set<string>) => {
    if (a.size === 0 || a.size > b.size) return false;
    for (const x of a) if (!b.has(x)) return false;
    return true;
  };

  // Backtracking injective assignment (defs are small — a handful of items).
  const used = new Set<number>();
  const mapping: SubsumptionMapping = [];
  const assign = (k: number): boolean => {
    if (k === subSets.length) return true;
    for (let j = 0; j < parSets.length; j++) {
      if (used.has(j)) continue;
      if (!isSubset(subSets[k].set, parSets[j].set)) continue;
      used.add(j);
      mapping.push({ parentItemId: parSets[j].id, viaSubItemId: subSets[k].id });
      if (assign(k + 1)) {
        // Group constraint checked at the leaf so backtracking can escape a
        // valid-subset / wrong-group assignment.
        const targets = mapping.map((mm) => parSets.find((p) => p.id === mm.parentItemId)!);
        const ok =
          targets.length === 1 ||
          (targets.every((t) => t.group !== null) &&
            new Set(targets.map((t) => t.group)).size === 1);
        if (ok) return true;
      }
      mapping.pop();
      used.delete(j);
    }
    return false;
  };

  return assign(0) ? mapping : null;
}

// ---------------------------------------------------------------------------
// Snapshot serialization: canonical JSON — object keys sorted; arrays of
// objects carrying an `id` sorted by id — so identical state always yields an
// identical string (snapshot equality is string equality).
// ---------------------------------------------------------------------------

type JsonVal = string | number | boolean | null | JsonVal[] | { [k: string]: JsonVal };

function canonical(v: unknown): JsonVal {
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return v as JsonVal;
  }
  if (Array.isArray(v)) {
    const mapped = v.map(canonical);
    const allIdObjects = mapped.every(
      (x) => x !== null && typeof x === 'object' && !Array.isArray(x) && typeof (x as Record<string, JsonVal>).id === 'string',
    );
    if (allIdObjects) {
      return [...(mapped as { id: string }[])].sort((a, b) => a.id.localeCompare(b.id)) as JsonVal[];
    }
    return mapped;
  }
  if (typeof v === 'object') {
    const out: { [k: string]: JsonVal } = {};
    for (const k of Object.keys(v as object).sort()) {
      const val = (v as Record<string, unknown>)[k];
      if (val !== undefined) out[k] = canonical(val);
    }
    return out;
  }
  return null;
}

export function serializeSnapshot(state: unknown): string {
  return JSON.stringify(canonical(state));
}
