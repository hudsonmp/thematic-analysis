# Progression Analysis Viewer (A) + Study-Write Safety L2/L3 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `/progression-analysis` — a read-only viewer of each participant's spec+entities across 5 phases (Requirement, Scenarios 1–4) with entity diffs and the authored Gherkin beside it — on top of a structurally read-only study-data path (`studyFrom` guard + hardened CI).

**Architecture:** Pure engine (`lib/progression`) → server actions (`app/actions/progression.ts`) reading via a new select-only `studyFrom()` guard (user client + RLS SELECT-only policies, applied to prod 2026-07-01) → client island UI mirroring `/sessions` patterns. All existing study reads migrate from the service-role client to `studyFrom`, quarantining the service key to `cbFrom` + storage.

**Tech Stack:** Next.js 16.2.6 (webpack), React 19, Supabase (`@supabase/ssr` user client), TypeScript, vitest, Tailwind 4. No new dependencies.

## Global Constraints

- **Specs:** `docs/superpowers/specs/2026-06-30-progression-analysis-viewer-design.md` + `2026-06-30-study-data-write-safety-design.md`. Follow them exactly.
- **Next 16 has breaking changes** — read the relevant guide in `node_modules/next/dist/docs/` before writing any Next-specific code (AGENTS.md mandate). `searchParams`/`params` are Promises. Client Components never call Server Actions during render.
- **NEVER** run `npm run build` or `next dev` as part of a task. Verification = `npx tsc --noEmit`, `npx vitest run <paths>`, `npm run lint` (eslint + `scripts/check-no-study-writes.sh`).
- **Work in the main checkout** `/Users/hudsonmitchell-pullman/thematic-analysis` on branch **`feat/progression-analysis`** (already checked out; the dev server on :3200 serves this checkout — Hudson watches progress live). Commit after every task; never switch branches.
- **Study data is IRB-covered and read-only.** Every study-table access is a `.select()` via `studyFrom()` (after Task 1). No `.insert/.update/.delete/.upsert/.rpc` on study tables anywhere, ever. Study tables: `studies, study_events, study_snapshots, study_responses, study_scripts, study_assistant_messages, users, onboarding_fields, onboarding_responses, llm_prompts`.
- **PII:** participant identity renders as `pid` ONLY. Never select/return `first_name` or `email` from any new code.
- **Scenario display numbering:** UI shows `scenario_idx + 1` ("Scenario 1"–"Scenario 4"). The DB stays 0-indexed.
- Match surrounding code style: heavy doc comments explaining WHY, defensive narrowing of `Json`, empty-shape returns (never throw on missing data), `text-foreground/60`-style Tailwind idiom.

---

### Task 1: `studyFrom()` select-only guard (safety L2)

**Files:**
- Create: `lib/supabase/study-guard-core.ts` (pure, testable)
- Create: `lib/supabase/study-guard.ts` (server-only composition)
- Test: `lib/supabase/__tests__/study-guard-core.test.ts`

**Interfaces:**
- Consumes: `createUserServerClient` (`@/lib/supabase/user-server`), `Database` type (`@/lib/types/cb-db`).
- Produces: `STUDY_TABLES`, `type StudyTable`, `assertStudyTable(table: string): void`, `selectOnly<B extends object>(builder: B): SelectOnly<B>` (core); `async function studyFrom<T extends StudyTable>(table: T)` (guard). Later tasks call `(await studyFrom('users')).select(...)`.

- [ ] **Step 1: Write the failing test**

```ts
// lib/supabase/__tests__/study-guard-core.test.ts
import { describe, expect, it } from 'vitest';
import {
  STUDY_TABLES,
  assertStudyTable,
  selectOnly,
} from '@/lib/supabase/study-guard-core';

describe('assertStudyTable', () => {
  it('accepts every allowlisted study table', () => {
    for (const t of STUDY_TABLES) expect(() => assertStudyTable(t)).not.toThrow();
  });
  it('rejects cb_ tables, eval tables, and unknown names', () => {
    for (const t of ['cb_codes', 'cb_sessions', 'eval_runs', 'auth.users', 'studiesx', '']) {
      expect(() => assertStudyTable(t)).toThrow(/not a study table/i);
    }
  });
});

describe('selectOnly', () => {
  // A stub PostgREST-ish builder: read verbs return marker values; write verbs exist
  // (as they do on the real builder) and MUST become unreachable through the proxy.
  const stub = {
    select: (cols: string) => `selected:${cols}`,
    insert: () => 'wrote',
    update: () => 'wrote',
    upsert: () => 'wrote',
    delete: () => 'wrote',
    url: 'https://example.test',
  };

  it('passes read members through untouched', () => {
    const guarded = selectOnly(stub);
    expect(guarded.select('id')).toBe('selected:id');
    expect(guarded.url).toBe('https://example.test');
  });

  it('throws on every write verb, at ACCESS time (before any call)', () => {
    const guarded = selectOnly(stub) as unknown as Record<string, unknown>;
    for (const verb of ['insert', 'update', 'upsert', 'delete']) {
      expect(() => guarded[verb]).toThrow(/read-only/i);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/supabase/__tests__/study-guard-core.test.ts`
Expected: FAIL — `Cannot find module '@/lib/supabase/study-guard-core'`

- [ ] **Step 3: Write the pure core**

```ts
// lib/supabase/study-guard-core.ts
// Pure core of the STUDY-read guard (no next/headers, no client) so it unit-tests
// under vitest. Mirrors guard-core.ts (assertCbTable) on the read side: study
// tables are IRB-covered and READ-ONLY for this app — `studyFrom` (study-guard.ts)
// composes this core with the user client. See
// docs/superpowers/specs/2026-06-30-study-data-write-safety-design.md (L2).

/** Every study-side table this app may READ. Closed allowlist — adding a table is
 *  a deliberate, reviewed act. (cb_* tables are NOT here: they go through cbFrom.) */
export const STUDY_TABLES = [
  'studies',
  'study_events',
  'study_snapshots',
  'study_responses',
  'study_scripts',
  'study_assistant_messages',
  'users',
  'onboarding_fields',
  'onboarding_responses',
  'llm_prompts',
] as const;

export type StudyTable = (typeof STUDY_TABLES)[number];

/** Throws unless `table` is on the closed study-table allowlist. Runtime twin of
 *  the compile-time `StudyTable` bound (mirrors assertCbTable's role for cbFrom). */
export function assertStudyTable(table: string): void {
  if (!(STUDY_TABLES as readonly string[]).includes(table)) {
    throw new Error(
      `studyFrom: "${table}" is not a study table (closed allowlist; cb_ writes go through cbFrom).`,
    );
  }
}

/** PostgREST query-builder members that mutate. Blocked at PROPERTY ACCESS, so a
 *  write attempt throws before any request is even constructed. Write verbs only
 *  exist on the top-level query builder (`.from(t)`); the filter builder returned
 *  by `.select()` has none, so guarding this one level closes the write surface. */
const WRITE_VERBS = new Set(['insert', 'update', 'upsert', 'delete']);

/** The select-only view of a builder type (what `studyFrom` returns). */
export type SelectOnly<B> = Omit<B, 'insert' | 'update' | 'upsert' | 'delete'>;

/** Wrap a query builder so any write-verb ACCESS throws. Reads pass through with
 *  correct `this` binding (methods are bound to the underlying builder). */
export function selectOnly<B extends object>(builder: B): SelectOnly<B> {
  return new Proxy(builder, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && WRITE_VERBS.has(prop)) {
        throw new Error(
          `studyFrom: study tables are read-only — "${prop}" is forbidden (write participant data never).`,
        );
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as SelectOnly<B>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/supabase/__tests__/study-guard-core.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Write the server-only composition**

```ts
// lib/supabase/study-guard.ts
import 'server-only';
import { createUserServerClient } from '@/lib/supabase/user-server';
import {
  assertStudyTable,
  selectOnly,
  type SelectOnly,
  type StudyTable,
} from '@/lib/supabase/study-guard-core';

export { STUDY_TABLES, assertStudyTable } from '@/lib/supabase/study-guard-core';
export type { StudyTable } from '@/lib/supabase/study-guard-core';

/**
 * Use for ALL study-data READS. Returns a SELECT-ONLY query builder on `table`:
 *
 *  - CREDENTIAL: the anon-key USER client (researcher JWT). Since migration
 *    `study_tables_researcher_readonly_rls` (applied 2026-07-01), every study
 *    table carries a SELECT-only RLS policy for `authenticated` and NO write
 *    policy — so even bypassing this wrapper, Postgres refuses writes on this
 *    credential. The service-role key no longer touches study tables at all.
 *  - COMPILE TIME: `T extends StudyTable` (closed allowlist union).
 *  - RUNTIME: `assertStudyTable` + a Proxy that throws on any write-verb access.
 *
 * Mirrors `cbFrom` (guard.ts), which remains the ONLY write path (cb_ tables,
 * service role). See the write-safety spec, layer L2.
 */
export async function studyFrom<T extends StudyTable>(table: T) {
  assertStudyTable(table);
  const sb = await createUserServerClient();
  const builder = sb.from(table);
  return selectOnly(builder) as SelectOnly<typeof builder>;
}
```

- [ ] **Step 6: Typecheck + full test sweep**

Run: `npx tsc --noEmit && npx vitest run lib/supabase`
Expected: tsc clean; all supabase tests pass (existing `guard.test.ts` + new core test)

- [ ] **Step 7: Commit**

```bash
git add lib/supabase/study-guard-core.ts lib/supabase/study-guard.ts lib/supabase/__tests__/study-guard-core.test.ts
git commit -m "feat(safety): studyFrom select-only guard for study-table reads (L2)"
```

---

### Task 2: Migrate every study read to `studyFrom` (service-key quarantine)

**Files:**
- Modify: `app/actions/spec.ts` (lines 3, 104–117, 130 area)
- Modify: `app/actions/chat.ts` (the service-role study reads in `listSessionAssistantChat`)
- Modify: `app/actions/live.ts` (every `createServiceRoleClient()` study read: `listParticipants`, `resolveUserId`, latest-event/task-start readers, `safeShownStudyAuthoredData` path is via codebook)
- Modify: `app/actions/codebook.ts` (`getShownStudy` — reads `studies`)
- Modify: any other `createServiceRoleClient().from('<study table>')` call site found by grep

**Interfaces:**
- Consumes: `studyFrom` from Task 1.
- Produces: no signature changes — every exported function keeps its exact current signature and return shape. This task is a mechanical credential swap.

- [ ] **Step 1: Inventory the call sites**

Run: `grep -rn "createServiceRoleClient" app lib components --include='*.ts' --include='*.tsx' | grep -v 'lib/supabase/'`
Record the list. Study-table DB reads migrate; **storage/bucket uses (if any) stay on the service client** — note them for Task 3's allowlist.

- [ ] **Step 2: Migrate spec.ts**

Replace the service-role import and both study reads. The diff pattern (apply the same shape everywhere):

```ts
// BEFORE (spec.ts:3):
import { createServiceRoleClient } from '@/lib/supabase/service';
// AFTER:
import { studyFrom } from '@/lib/supabase/study-guard';

// BEFORE (spec.ts:106-111):
const studySb = createServiceRoleClient();
const userRes = await studySb.from('users').select('id').eq('pid', pidLabel).maybeSingle();
// AFTER:
const userRes = await (await studyFrom('users')).select('id').eq('pid', pidLabel).maybeSingle();

// BEFORE (spec.ts:130-138):
let query = studySb
  .from('study_events')
  .select('event_type, payload, created_at')
  ...
// AFTER:
let query = (await studyFrom('study_events'))
  .select('event_type, payload, created_at')
  .eq('user_id', userId)
  .in('event_type', ['spec_edit', 'entities_edit'])
  .order('created_at', { ascending: true });
```

Also update the file's header comment block (lines 26–30): the study reads now go through `studyFrom` (user client + SELECT-only RLS), not the service role; the read-only guarantee is structural (RLS) + the guard, not just discipline.

- [ ] **Step 3: Migrate chat.ts, live.ts, codebook.ts the same way**

Same mechanical pattern. `getShownStudy` becomes:

```ts
export async function getShownStudy(): Promise<ShownStudy | null> {
  const studies = await studyFrom('studies');
  const { data, error } = await studies
    .select('id, name, authored_data')
    .eq('visibility', 'shown')
    .maybeSingle();
  if (error) {
    console.error('[codebook] getShownStudy failed:', error.message);
    return null;
  }
  if (!data) return null;
  return { id: data.id, name: data.name, authored_data: data.authored_data };
}
```

In `live.ts`, each `const sb = createServiceRoleClient()` study read becomes a per-table `await studyFrom('users')` / `await studyFrom('study_events')`. Update the doc comments that say "SERVICE-ROLE client" to name `studyFrom`.

- [ ] **Step 4: Verify no study read remains on the service client**

Run: `grep -rn "createServiceRoleClient" app components --include='*.ts' --include='*.tsx'`
Expected: ONLY non-DB uses (e.g. storage) or none. `lib/supabase/guard.ts`+`service.ts` keep theirs.

- [ ] **Step 5: Typecheck + full suite + guard**

Run: `npx tsc --noEmit && npx vitest run && npm run lint`
Expected: all green (no behavior change — same queries, new credential; RLS SELECT policies applied 2026-07-01 make the user client's reads succeed).

- [ ] **Step 6: Commit**

```bash
git add app/actions/spec.ts app/actions/chat.ts app/actions/live.ts app/actions/codebook.ts
git commit -m "refactor(safety): route all study reads through studyFrom; quarantine service key to cbFrom+storage"
```

---

### Task 3: Harden the CI guard (safety L3)

**Files:**
- Modify: `scripts/check-no-study-writes.sh`

**Interfaces:**
- Consumes: Task 2's end state (no raw service-client study reads outside guards).
- Produces: `npm run lint` now also fails on (a) `llm_prompts` writes, (b) raw `createServiceRoleClient(` outside the allowlist, (c) `.rpc(` outside the allowlist, and scans `components/` too.

- [ ] **Step 1: Extend the script**

Apply these edits to `scripts/check-no-study-writes.sh`:

1. `STUDY_FROM_RE` — add `llm_prompts`:
```bash
STUDY_FROM_RE="from\((['\"])(studies|study_events|study_snapshots|study_responses|study_scripts|study_assistant_messages|users|onboarding|llm_prompts)"
```
2. Widen the file scan: change `find app lib -type f ...` to `find app lib components -type f ...`.
3. Append two new checks before the final summary (after the existing offenders loop):

```bash
# --- Rule 2: the service-role client is QUARANTINED. Only the guard modules may
# construct it; everything else reads study data via studyFrom (user client,
# SELECT-only RLS) and writes cb_ data via cbFrom. Storage-only call sites that
# legitimately need the service key are allowlisted explicitly below.
SERVICE_ALLOWLIST_RE='lib/supabase/(guard|service|study-guard)\.ts$'
while IFS= read -r hit; do
  [ -n "$hit" ] || continue
  echo "ERROR: raw createServiceRoleClient outside the guard modules: $hit" >&2
  offenders=$((offenders + 1))
done < <(
  grep -rn "createServiceRoleClient(" app lib components \
    --include='*.ts' --include='*.tsx' 2>/dev/null \
    | grep -v -E "$SERVICE_ALLOWLIST_RE" || true
)

# --- Rule 3: no .rpc() anywhere in app code (stored procedures bypass both
# guards). Introduce an allowlist entry here deliberately if one is ever needed.
while IFS= read -r hit; do
  [ -n "$hit" ] || continue
  echo "ERROR: .rpc( call (bypasses cbFrom/studyFrom guards): $hit" >&2
  offenders=$((offenders + 1))
done < <(
  grep -rn "\.rpc(" app lib components --include='*.ts' --include='*.tsx' 2>/dev/null || true
)
```
If Step 1 of Task 2 found legitimate storage uses of the service client, extend `SERVICE_ALLOWLIST_RE` with those exact paths and a comment naming why each is safe.

- [ ] **Step 2: Prove the new rules fire (fixture smoke, then clean up)**

```bash
cat > app/_guardprobe.ts <<'EOF'
import { createServiceRoleClient } from '@/lib/supabase/service';
export async function probe() {
  const sb = createServiceRoleClient();
  await sb.from('llm_prompts').update({ content: 'x' }).eq('key', 'help_seeking');
  await sb.rpc('anything');
}
EOF
bash scripts/check-no-study-writes.sh; echo "exit=$?"   # Expected: ERRORs + exit=1
rm app/_guardprobe.ts
bash scripts/check-no-study-writes.sh                    # Expected: OK, exit 0
```

- [ ] **Step 3: Full verification + commit**

Run: `npm run lint && npx tsc --noEmit`
Expected: green.

```bash
git add scripts/check-no-study-writes.sh
git commit -m "chore(safety): guard llm_prompts, quarantine service client, forbid .rpc, scan components (L3)"
```

---

### Task 4: Export entity coercers + shared task-module/authoring parser

**Files:**
- Modify: `lib/spec/reconstruct.ts` (export 3 private functions; no logic change)
- Create: `lib/study/task-module.ts` (pure parser)
- Modify: `app/actions/spec.ts` (delete its private `resolveTaskModuleId`, use shared)
- Modify: `app/actions/live.ts` (same — its `resolveTaskModuleId` keeps calling `getShownStudy` but delegates parsing)
- Test: `lib/study/__tests__/task-module.test.ts`

**Interfaces:**
- Consumes: `Json` type; existing `Scenario`, `Requirement` types from `lib/study/study.ts`; `getShownStudy` stays in codebook.ts.
- Produces: `parseEntities`, `coerceEntity`, `coerceElement` exported from `@/lib/spec/reconstruct`; from `@/lib/study/task-module`: `taskModuleIdFrom(authoredData: Json | null): string | null` and `parseTaskAuthoring(authoredData: Json | null): TaskAuthoring | null` where `type TaskAuthoring = { moduleId: string; title: string; requirements: Requirement[]; scenarios: Scenario[] }`.

- [ ] **Step 1: Export the coercers in reconstruct.ts**

Change the three declarations (`function parseEntities` line 98, `function coerceEntity` line 110, `function coerceElement` line 124) to `export function ...`. Extend each doc comment with one line: parseEntities is for the STRINGIFIED event-stream encoding; `coerceEntity`/`coerceElement` are the entry points for the ALREADY-PARSED `study_snapshots.entities` jsonb (never `JSON.parse` a snapshot's entities — it is already an array).

- [ ] **Step 2: Write the failing tests for the parser**

```ts
// lib/study/__tests__/task-module.test.ts
import { describe, expect, it } from 'vitest';
import { parseTaskAuthoring, taskModuleIdFrom } from '@/lib/study/task-module';

const AUTHORED = {
  modules: [
    { id: 'warm1', type: 'task_warmup', title: 'Warmup' },
    {
      id: '3g7lg4if',
      type: 'task',
      title: 'Rideshare Matching Platform',
      requirements: [{ id: 'r1', role: 'rider', want: 'an empty car', so: 'comfort' }],
      scenarios: [
        {
          id: 's0', title: 'Scenario I', facilitatorNote: '',
          clauses: [{ id: 'c1', type: 'Given', text: 'one vehicle', marker: 'new' }],
        },
      ],
    },
  ],
};

describe('taskModuleIdFrom', () => {
  it('finds the type:"task" module id', () => {
    expect(taskModuleIdFrom(AUTHORED as never)).toBe('3g7lg4if');
  });
  it.each([null, 'str', 42, [], { modules: 'x' }, { modules: [{ type: 'task' }] }])(
    'returns null for malformed authored_data %#',
    (bad) => expect(taskModuleIdFrom(bad as never)).toBeNull(),
  );
});

describe('parseTaskAuthoring', () => {
  it('extracts moduleId, title, requirements, scenarios', () => {
    const t = parseTaskAuthoring(AUTHORED as never);
    expect(t?.moduleId).toBe('3g7lg4if');
    expect(t?.requirements).toHaveLength(1);
    expect(t?.scenarios[0].clauses[0]).toMatchObject({ type: 'Given', marker: 'new' });
  });
  it('drops malformed clause/requirement entries instead of throwing', () => {
    const messy = {
      modules: [{
        id: 't', type: 'task', title: 'T',
        requirements: [null, { id: 'r', role: 'x', want: 'y', so: 'z' }, 'junk'],
        scenarios: [{ id: 's', title: 'S', facilitatorNote: '', clauses: [null, { id: 'c', type: 'Then', text: 'ok' }] }],
      }],
    };
    const t = parseTaskAuthoring(messy as never);
    expect(t?.requirements).toHaveLength(1);
    expect(t?.scenarios[0].clauses).toHaveLength(1);
  });
  it('returns null when there is no task module', () =>
    expect(parseTaskAuthoring({ modules: [{ id: 'w', type: 'task_warmup' }] } as never)).toBeNull());
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run lib/study/__tests__/task-module.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the pure parser**

```ts
// lib/study/task-module.ts
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
```

- [ ] **Step 5: Run tests to verify pass**

Run: `npx vitest run lib/study/__tests__/task-module.test.ts lib/spec`
Expected: PASS (new tests + existing reconstruct tests untouched).

- [ ] **Step 6: Repoint spec.ts and live.ts**

In `app/actions/spec.ts`: delete the private `resolveTaskModuleId` (lines 175–197) and replace its call (line 126) with:

```ts
import { taskModuleIdFrom } from '@/lib/study/task-module';
// ...
const taskModuleId = taskModuleIdFrom((await getShownStudy())?.authored_data ?? null);
```

In `app/actions/live.ts`: replace the body of its private `resolveTaskModuleId` with `return taskModuleIdFrom(await safeShownStudyAuthoredData());` (keep `parseModules` — the live module list uses it for more than the task id).

- [ ] **Step 7: Verify + commit**

Run: `npx tsc --noEmit && npx vitest run && npm run lint`
Expected: green.

```bash
git add lib/spec/reconstruct.ts lib/study/task-module.ts lib/study/__tests__/task-module.test.ts app/actions/spec.ts app/actions/live.ts
git commit -m "refactor: export entity coercers; extract shared task-module authoring parser"
```

---

### Task 5: Pure progression engine

**Files:**
- Create: `lib/progression/progression.ts`
- Test: `lib/progression/__tests__/progression.test.ts`

**Interfaces:**
- Consumes: `Entity` from `@/lib/spec/reconstruct`.
- Produces (exact, later tasks depend on these):

```ts
export type PhaseSnapshot = {
  phase: 'initial' | 'after_scenario' | 'final';
  scenarioIdx: number | null;
  spec: string;
  entities: Entity[];
  clientTs: string | null;   // dedupe key (fallback: createdAt)
  createdAt: string;
};
export type EntityChange = { name: string; addedElements: string[]; removedElements: string[] };
export type EntityDiff = { addedEntities: string[]; removedEntities: string[]; changedEntities: EntityChange[] };
export type ProgressionStep = {
  ordinal: 0 | 1 | 2 | 3 | 4;
  kind: 'requirement' | 'scenario';
  label: string;                       // 'Requirement' | 'Scenario 1'..'Scenario 4'
  scenarioIdx: number | null;
  snapshot: PhaseSnapshot | null;
  submitted: boolean;                  // true ONLY on ordinal 4 when a `final` row exists
  diff: EntityDiff | null;             // vs previous non-null step; null on ordinal 0 / no prior
};
export function orderSnapshots(rows: PhaseSnapshot[]): PhaseSnapshot[];
export function buildSteps(rows: PhaseSnapshot[]): ProgressionStep[];
export function diffEntities(prev: Entity[], curr: Entity[]): EntityDiff;
export function stepCount(rows: PhaseSnapshot[]): number; // # of the 5 step slots filled
```

- [ ] **Step 1: Write the failing tests** (the behaviors come straight from the data dossier: duplicate slots, non-monotonic `client_ts`, truncated tails, `final`≡last-scenario, untrimmed names)

```ts
// lib/progression/__tests__/progression.test.ts
import { describe, expect, it } from 'vitest';
import {
  buildSteps,
  diffEntities,
  orderSnapshots,
  stepCount,
  type PhaseSnapshot,
} from '@/lib/progression/progression';

const E = (name: string, elements: string[] = []) => ({
  id: name.trim() || 'x',
  name,
  elements: elements.map((n) => ({ id: n, name: n })),
});

const snap = (over: Partial<PhaseSnapshot>): PhaseSnapshot => ({
  phase: 'initial',
  scenarioIdx: null,
  spec: '',
  entities: [],
  clientTs: '2026-06-21T15:00:00Z',
  createdAt: '2026-06-21T15:00:00Z',
  ...over,
});

describe('orderSnapshots', () => {
  it('dedupes to the LATEST row per (phase, scenarioIdx) by clientTs', () => {
    const rows = [
      snap({ phase: 'initial', spec: 'old', clientTs: '2026-06-21T15:00:00Z' }),
      snap({ phase: 'initial', spec: 'newer', clientTs: '2026-06-21T15:05:00Z' }),
    ];
    const out = orderSnapshots(rows);
    expect(out).toHaveLength(1);
    expect(out[0].spec).toBe('newer');
  });

  it('orders by slot ordinal (scenario_idx), NOT clientTs — the non-monotonic user', () => {
    const rows = [
      snap({ phase: 'after_scenario', scenarioIdx: 2, spec: 's2', clientTs: '2026-06-21T16:00:00Z' }),
      // s1 committed LATER than s2 on the wall clock — still orders before it:
      snap({ phase: 'after_scenario', scenarioIdx: 1, spec: 's1', clientTs: '2026-06-21T16:30:00Z' }),
      snap({ phase: 'initial', spec: 'req', clientTs: '2026-06-21T15:00:00Z' }),
    ];
    expect(orderSnapshots(rows).map((r) => r.spec)).toEqual(['req', 's1', 's2']);
  });

  it('falls back to createdAt when clientTs is null', () => {
    const rows = [
      snap({ spec: 'a', clientTs: null, createdAt: '2026-06-21T15:00:00Z' }),
      snap({ spec: 'b', clientTs: null, createdAt: '2026-06-21T15:10:00Z' }),
    ];
    expect(orderSnapshots(rows)[0].spec).toBe('b');
  });
});

describe('buildSteps', () => {
  const full = [
    snap({ phase: 'initial', spec: 'v0' }),
    snap({ phase: 'after_scenario', scenarioIdx: 0, spec: 'v1', entities: [E('Vehicle ')] }),
    snap({ phase: 'after_scenario', scenarioIdx: 1, spec: 'v2', entities: [E('Vehicle'), E('Rider')] }),
    snap({ phase: 'after_scenario', scenarioIdx: 2, spec: 'v3', entities: [E('Rider')] }),
    snap({ phase: 'after_scenario', scenarioIdx: 3, spec: 'v4', entities: [E('Rider')] }),
    snap({ phase: 'final', spec: 'v4', entities: [E('Rider')] }),
  ];

  it('produces exactly 5 steps with 1-based scenario labels; final → submitted badge', () => {
    const steps = buildSteps(full);
    expect(steps.map((s) => s.label)).toEqual([
      'Requirement', 'Scenario 1', 'Scenario 2', 'Scenario 3', 'Scenario 4',
    ]);
    expect(steps[4].submitted).toBe(true);
    expect(steps.every((s) => s.snapshot !== null)).toBe(true);
  });

  it('truncated tail: missing s3 (+final) → null snapshots, submitted=false', () => {
    const steps = buildSteps(full.slice(0, 4)); // initial + s0 + s1 + s2
    expect(steps[4].snapshot).toBeNull();
    expect(steps[4].submitted).toBe(false);
    expect(steps[3].snapshot?.spec).toBe('v3');
  });

  it('diff is vs the previous NON-NULL step and null on the Requirement step', () => {
    const steps = buildSteps(full);
    expect(steps[0].diff).toBeNull();
    // step1 entities [Vehicle ] vs step0 [] → Vehicle added (trimmed name)
    expect(steps[1].diff?.addedEntities).toEqual(['Vehicle']);
    // step2 adds Rider, keeps Vehicle (trailing-space name matches trimmed)
    expect(steps[2].diff?.addedEntities).toEqual(['Rider']);
    expect(steps[2].diff?.removedEntities).toEqual([]);
    // step3 removes Vehicle
    expect(steps[3].diff?.removedEntities).toEqual(['Vehicle']);
  });

  it('stepCount counts filled step slots (final not a slot)', () => {
    expect(stepCount(full)).toBe(5);
    expect(stepCount(full.slice(0, 4))).toBe(4);
  });
});

describe('diffEntities', () => {
  it('matches by TRIMMED name so "Vehicle " == "Vehicle" (no phantom diffs)', () => {
    const d = diffEntities([E('Vehicle ')], [E('Vehicle')]);
    expect(d.addedEntities).toEqual([]);
    expect(d.removedEntities).toEqual([]);
    expect(d.changedEntities).toEqual([]);
  });

  it('reports element-level adds/removes on a persisting entity', () => {
    const d = diffEntities([E('Vehicle', ['Battery'])], [E('Vehicle', ['Battery', 'Location'])]);
    expect(d.changedEntities).toEqual([
      { name: 'Vehicle', addedElements: ['Location'], removedElements: [] },
    ]);
  });

  it('ignores entities whose trimmed name is empty (unmatchable)', () => {
    const d = diffEntities([], [E('  ')]);
    expect(d.addedEntities).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run lib/progression`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// lib/progression/progression.ts
// PURE progression engine over study_snapshots rows (no I/O). Encodes the data
// realities verified against the live study DB (see the viewer design spec §2):
//   - duplicate rows exist (3 users re-flushed slots) → dedupe LATEST per
//     (phase, scenarioIdx) by clientTs (createdAt fallback);
//   - clientTs is NOT monotonic across slots for one user → order by SLOT
//     ordinal (scenario_idx), never by wall clock;
//   - `final` is a byte-identical flush of the last scenario (26/26 users) →
//     it is NOT a 6th step; it sets `submitted` on the Scenario 4 step;
//   - completeness is a monotone prefix (truncated tails) → absent steps are
//     null snapshots, an expected state;
//   - entity/element names are RAW user input (trailing spaces) → diffs match
//     on TRIMMED names so whitespace never reads as change.

import type { Entity } from '@/lib/spec/reconstruct';

export type PhaseSnapshot = {
  phase: 'initial' | 'after_scenario' | 'final';
  scenarioIdx: number | null;
  spec: string;
  entities: Entity[];
  clientTs: string | null;
  createdAt: string;
};

export type EntityChange = { name: string; addedElements: string[]; removedElements: string[] };
export type EntityDiff = {
  addedEntities: string[];
  removedEntities: string[];
  changedEntities: EntityChange[];
};

export type ProgressionStep = {
  ordinal: 0 | 1 | 2 | 3 | 4;
  kind: 'requirement' | 'scenario';
  label: string;
  scenarioIdx: number | null;
  snapshot: PhaseSnapshot | null;
  submitted: boolean;
  diff: EntityDiff | null;
};

/** Slot ordinal for ordering/keying: initial=0, after_scenario n=1+n, final=5.
 *  Returns null for a row that fits no slot (defensive: unknown phase or an
 *  after_scenario row with no scenarioIdx — dropped by orderSnapshots). */
function slotOrdinal(row: PhaseSnapshot): number | null {
  if (row.phase === 'initial') return 0;
  if (row.phase === 'final') return 5;
  if (row.phase === 'after_scenario' && row.scenarioIdx !== null && row.scenarioIdx >= 0 && row.scenarioIdx <= 3) {
    return 1 + row.scenarioIdx;
  }
  return null;
}

/** Epoch ms of the row's commit instant: clientTs, falling back to createdAt.
 *  Unparseable → -Infinity (any parseable row wins the dedupe). */
function commitMs(row: PhaseSnapshot): number {
  const t = Date.parse(row.clientTs ?? row.createdAt);
  return Number.isNaN(t) ? -Infinity : t;
}

/** Dedupe to the LATEST row per slot, then order by slot ordinal. Rows fitting
 *  no slot are dropped. */
export function orderSnapshots(rows: PhaseSnapshot[]): PhaseSnapshot[] {
  const bySlot = new Map<number, PhaseSnapshot>();
  for (const row of rows) {
    const slot = slotOrdinal(row);
    if (slot === null) continue;
    const existing = bySlot.get(slot);
    if (!existing || commitMs(row) >= commitMs(existing)) bySlot.set(slot, row);
  }
  return [...bySlot.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r);
}

/** # of the FIVE step slots (ordinals 0–4) present after dedupe. `final` is not
 *  a step slot, so it never counts. Drives the picker's "n/5" hint. */
export function stepCount(rows: PhaseSnapshot[]): number {
  const slots = new Set<number>();
  for (const row of rows) {
    const slot = slotOrdinal(row);
    if (slot !== null && slot <= 4) slots.add(slot);
  }
  return slots.size;
}

const STEP_DEFS: { ordinal: 0 | 1 | 2 | 3 | 4; kind: 'requirement' | 'scenario'; label: string; scenarioIdx: number | null }[] = [
  { ordinal: 0, kind: 'requirement', label: 'Requirement', scenarioIdx: null },
  { ordinal: 1, kind: 'scenario', label: 'Scenario 1', scenarioIdx: 0 },
  { ordinal: 2, kind: 'scenario', label: 'Scenario 2', scenarioIdx: 1 },
  { ordinal: 3, kind: 'scenario', label: 'Scenario 3', scenarioIdx: 2 },
  { ordinal: 4, kind: 'scenario', label: 'Scenario 4', scenarioIdx: 3 },
];

/** Build the 5 display steps from raw rows (dedupes + orders internally).
 *  `submitted` marks the Scenario 4 step when a `final` row exists. Each step's
 *  `diff` compares its entities to the PREVIOUS NON-NULL step's, so a missing
 *  middle slot doesn't blank the next step's diff. */
export function buildSteps(rows: PhaseSnapshot[]): ProgressionStep[] {
  const ordered = orderSnapshots(rows);
  const bySlot = new Map<number, PhaseSnapshot>();
  for (const row of ordered) {
    const slot = slotOrdinal(row);
    if (slot !== null) bySlot.set(slot, row);
  }
  const hasFinal = bySlot.has(5);

  const steps: ProgressionStep[] = [];
  let prev: PhaseSnapshot | null = null;
  for (const def of STEP_DEFS) {
    const snapshot = bySlot.get(def.ordinal) ?? null;
    const diff = snapshot && prev ? diffEntities(prev.entities, snapshot.entities) : null;
    steps.push({
      ...def,
      snapshot,
      submitted: def.ordinal === 4 && snapshot !== null && hasFinal,
      diff,
    });
    if (snapshot) prev = snapshot;
  }
  return steps;
}

/** Entity/element set diff, matched by TRIMMED name (case-sensitive). Entities
 *  whose trimmed name is empty are unmatchable and ignored. Duplicate trimmed
 *  names: first occurrence wins (raw user data; documented, not an error). */
export function diffEntities(prev: Entity[], curr: Entity[]): EntityDiff {
  const prevMap = byTrimmedName(prev);
  const currMap = byTrimmedName(curr);

  const addedEntities: string[] = [];
  const removedEntities: string[] = [];
  const changedEntities: EntityChange[] = [];

  for (const name of currMap.keys()) {
    if (!prevMap.has(name)) addedEntities.push(name);
  }
  for (const name of prevMap.keys()) {
    if (!currMap.has(name)) removedEntities.push(name);
  }
  for (const [name, currEnt] of currMap) {
    const prevEnt = prevMap.get(name);
    if (!prevEnt) continue;
    const prevEls = elementNameSet(prevEnt);
    const currEls = elementNameSet(currEnt);
    const addedElements = [...currEls].filter((e) => !prevEls.has(e));
    const removedElements = [...prevEls].filter((e) => !currEls.has(e));
    if (addedElements.length > 0 || removedElements.length > 0) {
      changedEntities.push({ name, addedElements, removedElements });
    }
  }
  return { addedEntities, removedEntities, changedEntities };
}

function byTrimmedName(entities: Entity[]): Map<string, Entity> {
  const map = new Map<string, Entity>();
  for (const ent of entities) {
    const name = ent.name.trim();
    if (!name || map.has(name)) continue;
    map.set(name, ent);
  }
  return map;
}

function elementNameSet(ent: Entity): Set<string> {
  const set = new Set<string>();
  for (const el of ent.elements) {
    const name = el.name.trim();
    if (name) set.add(name);
  }
  return set;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run lib/progression`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add lib/progression/progression.ts lib/progression/__tests__/progression.test.ts
git commit -m "feat(progression): pure engine — slot dedupe/order, 5-step build, trimmed-name entity diffs"
```

---

### Task 6: Progression data layer (server actions)

**Files:**
- Create: `app/actions/progression.ts`
- Test: extend `lib/progression/__tests__/progression.test.ts` ONLY if pure helpers are added; the action itself is verified by tsc + guard + Task 8's manual smoke (established repo pattern for actions).

**Interfaces:**
- Consumes: `studyFrom` (Task 1), `taskModuleIdFrom`/`parseTaskAuthoring` (Task 4), `coerceEntity` (Task 4), engine types/functions (Task 5), `getShownStudy`, `createUserServerClient`, `requireAuthUser`.
- Produces (the UI consumes exactly these):

```ts
export type ProgressionParticipant = {
  pid: string;
  cohort: string | null;      // cb_sessions.collection; null when no session (PIDs 343, 411)
  sessionId: string | null;
  stepCount: number;          // 0..5
};
export async function listProgressionParticipants(): Promise<ProgressionParticipant[]>;

export type ParticipantProgression = {
  pid: string;
  title: string;                       // authored task title
  requirements: Requirement[];
  scenarios: Scenario[];               // indexed 0..3; UI shows idx+1
  steps: ProgressionStep[];
};
export async function getParticipantProgression(pid: string): Promise<ParticipantProgression | null>;
```

- [ ] **Step 1: Implement the action file**

```ts
// app/actions/progression.ts
'use server';

import { createUserServerClient } from '@/lib/supabase/user-server';
import { studyFrom } from '@/lib/supabase/study-guard';
import { requireAuthUser } from '@/lib/auth/supabase-auth';
import { getShownStudy } from '@/app/actions/codebook';
import { coerceEntity } from '@/lib/spec/reconstruct';
import { parseTaskAuthoring } from '@/lib/study/task-module';
import {
  buildSteps,
  stepCount as countSteps,
  type PhaseSnapshot,
  type ProgressionStep,
} from '@/lib/progression/progression';
import type { Requirement, Scenario } from '@/lib/study/study';

// ---------------------------------------------------------------------------
// Progression-analysis data layer (study-table READ, sub-project A).
//
// Reads the per-phase spec+entities snapshots (`study_snapshots` — one row per
// (participant, module, scenario, phase) boundary, written by the participant
// app at each phase flush) and shapes them into the 5-step progression the
// viewer renders. ALL study reads go through `studyFrom` (select-only guard on
// the user client; study tables carry SELECT-only RLS — the write-safety spec's
// L1+L2). `cb_sessions` (cohort tag) is read via the user client directly, the
// same split every study-reading action uses.
//
// PARTICIPANT-FIRST, not session-first: 27 users have snapshots but only 26
// cb_sessions exist — PIDs with a progression and NO session (343, 411) must
// still list, with cohort null (rendered "—", never defaulted).
//
// PII: `pid` only. This module never selects first_name or email.
// Empty-shape discipline: unknown pid / no snapshots → null / [] — never throw
// (only a genuine DB .error throws), mirroring spec.ts / chat.ts.
// ---------------------------------------------------------------------------

export type ProgressionParticipant = {
  pid: string;
  cohort: string | null;
  sessionId: string | null;
  stepCount: number;
};

export type ParticipantProgression = {
  pid: string;
  title: string;
  requirements: Requirement[];
  scenarios: Scenario[];
  steps: ProgressionStep[];
};

/** Snapshot row → engine shape. `entities` is ALREADY-PARSED jsonb (an array) —
 *  coerce each element; never JSON.parse (that's the event-stream encoding). */
function toPhaseSnapshot(row: {
  phase: string;
  scenario_idx: number | null;
  spec: string;
  entities: unknown;
  client_ts: string | null;
  created_at: string;
}): PhaseSnapshot | null {
  if (row.phase !== 'initial' && row.phase !== 'after_scenario' && row.phase !== 'final') {
    return null; // unknown phase: drop defensively (closed enum in the writer)
  }
  return {
    phase: row.phase,
    scenarioIdx: row.scenario_idx,
    spec: typeof row.spec === 'string' ? row.spec : '',
    entities: Array.isArray(row.entities) ? row.entities.map(coerceEntity) : [],
    clientTs: row.client_ts,
    createdAt: row.created_at,
  };
}

/**
 * Participants who have progression snapshots on the task module, ordered by
 * pid, each with cohort (via cb_sessions.pid_label = users.pid; null when no
 * session) and a filled-step count for the picker's "n/5" hint.
 */
export async function listProgressionParticipants(): Promise<ProgressionParticipant[]> {
  await requireAuthUser();

  // 1. Task module (scopes snapshots; every current snapshot is on it anyway —
  //    if unresolvable we include all rows rather than silently guessing).
  const authoring = parseTaskAuthoring((await getShownStudy())?.authored_data ?? null);

  // 2. All snapshot slots (user_id + slot keys only) via the select-only guard.
  let snapQuery = (await studyFrom('study_snapshots'))
    .select('user_id, phase, scenario_idx, client_ts, created_at');
  if (authoring) snapQuery = snapQuery.eq('module_id', authoring.moduleId);
  const snapRes = await snapQuery;
  if (snapRes.error) {
    throw new Error(`listProgressionParticipants: study_snapshots read failed: ${snapRes.error.message}`);
  }
  const rows = snapRes.data ?? [];
  if (rows.length === 0) return [];

  // Group slot rows per user; spec/entities are irrelevant for counting, so
  // synthesize empty ones for the engine's stepCount.
  const byUser = new Map<string, PhaseSnapshot[]>();
  for (const r of rows) {
    const snap = toPhaseSnapshot({ ...r, spec: '', entities: [] });
    if (!snap) continue;
    const list = byUser.get(r.user_id) ?? [];
    list.push(snap);
    byUser.set(r.user_id, list);
  }

  // 3. pid per user (pid ONLY — no name/email leaves this layer).
  const userRes = await (await studyFrom('users'))
    .select('id, pid')
    .in('id', [...byUser.keys()]);
  if (userRes.error) {
    throw new Error(`listProgressionParticipants: users read failed: ${userRes.error.message}`);
  }

  // 4. Cohort via cb_sessions (user client — cb_ table), keyed by pid_label.
  //    LEFT-join semantics: a pid with no session keeps cohort null.
  const userSb = await createUserServerClient();
  const sessRes = await userSb.from('cb_sessions').select('id, pid_label, collection');
  if (sessRes.error) {
    throw new Error(`listProgressionParticipants: cb_sessions read failed: ${sessRes.error.message}`);
  }
  const sessionByPid = new Map<string, { id: string; collection: string }>();
  for (const s of sessRes.data ?? []) {
    const pid = (s.pid_label ?? '').trim();
    if (pid && !sessionByPid.has(pid)) sessionByPid.set(pid, { id: s.id, collection: s.collection });
  }

  return (userRes.data ?? [])
    .map((u) => {
      const sess = sessionByPid.get(u.pid) ?? null;
      return {
        pid: u.pid,
        cohort: sess?.collection ?? null,
        sessionId: sess?.id ?? null,
        stepCount: countSteps(byUser.get(u.id) ?? []),
      };
    })
    .sort((a, b) => a.pid.localeCompare(b.pid));
}

/**
 * One participant's full progression: authored requirements + scenarios (for
 * the right-hand pane) and the 5 steps with snapshots + entity diffs. Null when
 * the pid is unknown or has no snapshots (the picker only lists pids that do,
 * so null here means a stale/removed pid — the UI shows an empty state).
 */
export async function getParticipantProgression(pid: string): Promise<ParticipantProgression | null> {
  await requireAuthUser();
  const cleanPid = (pid ?? '').trim();
  if (!cleanPid) return null;

  const authoring = parseTaskAuthoring((await getShownStudy())?.authored_data ?? null);

  const userRes = await (await studyFrom('users'))
    .select('id')
    .eq('pid', cleanPid)
    .maybeSingle();
  if (userRes.error) {
    throw new Error(`getParticipantProgression: users read failed: ${userRes.error.message}`);
  }
  const userId = userRes.data?.id;
  if (!userId) return null;

  let snapQuery = (await studyFrom('study_snapshots'))
    .select('phase, scenario_idx, spec, entities, client_ts, created_at')
    .eq('user_id', userId);
  if (authoring) snapQuery = snapQuery.eq('module_id', authoring.moduleId);
  const snapRes = await snapQuery;
  if (snapRes.error) {
    throw new Error(`getParticipantProgression: study_snapshots read failed: ${snapRes.error.message}`);
  }

  const snapshots = (snapRes.data ?? [])
    .map(toPhaseSnapshot)
    .filter((s): s is PhaseSnapshot => s !== null);
  if (snapshots.length === 0) return null;

  return {
    pid: cleanPid,
    title: authoring?.title ?? '',
    requirements: authoring?.requirements ?? [],
    scenarios: authoring?.scenarios ?? [],
    steps: buildSteps(snapshots),
  };
}
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit && npm run lint && npx vitest run`
Expected: all green (lint proves: no study write, no raw service client, no rpc).

- [ ] **Step 3: Commit**

```bash
git add app/actions/progression.ts
git commit -m "feat(progression): participant list + per-participant progression actions via studyFrom"
```

---

### Task 7: Viewer UI + route + nav

**Files:**
- Create: `components/progression/ProgressionViewer.tsx` (client island: picker + stepper + panes)
- Create: `components/progression/ProgressionEntityGrid.tsx` (diff-overlaid entity grid)
- Create: `components/progression/AuthoredScenarioPane.tsx` (requirements / Gherkin clauses)
- Create: `app/(protected)/progression-analysis/page.tsx`
- Modify: `app/(protected)/CodebookNav.tsx` (add nav link after the Sessions entry)

**Interfaces:**
- Consumes: `ProgressionParticipant`, `ParticipantProgression`, `getParticipantProgression` (Task 6); `ProgressionStep`, `EntityDiff` (Task 5); `Entity` (`@/lib/spec/reconstruct`); `Requirement`, `Scenario` (`@/lib/study/study`).
- Produces: the `/progression-analysis` route. No other task consumes these components.

- [ ] **Step 1: Entity grid with diff overlay**

```tsx
// components/progression/ProgressionEntityGrid.tsx
'use client';

import type { Entity } from '@/lib/spec/reconstruct';
import type { EntityDiff } from '@/lib/progression/progression';

// ---------------------------------------------------------------------------
// The participant's entity/element grid at one phase, with the step's diff
// overlaid: entities/elements ADDED this phase get an accent ring + "+" mark;
// REMOVED ones (present in the previous phase, gone now) render as ghost cards,
// struck through, so the researcher sees what disappeared without consulting
// two steps. diff === null (Requirement step / no prior step) renders plain —
// the same visual as SpecReplay's ReadOnlyEntityGrid, whose card layout this
// mirrors (grid-cols-3, name over a `· element` list).
// Matching is by TRIMMED name, identical to lib/progression/diffEntities.
// ---------------------------------------------------------------------------

export default function ProgressionEntityGrid({
  entities,
  diff,
}: {
  entities: Entity[];
  diff: EntityDiff | null;
}) {
  const addedEnt = new Set(diff?.addedEntities ?? []);
  const changed = new Map((diff?.changedEntities ?? []).map((c) => [c.name, c]));

  if (entities.length === 0 && (diff?.removedEntities.length ?? 0) === 0) {
    return <p className="text-xs italic text-[var(--muted)]">(no entities recorded)</p>;
  }

  return (
    <div className="grid grid-cols-3 gap-2">
      {entities.map((ent, i) => {
        const name = ent.name.trim();
        const isAdded = addedEnt.has(name);
        const change = changed.get(name);
        const addedEls = new Set(change?.addedElements ?? []);
        return (
          <div
            key={ent.id || `entity-${i}`}
            className={`border p-2 flex flex-col gap-1 bg-[var(--background)] ${
              isAdded ? 'border-emerald-600/70 ring-1 ring-emerald-600/30' : 'border-[var(--rule)]'
            }`}
          >
            <div className="text-sm border-b border-dashed border-[var(--rule)] py-1 break-words">
              {isAdded && <span className="mr-1 text-emerald-700" aria-label="added this phase">+</span>}
              {ent.name || <span className="text-[var(--muted)]">Entity</span>}
            </div>
            <ul className="space-y-0.5">
              {ent.elements.map((el, ei) => {
                const elAdded = addedEls.has(el.name.trim());
                return (
                  <li key={el.id || `element-${i}-${ei}`} className="flex gap-1 items-center text-sm">
                    <span className="text-[var(--muted)] shrink-0">·</span>
                    <span className={`min-w-0 break-words py-0.5 ${elAdded ? 'text-emerald-700' : ''}`}>
                      {elAdded && <span className="mr-0.5">+</span>}
                      {el.name || <span className="text-[var(--muted)]">element</span>}
                    </span>
                  </li>
                );
              })}
              {/* Elements REMOVED from this (persisting) entity this phase. */}
              {(change?.removedElements ?? []).map((elName) => (
                <li key={`removed-${elName}`} className="flex gap-1 items-center text-sm">
                  <span className="text-[var(--muted)] shrink-0">·</span>
                  <span className="min-w-0 break-words py-0.5 line-through text-red-700/60">{elName}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      {/* Ghost cards for entities removed this phase. */}
      {(diff?.removedEntities ?? []).map((name) => (
        <div
          key={`removed-${name}`}
          className="border border-dashed border-red-700/40 p-2 bg-[var(--background)] opacity-60"
        >
          <div className="text-sm py-1 break-words line-through text-red-700/70">{name}</div>
          <p className="text-[10px] uppercase tracking-wider text-red-700/50">removed this phase</p>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Authored scenario pane**

```tsx
// components/progression/AuthoredScenarioPane.tsx
'use client';

import type { Requirement, Scenario } from '@/lib/study/study';

// ---------------------------------------------------------------------------
// The right-hand comparison pane: WHAT THE PARTICIPANT WAS RESPONDING TO at the
// selected step. Requirement step → the authored user stories (role/want/so).
// Scenario step → the authored Gherkin clauses in order; clauses marked `new`
// (added in this scenario — scenarios are cumulative) carry an accent bar +
// "new" chip so the delta the participant saw is visible at a glance. Text
// only by design (spec §1): no map, no seeded markers.
// ---------------------------------------------------------------------------

export function RequirementsPane({ requirements }: { requirements: Requirement[] }) {
  if (requirements.length === 0) {
    return <p className="text-sm italic text-[var(--muted)]">(no authored requirements found)</p>;
  }
  return (
    <ul className="space-y-2">
      {requirements.map((r) => (
        <li key={r.id} className="border border-[var(--rule)] bg-[var(--background)] p-2 text-sm leading-relaxed">
          <span className="font-medium">As a {r.role}</span>
          <span>, I want {r.want}</span>
          <span className="text-foreground/70"> so that {r.so}.</span>
        </li>
      ))}
    </ul>
  );
}

export function ScenarioPane({ scenario }: { scenario: Scenario | null }) {
  if (!scenario) {
    return <p className="text-sm italic text-[var(--muted)]">(no authored scenario at this index)</p>;
  }
  return (
    <div className="space-y-1">
      <h4 className="text-sm font-medium">{scenario.title}</h4>
      <ul className="space-y-1">
        {scenario.clauses.map((c) => (
          <li
            key={c.id}
            className={`flex gap-2 border-l-2 py-0.5 pl-2 text-sm leading-relaxed ${
              c.marker === 'new' ? 'border-emerald-600/70' : 'border-transparent'
            }`}
          >
            <span className="w-12 shrink-0 font-mono text-xs uppercase tracking-wide text-foreground/50 pt-0.5">
              {c.type}
            </span>
            <span className={c.marker === 'superseded' ? 'line-through text-foreground/40' : ''}>
              {c.text}
            </span>
            {c.marker === 'new' && (
              <span className="ml-auto shrink-0 self-start border border-emerald-600/40 px-1 text-[10px] uppercase tracking-wider text-emerald-700">
                new
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 3: The viewer island**

```tsx
// components/progression/ProgressionViewer.tsx
'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { getParticipantProgression } from '@/app/actions/progression';
import type {
  ParticipantProgression,
  ProgressionParticipant,
} from '@/app/actions/progression';
import ProgressionEntityGrid from '@/components/progression/ProgressionEntityGrid';
import { RequirementsPane, ScenarioPane } from '@/components/progression/AuthoredScenarioPane';

// ---------------------------------------------------------------------------
// Progression viewer island. LEFT: participant picker mirroring the /sessions
// index — grouped by cohort (pilot / study / "—" for snapshot-only PIDs with no
// session), one clickable row per pid with an n/5 filled-steps hint. RIGHT: the
// 5-step phase stepper (Requirement, Scenarios 1–4; data scenario_idx is
// 0-based, display is 1-based) over two panes — the participant's spec+entities
// at that phase (with the entity diff overlaid) and the authored content they
// were responding to. `final` is not a step: it renders as a "submitted ✓"
// badge on Scenario 4 (it is byte-identical to it for every participant).
// Server action called from a HANDLER (never render), result held in state —
// the standard island pattern (SessionsIndex / LiveFollow).
// ---------------------------------------------------------------------------

export default function ProgressionViewer({
  participants,
}: {
  participants: ProgressionParticipant[];
}) {
  const [activePid, setActivePid] = useState<string | null>(null);
  const [progression, setProgression] = useState<ParticipantProgression | null>(null);
  const [activeOrdinal, setActiveOrdinal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function pick(pid: string) {
    setActivePid(pid);
    setError(null);
    startTransition(async () => {
      try {
        const result = await getParticipantProgression(pid);
        setProgression(result);
        // Land on the first step that has data (always 0 in practice — nobody
        // is missing `initial` — but stay defensive).
        setActiveOrdinal(result?.steps.find((s) => s.snapshot)?.ordinal ?? 0);
      } catch (err) {
        setProgression(null);
        setError(err instanceof Error ? err.message : 'Failed to load progression.');
      }
    });
  }

  // Cohort grouping, insertion-ordered: pilot, study, then "—" (no session).
  const groups = new Map<string, ProgressionParticipant[]>();
  for (const p of [...participants].sort(
    (a, b) => (a.cohort ?? '~').localeCompare(b.cohort ?? '~') || a.pid.localeCompare(b.pid),
  )) {
    const key = p.cohort ?? '—';
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }

  const activeStep = progression?.steps.find((s) => s.ordinal === activeOrdinal) ?? null;

  return (
    <div className="flex gap-6">
      {/* ---- Left rail: participant picker (mirrors SessionsIndex grouping) ---- */}
      <aside className="w-56 shrink-0 space-y-5">
        {participants.length === 0 && (
          <p className="text-sm text-foreground/60">No participants with snapshots.</p>
        )}
        {[...groups.entries()].map(([cohort, group]) => (
          <section key={cohort}>
            <h2 className="mb-1 text-xs font-semibold uppercase tracking-wider text-foreground/50">
              {cohort} · {group.length}
            </h2>
            <ul className="divide-y divide-foreground/10 border border-foreground/15">
              {group.map((p) => (
                <li key={p.pid}>
                  <button
                    type="button"
                    onClick={() => pick(p.pid)}
                    disabled={isPending}
                    aria-pressed={activePid === p.pid}
                    className={`flex w-full items-center justify-between px-2 py-1.5 text-left text-sm transition disabled:opacity-50 ${
                      activePid === p.pid ? 'bg-foreground text-background' : 'hover:bg-foreground/5'
                    }`}
                  >
                    <span className="font-mono">{p.pid}</span>
                    <span className={activePid === p.pid ? 'text-background/70 text-xs' : 'text-foreground/40 text-xs'}>
                      {p.stepCount}/5
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </aside>

      {/* ---- Right: stepper + panes ---- */}
      <div className="min-w-0 flex-1">
        {error && (
          <p className="mb-3 border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700">{error}</p>
        )}
        {!activePid && (
          <p className="text-sm text-foreground/60">
            Pick a participant to walk their specification across the five phases.
          </p>
        )}
        {activePid && isPending && <p className="text-sm text-foreground/40">Loading {activePid}…</p>}
        {activePid && !isPending && !progression && !error && (
          <p className="text-sm text-foreground/60">No progression data for {activePid}.</p>
        )}

        {progression && !isPending && (
          <>
            {/* Step tabs. Disabled when that phase has no snapshot (truncated tail). */}
            <div className="mb-4 flex items-center gap-1 border-b border-foreground/15">
              {progression.steps.map((step) => (
                <button
                  key={step.ordinal}
                  type="button"
                  onClick={() => setActiveOrdinal(step.ordinal)}
                  disabled={!step.snapshot}
                  className={`px-3 py-1.5 text-sm transition disabled:opacity-30 ${
                    activeOrdinal === step.ordinal
                      ? 'border-b-2 border-foreground font-medium'
                      : 'text-foreground/60 hover:text-foreground'
                  }`}
                >
                  {step.label}
                  {step.submitted && (
                    <span className="ml-1 text-emerald-700" title="final submission recorded (identical to Scenario 4)">
                      ✓
                    </span>
                  )}
                </button>
              ))}
              {progression && (
                <span className="ml-auto pb-1 text-xs text-foreground/40">
                  {progression.title}
                  {(() => {
                    const p = participants.find((x) => x.pid === activePid);
                    return p?.sessionId ? (
                      <>
                        {' · '}
                        <Link href={`/sessions/${p.sessionId}`} className="underline underline-offset-2 hover:text-foreground">
                          open session →
                        </Link>
                      </>
                    ) : null;
                  })()}
                </span>
              )}
            </div>

            {activeStep && activeStep.snapshot && (
              <div className="grid grid-cols-2 gap-6">
                {/* Participant state at this phase */}
                <section className="min-w-0 space-y-2">
                  <h3 className="text-[11px] uppercase tracking-[0.14em] text-[var(--muted)]">
                    Participant · {activePid} · {activeStep.label}
                  </h3>
                  <div className="border border-[var(--rule)] bg-[var(--rule-soft)] p-3 flex flex-col gap-2">
                    <h4 className="text-[11px] uppercase tracking-[0.14em] text-[var(--muted)]">
                      Entities &amp; Elements
                    </h4>
                    <ProgressionEntityGrid
                      entities={activeStep.snapshot.entities}
                      diff={activeStep.diff}
                    />
                    <p
                      className="font-mono text-[10px] tracking-tighter text-[var(--muted)] select-none leading-none my-2"
                      aria-hidden
                    >
                      ================================================
                    </p>
                    {activeStep.snapshot.spec ? (
                      <p className="text-[15px] leading-relaxed font-mono whitespace-pre-wrap break-words">
                        {activeStep.snapshot.spec}
                      </p>
                    ) : (
                      <p className="text-xs italic text-[var(--muted)]">(empty specification at this phase)</p>
                    )}
                  </div>
                </section>

                {/* What they were responding to */}
                <section className="min-w-0 space-y-2">
                  <h3 className="text-[11px] uppercase tracking-[0.14em] text-[var(--muted)]">
                    {activeStep.kind === 'requirement' ? 'Authored requirements' : `Authored · ${activeStep.label}`}
                  </h3>
                  {activeStep.kind === 'requirement' ? (
                    <RequirementsPane requirements={progression.requirements} />
                  ) : (
                    <ScenarioPane
                      scenario={
                        activeStep.scenarioIdx !== null
                          ? progression.scenarios[activeStep.scenarioIdx] ?? null
                          : null
                      }
                    />
                  )}
                </section>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Page + nav**

```tsx
// app/(protected)/progression-analysis/page.tsx
import { listProgressionParticipants } from '@/app/actions/progression';
import ProgressionViewer from '@/components/progression/ProgressionViewer';

/**
 * Progression analysis (server page). Lists participants WITH study snapshots
 * (participant-first — includes the snapshot-only PIDs that have no cb_session;
 * their cohort renders "—") and hands them to the client viewer, which fetches
 * one participant's 5-phase progression on selection. Read-only over study
 * data via studyFrom; identity is pid-only.
 */
export default async function ProgressionAnalysisPage() {
  const participants = await listProgressionParticipants();

  return (
    <main className="px-6 py-6">
      <header className="mb-4">
        <h1 className="text-lg font-medium tracking-tight">Progression</h1>
        <p className="max-w-2xl text-sm text-foreground/60">
          Each participant&apos;s specification at its five phase boundaries — the
          requirement-only draft, then the revision after each scenario. Entity
          changes vs the prior phase are highlighted; the authored scenario the
          participant saw sits beside their spec.
        </p>
      </header>
      <ProgressionViewer participants={participants} />
    </main>
  );
}
```

In `app/(protected)/CodebookNav.tsx`, add to `LINKS` after the Sessions entry:

```ts
  { href: '/sessions', label: 'Sessions' },
  { href: '/progression-analysis', label: 'Progression' },
```

- [ ] **Step 5: Verify + commit**

Run: `npx tsc --noEmit && npm run lint && npx vitest run`
Expected: green.

```bash
git add components/progression app/(protected)/progression-analysis app/(protected)/CodebookNav.tsx
git commit -m "feat(progression): /progression-analysis viewer — cohort picker, 5-step stepper, diff grid, authored pane"
```

---

### Task 8: Full verification + manual smoke

**Files:** none created; fixes only if verification fails.

- [ ] **Step 1: Full battery**

Run, from the repo root:
```bash
npx tsc --noEmit
npx vitest run
npm run lint
```
Expected: all green. Any failure: fix within this task, re-run.

- [ ] **Step 2: Manual smoke on :3200** (the dev server serves this checkout; if down: `npm run dev` is Hudson's to run — ask, don't start it inside the task)

Checklist (record actual results):
1. `/progression-analysis` renders; nav shows "Progression"; groups show `pilot`, `study`, and `—` (PIDs 343 + 411 under `—`).
2. Pick a full-progression pid → 5 tabs enabled, Scenario 4 shows ✓; walk all steps; diffs highlight adds (green), removals (struck ghosts); Scenario tabs show authored clauses with `new` chips.
3. Pick a truncated-tail pid (one of the 3 with <5 steps) → later tabs disabled, no errors.
4. Empty-spec phase renders "(empty specification at this phase)".
5. Regression: `/sessions/<id>` player still loads chat + specification tabs (Task 2 changed their read path); `/sessions/live` PID picker still lists participants.
6. Confirm zero study-table writes occurred: reads only (the guard + RLS make writes impossible, but note it).

- [ ] **Step 3: Commit any fixes; final state**

```bash
git status --short   # expect: clean tree, all tasks committed
git log --oneline origin/main..HEAD
```

## Self-Review (done at plan time)

- **Spec coverage:** picker w/ cohorts + "—" (T6/T7), 5 steps + 1-based labels + submitted badge (T5/T7), dedupe/order/tail hazards (T5), text-only authored pane w/ `new` markers (T4/T7), entity diffs trimmed-name (T5/T7), `studyFrom` + migration + CI hardening = safety L2/L3 (T1–T3), guard-gap `llm_prompts` (T3), PII pid-only (T6), nav + page shell (T7). Deliberately dropped per spec: map/sim, `resolveTaskModuleId` third copy (extracted instead, T4).
- **Placeholders:** none — every step carries real code/commands.
- **Type consistency:** `PhaseSnapshot`/`ProgressionStep`/`EntityDiff` defined once (T5), consumed by name in T6/T7; `studyFrom` await-then-chain shape identical in T2 and T6; `parseTaskAuthoring` return consumed field-for-field in T6.
