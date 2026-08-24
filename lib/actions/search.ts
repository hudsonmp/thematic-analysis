/**
 * search — pure helpers for the ACTION picker on /coding/action.
 *
 * With dozens of saved actions a coder cannot recall them by name, so the
 * picker is a faceted search: a fuzzy text box over everything an action says
 * about itself, a single-select MOVE facet, a multi-select OBJECT facet, and
 * hidden advanced facets (role, question answer). No I/O, no DOM — every
 * function is deterministic so the ranking is unit-testable and identical on
 * the server and in the browser.
 *
 * Filter semantics (the contract the modal states in its UI):
 *   • AND across categories — an action must satisfy the move facet AND the
 *     object facet AND the role facet AND the answer facet.
 *   • Objects are AND within: every selected object must be present (Scenario +
 *     Specification ⇒ actions involving BOTH). Selecting a PARENT object matches
 *     an action that names the parent or any of its subclasses; selecting a
 *     subclass matches only that subclass.
 *   • Roles and answers are OR within: any one of the selected values matches.
 *   • The text query further narrows the filtered set.
 */

import { fuzzyScore } from '@/lib/transcript/fuzzy';
import { objectLabel, type ObjectLite, type RoleLite } from '@/lib/actions/schema';

export type ActionSearchFilters = {
  /** At most one move — every action has exactly one. */
  moveId: string | null;
  /** Every selected object must be present (AND within). */
  objectIds: string[];
  /** Any selected role must be assigned to some object of the action (OR within). */
  roleIds: string[];
  /** `"questionId=optionId"` keys; any selected answer must be given (OR within). */
  answerKeys: string[];
};

export const EMPTY_FILTERS: ActionSearchFilters = { moveId: null, objectIds: [], roleIds: [], answerKeys: [] };

export function hasActiveFilters(f: ActionSearchFilters): boolean {
  return f.moveId !== null || f.objectIds.length > 0 || f.roleIds.length > 0 || f.answerKeys.length > 0;
}

/** `"questionId=optionId"` — the key an answer facet value is stored under. */
export function answerKey(questionId: string, optionId: string): string {
  return `${questionId}=${optionId}`;
}

/** How often (and how recently, epoch ms) THIS coder has applied each action. */
export type ActionUsage = Record<string, { count: number; lastMs: number }>;

/** The slice of the schema the search needs — structurally compatible with ActionSchema. */
export type SearchVocab = {
  moves: { id: string; name: string }[];
  objects: ObjectLite[];
  roles: RoleLite[];
  questions: { id: string; prompt: string; options: { id: string; label: string }[] }[];
};

/** The slice of an action the search needs — structurally compatible with ActionEntry. */
export type SearchableAction = {
  id: string;
  name: string;
  description?: string | null;
  position?: number;
  moveIds: string[];
  objectIds: string[];
  objectRoles?: Record<string, string | null | undefined>;
  answers: { questionId: string; optionId: string | null; freeText: string | null }[];
};

/**
 * Everything the text box searches: name, description, move, object (with
 * parent) names, role names, and the answer text (option label or free text).
 * Question prompts are NOT included — a prompt is shared by every action that
 * answers it, so it would match everything.
 */
export function actionHaystack(a: SearchableAction, vocab: SearchVocab): string {
  const parts: string[] = [a.name];
  if (a.description) parts.push(a.description);
  for (const id of a.moveIds) {
    const m = vocab.moves.find((x) => x.id === id);
    if (m) parts.push(m.name);
  }
  for (const id of a.objectIds) {
    const label = objectLabel(vocab.objects, id);
    if (label !== '?') parts.push(label);
    const roleId = a.objectRoles?.[id];
    const role = roleId ? vocab.roles.find((r) => r.id === roleId) : null;
    if (role) parts.push(role.name);
  }
  for (const ans of a.answers) {
    const q = vocab.questions.find((x) => x.id === ans.questionId);
    if (!q) continue;
    if (ans.optionId) {
      const o = q.options.find((x) => x.id === ans.optionId);
      if (o) parts.push(o.label);
    } else if (ans.freeText) {
      parts.push(ans.freeText);
    }
  }
  return parts.join(' ');
}

/** Does `a` name `objectId` — directly, or (for a parent) through any of its subclasses? */
export function actionHasObject(a: SearchableAction, objectId: string, objects: ObjectLite[]): boolean {
  if (a.objectIds.includes(objectId)) return true;
  return a.objectIds.some((id) => objects.find((o) => o.id === id)?.parentId === objectId);
}

export function matchesFilters(a: SearchableAction, f: ActionSearchFilters, vocab: SearchVocab): boolean {
  if (f.moveId !== null && !a.moveIds.includes(f.moveId)) return false;
  for (const oid of f.objectIds) if (!actionHasObject(a, oid, vocab.objects)) return false;
  if (f.roleIds.length > 0) {
    const assigned = new Set(
      Object.entries(a.objectRoles ?? {})
        .filter(([objectId, roleId]) => !!roleId && a.objectIds.includes(objectId))
        .map(([, roleId]) => roleId as string),
    );
    if (!f.roleIds.some((r) => assigned.has(r))) return false;
  }
  if (f.answerKeys.length > 0) {
    const given = new Set(a.answers.filter((x) => x.optionId).map((x) => answerKey(x.questionId, x.optionId!)));
    if (!f.answerKeys.some((k) => given.has(k))) return false;
  }
  return true;
}

export type RankedAction<A extends SearchableAction> = {
  action: A;
  /** 2 = exact name match · 1 = keyword match (or no query) */
  tier: number;
  score: number;
  /** Indices into `action.name` the query matched (for bolding); [] when none. */
  nameIndices: number[];
  /** Indices into `action.description` the query matched; [] when none. */
  descIndices: number[];
};

function norm(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Token-level fuzzy match. The haystack is a long concatenation of fields, so a
 * plain ordered-subsequence over the whole string would accept almost any
 * query ("wrote" scatters across "Infer purpose of scenario … evidence"). Here
 * each query token must be a fuzzy (subsequence) match of ONE haystack word —
 * "spc" still finds "Specification", "ent" finds "Entity" — and the score sums
 * each token's best word hit. Returns null when any token misses. An empty
 * query scores 1 (match everything weakly), mirroring fuzzyScore.
 */
export function tokenFuzzyScore(query: string, haystack: string): { score: number } | null {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { score: 1 };
  const words = haystack.split(/[\s·›→,()[\]]+/).filter(Boolean);
  let score = 0;
  for (const t of tokens) {
    let best = 0;
    for (const w of words) {
      const hit = fuzzyScore(t, w);
      if (hit && hit.score > best) best = hit.score;
    }
    if (best === 0) return null;
    score += best;
  }
  return { score };
}

/**
 * Indices into `text` to bold for `query`: for each query token, the chars of
 * its best-matching word in `text` (same word-level rule as tokenFuzzyScore).
 * Tokens that miss contribute nothing — the match may live in another field.
 */
export function tokenHighlightIndices(query: string, text: string): number[] {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || !text) return [];
  const out = new Set<number>();
  const wordRe = /[^\s·›→,()[\]]+/g;
  const words: { start: number; word: string }[] = [];
  for (let m = wordRe.exec(text); m; m = wordRe.exec(text)) words.push({ start: m.index, word: m[0] });
  for (const t of tokens) {
    let best: { start: number; idx: number[]; score: number } | null = null;
    for (const w of words) {
      const hit = fuzzyScore(t, w.word);
      if (hit && (!best || hit.score > best.score)) best = { start: w.start, idx: hit.matchedIndices, score: hit.score };
    }
    if (best) for (const i of best.idx) out.add(best.start + i);
  }
  return Array.from(out).sort((a, b) => a - b);
}

/**
 * Filter, then rank:
 *   1. exact (case/whitespace-insensitive) name matches first,
 *   2. then fuzzy score over the full haystack (see {@link actionHaystack}),
 *   3. then — among ties — most-used, then most-recently-used by this coder,
 *   4. then catalog position / input order.
 * An empty query keeps every filtered action (score 1) so usage and position
 * decide the order.
 */
export function rankActions<A extends SearchableAction>(
  query: string,
  actions: A[],
  filters: ActionSearchFilters,
  vocab: SearchVocab,
  usage: ActionUsage = {},
): RankedAction<A>[] {
  const q = norm(query);
  const out: (RankedAction<A> & { index: number })[] = [];
  actions.forEach((a, index) => {
    if (!matchesFilters(a, filters, vocab)) return;
    const hit = tokenFuzzyScore(query, actionHaystack(a, vocab));
    if (!hit) return;
    const tier = q !== '' && norm(a.name) === q ? 2 : 1;
    out.push({
      action: a,
      tier,
      score: hit.score,
      nameIndices: tokenHighlightIndices(query, a.name),
      descIndices: a.description ? tokenHighlightIndices(query, a.description) : [],
      index,
    });
  });
  out.sort((x, y) => {
    if (x.tier !== y.tier) return y.tier - x.tier;
    if (x.score !== y.score) return y.score - x.score;
    const ux = usage[x.action.id];
    const uy = usage[y.action.id];
    const cx = ux?.count ?? 0;
    const cy = uy?.count ?? 0;
    if (cx !== cy) return cy - cx;
    const lx = ux?.lastMs ?? 0;
    const ly = uy?.lastMs ?? 0;
    if (lx !== ly) return ly - lx;
    const px = x.action.position ?? x.index;
    const py = y.action.position ?? y.index;
    if (px !== py) return px - py;
    return x.index - y.index;
  });
  return out.map(({ action, tier, score, nameIndices, descIndices }) => ({ action, tier, score, nameIndices, descIndices }));
}

/**
 * "INFER · Scenario [evidence] → Goal [product]" — the compact structural line
 * under each result. Move upper-cased; objects in catalog order, roles in
 * brackets; subclasses as "Parent › Child".
 */
export function structuralSummary(a: SearchableAction, vocab: SearchVocab): string {
  const move = a.moveIds
    .map((id) => vocab.moves.find((m) => m.id === id)?.name ?? '?')
    .join(' + ')
    .toUpperCase();
  const objs = a.objectIds.map((id) => {
    const base = objectLabel(vocab.objects, id);
    const roleId = a.objectRoles?.[id];
    const role = roleId ? vocab.roles.find((r) => r.id === roleId) : null;
    return role ? `${base} [${role.name}]` : base;
  });
  return `${move || '(NO MOVE)'} · ${objs.join(' → ') || '(no object)'}`;
}

/** Split `text` into [chunk, matched] runs from a matched-index list (for <mark>). */
export function highlightRuns(text: string, indices: number[]): { text: string; hit: boolean }[] {
  if (indices.length === 0) return text ? [{ text, hit: false }] : [];
  const set = new Set(indices);
  const runs: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    const last = runs[runs.length - 1];
    if (last && last.hit === hit) last.text += text[i];
    else runs.push({ text: text[i], hit });
  }
  return runs;
}

/**
 * Fold a list of codings (actionId + when) into {@link ActionUsage}. Ad hoc
 * codings (null actionId) are ignored — there is nothing to rank by them.
 */
export function foldUsage(rows: { actionId: string | null; createdAt: string | number | null }[]): ActionUsage {
  const out: ActionUsage = {};
  for (const r of rows) {
    if (!r.actionId) continue;
    const ms = typeof r.createdAt === 'number' ? r.createdAt : r.createdAt ? Date.parse(r.createdAt) : 0;
    const cur = out[r.actionId] ?? { count: 0, lastMs: 0 };
    out[r.actionId] = { count: cur.count + 1, lastMs: Math.max(cur.lastMs, Number.isFinite(ms) ? ms : 0) };
  }
  return out;
}

/** Merge two usage maps (e.g. cross-session from the server + this session's live state). */
export function mergeUsage(a: ActionUsage, b: ActionUsage): ActionUsage {
  const out: ActionUsage = { ...a };
  for (const [id, u] of Object.entries(b)) {
    const cur = out[id];
    out[id] = cur ? { count: cur.count + u.count, lastMs: Math.max(cur.lastMs, u.lastMs) } : u;
  }
  return out;
}
