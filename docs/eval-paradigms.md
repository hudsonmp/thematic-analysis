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

## 6 · Deterministic world simulator: rules vs. policy, illegal-as-signal (B2, shipped)

The rideshare world is a fixed, researcher-owned simulator (`lib/sim/sim-source.ts` as a
plain-JS string; `harness.ts` types it): five landmarks on the authored 1-decimal city map,
Manhattan travel at 1 unit/min (ceil), 1%/unit battery drain floored at 0 (0% never strands
a vehicle — battery is graded SIGNAL, not a movement constraint), an edge-triggered 15%
`low_battery` event, FIFO one-passenger service, and deferred same-minute dispatch so a
policy sees every event (a dropoff, then a `low_battery`) BEFORE the world starts the next
leg. Only the participant's DISPATCH POLICY is synthesized from their spec; the world can't
be smuggled. The four authored scenarios are fixtures derived from the Given/When clauses
(`scenarios.ts`), with mid-ride Given state (`has picked up A`) replayed via
`preassigned` + requestAtMin 0. Key design choice: **illegal policy actions are IGNORED with
a log line, never thrown** — participant policies are wrong in exactly these ways (double-
assign, reassign a boarded rider, divert a mid-leg vehicle), and that wrongness is the
signal the grader reads. Distances round to 0.1 so authored float coordinates don't corrupt
travel-time/drain (both consume the same rounded value — no skew).

Grading contract (B2-1 gate, load-bearing): the execution grader scores per-rider
servedBy+droppedAt and per-vehicle charged ONLY. `pickupOrder` is golden-test reference data,
NOT graded — under atomic movement S0's B-first order is reachable only by a policy that
starves A (the authored "pauses mid-trip" is outside the world's expressive range), so
grading order would fail faithful policies. S1's "V2 repositions" clause is a documented
blind spot (end-states carry no vehicle position; the naive baseline passes S1 100%). Both
are oracle-spec.md `[UNDECIDED]`s for Hudson's matching-strictness decision.

Source: B spec §3 (world-rules/policy separation); execution-accuracy cluster of the reading
guide (held-out tests as oracle); B2-1 gate empirical probes.

## 7 · Sandbox: unforgeable result channel + tiered isolation (B2, shipped)

LLM-generated policy code runs ONLY in a `node -e` child process (never in the server
process). Because the policy is concatenated as TOP-LEVEL code, it shares stdout and globals
with the emitter — so a fixed-string sentinel is FORGEABLE (the B2-2 gate demonstrated four
vectors — setImmediate, exit hook, monkey-patched `stdout.write`, pre-empt+exit — each
returning a fabricated passing verdict). Fix: a SEALED EMITTER in a private IIFE that runs
before any policy code, closing over a per-run `randomUUID` nonce and a pristine bound
`stdout.write`; the result is bracketed by the nonce on both sides. The policy's sibling
scope can't read the nonce or the captured writer, so only the emitter — which always routes
through the trusted sim — can produce a nonce-tagged segment. INVARIANT: the returned
endState is a faithful sim run or an honest failure, never an attacker-chosen object
(serialization goes through a null-proto safe-clone so `Object.prototype.toJSON` poisoning
throws → honest failure, not a rewrite). Isolation tiers: WITH a permission flag
(`--permission` on node ≥23, else legacy `--experimental-permission` — both probed, because
the rename silently drops the belt) fs/net are denied; the floor without any flag is cleared
env (no secrets) + SIGKILL timeout + 1 MB stdout cap + the nonce channel.

Source: B spec §4; B2-2 gate (empirical forgery vectors → BLOCKING fix).

## 8 · Fixed-target grading (B2, shipped)

Every phase snapshot (the spec at ordinals 0–4) is graded against ALL FOUR scenarios — the
phase and scenario axes are independent nested loops, not zipped to the revealed order. This
makes cross-phase deltas comparable (the same target set at every phase) and is what lets the
UI ask "did the spec improve after seeing scenario k". The REVEALED-ONLY view (grade phase k
only against the scenario just revealed) is recoverable from fixed-target verdicts without
re-running — both coordinates persist on every verdict — and is left as Hudson's measurement
choice. A phase with no snapshot, or a scenarioIdx with no authored `Scenario` (the editor
authors 1–4, so `scenarios[idx]` can be undefined), records an honest `pass:null`, never a
crash or fabrication.

Source: B spec §3; B2-4 executor + gate (axis-independence verified).

## 9 · Inter-grader agreement: Cohen's κ conventions (B2, shipped)

The empirical fork-resolver (`lib/eval/agreement.ts`, pure + unit-tested; the B2-4 gate
re-derived every fixture in an independent implementation, non-circular): κ=(po−pe)/(1−pe)
over pairwise-COMPLETE cells only — a cell where either grader returned `pass:null` is
excluded from n (an ungradable verdict is not a disagreement). κ is null ONLY when n===0.
The constant-rater edge (a grader that emitted one label throughout) returns a NUMBER by the
documented convention — 1 if observed agreement is also 1, else 0 — and the 1−pe===0 division
is structurally unreachable (the constant-rater guard returns first). `disagreements` pairs
verdicts on (pid, phaseOrdinal, scenarioIdx) with two accessors (the join has two raters) and
surfaces the discordant cells for reading. Comparability is enforced upstream by config_hash,
which now covers resolved few-shot CONTENT (not just id) alongside oracle/metric content
hashes — so runs that differ in any grading input hash differently.

Source: B spec §3 (agreement as construct validation); B2-4 gate (κ math + config_hash
provenance).
