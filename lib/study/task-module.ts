// PURE parsing of the shown study's `authored_data` (Json) into the task module's
// id + authored content. Shared by spec.ts / live.ts (which previously each held a
// private resolveTaskModuleId copy) and by the progression viewer (which also needs
// the requirements + scenarios). Defensive throughout: malformed shapes yield
// null / dropped entries, never a throw — authored_data is external Json.

import type { Json } from '@/lib/types/cb-db';
import type { Clause, ClauseType, Requirement, Scenario } from '@/lib/study/study';

export type TaskAuthoring = {
  moduleId: string;
  title: string;
  requirements: Requirement[];
  scenarios: Scenario[];
};

/** The `type:'task'` module id from authored_data, or null. (Same resolution the
 *  live clock + spec replay use; extracted so there is ONE copy.) */
export function taskModuleIdFrom(authoredData: Json | null): string | null {
  const task = taskModuleRecord(authoredData);
  return task && typeof task.id === 'string' ? task.id : null;
}

/** The task module's authored content (requirements + scenarios), or null when
 *  no task module resolves. Malformed entries are DROPPED, not thrown on. */
export function parseTaskAuthoring(authoredData: Json | null): TaskAuthoring | null {
  const task = taskModuleRecord(authoredData);
  if (!task || typeof task.id !== 'string') return null;
  return {
    moduleId: task.id,
    title: typeof task.title === 'string' ? task.title : '',
    requirements: coerceArray(task.requirements, coerceRequirement),
    scenarios: coerceArray(task.scenarios, coerceScenario),
  };
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function taskModuleRecord(authoredData: Json | null): Record<string, unknown> | null {
  if (!authoredData || typeof authoredData !== 'object' || Array.isArray(authoredData)) return null;
  const modules = (authoredData as Record<string, unknown>).modules;
  if (!Array.isArray(modules)) return null;
  for (const m of modules) {
    if (m && typeof m === 'object' && (m as Record<string, unknown>).type === 'task') {
      return m as Record<string, unknown>;
    }
  }
  return null;
}

/** Map `raw` through `coerce`, dropping entries coerce rejects (returns null). */
function coerceArray<T>(raw: unknown, coerce: (v: unknown) => T | null): T[] {
  if (!Array.isArray(raw)) return [];
  const out: T[] = [];
  for (const v of raw) {
    const c = coerce(v);
    if (c !== null) out.push(c);
  }
  return out;
}

function coerceRequirement(raw: unknown): Requirement | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string') return null;
  return {
    id: r.id,
    role: typeof r.role === 'string' ? r.role : '',
    want: typeof r.want === 'string' ? r.want : '',
    so: typeof r.so === 'string' ? r.so : '',
  };
}

const CLAUSE_TYPES: readonly ClauseType[] = ['Given', 'And', 'When', 'Then'];

function coerceClause(raw: unknown): Clause | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.id !== 'string' || typeof c.text !== 'string') return null;
  if (!CLAUSE_TYPES.includes(c.type as ClauseType)) return null;
  const clause: Clause = { id: c.id, type: c.type as ClauseType, text: c.text };
  if (c.marker === 'new' || c.marker === 'superseded') clause.marker = c.marker;
  return clause;
}

function coerceScenario(raw: unknown): Scenario | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.id !== 'string') return null;
  return {
    id: s.id,
    title: typeof s.title === 'string' ? s.title : '',
    facilitatorNote: typeof s.facilitatorNote === 'string' ? s.facilitatorNote : '',
    clauses: coerceArray(s.clauses, coerceClause),
    // seededMarkers intentionally omitted: the viewer is text-only (spec §1).
  };
}
