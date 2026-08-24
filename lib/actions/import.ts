/**
 * import — pure helpers for the Action Import Schema v2 (Markdown + fenced
 * ```action YAML blocks).
 *
 * No I/O: `planActionImport` turns a file's text plus the study's CURRENT
 * vocabulary into a plan — one row per block saying whether it would be
 * created, is already in the study (same composition key), repeats an earlier
 * block in the same file, or cannot be resolved and why. The server action
 * executes the `create` rows; the client renders the plan as a preview.
 *
 * The file defines ACTIONS. Moves, objects, subclasses and roles it names that
 * are not yet in the study are ADDED on import (the plan lists them under
 * `vocabAdds`; the server creates them before the actions). Questions and their
 * options must already exist — a question needs a kind and options the file
 * cannot express. Names are matched trimmed and case-insensitively (an exact
 * trimmed match wins when that is ambiguous).
 * An action's NAME is not its identity — `compositionKey` is — so two blocks
 * may share a name when their signatures differ, and a block whose signature
 * already exists in the study is reported as a duplicate, not re-created.
 */

import { parse as parseYaml } from 'yaml';
import {
  answerRows,
  compositionKey,
  compositionLabel,
  validateActionDraft,
  type ActionDraft,
  type AnswerDraft,
  type CompositionAnswer,
  type MoveLite,
  type ObjectLite,
  type ObjectRoles,
  type QuestionLite,
  type RoleLite,
} from './schema';

export const IMPORT_SCHEMA_VERSION = 2;

export type ImportVocab = {
  moves: MoveLite[];
  objects: ObjectLite[];
  roles: RoleLite[];
  questions: QuestionLite[];
  actions: {
    id: string;
    name: string;
    moveIds: string[];
    objectIds: string[];
    answers: CompositionAnswer[];
    objectRoles?: ObjectRoles;
  }[];
};

export type ImportBlock = { index: number; line: number; body: string };

type ItemBase = { index: number; line: number; name: string | null };

export type ImportItem =
  | (ItemBase & { status: 'create'; draft: ActionDraft; summary: string })
  | (ItemBase & { status: 'duplicate'; draft: ActionDraft; summary: string; existingName: string })
  | (ItemBase & { status: 'repeat'; draft: ActionDraft; summary: string; ofIndex: number })
  | (ItemBase & { status: 'error'; errors: string[] });

/**
 * Vocabulary the file names that the study does not have yet. The server
 * creates these (moves and roles as-is, top-level objects, then subclasses
 * under `parent` — an existing or just-added top-level object name) before it
 * creates the actions. Names are the first spelling seen in the file, trimmed.
 */
export type VocabAdds = {
  moves: string[];
  objects: { name: string; parent: string | null }[];
  roles: string[];
};

export type ImportPlan = {
  /** Problems with the file as a whole (missing/unsupported schema_version, no blocks). */
  fileErrors: string[];
  items: ImportItem[];
  counts: { create: number; duplicate: number; repeat: number; error: number };
  /** Moves / objects / roles that will be added so the `create` rows resolve. */
  vocabAdds: VocabAdds;
};

// ---------------------------------------------------------------------------
// 1. Split the Markdown into the schema_version declaration + ```action blocks
// ---------------------------------------------------------------------------

const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})\s*([\w.+-]*)\s*$/;
const SCHEMA_LINE = /^\s*schema_version\s*:\s*(.+?)\s*$/;

/**
 * Find `schema_version:` (bare or inside a ```yaml fence — the first one wins)
 * and every ```action fenced block, with its 1-based starting line.
 */
export function splitActionBlocks(markdown: string): { schemaVersion: string | null; blocks: ImportBlock[] } {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ImportBlock[] = [];
  let schemaVersion: string | null = null;
  let open: { fence: string; lang: string; startLine: number; body: string[] } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (open) {
      const close = line.match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === open.fence[0] && close[1].length >= open.fence.length) {
        if (open.lang === 'action') {
          blocks.push({ index: blocks.length, line: open.startLine, body: open.body.join('\n') });
        }
        open = null;
        continue;
      }
      open.body.push(line);
      if (schemaVersion === null && open.lang !== 'action') {
        const m = line.match(SCHEMA_LINE);
        if (m) schemaVersion = stripQuotes(m[1]);
      }
      continue;
    }
    const fence = line.match(FENCE_OPEN);
    if (fence) {
      open = { fence: fence[1], lang: fence[2].toLowerCase(), startLine: i + 2, body: [] };
      continue;
    }
    if (schemaVersion === null) {
      const m = line.match(SCHEMA_LINE);
      if (m) schemaVersion = stripQuotes(m[1]);
    }
  }
  return { schemaVersion, blocks };
}

function stripQuotes(s: string): string {
  const t = s.trim();
  return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) ? t.slice(1, -1) : t;
}

// ---------------------------------------------------------------------------
// 2. Parse one block's YAML into a shape-checked record
// ---------------------------------------------------------------------------

type RawObject = { object: string; subclass: string | null; role: string | null };
type RawAnswer = { type: string | null; value: unknown };
type RawQuestion = { question: string; answer: RawAnswer };
export type RawAction = {
  name: string;
  description: string | null;
  move: string;
  objects: RawObject[];
  questions: RawQuestion[];
};

const TOP_KEYS = new Set(['name', 'description', 'move', 'objects', 'questions']);
const OBJECT_KEYS = new Set(['object', 'subclass', 'role']);
const QUESTION_KEYS = new Set(['question', 'answer']);
const ANSWER_KEYS = new Set(['type', 'value']);

/** Parse a block's body. Returns the raw action or the list of shape problems. */
export function parseActionBlock(body: string): { raw: RawAction } | { errors: string[] } {
  if (!body.trim()) return { errors: ['Block is empty.'] };
  let doc: unknown;
  try {
    doc = parseYaml(body);
  } catch (e) {
    return { errors: [`YAML: ${e instanceof Error ? e.message.split('\n')[0] : 'could not parse'}`] };
  }
  if (!isRecord(doc)) return { errors: ['Block must be a YAML mapping (name:, move:, objects:, …).'] };

  const errors: string[] = [];
  for (const k of Object.keys(doc)) {
    if (!TOP_KEYS.has(k)) errors.push(`Unknown key “${k}” (allowed: name, description, move, objects, questions).`);
  }

  const name = asTrimmed(doc.name);
  if (name === undefined) errors.push('`name` must be a string.');
  else if (!name) errors.push('`name` is required and must not be empty.');

  const description = doc.description === undefined || doc.description === null ? null : asTrimmed(doc.description);
  if (description === undefined) errors.push('`description` must be a string.');

  const move = asTrimmed(doc.move);
  if (move === undefined) errors.push('`move` must be a string.');
  else if (!move) errors.push('`move` is required (exactly one existing move).');
  if (Array.isArray(doc.move)) errors.push('`move` names exactly one move — two simultaneous moves are two actions.');
  if ('moves' in doc) errors.push('Use `move:` (singular) — an action has exactly one move.');

  const objects: RawObject[] = [];
  if (doc.objects === undefined || doc.objects === null) {
    errors.push('`objects` is required (a list of at least one object).');
  } else if (!Array.isArray(doc.objects)) {
    errors.push('`objects` must be a list.');
  } else {
    if (doc.objects.length === 0) errors.push('`objects` must list at least one object.');
    doc.objects.forEach((o, i) => {
      const at = `objects[${i}]`;
      if (typeof o === 'string') {
        // Lenient: a bare string is the object name.
        const t = o.trim();
        if (!t) errors.push(`${at}: object name is empty.`);
        else objects.push({ object: t, subclass: null, role: null });
        return;
      }
      if (!isRecord(o)) {
        errors.push(`${at}: must be a mapping with \`object:\` (and optional subclass / role).`);
        return;
      }
      for (const k of Object.keys(o)) if (!OBJECT_KEYS.has(k)) errors.push(`${at}: unknown key “${k}”.`);
      const obj = asTrimmed(o.object);
      if (!obj) errors.push(`${at}: \`object\` is required.`);
      const sub = o.subclass === undefined || o.subclass === null ? null : asTrimmed(o.subclass);
      if (sub === undefined) errors.push(`${at}: \`subclass\` must be a string.`);
      const role = o.role === undefined || o.role === null ? null : asTrimmed(o.role);
      if (role === undefined) errors.push(`${at}: \`role\` must be a string.`);
      if (obj) objects.push({ object: obj, subclass: sub || null, role: role || null });
    });
  }

  const questions: RawQuestion[] = [];
  if (doc.questions !== undefined && doc.questions !== null) {
    if (!Array.isArray(doc.questions)) {
      errors.push('`questions` must be a list.');
    } else {
      doc.questions.forEach((q, i) => {
        const at = `questions[${i}]`;
        if (!isRecord(q)) {
          errors.push(`${at}: must be a mapping with \`question:\` and \`answer:\`.`);
          return;
        }
        for (const k of Object.keys(q)) if (!QUESTION_KEYS.has(k)) errors.push(`${at}: unknown key “${k}”.`);
        const prompt = asTrimmed(q.question);
        if (!prompt) errors.push(`${at}: \`question\` is required.`);
        let answer: RawAnswer | null = null;
        if (q.answer === undefined || q.answer === null) {
          errors.push(`${at}: \`answer\` is required (omit the question instead of leaving it blank).`);
        } else if (isRecord(q.answer)) {
          for (const k of Object.keys(q.answer)) if (!ANSWER_KEYS.has(k)) errors.push(`${at}.answer: unknown key “${k}”.`);
          const type = q.answer.type === undefined || q.answer.type === null ? null : asTrimmed(q.answer.type);
          if (type === undefined) errors.push(`${at}.answer: \`type\` must be a string.`);
          if (!('value' in q.answer)) errors.push(`${at}.answer: \`value\` is required.`);
          answer = { type: type || null, value: q.answer.value };
        } else {
          // Lenient: a bare scalar is the value.
          answer = { type: null, value: q.answer };
        }
        if (prompt && answer) questions.push({ question: prompt, answer });
      });
    }
  }

  if (errors.length) return { errors };
  return {
    raw: { name: name!, description: description ?? null, move: move!, objects, questions },
  };
}

// ---------------------------------------------------------------------------
// 3. Resolve names → ids against the vocabulary and build an ActionDraft
// ---------------------------------------------------------------------------

const OPTION_TYPES = new Set(['option', 'choice', 'multiple_choice', 'multiple-choice', 'mc', 'select']);
const TEXT_TYPES = new Set(['text', 'free_text', 'free-text', 'string', 'freetext']);

/** Build the draft for one parsed block, or every reason it cannot be built. */
export function resolveAction(raw: RawAction, vocab: ImportVocab): { draft: ActionDraft } | { errors: string[] } {
  const errors: string[] = [];

  const move = findByName(vocab.moves, raw.move, (m) => m.name);
  if (move.kind === 'missing') errors.push(`Move “${raw.move}” does not exist.`);
  if (move.kind === 'ambiguous') errors.push(`Move “${raw.move}” matches several moves — fix the vocabulary first.`);

  const tops = vocab.objects.filter((o) => o.parentId === null);
  const objectIds: string[] = [];
  const objectRoles: ObjectRoles = {};
  raw.objects.forEach((ro, i) => {
    const at = `objects[${i}]`;
    const top = findByName(tops, ro.object, (o) => o.name);
    if (top.kind !== 'found') {
      const asSub = findByName(
        vocab.objects.filter((o) => o.parentId !== null),
        ro.object,
        (o) => o.name,
      );
      if (asSub.kind === 'found') {
        const parent = vocab.objects.find((o) => o.id === asSub.item.parentId);
        errors.push(
          `${at}: “${ro.object}” is a subclass of “${parent?.name ?? '?'}” — write object: "${parent?.name ?? '?'}", subclass: "${asSub.item.name}".`,
        );
      } else if (top.kind === 'ambiguous') {
        errors.push(`${at}: object “${ro.object}” matches several objects — fix the vocabulary first.`);
      } else {
        errors.push(`${at}: object “${ro.object}” does not exist.`);
      }
      return;
    }
    let chosen: ObjectLite = top.item;
    if (ro.subclass) {
      const children = vocab.objects.filter((o) => o.parentId === top.item.id);
      const sub = findByName(children, ro.subclass, (o) => o.name);
      if (sub.kind === 'found') chosen = sub.item;
      else if (sub.kind === 'ambiguous') errors.push(`${at}: subclass “${ro.subclass}” is ambiguous under “${top.item.name}”.`);
      else errors.push(`${at}: “${top.item.name}” has no subclass “${ro.subclass}”.`);
      if (sub.kind !== 'found') return;
    }
    if (objectIds.includes(chosen.id)) {
      errors.push(`${at}: “${labelOf(vocab.objects, chosen)}” is listed twice — an action names each object once (one role per object).`);
      return;
    }
    objectIds.push(chosen.id);
    if (ro.role) {
      const role = findByName(vocab.roles, ro.role, (r) => r.name);
      if (role.kind === 'found') objectRoles[chosen.id] = role.item.id;
      else if (role.kind === 'ambiguous') errors.push(`${at}: role “${ro.role}” matches several roles.`);
      else errors.push(`${at}: role “${ro.role}” does not exist.`);
    }
  });

  const answers: Record<string, AnswerDraft> = {};
  raw.questions.forEach((rq, i) => {
    const at = `questions[${i}]`;
    const q = findByName(vocab.questions, rq.question, (x) => x.prompt);
    if (q.kind === 'missing') return void errors.push(`${at}: question “${rq.question}” does not exist.`);
    if (q.kind === 'ambiguous') return void errors.push(`${at}: question “${rq.question}” matches several questions.`);
    if (answers[q.item.id]) return void errors.push(`${at}: question “${q.item.prompt}” is answered twice.`);

    const type = rq.answer.type?.toLowerCase() ?? null;
    const wantsOption = q.item.kind === 'multiple_choice';
    if (type && !OPTION_TYPES.has(type) && !TEXT_TYPES.has(type)) {
      return void errors.push(`${at}.answer: unknown type “${rq.answer.type}” (use option or text).`);
    }
    if (type && wantsOption && TEXT_TYPES.has(type)) {
      return void errors.push(`${at}.answer: “${q.item.prompt}” is multiple choice — give type: option and an option label.`);
    }
    if (type && !wantsOption && OPTION_TYPES.has(type)) {
      return void errors.push(`${at}.answer: “${q.item.prompt}” is free text — give type: text.`);
    }

    const value = scalarToString(rq.answer.value);
    if (value === null) return void errors.push(`${at}.answer: \`value\` must be a single scalar (text or an option label).`);
    if (!value) return void errors.push(`${at}.answer: \`value\` is empty.`);

    if (wantsOption) {
      const opt = findByName(q.item.options, value, (o) => o.label);
      if (opt.kind === 'found') answers[q.item.id] = { optionId: opt.item.id };
      else if (opt.kind === 'ambiguous') errors.push(`${at}.answer: option “${value}” is ambiguous for “${q.item.prompt}”.`);
      else
        errors.push(
          `${at}.answer: “${q.item.prompt}” has no option “${value}” (options: ${q.item.options.map((o) => o.label).join(', ') || 'none'}).`,
        );
    } else {
      answers[q.item.id] = { text: value };
    }
  });

  if (errors.length) return { errors };
  const draft: ActionDraft = {
    name: raw.name,
    description: raw.description,
    moveIds: move.kind === 'found' ? [move.item.id] : [],
    objectIds,
    answers,
    objectRoles,
  };
  const problems = validateActionDraft(draft, vocab.moves, vocab.questions, vocab.roles);
  if (problems.length) return { errors: problems };
  return { draft };
}

// ---------------------------------------------------------------------------
// 3½. Missing moves / objects / roles: collect them and extend the vocabulary
//     with PROVISIONAL entries (ids prefixed `pending:`) so blocks that only
//     lacked vocabulary resolve. The server swaps these for real rows.
// ---------------------------------------------------------------------------

const PENDING = 'pending:';

const pendingMoveId = (name: string) => `${PENDING}move:${norm(name)}`;
const pendingRoleId = (name: string) => `${PENDING}role:${norm(name)}`;
const pendingObjectId = (name: string, parent: string | null) =>
  parent === null ? `${PENDING}object:${norm(name)}` : `${PENDING}object:${norm(parent)}/${norm(name)}`;

/**
 * Every move, top-level object, subclass and role the parsed blocks name that
 * is not in `vocab` — deduped by normalised name, first spelling kept. Objects
 * are listed tops first, then subclasses (whose `parent` is the top's name).
 * Ambiguous names and subclasses written as the object are NOT collected —
 * `resolveAction` reports those as errors.
 */
export function collectVocabAdds(raws: RawAction[], vocab: ImportVocab): VocabAdds {
  const moves = new Map<string, string>();
  const roles = new Map<string, string>();
  const tops = new Map<string, string>();
  const subs = new Map<string, { name: string; parent: string }>();
  const existingTops = vocab.objects.filter((o) => o.parentId === null);
  const existingSubs = vocab.objects.filter((o) => o.parentId !== null);

  for (const raw of raws) {
    if (findByName(vocab.moves, raw.move, (m) => m.name).kind === 'missing') {
      const k = norm(raw.move);
      if (!moves.has(k)) moves.set(k, raw.move.trim());
    }
    for (const ro of raw.objects) {
      const top = findByName(existingTops, ro.object, (o) => o.name);
      let parentName: string | null = null;
      if (top.kind === 'found') {
        parentName = top.item.name;
        if (ro.subclass) {
          const children = vocab.objects.filter((o) => o.parentId === top.item.id);
          if (findByName(children, ro.subclass, (o) => o.name).kind === 'missing') {
            const k = `${norm(parentName)}/${norm(ro.subclass)}`;
            if (!subs.has(k)) subs.set(k, { name: ro.subclass.trim(), parent: parentName });
          }
        }
      } else if (top.kind === 'missing' && findByName(existingSubs, ro.object, (o) => o.name).kind === 'missing') {
        const k = norm(ro.object);
        if (!tops.has(k)) tops.set(k, ro.object.trim());
        parentName = tops.get(k)!;
        if (ro.subclass) {
          const sk = `${k}/${norm(ro.subclass)}`;
          if (!subs.has(sk)) subs.set(sk, { name: ro.subclass.trim(), parent: parentName });
        }
      }
      if (ro.role && findByName(vocab.roles, ro.role, (r) => r.name).kind === 'missing') {
        const k = norm(ro.role);
        if (!roles.has(k)) roles.set(k, ro.role.trim());
      }
    }
  }
  return {
    moves: [...moves.values()],
    objects: [...[...tops.values()].map((name) => ({ name, parent: null as string | null })), ...subs.values()],
    roles: [...roles.values()],
  };
}

/** `vocab` plus provisional entries for `adds`, so resolution can proceed. */
export function withProvisionalVocab(vocab: ImportVocab, adds: VocabAdds): ImportVocab {
  const objects: ObjectLite[] = [...vocab.objects];
  for (const o of adds.objects.filter((x) => x.parent === null)) {
    objects.push({ id: pendingObjectId(o.name, null), name: o.name, parentId: null });
  }
  for (const o of adds.objects.filter((x) => x.parent !== null)) {
    const parent = findByName(
      objects.filter((x) => x.parentId === null),
      o.parent!,
      (x) => x.name,
    );
    if (parent.kind !== 'found') continue;
    objects.push({ id: pendingObjectId(o.name, o.parent), name: o.name, parentId: parent.item.id });
  }
  return {
    ...vocab,
    moves: [...vocab.moves, ...adds.moves.map((name) => ({ id: pendingMoveId(name), name, minObjects: 1 }))],
    objects,
    roles: [...vocab.roles, ...adds.roles.map((name) => ({ id: pendingRoleId(name), name }))],
  };
}

/** Keep only the additions some resolved draft actually uses (plus the parents of kept subclasses). */
function pruneVocabAdds(adds: VocabAdds, drafts: ActionDraft[]): VocabAdds {
  const used = new Set<string>();
  for (const d of drafts) {
    d.moveIds.forEach((id) => used.add(id));
    d.objectIds.forEach((id) => used.add(id));
    Object.values(d.objectRoles ?? {}).forEach((id) => id && used.add(id));
  }
  const subs = adds.objects.filter((o) => o.parent !== null && used.has(pendingObjectId(o.name, o.parent)));
  const neededParents = new Set(subs.map((s) => norm(s.parent!)));
  const tops = adds.objects.filter(
    (o) => o.parent === null && (used.has(pendingObjectId(o.name, null)) || neededParents.has(norm(o.name))),
  );
  return {
    moves: adds.moves.filter((m) => used.has(pendingMoveId(m))),
    objects: [...tops, ...subs],
    roles: adds.roles.filter((r) => used.has(pendingRoleId(r))),
  };
}

// ---------------------------------------------------------------------------
// 4. The whole plan
// ---------------------------------------------------------------------------

export function planActionImport(markdown: string, vocab: ImportVocab): ImportPlan {
  const fileErrors: string[] = [];
  const { schemaVersion, blocks } = splitActionBlocks(markdown);
  if (schemaVersion === null) {
    fileErrors.push(`Missing \`schema_version: ${IMPORT_SCHEMA_VERSION}\` — add it at the top of the file.`);
  } else if (String(schemaVersion) !== String(IMPORT_SCHEMA_VERSION)) {
    fileErrors.push(`Unsupported schema_version “${schemaVersion}” (this importer reads version ${IMPORT_SCHEMA_VERSION}).`);
  }
  if (blocks.length === 0) fileErrors.push('No ```action blocks found.');

  const parsedBlocks = blocks.map((b) => ({ b, parsed: parseActionBlock(b.body) }));
  const raws = parsedBlocks.flatMap(({ parsed }) => ('raw' in parsed ? [parsed.raw] : []));
  const candidates = collectVocabAdds(raws, vocab);
  const extended = withProvisionalVocab(vocab, candidates);

  const existing = new Map<string, string>();
  for (const a of vocab.actions) {
    const key = compositionKey(a, vocab.questions);
    if (!existing.has(key)) existing.set(key, a.name);
  }
  const seen = new Map<string, number>();

  const items: ImportItem[] = parsedBlocks.map(({ b, parsed }) => {
    const base = { index: b.index, line: b.line };
    if ('errors' in parsed) return { ...base, name: peekName(b.body), status: 'error', errors: parsed.errors };
    const resolved = resolveAction(parsed.raw, extended);
    if ('errors' in resolved) return { ...base, name: parsed.raw.name, status: 'error', errors: resolved.errors };
    const { draft } = resolved;
    const key = compositionKey(
      {
        moveIds: draft.moveIds,
        objectIds: draft.objectIds,
        answers: answerRows(draft.answers, vocab.questions),
        objectRoles: draft.objectRoles,
      },
      vocab.questions,
    );
    const summary = compositionLabel(draft, extended);
    const dup = existing.get(key);
    if (dup !== undefined) return { ...base, name: draft.name, status: 'duplicate', draft, summary, existingName: dup };
    const prior = seen.get(key);
    if (prior !== undefined) return { ...base, name: draft.name, status: 'repeat', draft, summary, ofIndex: prior };
    seen.set(key, b.index);
    return { ...base, name: draft.name, status: 'create', draft, summary };
  });

  const counts = { create: 0, duplicate: 0, repeat: 0, error: 0 };
  for (const it of items) counts[it.status] += 1;
  const vocabAdds = pruneVocabAdds(
    candidates,
    items.flatMap((it) => (it.status === 'create' ? [it.draft] : [])),
  );
  return { fileErrors, items, counts, vocabAdds };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** Trimmed string for a string scalar; '' when missing; undefined when not a string. */
function asTrimmed(x: unknown): string | undefined {
  if (x === undefined || x === null) return '';
  if (typeof x === 'string') return x.trim();
  if (typeof x === 'number' || typeof x === 'boolean') return String(x);
  return undefined;
}

function scalarToString(x: unknown): string | null {
  if (typeof x === 'string') return x.trim();
  if (typeof x === 'number' || typeof x === 'boolean') return String(x);
  if (x instanceof Date) return x.toISOString();
  return null;
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

type Found<T> = { kind: 'found'; item: T } | { kind: 'missing' } | { kind: 'ambiguous' };

/** Exact trimmed match first; otherwise a unique case/whitespace-insensitive match. */
function findByName<T>(list: T[], name: string, nameOf: (t: T) => string): Found<T> {
  const exact = list.filter((t) => nameOf(t).trim() === name.trim());
  if (exact.length === 1) return { kind: 'found', item: exact[0] };
  if (exact.length > 1) return { kind: 'ambiguous' };
  const loose = list.filter((t) => norm(nameOf(t)) === norm(name));
  if (loose.length === 1) return { kind: 'found', item: loose[0] };
  if (loose.length > 1) return { kind: 'ambiguous' };
  return { kind: 'missing' };
}

function labelOf(objects: ObjectLite[], o: ObjectLite): string {
  const parent = o.parentId ? objects.find((x) => x.id === o.parentId) : null;
  return parent ? `${parent.name} › ${o.name}` : o.name;
}

/** Best-effort `name:` for labelling a block that failed to parse. */
function peekName(body: string): string | null {
  const m = body.match(/^\s*name\s*:\s*(.+?)\s*$/m);
  return m ? stripQuotes(m[1]).replace(/^["']|["']$/g, '').trim() || null : null;
}
