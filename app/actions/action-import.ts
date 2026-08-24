'use server';

import { requireEditor } from '@/lib/auth/roles';
import { planActionImport, type ImportPlan, type ImportVocab, type VocabAdds } from '@/lib/actions/import';
import { createAction, createMove, createObject, createRole, getActionSchema } from '@/app/actions/action-schema';

// ---------------------------------------------------------------------------
// Action import (Action Import Schema v2) — Markdown with ```action YAML
// blocks → reusable actions in this codebook.
//
// Two steps over the SAME pure planner so the preview the researcher approves
// is exactly what gets written: `previewActionImport` returns the plan;
// `commitActionImport` first creates the moves / objects / roles the plan
// says are missing (through the ordinary createMove / createObject /
// createRole), reloads the vocabulary, re-plans (the catalog may also have
// moved since the preview) and creates every `create` row through the
// ordinary `createAction` path — same validation, same position bookkeeping,
// same editor gate.
// ---------------------------------------------------------------------------

export type ImportResult = {
  created: { name: string; id: string }[];
  /** Blocks skipped because their signature already existed (in the study or earlier in the file). */
  skipped: number;
  /** Blocks that could not be imported: either planned as errors or refused by createAction. */
  failed: { index: number; name: string | null; errors: string[] }[];
  /** Vocabulary rows created so the file's actions could resolve. */
  vocabAdded: VocabAdds;
  plan: ImportPlan;
};

const MAX_BYTES = 512 * 1024;

export async function previewActionImport(codebookId: string, markdown: string): Promise<ImportPlan> {
  await requireEditor();
  guardSize(markdown);
  return planActionImport(markdown, await loadVocab(codebookId));
}

export async function commitActionImport(codebookId: string, markdown: string): Promise<ImportResult> {
  await requireEditor();
  guardSize(markdown);
  const first = planActionImport(markdown, await loadVocab(codebookId));
  const empty: VocabAdds = { moves: [], objects: [], roles: [] };
  if (first.fileErrors.length) return { created: [], skipped: 0, failed: [], vocabAdded: empty, plan: first };

  const vocabAdded = await addMissingVocab(codebookId, first.vocabAdds);
  // Re-plan against the live vocabulary: the pending ids become real rows.
  const plan = planActionImport(markdown, await loadVocab(codebookId));
  const result: ImportResult = { created: [], skipped: 0, failed: [], vocabAdded, plan };

  // Sequential on purpose: createAction assigns position = max + 1, so
  // concurrent inserts would collide on position and scramble the file order.
  for (const item of plan.items) {
    if (item.status === 'duplicate' || item.status === 'repeat') {
      result.skipped += 1;
      continue;
    }
    if (item.status === 'error') {
      result.failed.push({ index: item.index, name: item.name, errors: item.errors });
      continue;
    }
    try {
      const id = await createAction(codebookId, item.draft);
      result.created.push({ name: item.draft.name, id });
    } catch (err) {
      result.failed.push({
        index: item.index,
        name: item.name,
        errors: [err instanceof Error ? err.message : 'createAction failed.'],
      });
    }
  }
  return result;
}

/**
 * Create the moves, roles and objects the plan found missing — tops first,
 * then subclasses under their (now existing) parent. Sequential: each create
 * takes position = max + 1. Returns what was actually created; a subclass
 * whose parent cannot be found afterwards is left out (the re-plan will then
 * report that block as an error rather than silently attaching it elsewhere).
 */
async function addMissingVocab(codebookId: string, adds: VocabAdds): Promise<VocabAdds> {
  const added: VocabAdds = { moves: [], objects: [], roles: [] };
  for (const name of adds.moves) {
    await createMove(codebookId, { name });
    added.moves.push(name);
  }
  for (const name of adds.roles) {
    await createRole(codebookId, { name });
    added.roles.push(name);
  }
  for (const o of adds.objects.filter((x) => x.parent === null)) {
    await createObject(codebookId, { name: o.name });
    added.objects.push(o);
  }
  const subs = adds.objects.filter((x) => x.parent !== null);
  if (subs.length) {
    const tops = (await loadVocab(codebookId)).objects.filter((x) => x.parentId === null);
    for (const o of subs) {
      const want = o.parent!.trim().toLowerCase().replace(/\s+/g, ' ');
      const parent =
        tops.find((t) => t.name.trim() === o.parent!.trim()) ??
        tops.find((t) => t.name.trim().toLowerCase().replace(/\s+/g, ' ') === want);
      if (!parent) continue;
      await createObject(codebookId, { name: o.name, parentId: parent.id });
      added.objects.push(o);
    }
  }
  return added;
}

async function loadVocab(codebookId: string): Promise<ImportVocab> {
  const s = await getActionSchema(codebookId);
  return {
    moves: s.moves.map((m) => ({ id: m.id, name: m.name, minObjects: m.minObjects })),
    objects: s.objects.map((o) => ({ id: o.id, name: o.name, parentId: o.parentId })),
    roles: s.roles.map((r) => ({ id: r.id, name: r.name })),
    questions: s.questions.map((q) => ({
      id: q.id,
      prompt: q.prompt,
      kind: q.kind,
      required: q.required,
      options: q.options.map((o) => ({ id: o.id, label: o.label })),
    })),
    actions: s.actions.map((a) => ({
      id: a.id,
      name: a.name,
      moveIds: a.moveIds,
      objectIds: a.objectIds,
      answers: a.answers,
      objectRoles: a.objectRoles,
    })),
  };
}

function guardSize(markdown: string): void {
  if (typeof markdown !== 'string') throw new Error('Import expects the file contents as text.');
  if (markdown.length > MAX_BYTES) throw new Error('Import file is too large (limit 512 KB).');
}
