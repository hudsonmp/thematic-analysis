# Eval Harness B3 — Playground UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the researcher-facing playground at `/progression-analysis/llm`: cohort multiselect (with Select all · Deselect all · per-cohort select — Hudson's explicit ask), a config panel (grader/backend pickers, model/temp model-conditional, prompt-variant editor, few-shot picker, oracle-spec/metric artifact editors), run → verdict grid (participant × phase × grader) with per-phase improvement deltas, inspect + annotate → fold-into-variant, and the agreement view (κ + disagreement browser).

**Architecture:** Server page loads the participant list (reuse A's `listProgressionParticipants`) + initial artifacts/variants/few-shot sets, hands them to a client island. All mutation/run I/O goes through the EXISTING server actions from B1 (`app/actions/eval.ts`) and B2-4 (`app/actions/runs.ts`) — B3 adds NO new server actions and NO new DB access. Every unit of contestable logic (selection set-ops, model→control matrix, verdict-grid assembly, per-phase deltas, disagreement extraction) lives in PURE modules under `lib/eval/playground/` with vitest coverage; the React components are thin islands that call actions from handlers (never render) and hold results in state — exactly A's `ProgressionViewer` pattern.

**Tech Stack:** Next.js client islands (`'use client'`, `useState`/`useTransition`), Tailwind (match A's classes), zod only via the existing config validator. No new dependencies.

## Global Constraints

- Branch `feat/progression-analysis`. NEVER push to a remote; NEVER merge. Feature-branch commits only.
- **This is NOT the Next.js you know** (AGENTS.md): before writing any component/page, read the relevant guide under `node_modules/next/dist/docs/`. Server Components by default; a client island needs `'use client'`; server actions are called from event handlers or `useTransition`, NEVER during render (A documents this in `ProgressionViewer.tsx`). `searchParams`/`params` are Promises. Do NOT run `npm run dev` or `next build` in any task.
- Study tables are IRB READ-ONLY; B3 performs NO study writes and NO new study reads (the participant list + progression come from A's existing `studyFrom`-bound actions). PII is pid-only — never render first_name/email.
- All eval writes already funnel through `evalFrom` + `withStudyAudit` INSIDE the B1/B2-4 actions; B3 must not add a raw client, `.rpc`, or a service client. `check-no-study-writes.sh` must stay green.
- **AMENDED (B3-4b, commit 932187e):** the "B3 adds NO new server actions" intent held until a discovered requirement made it wrong — the annotate→fold loop is unusable without a way to read foldable annotation ids (`saveAnnotation` returned void; no list action). B3-4b therefore adds `listUnfoldedAnnotations()` (a new eval READ action) and changes `saveAnnotation` to return `{ id }`. Both stay inside the guard posture (eval_* via `evalFrom`, write still `withStudyAudit`, no raw client/`.rpc`/service client, PII pid-only). The constraint is amended, not violated: new eval actions are allowed when the loop demands them, provided they keep the guard invariants.
- Battery per task: `npx tsc --noEmit && npx vitest run && npm run lint` all green. TDD: pure helpers get failing tests first.
- Match A's visual register: `px-6 py-6`, `text-sm`, `text-foreground/60`, `border-foreground/15`, cohort order pilot → study → "—" (null) LAST via an explicit null-last comparator (NOT a `'~'` sentinel — ICU collation sorts `~` before letters; A's `ProgressionViewer` documents this trap).

## Consumed interfaces (exact — read the real files before building; adapt to them if drift)

From `app/actions/progression.ts` (A, shipped):
```ts
export type ProgressionParticipant = { pid: string; cohort: string | null; stepCount: number };
// NOTE (verified against committed code): ParticipantProgression has NO cohort —
// cohort lives ONLY on ProgressionParticipant from the LIST. Any grid/row that
// needs cohort must join it from the participant list by pid, never expect it on
// the progression.
export type ParticipantProgression = { pid: string; title: string; requirements: Requirement[]; scenarios: Scenario[]; steps: ProgressionStep[] };
// ProgressionStep (lib/progression/progression.ts): { ordinal: 0|1|2|3|4; kind: 'requirement'|'scenario'; label: string; scenarioIdx: number|null; snapshot: PhaseSnapshot|null; diff: EntityDiff|null; submitted?: boolean }
export async function listProgressionParticipants(): Promise<ProgressionParticipant[]>;
// getParticipantProgression(pid) returns ParticipantProgression | null.
```
From `app/actions/eval.ts` (B1, shipped): `listArtifacts(kind)`, `saveArtifact`, `listPromptVariants`, `savePromptVariant`, `listFewShotSets`, `saveFewShotSet`, `listAssistantTurnsForFewShot`, `saveAnnotation`, `foldAnnotationsIntoVariant` + types `EvalArtifact`, `PromptVariant`, `FewShotExample`, `FewShotSet`, `AssistantTurn`. **Read the real signatures at build time** (some take input objects); do not assume arg order.
From `app/actions/runs.ts` (B2-4): `RunRequest`, `createAndExecuteRun(req): {runId}`, `RunSummary`, `listRuns()`, `VerdictRow`, `listVerdicts(runId)`, `AgreementReport`, `compareRuns(a,b)`. **Read the real file** — if B2-4's committed shapes differ from the B2-4 plan, follow the committed code and note the delta.
From `lib/llm/config.ts` (B1): `EVAL_MODELS`, `LlmConfig`, `validateLlmConfig(cfg)`.

---

### Task B3-1: Route scaffold, nav entry, cohort multiselect with select-all/deselect-all/per-cohort

**Files:**
- Create: `lib/eval/playground/selection.ts`, `lib/eval/playground/__tests__/selection.test.ts`
- Create: `app/(protected)/progression-analysis/llm/page.tsx` (server), `components/playground/Playground.tsx` (client island shell), `components/playground/CohortPanel.tsx`
- Modify: `app/(protected)/CodebookNav.tsx` (add `{ href: '/progression-analysis/llm', label: 'LLM Eval' }` after the Progression entry)

**`selection.ts` (pure — the testable core of Hudson's explicit ask):**
```ts
import type { ProgressionParticipant } from '@/app/actions/progression';

/** Stable cohort order: pilot, study, then null ("—") LAST. Null-last explicit
 *  (a '~' sentinel sorts BEFORE letters under ICU collation — A's trap). */
export function cohortKey(cohort: string | null): string { return cohort ?? '￿—'; }
export function orderCohorts(cohorts: (string | null)[]): (string | null)[] {
  const uniq = Array.from(new Set(cohorts));
  return uniq.sort((a, b) => {
    const an = a === null ? 1 : 0, bn = b === null ? 1 : 0;
    return an - bn || (a ?? '').localeCompare(b ?? '');
  });
}
/** Group participants by cohort in display order. */
export function groupByCohort(ps: ProgressionParticipant[]): { cohort: string | null; pids: string[] }[] {
  const order = orderCohorts(ps.map((p) => p.cohort));
  return order.map((cohort) => ({
    cohort,
    pids: ps.filter((p) => p.cohort === cohort).map((p) => p.pid),
  }));
}
export function selectAll(ps: ProgressionParticipant[]): Set<string> { return new Set(ps.map((p) => p.pid)); }
export function deselectAll(): Set<string> { return new Set(); }
export function toggle(sel: Set<string>, pid: string): Set<string> {
  const next = new Set(sel); next.has(pid) ? next.delete(pid) : next.add(pid); return next;
}
/** Select every pid in one cohort WITHOUT touching other cohorts' selection. */
export function selectCohort(sel: Set<string>, ps: ProgressionParticipant[], cohort: string | null): Set<string> {
  const next = new Set(sel);
  ps.filter((p) => p.cohort === cohort).forEach((p) => next.add(p.pid));
  return next;
}
export function deselectCohort(sel: Set<string>, ps: ProgressionParticipant[], cohort: string | null): Set<string> {
  const next = new Set(sel);
  ps.filter((p) => p.cohort === cohort).forEach((p) => next.delete(p.pid));
  return next;
}
/** Tri-state for a per-cohort checkbox header. */
export function cohortSelectionState(sel: Set<string>, ps: ProgressionParticipant[], cohort: string | null): 'all' | 'none' | 'some' {
  const pids = ps.filter((p) => p.cohort === cohort).map((p) => p.pid);
  const n = pids.filter((p) => sel.has(p)).length;
  return n === 0 ? 'none' : n === pids.length ? 'all' : 'some';
}
```

**Tests (write FIRST, fail, then implement):** `orderCohorts(['study',null,'pilot'])` → `['pilot','study',null]`; `groupByCohort` buckets + order; `selectAll` size; `toggle` add then remove; `selectCohort` adds only that cohort's pids and leaves others; `deselectCohort` inverse; `cohortSelectionState` returns 'none'/'some'/'all' across a partial selection; null cohort is addressable (a `—`-cohort select works).

**Component structure:** `page.tsx` (server) awaits `listProgressionParticipants()` + `listArtifacts('oracle_spec')` + `listArtifacts('metric')` + `listPromptVariants()` + `listFewShotSets()` and passes them to `<Playground .../>`. `Playground.tsx` holds `selected: Set<string>` state and renders `<CohortPanel>` (this task) + placeholders for config/run (later tasks). `CohortPanel` renders, per `groupByCohort`: a cohort header with a tri-state checkbox (`cohortSelectionState` → checked/indeterminate) wired to `selectCohort`/`deselectCohort`, and a global **Select all · Deselect all** pair (`selectAll`/`deselectAll`); each pid is a checkbox row with an n/5 `stepCount` hint (mirror `ProgressionViewer`'s row). Indeterminate: set `ref.indeterminate = state === 'some'` in an effect.

**Steps:** failing selection tests → implement selection.ts → green → read `node_modules/next/dist/docs` routing/client-component guide → scaffold page + Playground shell + CohortPanel → add nav entry → `tsc && vitest && lint` → commit `feat(playground): route, nav, cohort multiselect with select-all/deselect-all/per-cohort`.

---

### Task B3-2: Config panel — graders, model-conditional knobs, artifact + variant + few-shot editors

**Files:**
- Create: `lib/eval/playground/config.ts` (pure: model→control matrix + RunRequest assembly), `lib/eval/playground/__tests__/config.test.ts`
- Create: `components/playground/ConfigPanel.tsx`, `components/playground/ArtifactEditor.tsx`, `components/playground/VariantEditor.tsx`, `components/playground/FewShotPicker.tsx`
- Modify: `components/playground/Playground.tsx` (mount ConfigPanel; lift config state)

**`config.ts` (pure):**
```ts
import { EVAL_MODELS, validateLlmConfig, type LlmConfig } from '@/lib/llm/config';
import type { RunRequest } from '@/app/actions/runs';

export type ControlMatrix = { temperatureAllowed: boolean; efforts: LlmConfig['effort'][]; models: typeof EVAL_MODELS };
/** Which knobs are valid for a model — derived by PROBING validateLlmConfig so
 *  the UI can never present an option the validator rejects (single source of
 *  truth). temperatureAllowed: does {model, temperature: 0.5} validate?
 *  efforts: which of low/medium/high/xhigh/max validate for this model. */
export function controlMatrix(model: LlmConfig['model']): ControlMatrix { /* probe validateLlmConfig for temp + each effort; return the allowed set */ }

export type PlaygroundConfig = {
  graderId: 'execution-codegen' | 'llm-judge';
  simBackend: 'deterministic' | 'llm' | null; // null when graderId is llm-judge
  llmConfig: LlmConfig;
  promptVariantId: string;
  fewShotSetId: string | null;
  oracleArtifactId: string;
  metricArtifactId: string;
};
/** Assemble + validate a RunRequest from panel state + the current selection.
 *  Returns {ok:false, error} when the selection is empty, an artifact/variant is
 *  unset, or validateLlmConfig fails — so Run is disabled with a reason. */
export function buildRunRequest(name: string, pids: string[], cfg: PlaygroundConfig): { ok: true; req: RunRequest } | { ok: false; error: string } { /* ... */ }
```

**Tests:** `controlMatrix('claude-opus-4-8').temperatureAllowed === false` and includes `xhigh`; `controlMatrix('claude-sonnet-4-6').temperatureAllowed === true` and EXCLUDES `xhigh`; `controlMatrix('claude-haiku-4-5').efforts` excludes effort entirely (per config.ts rules); `buildRunRequest` fails on empty pids / unset oracle / bad llmConfig with a specific message, succeeds on a valid config and echoes the ids. (These pin the matrix to `validateLlmConfig` — if the API rules change in config.ts, the matrix test breaks, forcing the UI in sync.)

**Component structure:** `ConfigPanel` renders: grader `<select>` (execution-codegen | llm-judge); when execution-codegen, a sim-backend `<select>` (deterministic | llm), else backend forced null + hidden; model `<select>` over `EVAL_MODELS`; a temperature slider shown only when `controlMatrix(model).temperatureAllowed`; an effort `<select>` over `controlMatrix(model).efforts`; a maxTokens number input (≤16000). `VariantEditor`: list `PromptVariant`s, pick one, edit its `system_prompt` in a textarea, Save → `savePromptVariant` (from a handler, `useTransition`), refresh list. `ArtifactEditor` (rendered twice — oracle_spec, metric): list versions from `listArtifacts(kind)`, show the latest content in a textarea WITH its `[UNDECIDED]` markers visible, Save → `saveArtifact` (new version). `FewShotPicker`: `listFewShotSets` to pick a set; a "build set" affordance listing `listAssistantTurnsForFewShot()` turns with checkboxes → `saveFewShotSet`. All editors are self-contained islands taking initial data as props and calling their action from handlers.

**Steps:** failing config tests → implement config.ts (probe-based matrix) → green → build the four editor components + ConfigPanel (read the Next docs for `useTransition` + form patterns) → wire into Playground → battery → commit `feat(playground): config panel — model-conditional knobs, artifact/variant/few-shot editors`.

---

### Task B3-3: Run execution + verdict grid + per-phase deltas

**Files:**
- Create: `lib/eval/playground/grid.ts` (pure: verdicts → grid + deltas), `lib/eval/playground/__tests__/grid.test.ts`
- Create: `components/playground/RunPanel.tsx`, `components/playground/VerdictGrid.tsx`, `components/playground/VerdictDetail.tsx`
- Modify: `components/playground/Playground.tsx` (mount RunPanel; hold current runId + verdicts)

**`grid.ts` (pure):**
```ts
import type { VerdictRow } from '@/app/actions/runs';
export type GridCell = { pid: string; phaseOrdinal: number; scenarioIdx: number | null; pass: boolean | null; score: number | null; verdictId: string };
export type GridRow = { pid: string; cohort: string | null; cells: GridCell[]; phaseDeltas: (number | null)[] };
/** Pivot flat verdicts into participant rows × phase columns for ONE grader
 *  run. Phase columns are the 5 ordinals (0..4). Per-phase improvement delta =
 *  score[phase] - score[phase-1] over the SAME scenarioIdx aggregate (mean
 *  score across the 4 scenarios at that phase), null where either side is
 *  ungradable. This is the metric-agnostic "did the spec improve after seeing
 *  scenario k" signal (metric.md defines the aggregation; v1 = mean of
 *  non-null scenario scores per phase). */
export function buildGrid(verdicts: VerdictRow[], participants: { pid: string; cohort: string | null }[]): GridRow[] { /* ... */ }
export function meanScorePerPhase(cells: GridCell[]): (number | null)[] { /* mean of non-null scores per ordinal 0..4 */ }
```

**Tests:** a fixture of verdicts (2 pids × 5 phases × 4 scenarios) → `buildGrid` yields 2 rows, each 20 cells, cohort carried; `meanScorePerPhase` averages non-null and returns null for an all-null phase; `phaseDeltas[k]` = mean[k]-mean[k-1], null when a neighbor is null; deltas[0] is null (no prior phase). Pin the "ungradable phase → null delta, not 0" case.

**Component structure:** `RunPanel`: a run-name input + a **Run** button (disabled with the `buildRunRequest` error reason when invalid) that calls `createAndExecuteRun(req)` via `useTransition`, shows a pending state, then loads `listVerdicts(runId)` and renders `<VerdictGrid>`. `VerdictGrid`: rows = participants, columns = 5 phases; each cell shows pass (✓/✗/—) + score, colored; a `phaseDeltas` strip under the header (▲/▼/—). Clicking a cell opens `<VerdictDetail>` (rationale, evidence JSON pretty-printed, and for execution verdicts the end-state per-check list; this is where B3-4's annotate affordance mounts). A run picker (`listRuns()`) lets Hudson reload a past run's grid. NOTE: `createAndExecuteRun` is synchronous-batch and may be slow (many LLM calls) — show a clear pending state; do not add polling infrastructure (YAGNI — it awaits).

**Steps:** failing grid tests → implement grid.ts → green → build RunPanel/VerdictGrid/VerdictDetail → wire into Playground → battery → commit `feat(playground): run execution, verdict grid, per-phase improvement deltas`.

---

### Task B3-4: Inspect + annotate → fold into variant

**Files:**
- Create: `components/playground/AnnotatePanel.tsx`
- Modify: `components/playground/VerdictDetail.tsx` (mount annotate affordance), `components/playground/Playground.tsx` (hold pending annotations + a fold action)

**Behavior:** In `VerdictDetail`, an annotate box (textarea + Save) calls `saveAnnotation({ ... })` (read its real input shape — it likely takes the run/verdict/pid context + note; wire whatever the committed action requires, PII pid-only). `AnnotatePanel` lists the researcher's un-folded annotations for the current variant context and offers **Fold into new variant**: pick a base variant + a new name → `foldAnnotationsIntoVariant(annotationIds, baseVariantId, newName)`; on success, surface the new variant (its provenance chain: base → folded, with the dated `## Researcher annotations` section) and refresh the variant list so ConfigPanel can select it for the next run. Respect the committed action's loud partial-fold refusal (a stale id throws — surface the message, don't swallow).

**Tests:** No new pure module strictly required; if any selection/grouping logic emerges (e.g. which annotations are foldable), extract it to `lib/eval/playground/annotations.ts` with a unit test rather than embedding in JSX. Otherwise this task's deliverable is component wiring verified by `tsc` + the adversarial gate + battery. (Right-sizing: fold setup into the annotate task; no separate test cycle unless logic warrants it.)

**Steps:** read `saveAnnotation` + `foldAnnotationsIntoVariant` real signatures → build AnnotatePanel + wire into VerdictDetail/Playground → (extract + test any non-trivial helper) → battery → commit `feat(playground): verdict annotation + fold-into-variant with provenance`.

---

### Task B3-5: Agreement view — κ + disagreement browser

**Files:**
- Create: `lib/eval/playground/disagreement.ts` (pure: pair verdict rows across two runs → discordant list), `lib/eval/playground/__tests__/disagreement.test.ts`
- Create: `components/playground/AgreementView.tsx`
- Modify: `components/playground/Playground.tsx` (mount AgreementView)

**`disagreement.ts` (pure):** if `compareRuns` already returns `disagreements` (per the B2-4 `AgreementReport`), this module only formats/sorts them (e.g. group by phase, sort by |scoreA−scoreB|); if B2-4 returns raw κ only, this module does the pairing on `(pid,phaseOrdinal,scenarioIdx)`. Read the committed `AgreementReport` and implement accordingly. Provide `sortDisagreements(report)` returning the discordant cells ordered for reading (largest disagreement first), unit-tested on a fixture with 1 concordant + 2 discordant cells.

**Component structure:** `AgreementView`: two run pickers (`listRuns()`) → **Compare** → `compareRuns(a,b)` → show κ + raw agreement % + n, then the disagreement browser (each row: pid, phase, scenario, passA vs passB, jump to each verdict's detail). This is the empirical fork-resolver from the B spec §3 — the cases Hudson reads before deciding which grader to trust; present them, never adjudicate.

**Steps:** failing disagreement test → implement → green → build AgreementView → wire into Playground → battery → commit `feat(playground): agreement view — Cohen's kappa + disagreement browser`.

---

### Task B3-6: Paradigms doc + final whole-branch battery

**Files:** Modify `docs/eval-paradigms.md`.

Append entry 10 (playground = decisions-as-data made operable: every knob edits an artifact/variant that a run references by id+hash; the UI presents disagreements, never adjudicates the grader fork — cite B spec §3 + the agreement cluster of the reading guide). Full battery. Commit `docs(eval): paradigms entry for the playground as decisions-as-data surface`.

## Self-Review
- Spec coverage (B spec §7): cohort panel ✓ (B3-1, WITH Hudson's select-all/deselect-all/per-cohort), config panel ✓ (B3-2, model-conditional via `controlMatrix` probing `validateLlmConfig`), verdict grid + deltas ✓ (B3-3), inspect+annotate+fold ✓ (B3-4), agreement view ✓ (B3-5), paradigms doc ✓ (B3-6). §5 safety: B3 adds no DB access — inherits B1/B2-4's guards; guard script stays green.
- No new server actions, no new study reads/writes — B3 is presentation over shipped actions. Every contestable computation is a PURE, unit-tested module under `lib/eval/playground/`; components stay thin and call actions from handlers (A's island rule).
- Type consistency: consumes the REAL committed signatures (read them at build time; the plan flags where B2-4 shapes must be confirmed against the committed file, not assumed). No placeholders in the pure modules; component contracts specify the exact action calls and state.
