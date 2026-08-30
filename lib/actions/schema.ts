/**
 * schema — pure helpers for the ACTION = MOVE × OBJECT layer (migration 45).
 *
 * No I/O: these shape and validate an action draft so the server action and
 * the client form agree on exactly one rule set, and so the rules are
 * unit-testable without a database.
 */

export type QuestionKind = 'free_text' | 'multiple_choice';

export type MoveLite = { id: string; name: string; minObjects: number };

export type QuestionLite = {
  id: string;
  prompt: string;
  kind: QuestionKind;
  required: boolean;
  options: { id: string; label: string }[];
};

/** One answer to one question. `optionId` for multiple_choice, `text` for free_text. */
export type AnswerDraft = { optionId?: string | null; text?: string | null };

/** A ROLE an object may be assigned inside an action (migration 49/50). */
export type RoleLite = { id: string; name: string };

/** objectId → roleId. Missing key / null ⇒ no role (roles are optional). */
export type ObjectRoles = Record<string, string | null | undefined>;

export type ActionDraft = {
  name: string;
  description?: string | null;
  moveIds: string[];
  objectIds: string[];
  /** Keyed by question id. Missing key ⇒ unanswered. */
  answers: Record<string, AnswerDraft>;
  /** Optional role per selected object. Entries for unselected objects are ignored. */
  objectRoles?: ObjectRoles;
};

/**
 * Strip object→role assignments down to what is worth persisting: only
 * SELECTED objects, only roles that still exist in the vocabulary, no nulls.
 */
export function cleanObjectRoles(
  objectRoles: ObjectRoles | undefined,
  objectIds: string[],
  roles: RoleLite[],
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!objectRoles) return out;
  const known = new Set(roles.map((r) => r.id));
  const selected = new Set(objectIds);
  for (const [objectId, roleId] of Object.entries(objectRoles)) {
    if (roleId && selected.has(objectId) && known.has(roleId)) out[objectId] = roleId;
  }
  return out;
}

/**
 * The fewest objects an action composed of `moveIds` must name: the selected
 * move's `min_objects` (MAX across ids, so legacy multi-move rows still get a
 * sound floor), and 1 when no move is selected (a move is still required — see
 * validateActionDraft).
 */
export function requiredObjectCount(moves: MoveLite[], moveIds: string[]): number {
  const selected = new Set(moveIds);
  let max = 1;
  for (const m of moves) if (selected.has(m.id) && m.minObjects > max) max = m.minObjects;
  return max;
}

/** True when the answer counts as "given" for its question's kind. */
export function isAnswered(q: QuestionLite, a: AnswerDraft | undefined): boolean {
  if (!a) return false;
  if (q.kind === 'multiple_choice') {
    return !!a.optionId && q.options.some((o) => o.id === a.optionId);
  }
  return !!a.text && a.text.trim().length > 0;
}

/** The one problem string for >1 move; exported so UIs can special-case it. */
export const ONE_MOVE_PROBLEM =
  'An action has exactly one move — if two moves happen at once, create two actions.';

/**
 * Every reason the draft cannot be saved, in display order. Empty ⇒ valid.
 * Checks: non-empty name; exactly one move (an action is ONE move × object(s);
 * two simultaneous moves are two actions); enough objects for the selected
 * move; every `required` question answered; every given multiple_choice answer
 * names an option that belongs to that question; when `roles` is given, every
 * role assigned to a SELECTED object exists (roles themselves stay optional).
 */
export function validateActionDraft(
  draft: ActionDraft,
  moves: MoveLite[],
  questions: QuestionLite[],
  roles?: RoleLite[],
): string[] {
  const problems: string[] = [];
  if (!draft.name.trim()) problems.push('Action needs a name.');

  const moveIds = uniq(draft.moveIds);
  const objectIds = uniq(draft.objectIds);
  const known = new Set(moves.map((m) => m.id));
  const unknownMove = moveIds.find((id) => !known.has(id));
  if (unknownMove) problems.push('Action references a move that no longer exists.');
  if (moveIds.length === 0) problems.push('Pick at least one move.');
  if (moveIds.length > 1) problems.push(ONE_MOVE_PROBLEM);

  const need = requiredObjectCount(moves, moveIds);
  if (objectIds.length < need) {
    problems.push(
      need === 1
        ? 'Pick at least one object.'
        : `The selected move needs at least ${need} objects (${objectIds.length} picked).`,
    );
  }

  for (const q of questions) {
    const a = draft.answers[q.id];
    if (q.kind === 'multiple_choice' && a?.optionId && !q.options.some((o) => o.id === a.optionId)) {
      problems.push(`“${q.prompt}”: the chosen option does not belong to this question.`);
      continue;
    }
    if (q.required && !isAnswered(q, a)) problems.push(`“${q.prompt}” is required.`);
  }

  if (roles && draft.objectRoles) {
    const knownRole = new Set(roles.map((r) => r.id));
    const selected = new Set(objectIds);
    const unknownRole = Object.entries(draft.objectRoles).some(
      ([objectId, roleId]) => !!roleId && selected.has(objectId) && !knownRole.has(roleId),
    );
    if (unknownRole) problems.push('Action references a role that no longer exists.');
  }
  return problems;
}

/**
 * Strip a draft's answers down to rows worth persisting: only questions that
 * still exist, and only answers that are actually given (so clearing a free-text
 * field deletes the row rather than storing an empty string).
 */
export function answerRows(
  answers: Record<string, AnswerDraft>,
  questions: QuestionLite[],
): { questionId: string; optionId: string | null; freeText: string | null }[] {
  const rows: { questionId: string; optionId: string | null; freeText: string | null }[] = [];
  for (const q of questions) {
    const a = answers[q.id];
    if (!isAnswered(q, a)) continue;
    rows.push(
      q.kind === 'multiple_choice'
        ? { questionId: q.id, optionId: a!.optionId!, freeText: null }
        : { questionId: q.id, optionId: null, freeText: a!.text!.trim() },
    );
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Object subclasses (migration 46): one level of parent_id.
// ---------------------------------------------------------------------------

export type ObjectLite = { id: string; name: string; parentId: string | null };

export type ObjectGroup<T extends ObjectLite> = { root: T; children: T[] };

/**
 * Nest subclasses under their parent, preserving input order for both roots and
 * children. An object whose parent is not in the list is treated as top-level
 * (so a stale row never vanishes from the UI).
 */
export function groupObjects<T extends ObjectLite>(objects: T[]): ObjectGroup<T>[] {
  const ids = new Set(objects.map((o) => o.id));
  const groups: ObjectGroup<T>[] = [];
  const byRoot = new Map<string, ObjectGroup<T>>();
  for (const o of objects) {
    if (o.parentId === null || !ids.has(o.parentId)) {
      const g = { root: o, children: [] as T[] };
      groups.push(g);
      byRoot.set(o.id, g);
    }
  }
  for (const o of objects) {
    if (o.parentId !== null && ids.has(o.parentId)) byRoot.get(o.parentId)?.children.push(o);
  }
  return groups;
}

/** True when the group's parent or any of its subclasses is in `selected`. */
export function groupActive(selected: string[], g: ObjectGroup<ObjectLite>): boolean {
  return selected.includes(g.root.id) || g.children.some((c) => selected.includes(c.id));
}

/**
 * Selection rule for the coding picker: a parent and its subclasses occupy ONE
 * slot — picking a parent whose subclasses exist is a choice to stay at the
 * parent level; refining to a subclass replaces the parent; several subclasses
 * of one parent may coexist (Trace needs two objects); unpicking the last
 * subclass falls back to the parent, and unpicking the parent clears the group.
 * Order of untouched ids is preserved; the changed id is appended.
 */
export function toggleObjectSelection(selected: string[], g: ObjectGroup<ObjectLite>, id: string): string[] {
  const childIds = g.children.map((c) => c.id);
  const inGroup = (x: string) => x === g.root.id || childIds.includes(x);
  const outside = selected.filter((x) => !inGroup(x));
  if (id === g.root.id) {
    return groupActive(selected, g) ? outside : [...outside, g.root.id];
  }
  const pickedChildren = selected.filter((x) => childIds.includes(x));
  const next = pickedChildren.includes(id) ? pickedChildren.filter((x) => x !== id) : [...pickedChildren, id];
  return next.length === 0 ? [...outside, g.root.id] : [...outside, ...next];
}

/** "Keep the parent": drop the group's subclasses and select the parent itself. */
export function keepParentSelection(selected: string[], g: ObjectGroup<ObjectLite>): string[] {
  const childIds = g.children.map((c) => c.id);
  return [...selected.filter((x) => x !== g.root.id && !childIds.includes(x)), g.root.id];
}

/** "Parent › Child" for a subclass, the bare name otherwise, "?" if unknown. */
export function objectLabel(objects: ObjectLite[], id: string): string {
  const o = objects.find((x) => x.id === id);
  if (!o) return '?';
  const parent = o.parentId ? objects.find((x) => x.id === o.parentId) : null;
  return parent ? `${parent.name} › ${o.name}` : o.name;
}

/** Casefolded, whitespace-collapsed name — what "the same vocabulary entry" means. */
export function vocabKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** An existing move with this name, or null. Used to never mint a duplicate. */
export function findMoveByName<T extends { name: string }>(moves: T[], name: string): T | null {
  const k = vocabKey(name);
  return moves.find((m) => vocabKey(m.name) === k) ?? null;
}

/**
 * An existing object with this name UNDER THE SAME PARENT, or null. Scoped by
 * parent because "Queue" under two different parents are two real objects.
 */
export function findObjectByName<T extends ObjectLite>(
  objects: T[],
  name: string,
  parentId: string | null,
): T | null {
  const k = vocabKey(name);
  return objects.find((o) => vocabKey(o.name) === k && (o.parentId ?? null) === (parentId ?? null)) ?? null;
}

/**
 * Why `objectId` (null when creating) cannot take `parentId` as its parent, or
 * null when it can. Enforces exactly one level: the parent must exist and be
 * top-level, and an object that already has subclasses cannot itself become one.
 */
export function parentProblem(
  objects: ObjectLite[],
  objectId: string | null,
  parentId: string | null,
): string | null {
  if (parentId === null) return null;
  if (objectId !== null && parentId === objectId) return 'An object cannot be a subclass of itself.';
  const parent = objects.find((o) => o.id === parentId);
  if (!parent) return 'The chosen parent object does not exist.';
  if (parent.parentId !== null) return 'Subclasses go only one level deep — pick a top-level object as the parent.';
  if (objectId !== null && objects.some((o) => o.parentId === objectId)) {
    return 'This object has subclasses of its own, so it cannot become a subclass.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Option triggers (migration 47): a choice may point at an action, an object,
// or a move — whichever layer the coder should reach for next.
// ---------------------------------------------------------------------------

export type TriggerKind = 'action' | 'object' | 'move';

export type TriggerRef = { kind: TriggerKind; id: string };

export const TRIGGER_KINDS: readonly TriggerKind[] = ['action', 'object', 'move'];

/** `"kind:id"` for a <select> value; empty string for no trigger. */
export function encodeTrigger(t: TriggerRef | null | undefined): string {
  return t ? `${t.kind}:${t.id}` : '';
}

/** Inverse of encodeTrigger. Unknown kinds and malformed values decode to null. */
export function parseTrigger(value: string | null | undefined): TriggerRef | null {
  if (!value) return null;
  const i = value.indexOf(':');
  if (i <= 0) return null;
  const kind = value.slice(0, i);
  const id = value.slice(i + 1);
  if (!id || !(TRIGGER_KINDS as readonly string[]).includes(kind)) return null;
  return { kind: kind as TriggerKind, id };
}

/**
 * "action · Create entity" / "object · Scenario › User story" / "move · Revise",
 * or null when the trigger is unset or its target no longer exists.
 */
export function triggerLabel(
  t: TriggerRef | null | undefined,
  vocab: {
    actions: { id: string; name: string }[];
    objects: ObjectLite[];
    moves: { id: string; name: string }[];
  },
): string | null {
  if (!t) return null;
  if (t.kind === 'action') {
    const a = vocab.actions.find((x) => x.id === t.id);
    return a ? `action · ${a.name}` : null;
  }
  if (t.kind === 'move') {
    const m = vocab.moves.find((x) => x.id === t.id);
    return m ? `move · ${m.name}` : null;
  }
  const label = objectLabel(vocab.objects, t.id);
  return label === '?' ? null : `object · ${label}`;
}

// ---------------------------------------------------------------------------
// Compositions (migration 48): the MOVE(s) × OBJECT(s) × answers a coder picks
// on /coding/action, either resolved to a reusable action or kept ad hoc.
// ---------------------------------------------------------------------------

/** One persisted answer row — the shape cb_action_answers / cb_action_codings.answers store. */
export type CompositionAnswer = { questionId: string; optionId: string | null; freeText: string | null };

/** One coding on an action-layer anchor (cb_action_codings), as the player
 *  renders it: `id` is the coding row (the unit of attach/detach); `actionId`
 *  is the reusable action it references (null for an ad hoc combination);
 *  moves/objects/answers are the composition to display. */
export type ActionCodingView = {
  id: string;
  actionId: string | null;
  actionName: string | null;
  moveIds: string[];
  objectIds: string[];
  answers: CompositionAnswer[];
  /** objectId → roleId for the objects that carry a role. */
  objectRoles: Record<string, string>;
};

/** A manual (not-yet-promoted) combination as the coding modal builds it. */
export type ManualComposition = {
  moveIds: string[];
  objectIds: string[];
  /** Keyed by question id, like ActionDraft.answers. */
  answers: Record<string, AnswerDraft>;
  /** Optional role per selected object, like ActionDraft.objectRoles. */
  objectRoles?: ObjectRoles;
};

/** The minimum a composition needs for keying/matching. */
export type CompositionLike = {
  moveIds: string[];
  objectIds: string[];
  answers: CompositionAnswer[];
  objectRoles?: ObjectRoles;
};

/** The canonical, order-insensitive representation of a composition. Two
 *  compositions are "the same action" iff their keys are equal: same move SET,
 *  same object SET, same role on each selected object (a role on an unselected
 *  object is ignored; no role ≠ some role), same answers on the questions that
 *  still exist (an answer to a deleted question is ignored; free text is
 *  compared trimmed with collapsed whitespace). This ONE function backs every
 *  duplicate check — the modal's client-side match, the server's promote-guard,
 *  and the coding insert. */
export function compositionKey(c: CompositionLike, questions: QuestionLite[]): string {
  const known = new Map(questions.map((q) => [q.id, q]));
  const answers = c.answers
    .filter((a) => known.has(a.questionId))
    .map((a) => {
      const q = known.get(a.questionId)!;
      if (q.kind === 'multiple_choice') {
        return a.optionId && q.options.some((o) => o.id === a.optionId) ? `${a.questionId}=o:${a.optionId}` : null;
      }
      const t = (a.freeText ?? '').trim().replace(/\s+/g, ' ');
      return t ? `${a.questionId}=t:${t}` : null;
    })
    .filter((s): s is string => s !== null)
    .sort();
  const objectIds = uniq(c.objectIds).sort();
  const selected = new Set(objectIds);
  const roles = Object.entries(c.objectRoles ?? {})
    .filter(([objectId, roleId]) => !!roleId && selected.has(objectId))
    .map(([objectId, roleId]) => `${objectId}=${roleId}`)
    .sort();
  return JSON.stringify({
    m: uniq(c.moveIds).sort(),
    o: objectIds,
    r: roles,
    a: answers,
  });
}

/** The id of the action whose composition equals `c` exactly, or null. */
export function findExactAction<A extends CompositionLike & { id: string }>(
  actions: A[],
  c: CompositionLike,
  questions: QuestionLite[],
): A | null {
  const key = compositionKey(c, questions);
  return actions.find((a) => compositionKey(a, questions) === key) ?? null;
}

/** Every reason a manual composition cannot be coded: exactly one move, enough
 *  objects, required questions answered, options belong to their questions. Same
 *  rules as an action minus the name. */
export function validateComposition(
  c: ManualComposition,
  moves: MoveLite[],
  questions: QuestionLite[],
  roles?: RoleLite[],
): string[] {
  return validateActionDraft({ name: 'composition', ...c }, moves, questions, roles);
}

/** "Create + Revise × Scenario, Entity" — how an ad hoc composition is named in
 *  chips and rails. With a role vocabulary, a roled object reads "Entity
 *  (source)". Unknown ids render as "?" rather than vanishing. */
export function compositionLabel(
  c: { moveIds: string[]; objectIds: string[]; objectRoles?: ObjectRoles },
  vocab: { moves: { id: string; name: string }[]; objects: ObjectLite[]; roles?: RoleLite[] },
): string {
  const moves = uniq(c.moveIds).map((id) => vocab.moves.find((m) => m.id === id)?.name ?? '?');
  const objects = uniq(c.objectIds).map((id) => {
    const base = objectLabel(vocab.objects, id);
    const roleId = c.objectRoles?.[id];
    const role = roleId && vocab.roles ? vocab.roles.find((r) => r.id === roleId) : null;
    return role ? `${base} (${role.name})` : base;
  });
  return `${moves.join(' + ') || '(no move)'} × ${objects.join(', ') || '(no object)'}`;
}

function uniq<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}
