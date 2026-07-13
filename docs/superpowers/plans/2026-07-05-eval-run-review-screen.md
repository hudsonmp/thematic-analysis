# Eval Harness C — Run Review Screen (`/llm/run`) + Config Descriptions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A dedicated review screen at `/progression-analysis/llm/run` where Hudson selects a participant (browsable with NO run needed), sees their specification EVOLVING across the 5 phases beside the authored scenario at each (mirroring `/progression-analysis`, text-only), optionally overlays a selected run's verdicts per (phase × scenario), and annotates per (participant × iteration × scenario) coordinate — annotations that feed the existing fold→prompt-variant loop. Separately, refine the `/llm` config editors to describe WHAT each artifact is instead of presenting a blank textarea.

**Architecture:** `/llm/run` is a new client island over EXISTING read actions (`listProgressionParticipants`, `getParticipantProgression`, `listRuns`, `listVerdicts`) plus an EXTENDED `saveAnnotation` that now carries `(pid, phaseOrdinal, scenarioIdx)` so a note binds to a cell coordinate — with the verdict linked when a run is loaded. `eval_annotations` gains three nullable columns; the fold loop is unchanged (still folds by annotation id). Reuses A's `RequirementsPane`/`ScenarioPane` for the spec+scenario panes and B's annotate/fold plumbing.

**Tech Stack:** Next 16.2.6 client islands; the eval_* Supabase dataset; no new deps.

## Global Constraints

- Branch `feat/progression-analysis`. NEVER push/merge. Feature-branch commits only.
- **Next 16.2.6 breaking changes** (AGENTS.md): read `node_modules/next/dist/docs/01-app` before components. Server actions from handlers/`useTransition`, never render. No `npm run dev`/`next build` in tasks.
- Study tables IRB READ-ONLY; PII pid-only (pid IS allowed — it's the study's own de-identified id; never first_name/email). `eval_annotations` already stores `run_id`/`verdict_id`; adding `pid`/`phase_ordinal`/`scenario_idx` keeps it eval-only, still via `evalFrom` + `withStudyAudit` on writes. No raw client/`.rpc`/service. `check-no-study-writes.sh` green.
- Battery per task: `npx tsc --noEmit && npx vitest run && npm run lint` all green. TDD for pure helpers.
- Migration already applied to the VT `eval_annotations` table before C-1 (see C-1). Reuse A's null-last cohort comparator; match A's Tailwind register.

## Consumed interfaces (read the real files at build time)

- `app/actions/progression.ts` — `listProgressionParticipants()`, `getParticipantProgression(pid): ParticipantProgression | null` (`{pid, title, requirements, scenarios: Scenario[], steps: ProgressionStep[]}`; each `ProgressionStep`: `{ordinal 0..4, kind, label, scenarioIdx, snapshot: {spec, entities}|null, diff, submitted?}`).
- `app/actions/runs.ts` — `listRuns(): RunSummary[]`, `listVerdicts(runId): VerdictRow[]` (`{id, runId, pid, phaseOrdinal, scenarioIdx, pass, score, rationale, evidence}`).
- `app/actions/eval.ts` — `saveAnnotation`, `listUnfoldedAnnotations`, `foldAnnotationsIntoVariant`, `AnnotationRow` (extended in C-1).
- `components/progression/AuthoredScenarioPane.tsx` — `RequirementsPane`, `ScenarioPane`. `components/progression/ProgressionViewer.tsx` — the picker + stepper idiom to mirror.
- `components/playground/AnnotatePanel.tsx` — `AnnotateContext` bridge + fold panel (reused so `/llm/run` annotations appear in the same fold surface).

---

### Task C-1: Migration + coordinate-carrying annotations (backend)

**Files:** Modify `app/actions/eval.ts`, `lib/eval/playground/annotations.ts` + its test.

**Migration (ALREADY APPLIED by the orchestrator before this task — verify it exists, do NOT re-apply):**
```sql
alter table eval_annotations add column if not exists pid text;
alter table eval_annotations add column if not exists phase_ordinal integer;
alter table eval_annotations add column if not exists scenario_idx integer;
```
Then regenerate types is NOT required — hand-extend the row types (the repo hand-maintains cb-db types); if `lib/types/cb-db.ts` has an `eval_annotations` Row block, add the three nullable columns there so tsc sees them.

**Changes:**
- `saveAnnotation` input becomes `{ runId?: string; verdictId?: string; pid?: string; phaseOrdinal?: number; scenarioIdx?: number; note: string }`; insert stores `pid`, `phase_ordinal`, `scenario_idx` (null when absent) alongside the existing fields; still wrapped in `withStudyAudit`; still returns `{ id }`.
- `lib/eval/playground/annotations.ts`: extend `AnnotationRow` with `pid: string | null; phaseOrdinal: number | null; scenarioIdx: number | null`; extend `DbAnnotationRow` with `pid`, `phase_ordinal`, `scenario_idx`; `mapAnnotationRow` maps them. Add test cases pinning the new snake→camel fields (transposition guard) + null preservation.
- `listUnfoldedAnnotations`: add `pid, phase_ordinal, scenario_idx` to the `.select(...)` and rely on `mapAnnotationRow`.
- `foldAnnotationsIntoVariant`: UNCHANGED (folds by id; coordinates don't affect it).

**Steps:** verify columns exist (`\d eval_annotations` via a read) → extend annotations.ts types + mapper (failing test first for the new fields) → green → extend saveAnnotation + listUnfoldedAnnotations + cb-db types → battery → commit `feat(eval): coordinate-carrying annotations (pid/phase/scenario) for per-cell review`.

---

### Task C-2: `/llm/run` route + participant browse + spec-evolution stepper

**Files:** Create `app/(protected)/progression-analysis/llm/run/page.tsx` (server), `components/playground/RunReview.tsx` (client island), `components/playground/RunReviewStepper.tsx`. Modify `app/(protected)/CodebookNav.tsx` if a nav entry is wanted (OPTIONAL — `/llm/run` is reachable from `/llm`; add a sub-link on `/llm` instead of a 14th nav item — decide in-task, prefer a link from the `/llm` page header).

**page.tsx (server):** await `listProgressionParticipants()` + `listRuns()` + `listPromptVariants()` + `listFewShotSets()` + `listArtifacts(...)` (the fold panel needs variants); pass to `<RunReview/>`. Header mirrors `/progression-analysis`.

**RunReview.tsx (island):** LEFT — a run picker (`listRuns()`, "review an existing run — optional") + a participant picker grouped by cohort (reuse `groupByCohort`/null-last from `lib/eval/playground/selection`). Selecting a participant calls `getParticipantProgression(pid)`; selecting a run calls `listVerdicts(runId)` held in state. RIGHT — `<RunReviewStepper/>`: the 5-step phase stepper (Requirement, Scenario 1–4; data `scenario_idx` 0-based, display 1-based) showing at each phase the participant's SPEC (text) via a spec pane + the authored scenario via `ScenarioPane`/`RequirementsPane`. TEXT-ONLY (no entity map — per Hudson). Browsable with NO run selected (verdict overlay is C-3). Server actions from handlers only.

**Steps:** read Next docs + A's panes → scaffold page + RunReview + stepper → battery → commit `feat(playground): /llm/run review screen — participant browse + spec-evolution stepper`.

---

### Task C-3: Verdict overlay + per-cell annotate → fold

**Files:** Modify `components/playground/RunReviewStepper.tsx`, `components/playground/RunReview.tsx`; reuse `components/playground/AnnotatePanel.tsx` (mount the fold surface).

**Behavior:** when a run is selected, index its verdicts by `(pid, phaseOrdinal, scenarioIdx)`. At each phase, for each of the 4 scenarios, show the verdict (pass ✓/✗/—, score) — null/absent distinct from a real 0 (the grid's honest-signal rule). Each (phase, scenario) cell has an annotate box → `saveAnnotation({ pid, phaseOrdinal, scenarioIdx, runId?: selectedRunId, verdictId?: theCellVerdictId, note })` (coordinates always; run/verdict linked when a run is loaded). Saving signals the `AnnotateContext` bridge so the mounted `AnnotatePanel` refreshes its unfolded list — the per-cell notes are foldable into a new prompt variant exactly like `/llm` annotations (same loop). Show the fold panel on `/llm/run` too (reuse `AnnotatePanel`), so the review→annotate→fold loop closes on this screen.

**Steps:** verdict index + overlay render (null≠0) → per-cell annotate wired with coordinates → AnnotatePanel mounted + refresh signal → battery → commit `feat(playground): /llm/run verdict overlay + per-cell coordinate annotation feeding the fold loop`.

---

### Task C-4: Config editor descriptions + few-shot refinement (`/llm`)

**Files:** Modify `components/playground/{ConfigPanel,ArtifactEditor,VariantEditor,FewShotPicker}.tsx`. If descriptive copy is reused, a tiny `lib/eval/playground/editor-copy.ts` (plain strings, optional).

**Behavior:** each editor leads with a BRIEF (1–2 sentence) plain-language description of WHAT the artifact is and how it's used in a run — so Hudson is not editing a blank textarea blind:
- **oracle-spec** — "The operational definition of what 'satisfies scenario N' means. The judge grades against this verbatim; edit its `[UNDECIDED]` markers to make the pass condition concrete."
- **metric** — "The rubric + improvement measure. Embedded verbatim in every judge call; defines how per-clause verdicts roll up to a score."
- **prompt variant** — "The system prompt the grader runs under. Seeded from the study's live help-seeking prompt; edit + save to fork a child variant (lineage preserved)."
- **few-shot** — "Example (user→assistant) turns prepended to the grader prompt to steer its behavior. Pick real assistant turns to build a set; an empty set means zero-shot."
(Use the exact wording or tighten it; keep it accurate to the code.)
Refine the few-shot flow: make the build affordance legible — show the selected set's size + a clear "build/edit set" toggle, the turn list with checkboxes, and a save; make "zero-shot (none)" an explicit, selectable state rather than an ambient default. Do NOT change the underlying actions.

**Steps:** read the four editors → add descriptions + refine few-shot UX (no action changes) → battery → commit `feat(playground): describe each config artifact + refine few-shot builder UX`.

## Self-Review
- Requirements: separate `/llm/run` ✓ (C-2), spec-evolution like progression ✓ (C-2, text-only), authored scenario shown ✓ (C-2), select+review an existing run ✓ (C-2 run picker), per (scenario × iteration) annotation ✓ (C-3, coordinate-tied), feeds fold loop ✓ (C-3, same loop), config descriptions + few-shot refine ✓ (C-4).
- Schema: 3 nullable columns, additive, eval-only, guard-posture intact. Fold loop unchanged. Pure helpers (mapper) unit-pinned. Components thin over existing actions.
