'use server';

import { evalFrom } from '@/lib/supabase/eval-guard';
import { withStudyAudit } from '@/lib/eval/audit';
import { studyFrom } from '@/lib/supabase/study-guard';
import { requireAuthUser } from '@/lib/auth/supabase-auth';
import { getShownStudy } from '@/app/actions/codebook';
import { taskModuleIdFrom } from '@/lib/study/task-module';
import {
  GRADER_SYSTEM_PROMPT_DRAFT,
  METRIC_DRAFT,
  ORACLE_SPEC_DRAFT,
  sha256Hex,
} from '@/lib/eval/seeds';
import { annotationInsertRow, mapAnnotationRow, type AnnotationRow } from '@/lib/eval/playground/annotations';
import type { Json, Tables } from '@/lib/types/cb-db';

// ---------------------------------------------------------------------------
// Eval-harness data layer (sub-project B): artifacts (oracle spec + metric),
// prompt variants, few-shot sets, and researcher annotations.
//
// SAFETY POSTURE (spec L5): eval_* tables are the harness's OWN storage — all
// reads AND writes go through `evalFrom` (closed allowlist, user client; the
// service key never touches this path). Every action that writes wraps its
// write section in `withStudyAudit`, the pre/post study-table fingerprint
// belt: a study row count that moves across an eval write throws loudly.
// Study data (the assistant-turn corpus) is READ via `studyFrom` only — the
// SELECT-only guard over IRB tables.
//
// SELF-INITIALIZING SEEDS: `listArtifacts` inserts the DRAFT oracle-spec /
// metric from lib/eval/seeds.ts when a kind is empty; `listPromptVariants`
// seeds variant #1 from GRADER_SYSTEM_PROMPT_DRAFT (a grading persona, NOT the
// study's help-seeking prompt — the eval grades spec improvement, not help) when
// empty. Both are idempotent by the empty check. Two concurrent FIRST loads
// could double-seed — accepted: single researcher, and versions are append-only
// anyway (a duplicate seed is just one extra selectable version, never data
// loss).
//
// PII: `pid` only. `listAssistantTurnsForFewShot` never selects name/email.
// Empty-shape discipline: no rows → [] (and a missing help_seeking prompt →
// [] rather than a throw); only a genuine DB .error or invalid caller input
// throws, mirroring progression.ts / spec.ts.
// ---------------------------------------------------------------------------

export type EvalArtifact = {
  id: string;
  kind: 'oracle_spec' | 'metric';
  name: string;
  content: string;
  hash: string;
  createdAt: string;
};

export type PromptVariant = {
  id: string;
  name: string;
  systemPrompt: string;
  parentId: string | null;
  createdAt: string;
};

export type FewShotExample = {
  sourceMessageId: string | null;
  role: 'user' | 'assistant';
  content: string;
};

export type FewShotSet = {
  id: string;
  name: string;
  examples: FewShotExample[];
  createdAt: string;
};

export type AssistantTurn = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  scenarioIdx: number | null;
  pid: string;
};

// ---------------------------------------------------------------------------
// Row → interface mapping (module-private; 'use server' files may only export
// async functions + types).
// ---------------------------------------------------------------------------

function mapArtifact(row: Tables<'eval_artifacts'>): EvalArtifact {
  return {
    id: row.id,
    // `kind` is text in the DB; the two writers below only ever store these
    // two values — narrow defensively rather than assert.
    kind: row.kind === 'metric' ? 'metric' : 'oracle_spec',
    name: row.name,
    content: row.content,
    hash: row.hash,
    createdAt: row.created_at,
  };
}

function mapVariant(row: Tables<'eval_prompt_variants'>): PromptVariant {
  return {
    id: row.id,
    name: row.name,
    systemPrompt: row.system_prompt,
    parentId: row.parent_id,
    createdAt: row.created_at,
  };
}

/** Coerce one stored jsonb example; malformed entries are DROPPED, not thrown
 *  on (saveFewShotSet validates on write, so a drop means hand-edited data). */
function coerceFewShotExample(raw: unknown): FewShotExample | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.content !== 'string' || e.content === '') return null;
  if (e.role !== 'user' && e.role !== 'assistant') return null;
  return {
    sourceMessageId: typeof e.sourceMessageId === 'string' ? e.sourceMessageId : null,
    role: e.role,
    content: e.content,
  };
}

function mapFewShotSet(row: Tables<'eval_few_shot_sets'>): FewShotSet {
  const raw = Array.isArray(row.examples) ? row.examples : [];
  return {
    id: row.id,
    name: row.name,
    examples: raw
      .map(coerceFewShotExample)
      .filter((e): e is FewShotExample => e !== null),
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Artifacts (oracle spec + metric) — append-only versions, newest first.
// ---------------------------------------------------------------------------

/**
 * All versions of `kind`, newest first. Self-initializing: an empty kind gets
 * the DRAFT seed inserted (audited) and returned as the single version, so the
 * harness never renders an artifact-less state.
 */
export async function listArtifacts(kind: 'oracle_spec' | 'metric'): Promise<EvalArtifact[]> {
  await requireAuthUser();

  const res = await (await evalFrom('eval_artifacts'))
    .select('*')
    .eq('kind', kind)
    .order('created_at', { ascending: false });
  if (res.error) {
    throw new Error(`listArtifacts: eval_artifacts read failed: ${res.error.message}`);
  }
  const rows = res.data ?? [];
  if (rows.length > 0) return rows.map(mapArtifact);

  const content = kind === 'oracle_spec' ? ORACLE_SPEC_DRAFT : METRIC_DRAFT;
  const name = kind === 'oracle_spec' ? 'oracle-spec.md (DRAFT)' : 'metric.md (DRAFT)';
  const inserted = await withStudyAudit('listArtifacts', async () => {
    const ins = await (await evalFrom('eval_artifacts'))
      .insert({ kind, name, content, hash: sha256Hex(content) })
      .select('*')
      .single();
    if (ins.error) {
      throw new Error(`listArtifacts: DRAFT seed insert failed: ${ins.error.message}`);
    }
    return ins.data;
  });
  return [mapArtifact(inserted)];
}

/**
 * Append a new artifact VERSION (never updates an existing row — the version
 * history is the provenance trail for every verdict's config_hash).
 */
export async function saveArtifact(
  kind: 'oracle_spec' | 'metric',
  name: string,
  content: string,
): Promise<EvalArtifact> {
  await requireAuthUser();

  const cleanName = (name ?? '').trim();
  const cleanContent = (content ?? '').trim();
  if (!cleanName) throw new Error('saveArtifact: name must be non-empty.');
  if (!cleanContent) throw new Error('saveArtifact: content must be non-empty.');

  const inserted = await withStudyAudit('saveArtifact', async () => {
    const ins = await (await evalFrom('eval_artifacts'))
      .insert({ kind, name: cleanName, content: cleanContent, hash: sha256Hex(cleanContent) })
      .select('*')
      .single();
    if (ins.error) {
      throw new Error(`saveArtifact: eval_artifacts insert failed: ${ins.error.message}`);
    }
    return ins.data;
  });
  return mapArtifact(inserted);
}

// ---------------------------------------------------------------------------
// Prompt variants — a lineage tree rooted at the study's live prompt.
// ---------------------------------------------------------------------------

/**
 * All prompt variants, newest first. Self-initializing: when empty, variant #1
 * is seeded from GRADER_SYSTEM_PROMPT_DRAFT — a GRADING persona (evaluate how
 * student specs improve across iterations), NOT the study's help-seeking prompt.
 * The eval measures spec improvement, so the grader's system prompt must not
 * adopt a help-seeking assistant role (that role contradiction biased every
 * verdict). The DRAFT is a proposal Hudson edits; saving forks child variants
 * whose lineage traces back to it.
 */
export async function listPromptVariants(): Promise<PromptVariant[]> {
  await requireAuthUser();

  const res = await (await evalFrom('eval_prompt_variants'))
    .select('*')
    .order('created_at', { ascending: false });
  if (res.error) {
    throw new Error(`listPromptVariants: eval_prompt_variants read failed: ${res.error.message}`);
  }
  const rows = res.data ?? [];
  if (rows.length > 0) return rows.map(mapVariant);

  const inserted = await withStudyAudit('listPromptVariants', async () => {
    const ins = await (await evalFrom('eval_prompt_variants'))
      .insert({
        name: 'grader-system-prompt (DRAFT)',
        system_prompt: GRADER_SYSTEM_PROMPT_DRAFT,
        parent_id: null,
      })
      .select('*')
      .single();
    if (ins.error) {
      throw new Error(`listPromptVariants: seed insert failed: ${ins.error.message}`);
    }
    return ins.data;
  });
  return [mapVariant(inserted)];
}

export async function savePromptVariant(
  name: string,
  systemPrompt: string,
  parentId: string | null,
): Promise<PromptVariant> {
  await requireAuthUser();

  const cleanName = (name ?? '').trim();
  if (!cleanName) throw new Error('savePromptVariant: name must be non-empty.');
  if (!(systemPrompt ?? '').trim()) {
    throw new Error('savePromptVariant: systemPrompt must be non-empty.');
  }

  const inserted = await withStudyAudit('savePromptVariant', async () => {
    const ins = await (await evalFrom('eval_prompt_variants'))
      .insert({ name: cleanName, system_prompt: systemPrompt, parent_id: parentId })
      .select('*')
      .single();
    if (ins.error) {
      throw new Error(`savePromptVariant: eval_prompt_variants insert failed: ${ins.error.message}`);
    }
    return ins.data;
  });
  return mapVariant(inserted);
}

// ---------------------------------------------------------------------------
// Few-shot sets — curated example lists stored as jsonb.
// ---------------------------------------------------------------------------

export async function listFewShotSets(): Promise<FewShotSet[]> {
  await requireAuthUser();

  const res = await (await evalFrom('eval_few_shot_sets'))
    .select('*')
    .order('created_at', { ascending: false });
  if (res.error) {
    throw new Error(`listFewShotSets: eval_few_shot_sets read failed: ${res.error.message}`);
  }
  return (res.data ?? []).map(mapFewShotSet);
}

export async function saveFewShotSet(
  name: string,
  examples: FewShotExample[],
): Promise<FewShotSet> {
  await requireAuthUser();

  const cleanName = (name ?? '').trim();
  if (!cleanName) throw new Error('saveFewShotSet: name must be non-empty.');
  const cleanExamples = (examples ?? []).map((e, i) => {
    if (e.role !== 'user' && e.role !== 'assistant') {
      throw new Error(
        `saveFewShotSet: examples[${i}].role must be 'user' or 'assistant' (got ${JSON.stringify(e.role)}).`,
      );
    }
    if (typeof e.content !== 'string' || !e.content.trim()) {
      throw new Error(`saveFewShotSet: examples[${i}].content must be non-empty.`);
    }
    return {
      sourceMessageId: e.sourceMessageId ?? null,
      role: e.role,
      content: e.content,
    };
  });

  const inserted = await withStudyAudit('saveFewShotSet', async () => {
    const ins = await (await evalFrom('eval_few_shot_sets'))
      .insert({ name: cleanName, examples: cleanExamples as Json })
      .select('*')
      .single();
    if (ins.error) {
      throw new Error(`saveFewShotSet: eval_few_shot_sets insert failed: ${ins.error.message}`);
    }
    return ins.data;
  });
  return mapFewShotSet(inserted);
}

// ---------------------------------------------------------------------------
// Assistant-turn corpus (READ-ONLY study access) — the picker's source list.
// ---------------------------------------------------------------------------

/**
 * Every assistant-chat turn on the task module, chronological, with the
 * author's pid (pid ONLY — name/email never leave this layer). Source list
 * for curating few-shot examples out of the real study corpus.
 *
 * Module scoping mirrors progression.ts: filter to the shown study's task
 * module when it resolves; when authored_data is malformed and no module id
 * resolves, include ALL turns rather than silently guessing (fail-open on
 * scope — every current turn is on the task module anyway, and a broader list
 * only ever adds candidates for a human picker).
 */
export async function listAssistantTurnsForFewShot(): Promise<AssistantTurn[]> {
  await requireAuthUser();

  const moduleId = taskModuleIdFrom((await getShownStudy())?.authored_data ?? null);

  let turnQuery = (await studyFrom('study_assistant_messages'))
    .select('id, user_id, role, content, scenario_idx')
    .order('created_at', { ascending: true });
  if (moduleId) turnQuery = turnQuery.eq('module_id', moduleId);
  const turnRes = await turnQuery;
  if (turnRes.error) {
    throw new Error(
      `listAssistantTurnsForFewShot: study_assistant_messages read failed: ${turnRes.error.message}`,
    );
  }
  const rows = turnRes.data ?? [];
  if (rows.length === 0) return [];

  // One users read for the pid map (pid ONLY).
  const userRes = await (await studyFrom('users'))
    .select('id, pid')
    .in('id', [...new Set(rows.map((r) => r.user_id))]);
  if (userRes.error) {
    throw new Error(`listAssistantTurnsForFewShot: users read failed: ${userRes.error.message}`);
  }
  const pidById = new Map((userRes.data ?? []).map((u) => [u.id, u.pid]));

  return rows.map((r) => ({
    id: r.id,
    // `role` is text in the DB; the writer only stores user/assistant. Narrow
    // any non-'user' value to 'assistant' defensively rather than drop a turn.
    role: r.role === 'user' ? ('user' as const) : ('assistant' as const),
    content: r.content,
    scenarioIdx: r.scenario_idx,
    // FK guarantees the user row exists; '' is unreachable-but-typed.
    pid: pidById.get(r.user_id) ?? '',
  }));
}

// ---------------------------------------------------------------------------
// Annotations — free-form researcher observations, foldable into variants.
// ---------------------------------------------------------------------------

/** A researcher annotation the fold panel can act on — the id is REAL (returned
 *  from the insert, listed by `listUnfoldedAnnotations`) so the checkbox fold no
 *  longer needs pasted ids. PII: none — run/verdict ids are the context, never
 *  pid/name/email (spec L5). */
// AnnotationRow's shape + its snake→camel mapper live in the pure playground
// module so the mapping is unit-tested (a field transposition type-checks);
// re-exported here so existing consumers keep importing it from the action.
export type { AnnotationRow };

export async function saveAnnotation(input: {
  runId?: string;
  verdictId?: string;
  pid?: string;
  phaseOrdinal?: number;
  scenarioIdx?: number;
  note: string;
}): Promise<{ id: string }> {
  await requireAuthUser();

  const note = (input?.note ?? '').trim();
  if (!note) throw new Error('saveAnnotation: note must be non-empty.');

  const inserted = await withStudyAudit('saveAnnotation', async () => {
    const ins = await (await evalFrom('eval_annotations'))
      .insert(annotationInsertRow({ ...input, note }))
      .select('id')
      .single();
    if (ins.error) {
      throw new Error(`saveAnnotation: eval_annotations insert failed: ${ins.error.message}`);
    }
    return ins.data;
  });
  return { id: inserted.id };
}

/**
 * Every not-yet-folded researcher annotation, newest first — the fold panel's
 * checkbox source. A READ (no `withStudyAudit`; the belt guards writes only),
 * through `evalFrom` on the researcher JWT. Folded rows drop off (their
 * `folded_into_variant_id` is stamped), so the list shrinks as observations get
 * acted on. PII: pid-only posture — `pid` here is the study's own de-identified
 * id (the per-cell review coordinate), never first_name/email; the run/verdict
 * ids + (pid · phase · scenario) coordinates ARE the context.
 */
export async function listUnfoldedAnnotations(): Promise<AnnotationRow[]> {
  await requireAuthUser();

  const res = await (await evalFrom('eval_annotations'))
    .select('id, note, run_id, verdict_id, pid, phase_ordinal, scenario_idx, created_at')
    .is('folded_into_variant_id', null)
    .order('created_at', { ascending: false });
  if (res.error) {
    throw new Error(`listUnfoldedAnnotations: eval_annotations read failed: ${res.error.message}`);
  }
  return (res.data ?? []).map(mapAnnotationRow);
}

/**
 * Fold researcher annotations into a NEW prompt variant: child of
 * `baseVariantId`, whose system prompt is the base's plus a dated
 * "## Researcher annotations" section listing the notes. The folded
 * annotations are stamped with the new variant's id so the UI can show
 * which observations have already been acted on.
 *
 * PARTIAL-FAILURE SEMANTICS (no transactions without .rpc, which is banned):
 * the variant insert and the fold-stamp update are two statements. If the
 * stamp fails after the insert, the new variant exists but its annotations
 * still read as unfolded — the variant is INERT (nothing references it until
 * a run selects it); re-folding creates a duplicate child, which append-only
 * versioning tolerates. Delete or ignore the orphan; acceptable for a
 * single-researcher tool.
 */
export async function foldAnnotationsIntoVariant(
  annotationIds: string[],
  baseVariantId: string,
  newName: string,
): Promise<PromptVariant> {
  await requireAuthUser();

  const cleanName = (newName ?? '').trim();
  if (!cleanName) throw new Error('foldAnnotationsIntoVariant: newName must be non-empty.');
  if (!annotationIds || annotationIds.length === 0) {
    throw new Error('foldAnnotationsIntoVariant: at least one annotation id is required.');
  }

  const inserted = await withStudyAudit('foldAnnotationsIntoVariant', async () => {
    const baseRes = await (await evalFrom('eval_prompt_variants'))
      .select('*')
      .eq('id', baseVariantId)
      .maybeSingle();
    if (baseRes.error) {
      throw new Error(
        `foldAnnotationsIntoVariant: base variant read failed: ${baseRes.error.message}`,
      );
    }
    if (!baseRes.data) {
      throw new Error(`foldAnnotationsIntoVariant: base variant ${baseVariantId} not found.`);
    }

    // Chronological note order so the folded section reads as observed.
    const annRes = await (await evalFrom('eval_annotations'))
      .select('id, note')
      .in('id', annotationIds)
      .order('created_at', { ascending: true });
    if (annRes.error) {
      throw new Error(
        `foldAnnotationsIntoVariant: annotations read failed: ${annRes.error.message}`,
      );
    }
    const annotations = annRes.data ?? [];
    if (annotations.length === 0) {
      throw new Error('foldAnnotationsIntoVariant: none of the annotation ids were found.');
    }
    // Fail LOUD on stale ids rather than silently folding a shrunken set —
    // a partial fold would misrepresent which observations shaped the variant.
    if (annotations.length !== new Set(annotationIds).size) {
      throw new Error(
        `foldAnnotationsIntoVariant: ${new Set(annotationIds).size - annotations.length} annotation id(s) did not resolve — refusing a partial fold.`,
      );
    }

    const systemPrompt =
      baseRes.data.system_prompt +
      '\n\n## Researcher annotations (folded ' +
      new Date().toISOString().slice(0, 10) +
      ')\n' +
      annotations.map((a) => '- ' + a.note).join('\n');

    const ins = await (await evalFrom('eval_prompt_variants'))
      .insert({ name: cleanName, system_prompt: systemPrompt, parent_id: baseVariantId })
      .select('*')
      .single();
    if (ins.error) {
      throw new Error(
        `foldAnnotationsIntoVariant: variant insert failed: ${ins.error.message}`,
      );
    }

    const upd = await (await evalFrom('eval_annotations'))
      .update({ folded_into_variant_id: ins.data.id })
      .in(
        'id',
        annotations.map((a) => a.id),
      );
    if (upd.error) {
      throw new Error(
        `foldAnnotationsIntoVariant: annotation fold-stamp failed: ${upd.error.message}`,
      );
    }
    return ins.data;
  });
  return mapVariant(inserted);
}
