# Eval Harness — Paradigms in Use

A running registry of the interaction / AI-agent paradigms the `/progression-analysis/llm`
harness is built on. **Rule: update this doc in the same PR as any module or paradigm
change.** Each entry names its design source (spec, reading guide, or API reference) so a
paradigm can be traced back to the literature or constraint that motivated it.

Reading guide (22 verified papers grounding the grader designs):
`~/Desktop/Readings - Claude/07-01-2026-spec-eval-paradigms.html`.
Design spec: `docs/superpowers/specs/2026-07-04-llm-eval-harness-design.md`.
Safety spec: `docs/superpowers/specs/2026-06-30-study-data-write-safety-design.md`.

---

## 1 · Decisions-as-data (B1, shipped)

Everything contestable about grading is a **versioned artifact or pluggable module**, never
code: the operational definition of "satisfies Scenario N" lives in `oracle-spec.md`
(eval_artifacts, kind `oracle_spec`), the judge rubric + improvement metric in `metric.md`
(kind `metric`), the system prompt in `eval_prompt_variants` (seeded from the study's live
`help_seeking` prompt), few-shot examples in `eval_few_shot_sets` (picked from the 234 real
`study_assistant_messages` task turns). Runs reference exact artifact rows + hashes —
re-grading under a new definition is an edit + re-run, and any two runs are comparable by
their provenance columns (`eval_runs`).

Both artifact seeds are **DRAFTs with `[UNDECIDED]` markers** at every open measurement
decision (silence handling, matching strictness, pass threshold, order-vs-endstate
tolerances). Editing those markers in the playground *is* the researcher making the
operational-definition decisions — the harness never silently makes them.

Source: B design spec §2 (Hudson's modularity constraint); the oracle-problem cluster of the
reading guide (no machine-readable pass condition exists in `authored_data` — the definition
is the research object).

## 2 · Inter-grader agreement as construct validation (design; lands with B2/B3)

Two graders (`execution-codegen`, `llm-judge`) × two simulator backends (`deterministic`,
`llm`) emit one common `Verdict` shape. "Which grader is ground truth?" is deliberately NOT
decided a priori — run both, measure pairwise agreement (raw % + Cohen's κ), read the
disagreement cases. Convergent/discriminant evidence across operationalizations (the
multitrait logic) replaces a design-time commitment.

Source: B spec §3; execution-accuracy vs judge clusters of the reading guide.

## 3 · World-rules / policy separation (design; lands with B2)

The deterministic simulator owns the WORLD RULES (city graph, movement, battery drain, the
15% operating threshold — fixed, researcher-owned); the LLM synthesizes ONLY the
participant's **dispatch policy** from their spec + entity model. This is the same
separation HumanEval-style execution grading gets from held-out tests: the model can't
smuggle in mechanics the participant never specified, which is what keeps execution verdicts
interpretable as claims about the PARTICIPANT's spec.

Source: B spec §3 (grader 1); pass@k / execution-accuracy cluster (Chen et al. 2021, Austin
et al. 2021), generated-tests-as-oracle caveat (CodeT) in the reading guide.

## 4 · LLM layer: model-conditional configs, structured verdicts (B1, shipped)

- Models: `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5` (exact ids). Config
  validation is a pure, unit-tested function (`lib/llm/config.ts`) encoding API ground
  truth from the claude-api reference (cached 2026-06): `temperature` is REJECTED on
  opus-4-8 (removed in the 4.7+ API — 400), allowed 0..1 on sonnet/haiku; `effort` only on
  opus/sonnet, `xhigh` opus-only; non-streaming `max_tokens` ceiling 16000. The playground's
  knobs are therefore model-conditional by construction, not by API surprise.
- Judge/grader outputs use **schema-enforced structured outputs** (`client.messages.parse` +
  `zodOutputFormat`, SDK 0.110.0) — verdicts are validated objects, never free-text parsing.
- `ANTHROPIC_API_KEY` is checked at call time only; builds/tests run keyless.

Source: claude-api reference; B spec §6.

## 5 · Safety posture for a writing harness (B1, shipped)

B is the first subsystem that WRITES to the shared database. Layers: eval writes are bound
to `eval_*` tables at compile time + runtime (`evalFrom`, user client — the service key
stays quarantined to `cbFrom`); every write action wraps in `withStudyAudit` (pre/post
row-count fingerprint over all 10 study tables; INSERT/DELETE drift throws loudly; UPDATE
drift is covered by the structural layers — SELECT-only RLS + `studyFrom`). Known limits,
documented in code: a same-table double count-failure compares clean; the fingerprint is
global, so grading concurrently with live data collection would false-positive (acceptable
post-collection; make table-scoped if that ever changes).

Source: safety spec L5; A-build gate findings (empirical guard-hardening lineage).
