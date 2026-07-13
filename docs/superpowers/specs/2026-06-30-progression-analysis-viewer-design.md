# Progression Analysis Viewer (`/progression-analysis`) — Design

**Date:** 2026-06-30
**Status:** Approved shape (4 forks resolved), pending spec review
**Scope:** Sub-project **A** of two. Sub-project B (`/progression-analysis/llm` eval harness) is sketched at the end and specced separately after A ships.

---

## 1. Purpose

A read-only researcher tool to **click through one participant's specification as it evolved** across the study's five phases — the requirement-only draft, then the revision after each of the four scenarios — seeing, at each phase, the participant's **spec text** and their **entity/element data model**, with a lightweight highlight of **what changed** from the prior phase. The participant is chosen from a picker that mirrors how `/sessions` presents participants, tagged with their `pilot`/`study` cohort.

This is the process-trace complement to `/sessions` (which replays the *recording*); here we read the *materialized per-phase snapshots* directly.

**Out of scope for A (explicit):** the rideshare `MapCanvas` / city-map render (pedagogical for participants, not needed here), any simulation, any LLM call, any write to study tables. All of that is sub-project B.

---

## 2. Data model (grounded in the study DB)

All study data lives in the shared VT Supabase project, **read-only**, reached via the **service-role** client (study tables are RLS-gated against the researcher JWT).

### 2.1 Progression source: `public.study_snapshots`
Columns: `id, user_id, study_id, module_id, phase text, scenario_idx int|null, spec text, entities jsonb, client_ts, created_at`.
- `phase` ∈ `{'initial','after_scenario','final'}` (closed enum, writer-enforced).
- All rows are on the single task module **`3g7lg4if`** ("Rideshare Matching Platform").
- `spec` is the **full self-contained spec at that phase**, not a delta (proven: `spec` length is non-monotonic across phases).
- `entities` is an **already-parsed jsonb array** conforming strictly to `Entity[] = [{id,name,elements:[{id,name}]}]` (0 violations across 164 non-empty rows). **Do not `JSON.parse`** — feed straight through `coerceEntity`.

**The canonical five-phase sequence** (display order):

| Ordinal | Step label | `phase` | `scenario_idx` |
|---|---|---|---|
| 0 | Requirement | `initial` | `null` |
| 1 | Scenario 1 | `after_scenario` | `0` |
| 2 | Scenario 2 | `after_scenario` | `1` |
| 3 | Scenario 3 | `after_scenario` | `2` |
| 4 | Scenario 4 | `after_scenario` | `3` |

The **displayed scenario number is `scenario_idx + 1`** (data is 0-indexed; researchers count from 1).

`phase='final'` is **not a step** — it is byte-identical to Scenario 4 for 26/26 users (a submission flush). It renders only as a **"submitted ✓" badge** on the Scenario 4 step when a `final` row exists.

**Two data hazards the code must handle:**
- **Duplicate rows.** 172 rows / 27 users because 3 users have re-written slots. **Dedupe to the latest row per `(user_id, phase, scenario_idx)` by `client_ts DESC`.**
- **Ordering.** Order by the **ordinal above (via `scenario_idx`)**, never by `client_ts` — one user is non-monotonic in `client_ts` even after dedup. `client_ts` is only a within-slot tiebreak.
- **Missing tail.** Completeness is a monotone prefix: 24 users have all 5 steps; 2 miss Scenario 4; 1 misses Scenarios 4 (dropout). A missing step renders an **absent state**, not an error. `spec` may be `''` and `entities` may be `[]` — render empty states.

### 2.2 Participant identity + cohort
- Participants are `public.users` (`id, pid, first_name`). **`pid`** (3-digit zero-padded, e.g. `041`) is the researcher-facing label. `first_name`/`email` are **real PII — never display or export them**; key everything on `pid`.
- Join to snapshots: `study_snapshots.user_id → users.id` (FK).
- **Cohort tag** = `public.cb_sessions.collection` ∈ `{'pilot','study'}` (no `prn`). `cb_sessions` has **no FK** to users — join is the text match **`cb_sessions.pid_label = users.pid`**, read via the **user/anon** client (cb_ tables are researcher-JWT RLS).
- **Participant-first, not session-first.** 27 users have snapshots; only 26 have a `cb_session`. PIDs **343** and **411** have full progressions but no session → a session-driven list drops them. Enumerate participants from `study_snapshots`; left-join `cb_sessions` for the cohort. When absent, cohort renders **"—"** (never defaulted).

### 2.3 Authored scenario (the right-hand comparison pane)
From `getShownStudy().authored_data.modules[]`, the element with `id='3g7lg4if'`:
- `requirements[]` = `{id, role, want, so}` (6 user stories) — shown on the Requirement step.
- `scenarios[]` (length 4, indexed 0–3) = `{id, title, facilitatorNote, clauses[]}` where `clauses[]` = `{id, type: 'Given'|'And'|'When'|'Then', text, marker?: 'new'}`. Scenarios are cumulative; `marker:'new'` flags clauses added this scenario, carried-over clauses have no marker. (No `seededMarkers`/`cityMap` render in A — text clauses only.)
- Joined to a snapshot by **`scenario_idx`** → `scenarios[scenario_idx]`.

---

## 3. Architecture

Follows the established `sessions/page.tsx → action → client island` pattern. No new deps.

### 3.1 Pure logic — `lib/progression/progression.ts` (no I/O, unit-tested)
```ts
export type Entity = import('@/lib/spec/reconstruct').Entity; // {id,name,elements:{id,name}[]}

export type PhaseSnapshot = {
  phase: 'initial' | 'after_scenario' | 'final';
  scenarioIdx: number | null;
  spec: string;
  entities: Entity[];
  clientTs: string | null;
};

export type EntityDiff = {
  addedEntities: string[];                 // entity names new this phase
  removedEntities: string[];               // entity names gone this phase
  changedEntities: {                       // entity present in both, element set changed
    name: string;
    addedElements: string[];
    removedElements: string[];
  }[];
};

export type ProgressionStep = {
  ordinal: 0 | 1 | 2 | 3 | 4;
  kind: 'requirement' | 'scenario';
  label: string;                           // "Requirement" | "Scenario 1".."Scenario 4"
  scenarioIdx: number | null;              // null for requirement, else 0..3
  snapshot: PhaseSnapshot | null;          // null = participant has no snapshot at this step
  submitted: boolean;                      // scenario 4 step only: a `final` row exists
  diff: EntityDiff | null;                 // vs previous NON-NULL step; null for requirement/first
};

// Dedupe latest per (phase, scenario_idx) by clientTs DESC, then order by ordinal.
export function orderSnapshots(rows: PhaseSnapshot[]): PhaseSnapshot[];

// Build the 5 steps from ordered snapshots + the final-row flag; compute diffs.
export function buildSteps(ordered: PhaseSnapshot[], hasFinal: boolean): ProgressionStep[];

// Entity/element set diff by TRIMMED name (names are untrimmed raw input, e.g. "Vehicle ").
export function diffEntities(prev: Entity[], curr: Entity[]): EntityDiff;
```
`diffEntities` matches entities/elements by **trimmed, case-sensitive name** (dossier: names carry trailing spaces; trimming prevents phantom whitespace diffs). Diff is computed **against the previous non-null step** (so a missing middle step doesn't blank the next step's diff).

### 3.2 Data layer — `app/actions/progression.ts` (`'use server'`)
Every function: `await requireAuthUser()` first; all study reads via `createServiceRoleClient()`; `cb_sessions` read via `createUserServerClient()`; every query is a `.select()`; unknown/empty inputs return empty shapes, never throw (mirrors `spec.ts`/`chat.ts`).

```ts
export type ProgressionParticipant = {
  pid: string;
  cohort: 'pilot' | 'study' | string | null; // from cb_sessions.collection; null when no session
  sessionId: string | null;                   // for optional deep-link to /sessions
  stepCount: number;                          // # of the 5 steps present (progress indicator)
};

// Enumerate participants who have snapshots on module 3g7lg4if; left-join cohort. Ordered by pid.
export async function listProgressionParticipants(): Promise<ProgressionParticipant[]>;

export type ParticipantProgression = {
  pid: string;
  requirements: Requirement[];                // authored, for the Requirement step
  scenarios: AuthoredScenario[];              // authored clauses, indexed 0..3
  steps: ProgressionStep[];                   // the participant's 5 steps w/ snapshots + diffs
};

// One participant's full progression, resolved + ordered + diffed. Empty steps for missing phases.
export async function getParticipantProgression(pid: string): Promise<ParticipantProgression | null>;
```
`AuthoredScenario` / `Requirement` / `Clause` types come from `lib/study/study.ts`. The task module id `3g7lg4if` is resolved via a shared `resolveTaskModuleId()` (today duplicated in `spec.ts`+`live.ts`; A extracts it to `lib/study/task-module.ts` and points all three call sites at it — a targeted cleanup, since A needs a third caller).

### 3.3 UI — `components/progression/` (client island)
- `ProgressionViewer.tsx` — top-level island. Left rail: a participant picker that **mirrors `/sessions` (`SessionsIndex`)** — grouped into cohort **sections** (`pilot`, `study`, and a `—` section for the sessionless PIDs 343/411), each a clickable **PID row** with a `stepCount/5` progress hint. Selecting a PID → calls `getParticipantProgression(pid)` from a handler (never during render) and holds the result in state. (Grouping/section-header idiom reused from `SessionsIndex`; rows are participant-keyed, not session-keyed.)
- **Phase stepper**: five step tabs (Requirement, Scenario 1–4); disabled/greyed when that step's snapshot is absent; Scenario 4 shows the "submitted ✓" badge when `submitted`.
- **Two panes** for the active step:
  - **Left — participant state:** the spec text (mono, `whitespace-pre-wrap`, reusing `SpecReplay`'s spec-rendering idiom) above a **new** `ProgressionEntityGrid.tsx`. The grid always renders the step's entities and overlays the step's `EntityDiff` when present (added = accent, removed = struck/muted, changed elements likewise); `diff === null` (Requirement step, or a step with no prior non-null step) renders plain — so the grid subsumes `SpecReplay`'s diffless entity half rather than branching between two grids.
  - **Right — authored scenario (text only):** `AuthoredScenarioPane.tsx` — for Requirement, the `requirements[]` user stories; for Scenario N, the Gherkin `clauses[]` grouped by `Given/When/Then`, `marker:'new'` clauses subtly emphasized.
- `coerceEntity`/`coerceElement` are **exported** from `lib/spec/reconstruct.ts` (currently private) so both the action and the grid parse snapshot jsonb crash-safely **without `JSON.parse`** (snapshot `entities` is already an array; `JSON.parse` would throw).

### 3.4 Page + nav
- `app/(protected)/progression-analysis/page.tsx` — async Server Component: `const participants = await listProgressionParticipants();` → `<ProgressionViewer participants={participants} />`. (Per-participant progression is fetched client-side on selection to keep the initial payload small.)
- Nav: add `{ href: '/progression-analysis', label: 'Progression' }` to `LINKS` in `app/(protected)/CodebookNav.tsx`.

---

## 4. Testing & verification
- **Unit (vitest):** `orderSnapshots` (dedupe latest-by-`client_ts`, ordinal ordering incl. the non-monotonic case, missing-tail), `buildSteps` (5 steps, final→badge, missing steps null, diff vs previous *non-null* step), `diffEntities` (add/remove/change by trimmed name, empty↔populated, untrimmed-name equivalence). Fixtures drawn from real shapes in the dossier (e.g. the `Vehicle `-with-trailing-space entity).
- **Type/lint:** `npx tsc --noEmit`; `npm run lint` (eslint + `scripts/check-no-study-writes.sh`).
- **Read-only enforcement:** A's reads go through the new `studyFrom()` select-only guard (see the **[Study-Data Write-Safety spec](./2026-06-30-study-data-write-safety-design.md)**), not raw `createServiceRoleClient()`. `check-no-study-writes.sh` already covers `study_snapshots`; the safety spec adds the one genuinely-missing table (`llm_prompts`) and quarantines the service-role client. A introduces zero writes, so it stays green throughout.
- **Manual:** on `:3200`, pick a full-5 participant (e.g. the perfect-6 user), a missing-Scenario-4 participant, and PID 343/411 (cohort "—"); confirm empty-state rendering and diff highlights.

---

## 5. Risks / decisions carried
- **PII:** display `pid` only; `first_name`/`email` never leave the action layer.
- **Untrimmed names:** normalize (trim) for diff matching only; display raw.
- **Read-only enforcement** is now structural via `studyFrom()` (L2 of the safety spec), not just discipline; the build runs under the L4 DB-safety verifier gate.
- **`resolveTaskModuleId` extraction** touches `spec.ts` + `live.ts` (repoint imports) — behavior-preserving; covered by their existing usage.

---

## 6. Sub-project B — `/progression-analysis/llm` (sketch; specced after A)
Participant multiselect (cohort tags) → prompt playground (system prompt seeded from `llm_prompts['help_seeking']`; few-shot picker over the 234 real `study_assistant_messages`; annotation→cached-prompt; model/temperature controls) → two graders: **(1) code-gen execution** — synthesize runnable logic from the participant's spec + entities and run it against a scenario oracle; **(2) LLM-as-judge** against a researcher-authored metric `.md` attached to every judge prompt → a per-phase improvement score + a running "paradigms" doc. Greenfield LLM layer: add an SDK + `ANTHROPIC_API_KEY` + a **non-study** results table (must not write `study_*`). **Open definitional crux:** there is no machine-readable pass/fail oracle in `authored_data` — "satisfies Scenario N" must be operationally defined (assignment match vs. pickup ordering vs. geographic end-state) before either grader is valid. B's design phase runs the `literature-review` skill + research subagents (execution-based eval, LLM-as-judge calibration — NeurIPS/ICML/ACL) to ground that definition.
