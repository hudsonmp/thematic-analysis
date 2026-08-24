'use server';

import { cbFrom } from '@/lib/supabase/guard';
import { requireAuthUser } from '@/lib/auth/supabase-auth';
import { requireEditor } from '@/lib/auth/roles';
import {
  answerRows,
  cleanObjectRoles,
  parentProblem,
  validateActionDraft,
  type ActionDraft,
  type AnswerDraft,
  type QuestionKind,
  type TriggerRef,
} from '@/lib/actions/schema';

// ---------------------------------------------------------------------------
// Action schema — ACTION = MOVE(s) × OBJECT(s) (migration 45).
//
// The researcher first defines the MOVE and OBJECT vocabularies and any extra
// QUESTIONS, then composes ACTIONS from them. All of it is codebook-scoped
// instrument authoring, so writes go through the service-role client behind
// requireEditor() exactly like codes / facets / flag-types. Reads are open to
// any signed-in user (coders need the catalog).
// ---------------------------------------------------------------------------

export type ActionMove = {
  id: string;
  name: string;
  description: string | null;
  minObjects: number;
  position: number;
};

export type ActionObject = {
  id: string;
  name: string;
  description: string | null;
  /** Top-level object when null; otherwise this is a subclass of `parentId` (one level deep). */
  parentId: string | null;
  position: number;
};

/** A ROLE an object may later be assigned inside an action (e.g. source / target of a Trace). */
export type ActionRole = {
  id: string;
  name: string;
  description: string | null;
  position: number;
};

export type ActionQuestionOption = {
  id: string;
  label: string;
  position: number;
  /** What choosing this option points the coder at next: an action, an object, or a move (one of). */
  trigger: TriggerRef | null;
  followUpQuestionId: string | null;
};

export type ActionQuestion = {
  id: string;
  prompt: string;
  description: string | null;
  kind: QuestionKind;
  required: boolean;
  position: number;
  options: ActionQuestionOption[];
};

export type ActionAnswer = { questionId: string; optionId: string | null; freeText: string | null };

export type ActionEntry = {
  id: string;
  name: string;
  description: string | null;
  position: number;
  moveIds: string[];
  objectIds: string[];
  answers: ActionAnswer[];
  /** objectId → roleId for the objects that were given a role (migration 50). */
  objectRoles: Record<string, string>;
};

export type ActionSchema = {
  moves: ActionMove[];
  objects: ActionObject[];
  roles: ActionRole[];
  questions: ActionQuestion[];
  actions: ActionEntry[];
};

/** Everything the /actions page needs, in display order. */
export async function getActionSchema(codebookId: string): Promise<ActionSchema> {
  await requireAuthUser();
  const [movesRes, objectsRes, rolesRes, questionsRes, actionsRes] = await Promise.all([
    cbFrom('cb_action_moves').select('*').eq('codebook_id', codebookId).order('position').order('created_at'),
    cbFrom('cb_action_objects').select('*').eq('codebook_id', codebookId).order('position').order('created_at'),
    cbFrom('cb_action_roles').select('*').eq('codebook_id', codebookId).order('position').order('created_at'),
    cbFrom('cb_action_questions').select('*').eq('codebook_id', codebookId).order('position').order('created_at'),
    cbFrom('cb_actions').select('*').eq('codebook_id', codebookId).order('position').order('created_at'),
  ]);
  for (const r of [movesRes, objectsRes, rolesRes, questionsRes, actionsRes]) {
    if (r.error) throw new Error(`getActionSchema failed: ${r.error.message}`);
  }
  const questionIds = (questionsRes.data ?? []).map((q) => q.id);
  const actionIds = (actionsRes.data ?? []).map((a) => a.id);

  const [optionsRes, moveLinksRes, objectLinksRes, answersRes] = await Promise.all([
    questionIds.length
      ? cbFrom('cb_action_question_options').select('*').in('question_id', questionIds).order('position').order('created_at')
      : Promise.resolve({ data: [], error: null }),
    actionIds.length
      ? cbFrom('cb_action_moves_link').select('*').in('action_id', actionIds)
      : Promise.resolve({ data: [], error: null }),
    actionIds.length
      ? cbFrom('cb_action_objects_link').select('*').in('action_id', actionIds)
      : Promise.resolve({ data: [], error: null }),
    actionIds.length
      ? cbFrom('cb_action_answers').select('*').in('action_id', actionIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  for (const r of [optionsRes, moveLinksRes, objectLinksRes, answersRes]) {
    if (r.error) throw new Error(`getActionSchema (children) failed: ${r.error.message}`);
  }

  const optionsByQ = new Map<string, ActionQuestionOption[]>();
  for (const o of optionsRes.data ?? []) {
    const list = optionsByQ.get(o.question_id) ?? [];
    list.push({
      id: o.id,
      label: o.label,
      position: o.position,
      trigger: o.trigger_action_id
        ? { kind: 'action', id: o.trigger_action_id }
        : o.trigger_object_id
          ? { kind: 'object', id: o.trigger_object_id }
          : o.trigger_move_id
            ? { kind: 'move', id: o.trigger_move_id }
            : null,
      followUpQuestionId: o.follow_up_question_id,
    });
    optionsByQ.set(o.question_id, list);
  }

  const moveIdsByA = new Map<string, string[]>();
  for (const l of moveLinksRes.data ?? []) {
    moveIdsByA.set(l.action_id, [...(moveIdsByA.get(l.action_id) ?? []), l.move_id]);
  }
  const objectIdsByA = new Map<string, string[]>();
  const objectRolesByA = new Map<string, Record<string, string>>();
  for (const l of objectLinksRes.data ?? []) {
    objectIdsByA.set(l.action_id, [...(objectIdsByA.get(l.action_id) ?? []), l.object_id]);
    if (l.role_id) {
      objectRolesByA.set(l.action_id, { ...(objectRolesByA.get(l.action_id) ?? {}), [l.object_id]: l.role_id });
    }
  }
  const answersByA = new Map<string, ActionAnswer[]>();
  for (const a of answersRes.data ?? []) {
    answersByA.set(a.action_id, [
      ...(answersByA.get(a.action_id) ?? []),
      { questionId: a.question_id, optionId: a.option_id, freeText: a.free_text },
    ]);
  }

  return {
    moves: (movesRes.data ?? []).map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      minObjects: m.min_objects,
      position: m.position,
    })),
    objects: (objectsRes.data ?? []).map((o) => ({
      id: o.id,
      name: o.name,
      description: o.description,
      parentId: o.parent_id,
      position: o.position,
    })),
    roles: (rolesRes.data ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      position: r.position,
    })),
    questions: (questionsRes.data ?? []).map((q) => ({
      id: q.id,
      prompt: q.prompt,
      description: q.description,
      kind: q.kind === 'multiple_choice' ? 'multiple_choice' : 'free_text',
      required: q.required,
      position: q.position,
      options: optionsByQ.get(q.id) ?? [],
    })),
    actions: (actionsRes.data ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      position: a.position,
      moveIds: moveIdsByA.get(a.id) ?? [],
      objectIds: objectIdsByA.get(a.id) ?? [],
      answers: answersByA.get(a.id) ?? [],
      objectRoles: objectRolesByA.get(a.id) ?? {},
    })),
  };
}

// ---------------------------------------------------------------------------
// Moves
// ---------------------------------------------------------------------------

export async function createMove(
  codebookId: string,
  { name, description, minObjects }: { name: string; description?: string; minObjects?: number },
): Promise<void> {
  await requireEditor();
  const trimmed = name.trim();
  if (!trimmed) throw new Error('createMove: name is required.');
  const { error } = await cbFrom('cb_action_moves').insert({
    codebook_id: codebookId,
    name: trimmed,
    description: cleanText(description),
    min_objects: cleanMin(minObjects ?? 1),
    position: await nextPosition('cb_action_moves', codebookId),
  });
  if (error) throw new Error(`createMove failed: ${error.message}`);
}

export async function updateMove(
  id: string,
  patch: { name?: string; description?: string | null; minObjects?: number },
): Promise<void> {
  await requireEditor();
  const row: { name?: string; description?: string | null; min_objects?: number } = {};
  if (patch.name !== undefined) {
    const t = patch.name.trim();
    if (!t) throw new Error('updateMove: name cannot be empty.');
    row.name = t;
  }
  if (patch.description !== undefined) row.description = cleanText(patch.description);
  if (patch.minObjects !== undefined) row.min_objects = cleanMin(patch.minObjects);
  const { error } = await cbFrom('cb_action_moves').update(row).eq('id', id);
  if (error) throw new Error(`updateMove failed: ${error.message}`);
}

export async function deleteMove(id: string): Promise<void> {
  await requireEditor();
  const { error } = await cbFrom('cb_action_moves').delete().eq('id', id);
  if (error) throw new Error(`deleteMove failed: ${error.message}`);
}

export async function reorderMoves(orderedIds: string[]): Promise<void> {
  await requireEditor();
  await reorder('cb_action_moves', orderedIds);
}

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

/**
 * Create an object, optionally as a SUBCLASS of `parentId` (e.g. object
 * "Scenario" with subclasses "Given scenario" / "User story"). One level only:
 * the parent must be a top-level object in the same codebook.
 */
export async function createObject(
  codebookId: string,
  { name, description, parentId }: { name: string; description?: string; parentId?: string | null },
): Promise<void> {
  await requireEditor();
  const trimmed = name.trim();
  if (!trimmed) throw new Error('createObject: name is required.');
  const parent = parentId || null;
  if (parent) {
    const problem = parentProblem(await loadObjectLites(codebookId), null, parent);
    if (problem) throw new Error(`createObject: ${problem}`);
  }
  const { error } = await cbFrom('cb_action_objects').insert({
    codebook_id: codebookId,
    name: trimmed,
    description: cleanText(description),
    parent_id: parent,
    position: await nextPosition('cb_action_objects', codebookId),
  });
  if (error) throw new Error(`createObject failed: ${error.message}`);
}

/**
 * Patch an object. `parentId: null` promotes a subclass to top level;
 * `parentId: <id>` makes it a subclass of that (top-level) object, which is
 * refused if this object has subclasses of its own (depth stays at one).
 */
export async function updateObject(
  id: string,
  patch: { name?: string; description?: string | null; parentId?: string | null },
): Promise<void> {
  await requireEditor();
  const row: { name?: string; description?: string | null; parent_id?: string | null } = {};
  if (patch.name !== undefined) {
    const t = patch.name.trim();
    if (!t) throw new Error('updateObject: name cannot be empty.');
    row.name = t;
  }
  if (patch.description !== undefined) row.description = cleanText(patch.description);
  if (patch.parentId !== undefined) {
    const parent = patch.parentId || null;
    if (parent) {
      const { data: self, error: selfErr } = await cbFrom('cb_action_objects')
        .select('codebook_id')
        .eq('id', id)
        .maybeSingle();
      if (selfErr) throw new Error(`updateObject failed: ${selfErr.message}`);
      if (!self) throw new Error('updateObject: object not found.');
      const problem = parentProblem(await loadObjectLites(self.codebook_id), id, parent);
      if (problem) throw new Error(`updateObject: ${problem}`);
    }
    row.parent_id = parent;
  }
  const { error } = await cbFrom('cb_action_objects').update(row).eq('id', id);
  if (error) throw new Error(`updateObject failed: ${error.message}`);
}

export async function deleteObject(id: string): Promise<void> {
  await requireEditor();
  const { error } = await cbFrom('cb_action_objects').delete().eq('id', id);
  if (error) throw new Error(`deleteObject failed: ${error.message}`);
}

export async function reorderObjects(orderedIds: string[]): Promise<void> {
  await requireEditor();
  await reorder('cb_action_objects', orderedIds);
}

// ---------------------------------------------------------------------------
// Roles — the list of roles an object may later be assigned (migration 49).
// ---------------------------------------------------------------------------

export async function createRole(
  codebookId: string,
  { name, description }: { name: string; description?: string },
): Promise<void> {
  await requireEditor();
  const trimmed = name.trim();
  if (!trimmed) throw new Error('createRole: name is required.');
  const { error } = await cbFrom('cb_action_roles').insert({
    codebook_id: codebookId,
    name: trimmed,
    description: cleanText(description),
    position: await nextPosition('cb_action_roles', codebookId),
  });
  if (error) throw new Error(`createRole failed: ${error.message}`);
}

export async function updateRole(
  id: string,
  patch: { name?: string; description?: string | null },
): Promise<void> {
  await requireEditor();
  const row: { name?: string; description?: string | null } = {};
  if (patch.name !== undefined) {
    const t = patch.name.trim();
    if (!t) throw new Error('updateRole: name cannot be empty.');
    row.name = t;
  }
  if (patch.description !== undefined) row.description = cleanText(patch.description);
  const { error } = await cbFrom('cb_action_roles').update(row).eq('id', id);
  if (error) throw new Error(`updateRole failed: ${error.message}`);
}

export async function deleteRole(id: string): Promise<void> {
  await requireEditor();
  const { error } = await cbFrom('cb_action_roles').delete().eq('id', id);
  if (error) throw new Error(`deleteRole failed: ${error.message}`);
}

export async function reorderRoles(orderedIds: string[]): Promise<void> {
  await requireEditor();
  await reorder('cb_action_roles', orderedIds);
}

// ---------------------------------------------------------------------------
// Questions + options
// ---------------------------------------------------------------------------

export async function createQuestion(
  codebookId: string,
  {
    prompt,
    description,
    kind,
    required,
  }: { prompt: string; description?: string; kind?: QuestionKind; required?: boolean },
): Promise<void> {
  await requireEditor();
  const trimmed = prompt.trim();
  if (!trimmed) throw new Error('createQuestion: prompt is required.');
  const { error } = await cbFrom('cb_action_questions').insert({
    codebook_id: codebookId,
    prompt: trimmed,
    description: cleanText(description),
    kind: kind ?? 'free_text',
    required: required ?? false,
    position: await nextPosition('cb_action_questions', codebookId),
  });
  if (error) throw new Error(`createQuestion failed: ${error.message}`);
}

export async function updateQuestion(
  id: string,
  patch: { prompt?: string; description?: string | null; kind?: QuestionKind; required?: boolean },
): Promise<void> {
  await requireEditor();
  const row: { prompt?: string; description?: string | null; kind?: string; required?: boolean } = {};
  if (patch.prompt !== undefined) {
    const t = patch.prompt.trim();
    if (!t) throw new Error('updateQuestion: prompt cannot be empty.');
    row.prompt = t;
  }
  if (patch.description !== undefined) row.description = cleanText(patch.description);
  if (patch.kind !== undefined) row.kind = patch.kind;
  if (patch.required !== undefined) row.required = patch.required;
  const { error } = await cbFrom('cb_action_questions').update(row).eq('id', id);
  if (error) throw new Error(`updateQuestion failed: ${error.message}`);
}

export async function deleteQuestion(id: string): Promise<void> {
  await requireEditor();
  const { error } = await cbFrom('cb_action_questions').delete().eq('id', id);
  if (error) throw new Error(`deleteQuestion failed: ${error.message}`);
}

export async function reorderQuestions(orderedIds: string[]): Promise<void> {
  await requireEditor();
  await reorder('cb_action_questions', orderedIds);
}

export async function createQuestionOption(questionId: string, label: string): Promise<void> {
  await requireEditor();
  const trimmed = label.trim();
  if (!trimmed) throw new Error('createQuestionOption: label is required.');
  const { data, error: posErr } = await cbFrom('cb_action_question_options')
    .select('position')
    .eq('question_id', questionId)
    .order('position', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (posErr) throw new Error(`createQuestionOption failed: ${posErr.message}`);
  const { error } = await cbFrom('cb_action_question_options').insert({
    question_id: questionId,
    label: trimmed,
    position: data ? data.position + 1 : 0,
  });
  if (error) throw new Error(`createQuestionOption failed: ${error.message}`);
}

/**
 * Patch an option's label and/or what happens when it is chosen. `null` clears
 * a target; an option may both trigger something and ask a follow-up. The
 * trigger is ONE of an action, an object, or a move — setting one clears the
 * other two columns (the DB check constraint refuses more than one).
 */
export async function updateQuestionOption(
  id: string,
  patch: { label?: string; trigger?: TriggerRef | null; followUpQuestionId?: string | null },
): Promise<void> {
  await requireEditor();
  const row: {
    label?: string;
    trigger_action_id?: string | null;
    trigger_object_id?: string | null;
    trigger_move_id?: string | null;
    follow_up_question_id?: string | null;
  } = {};
  if (patch.label !== undefined) {
    const t = patch.label.trim();
    if (!t) throw new Error('updateQuestionOption: label cannot be empty.');
    row.label = t;
  }
  if (patch.trigger !== undefined) {
    const t = patch.trigger;
    if (t && !t.id) throw new Error('updateQuestionOption: trigger needs a target id.');
    row.trigger_action_id = t?.kind === 'action' ? t.id : null;
    row.trigger_object_id = t?.kind === 'object' ? t.id : null;
    row.trigger_move_id = t?.kind === 'move' ? t.id : null;
  }
  if (patch.followUpQuestionId !== undefined) row.follow_up_question_id = patch.followUpQuestionId || null;
  const { error } = await cbFrom('cb_action_question_options').update(row).eq('id', id);
  if (error) throw new Error(`updateQuestionOption failed: ${error.message}`);
}

export async function deleteQuestionOption(id: string): Promise<void> {
  await requireEditor();
  const { error } = await cbFrom('cb_action_question_options').delete().eq('id', id);
  if (error) throw new Error(`deleteQuestionOption failed: ${error.message}`);
}

export async function reorderQuestionOptions(orderedIds: string[]): Promise<void> {
  await requireEditor();
  await reorder('cb_action_question_options', orderedIds);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Create an action from a draft. Validated server-side against the codebook's
 * CURRENT moves/questions (the client form mirrors the same rules), so a stale
 * form cannot save an under-specified action.
 */
export async function createAction(codebookId: string, draft: ActionDraft): Promise<string> {
  await requireEditor();
  const { moves, questions, roles } = await loadForValidation(codebookId);
  const problems = validateActionDraft(draft, moves, questions, roles);
  if (problems.length) throw new Error(problems.join(' '));

  const { data, error } = await cbFrom('cb_actions')
    .insert({
      codebook_id: codebookId,
      name: draft.name.trim(),
      description: cleanText(draft.description),
      position: await nextPosition('cb_actions', codebookId),
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`createAction failed: ${error?.message ?? 'no row returned'}`);
  await writeComposition(data.id, draft, questions, roles);
  return data.id;
}

/** Replace an action's name/description/composition/roles/answers with the draft. */
export async function updateAction(id: string, codebookId: string, draft: ActionDraft): Promise<void> {
  await requireEditor();
  const { moves, questions, roles } = await loadForValidation(codebookId);
  const problems = validateActionDraft(draft, moves, questions, roles);
  if (problems.length) throw new Error(problems.join(' '));

  const { error } = await cbFrom('cb_actions')
    .update({ name: draft.name.trim(), description: cleanText(draft.description) })
    .eq('id', id)
    .eq('codebook_id', codebookId);
  if (error) throw new Error(`updateAction failed: ${error.message}`);

  const cleared = await Promise.all([
    cbFrom('cb_action_moves_link').delete().eq('action_id', id),
    cbFrom('cb_action_objects_link').delete().eq('action_id', id),
    cbFrom('cb_action_answers').delete().eq('action_id', id),
  ]);
  const clearErr = cleared.find((r) => r.error)?.error;
  if (clearErr) throw new Error(`updateAction (clear) failed: ${clearErr.message}`);
  await writeComposition(id, draft, questions, roles);
}

export async function deleteAction(id: string): Promise<void> {
  await requireEditor();
  const { error } = await cbFrom('cb_actions').delete().eq('id', id);
  if (error) throw new Error(`deleteAction failed: ${error.message}`);
}

export async function reorderActions(orderedIds: string[]): Promise<void> {
  await requireEditor();
  await reorder('cb_actions', orderedIds);
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

type PositionedTable = 'cb_action_moves' | 'cb_action_objects' | 'cb_action_roles' | 'cb_action_questions' | 'cb_actions';
type ReorderableTable = PositionedTable | 'cb_action_question_options';

async function nextPosition(table: PositionedTable, codebookId: string): Promise<number> {
  const { data, error } = await cbFrom(table)
    .select('position')
    .eq('codebook_id', codebookId)
    .order('position', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`nextPosition(${table}) failed: ${error.message}`);
  return data ? data.position + 1 : 0;
}

/** position = array index, issued as independent updates (mirrors reorderFlagTypes). */
async function reorder(table: ReorderableTable, orderedIds: string[]): Promise<void> {
  const results = await Promise.all(
    orderedIds.map((id, index) => cbFrom(table).update({ position: index }).eq('id', id)),
  );
  const firstError = results.find((r) => r.error)?.error;
  if (firstError) throw new Error(`reorder(${table}) failed: ${firstError.message}`);
}

async function loadObjectLites(codebookId: string) {
  const { data, error } = await cbFrom('cb_action_objects').select('id, name, parent_id').eq('codebook_id', codebookId);
  if (error) throw new Error(`loadObjectLites failed: ${error.message}`);
  return (data ?? []).map((o) => ({ id: o.id, name: o.name, parentId: o.parent_id }));
}

async function loadForValidation(codebookId: string) {
  const [movesRes, questionsRes, rolesRes] = await Promise.all([
    cbFrom('cb_action_moves').select('id, name, min_objects').eq('codebook_id', codebookId),
    cbFrom('cb_action_questions').select('id, prompt, kind, required').eq('codebook_id', codebookId),
    cbFrom('cb_action_roles').select('id, name').eq('codebook_id', codebookId),
  ]);
  if (movesRes.error) throw new Error(`loadForValidation (moves) failed: ${movesRes.error.message}`);
  if (questionsRes.error) throw new Error(`loadForValidation (questions) failed: ${questionsRes.error.message}`);
  if (rolesRes.error) throw new Error(`loadForValidation (roles) failed: ${rolesRes.error.message}`);
  const qIds = (questionsRes.data ?? []).map((q) => q.id);
  const optionsRes = qIds.length
    ? await cbFrom('cb_action_question_options').select('id, label, question_id').in('question_id', qIds)
    : { data: [], error: null };
  if (optionsRes.error) throw new Error(`loadForValidation (options) failed: ${optionsRes.error.message}`);
  const optsByQ = new Map<string, { id: string; label: string }[]>();
  for (const o of optionsRes.data ?? []) {
    optsByQ.set(o.question_id, [...(optsByQ.get(o.question_id) ?? []), { id: o.id, label: o.label }]);
  }
  return {
    moves: (movesRes.data ?? []).map((m) => ({ id: m.id, name: m.name, minObjects: m.min_objects })),
    questions: (questionsRes.data ?? []).map((q) => ({
      id: q.id,
      prompt: q.prompt,
      kind: (q.kind === 'multiple_choice' ? 'multiple_choice' : 'free_text') as QuestionKind,
      required: q.required,
      options: optsByQ.get(q.id) ?? [],
    })),
    roles: (rolesRes.data ?? []).map((r) => ({ id: r.id, name: r.name })),
  };
}

/** Insert the move/object links (objects carrying their optional role) and
 *  answer rows for an action (assumes cleared). */
async function writeComposition(
  actionId: string,
  draft: ActionDraft,
  questions: Awaited<ReturnType<typeof loadForValidation>>['questions'],
  roles: Awaited<ReturnType<typeof loadForValidation>>['roles'],
): Promise<void> {
  const moveIds = Array.from(new Set(draft.moveIds));
  const objectIds = Array.from(new Set(draft.objectIds));
  const objectRoles = cleanObjectRoles(draft.objectRoles, objectIds, roles);
  const answers = answerRows(draft.answers as Record<string, AnswerDraft>, questions);
  const results = await Promise.all([
    cbFrom('cb_action_moves_link').insert(moveIds.map((move_id) => ({ action_id: actionId, move_id }))),
    cbFrom('cb_action_objects_link').insert(
      objectIds.map((object_id) => ({ action_id: actionId, object_id, role_id: objectRoles[object_id] ?? null })),
    ),
    answers.length
      ? cbFrom('cb_action_answers').insert(
          answers.map((a) => ({
            action_id: actionId,
            question_id: a.questionId,
            option_id: a.optionId,
            free_text: a.freeText,
          })),
        )
      : Promise.resolve({ error: null }),
  ]);
  const firstError = results.find((r) => r.error)?.error;
  if (firstError) throw new Error(`writeComposition failed: ${firstError.message}`);
}

function cleanText(s: string | null | undefined): string | null {
  const t = (s ?? '').trim();
  return t ? t : null;
}

function cleanMin(n: number): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 1) throw new Error('Minimum objects must be a whole number ≥ 1.');
  return v;
}
