# LLM Eval Harness (`/progression-analysis/llm`) — Design

**Date:** 2026-07-04
**Status:** Approved shape (architecture + sim forks resolved), pending spec review
**Scope:** Sub-project **B**. Builds on A (`2026-06-30-progression-analysis-viewer-design.md`) and the safety spec (`2026-06-30-study-data-write-safety-design.md`). Build order: **A ships first**; B is gated on safety L1 (**applied to prod 2026-07-01** — 10 study tables now carry SELECT-only RLS for `authenticated`, zero write policies).

---

## 1. Purpose

A researcher-facing **prompt playground + modular grading harness** that measures how participants' specifications improved across the five phases, under grading definitions **Hudson controls as editable artifacts, not code**. Two graders and two simulator backends ship in v1; every run records full config provenance so grader/config variants are comparable — turning "which grader is ground truth?" into an empirical inter-grader agreement question rather than an a-priori commitment.

## 2. Core principle — decisions-as-data (Hudson's modularity constraint)

Everything contestable is a **module** (swappable implementation) or an **artifact** (versioned, editable file/record). Nothing about "what counts as satisfying Scenario N" is hardcoded.

| Decision | Where it lives |
|---|---|
| Operational definition of "satisfies Scenario N" | `oracle-spec.md` — researcher-authored, per-scenario pass conditions (end-state fields to compare, ordering requirements, tolerances) |
| Grading rubric for the judge | `metric.md` — attached verbatim to every judge call |
| System prompt / few-shot examples / output annotations | `eval_prompt_variants`, `eval_few_shot_sets`, `eval_annotations` rows (seeded from `llm_prompts['help_seeking']` + `study_assistant_messages` turns) |
| Model, temperature, provider params | per-run `llmConfig` |
| Grader | `GraderModule` registry: `execution-codegen`, `llm-judge` |
| Simulator backend | `SimulatorBackend` registry: `deterministic`, `llm` |

## 3. Module architecture

```ts
// lib/eval/types.ts (pure)
type GradeInput = {
  snapshot: PhaseSnapshot;            // participant spec + entities (from A's loader)
  scenario: AuthoredScenario;         // clauses + seededMarkers + cityMap slice
  oracleSpec: Artifact;               // oracle-spec.md content + hash
  metricDoc: Artifact;                // metric.md content + hash
  llmConfig: LlmConfig;               // model, temperature, maxTokens
  promptVariant: PromptVariant;       // system prompt + few-shot set + folded annotations
};
type Verdict = {
  pass: boolean | null;               // null = grader abstained/errored
  score: number | null;               // 0..1 when the grader emits graded credit
  rationale: string;                  // grader's account (judge text / diff of end-states)
  evidence: Json;                     // grader-specific: end-state diff, clause-by-clause table, raw completion
  graderId: string; simBackend?: string;
  configHash: string;                 // hash over (oracleSpec, metricDoc, prompt, llmConfig)
};
interface GraderModule { id: string; grade(input: GradeInput): Promise<Verdict>; }
interface SimulatorBackend { id: string; run(policy: DispatchPolicy, scenario: ScenarioSetup): Promise<EndState>; }
```

**Grader 1 — `execution-codegen`.** LLM synthesizes a **dispatch policy** (a pure function: `(worldState, event) → decisions`) from the participant's spec + entity model — *only* the policy; world mechanics are not the LLM's to invent. The policy runs against a `SimulatorBackend`; the resulting `EndState` is compared to the scenario's oracle end-state per `oracle-spec.md`. Clause-level results go in `evidence`.

**Grader 2 — `llm-judge`.** Rubric-conditioned judge call: `metric.md` + the authored scenario + the participant's spec/entities → clause-by-clause verdict with rationale. Reference-free; no simulation required.

**Simulator backend (a) — `deterministic`.** A small, unit-tested rideshare state machine embodying the WORLD RULES: city graph from `cityMap` (landmarks ∪ origin — the depot is only in `origin`; Manhattan/street-graph distance), vehicles `{position, battery, queue, occupancy}`, riders `{pickup, dropoff, requestTime}`, fixed physics (movement rate, battery drain, the 15% operating threshold from Scenario 4). The generated policy is consulted at each decision point; everything else is fixed and Hudson-owned. Scenario setups compile from `seededMarkers` + Given/When clauses.

**Simulator backend (b) — `llm`.** Same generated policy + scenario setup handed to an LLM asked to *predict the execution end-state* (Learning-to-Execute framing; also matches the study assistant's oracle affordance). Output coerced to the same `EndState` shape.

**Agreement analysis (the empirical fork-resolver):** for any run set, the UI reports pairwise agreement — exec(det) vs judge, exec(det) vs exec(llm-sim) — as raw % + Cohen's κ, with a disagreement browser (the cases to read before deciding which construct to trust).

## 4. Sandboxing (untrusted generated code)

Generated policies NEVER run in the Next.js server process. Execution path: policy source → `node` **child process** with `--experimental-permission` deny-all (no fs/net), hard timeout (2s), memory cap, JSON-only stdin/stdout protocol. Sandbox violations/timeouts → `Verdict.pass = null` with the failure in `evidence`. (Research tool on Hudson's machine; child-process isolation is proportionate. Revisit if ever hosted.)

## 5. Data model + safety

**Reads** (all via `studyFrom()`, select-only): `study_snapshots` (via A's loader), `studies.authored_data`, `study_assistant_messages` (few-shot corpus; widen select to `state_spec`/`state_entities`), `llm_prompts` (seed prompt).
**Writes** (all via new `evalFrom()`, `eval_*` tables ONLY — safety L5): 

- `eval_prompt_variants` (id, name, system_prompt, parent_id, created_at)
- `eval_few_shot_sets` (id, name, examples jsonb — source turn ids + edited text)
- `eval_annotations` (id, target run/verdict id, note, folded_into_variant_id)
- `eval_artifacts` (id, kind oracle_spec|metric, name, content, hash) — versioned; runs reference by id+hash
- `eval_runs` (id, name, participant_pids text[], grader_id, sim_backend, llm_config jsonb, prompt_variant_id, oracle_artifact_id, metric_artifact_id, created_at)
- `eval_verdicts` (id, run_id, pid, phase_ordinal, scenario_idx, pass, score, rationale, evidence jsonb)

Runtime audit (safety L5): every write action wrapped in a pre/post study-table fingerprint assertion; drift → abort loudly. Migration adds `eval_*` tables + updates the CI guard. PII: `pid` only, everywhere.

## 6. LLM layer

`@anthropic-ai/sdk` (new dep) + `ANTHROPIC_API_KEY` in `.env.local`. Models selectable per run (default Sonnet for graders; Opus for judge calibration runs), temperature/max-tokens exposed in the playground. Consult the `claude-api` skill at build time for current model ids/params. All LLM calls from server actions; streaming optional (runs are batch).

## 7. Playground UI (`/progression-analysis/llm`)

Client island over server actions, mirroring A's patterns:
1. **Cohort panel** — participant multiselect with `pilot`/`study`/`—` tags (reuses A's participant list).
2. **Config panel** — grader + sim backend pickers; prompt variant editor (seeded from `help_seeking`); few-shot picker over real assistant turns; `oracle-spec.md` / `metric.md` artifact editor; model/temp.
3. **Run** → progress → **verdict grid** (participant × phase, per grader) with per-phase improvement deltas (defined in `metric.md`, computed over verdicts — grader-agnostic).
4. **Inspect & annotate** — verdict detail (rationale, evidence, end-state diff); annotations attach to outputs and can be **folded into** a new prompt variant (provenance chain preserved).
5. **Agreement view** — κ + disagreement browser across grader/backend pairs.

## 8. Paradigms doc

`docs/eval-paradigms.md` — living registry of the interaction/agent paradigms in use (grader designs, sim backends, prompt-variant lineage), each entry citing its basis in the reading guide (`07-01-2026-spec-eval-paradigms.html`). Updated in the same PR as any module/paradigm change.

## 9. Testing

- **Deterministic sim:** golden tests — the 4 authored scenarios as fixtures; hand-written reference policies (one correct, one deliberately naive) must produce known end-states. Property tests for battery/queue invariants.
- **Graders:** contract tests over the `GraderModule` interface with a stubbed LLM; verdict-shape validation (zod).
- **Sandbox:** timeout, fs/net denial, malformed-output tests.
- **Provenance:** run→verdict round-trip retains config hashes; changing an artifact changes the hash.
- **Safety:** `evalFrom` rejects non-`eval_` tables; fingerprint audit fires on a simulated drift; CI guard stays green.
- Standard: `tsc --noEmit`, vitest, `check-no-study-writes.sh`.

## 10. Open items (deliberately deferred to build)

- Exact `EndState` field set (derived from `oracle-spec.md` v1, which Hudson authors from the Then-clauses; the spec's §2 table in A lists the scenario content).
- Whether judge calls see the participant's *entity model* as well as spec text (default: yes, both).
- Few-shot default set (empty until Hudson picks turns in the UI).
