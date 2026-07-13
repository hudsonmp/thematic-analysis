# Eval Harness B2 — Simulators, Graders, Run Executor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship B's grading engine: the deterministic rideshare simulator (world rules), the sandboxed execution of LLM-generated dispatch policies, the two graders (`execution-codegen`, `llm-judge`) with the LLM-sim backend, and the run executor that writes `eval_runs`/`eval_verdicts` with full provenance + the agreement (κ) math.

**Architecture:** The sim is a SINGLE-SOURCE plain-JS module carried as a template-literal string (`SIM_JS`) — evaluated in-process for unit tests, concatenated with the generated policy for sandboxed child-process runs. Graders implement one `GraderModule` contract returning one `Verdict` shape; LLM calls are injected (testable with stubs, keyless). The executor grades every phase snapshot against ALL FOUR scenarios (fixed-target grading — v1 measurement choice, documented; Hudson may switch to revealed-only later).

**Tech Stack:** No new dependencies. node:child_process for the sandbox; zod for verdict schemas; B1's `llmComplete`/`llmCompleteJson`, `evalFrom`, `withStudyAudit`, artifacts/variants actions; A's `getParticipantProgression` for snapshots.

## Global Constraints

Same as B1 plan (branch, battery, IRB read-only, pid-only, comment style) plus:
- **Untrusted code never runs in the server process.** Generated policy source executes ONLY inside the sandbox child process (B2-2). The in-process `Function` evaluation of `SIM_JS` is allowed ONLY for the trusted sim string itself and trusted test policies — never for LLM output. Document this boundary in both files.
- **LLM functions are injected.** Graders take `{ complete, completeJson }` as a parameter (defaulting to the real B1 client) so every grader test runs keyless with stubs.
- **Verdict honesty:** any failure (codegen didn't produce a function, sandbox timeout, judge schema miss) → `pass: null` with the failure in `evidence` — never a fabricated fail/pass.

---

### Task B2-1: Deterministic rideshare simulator + scenario fixtures + golden tests

**Files:**
- Create: `lib/sim/sim-source.ts` (exports `SIM_JS: string` — the plain-JS sim), `lib/sim/harness.ts` (in-process eval wrapper + types), `lib/sim/scenarios.ts` (the four authored scenario setups as fixtures)
- Test: `lib/sim/__tests__/sim.test.ts`

**The sim contract (types in `harness.ts`, mirrored as JSDoc in `SIM_JS`):**
```ts
export type LandmarkName = 'Depot / Charging' | 'Newman Library' | 'Lane Field' | 'Executive Airport' | 'ASCEND³';
export type VehicleId = 'V1' | 'V2';
export type RiderId = 'A' | 'B' | 'C';
export type ScenarioSetup = {
  scenarioIdx: 0 | 1 | 2 | 3;
  vehicles: { id: VehicleId; start: LandmarkName; battery: number }[]; // battery 0..100
  riders: { id: RiderId; pickup: LandmarkName; dropoff: LandmarkName; requestAtMin: number }[];
  preassigned?: { rider: RiderId; vehicle: VehicleId }[]; // Given-clause queue state
};
export type SimEvent =
  | { type: 'ride_request'; rider: RiderId }
  | { type: 'dropoff_complete'; vehicle: VehicleId; rider: RiderId }
  | { type: 'low_battery'; vehicle: VehicleId }   // fired ONCE when battery crosses below 15 (world rule)
  | { type: 'idle'; vehicle: VehicleId };
export type PolicyAction =
  | { act: 'assign'; vehicle: VehicleId; rider: RiderId }      // append rider to vehicle queue
  | { act: 'reassign'; rider: RiderId; to: VehicleId }         // remove from current queue, append to `to`
  | { act: 'reposition'; vehicle: VehicleId; to: LandmarkName }
  | { act: 'charge'; vehicle: VehicleId }                      // go to Depot / Charging; battery→100 on arrival
  | { act: 'noop' };
export type WorldView = { // read-only snapshot handed to the policy at each event
  timeMin: number;
  vehicles: { id: VehicleId; at: LandmarkName; battery: number; queue: RiderId[]; carrying: RiderId | null }[];
  riders: { id: RiderId; pickup: LandmarkName; dropoff: LandmarkName; requested: boolean; pickedUpBy: VehicleId | null; droppedAt: LandmarkName | null }[];
};
export type EndState = {
  riders: { id: RiderId; servedBy: VehicleId | null; droppedAt: LandmarkName | null; pickupOrder: number | null }[]; // pickupOrder = 0-based global order
  vehicles: { id: VehicleId; at: LandmarkName; battery: number; charged: boolean }[];
  log: string[];   // human-readable event/action trace
  completed: boolean; // false when maxSteps guard tripped
};
export type PolicyFn = (world: WorldView, event: SimEvent) => PolicyAction[];
export function runScenario(setup: ScenarioSetup, policy: PolicyFn): EndState; // harness.ts, via SIM_JS eval
```
**World rules (fixed, researcher-owned — implement in `SIM_JS`, doc-comment each):** city coordinates from the authored map — Depot (5.4,8), Newman Library (5.4,14), Lane Field (16.5,11.7), Executive Airport (16.4,4), ASCEND³ (12.4,11.7); travel time = Manhattan distance ÷ 1 unit/min, rounded up; battery drain = 1% per distance unit (float, floor at 0); `low_battery` fires once when a vehicle crosses below 15% (the scenario-4 operating threshold — a WORLD fact; what the policy does about it is what's being graded); vehicles serve their queue FIFO: when idle and queue non-empty, drive to first rider's pickup, then dropoff (one passenger at a time); events processed in (time, insertion-seq) order; policy consulted on every SimEvent; illegal actions (unknown ids, reassign of a picked-up rider, action on a carrying vehicle for `reposition`/`charge`) are IGNORED with a log line (never throw — participant policies are wrong in exactly these ways and that's signal); hard cap 500 steps → `completed: false`.

**Scenario fixtures (`scenarios.ts`) — derived from the authored study content; cite the derivation in comments:**
- S0 (Scenario 1): V1 at Lane Field ("driving past Lane Field" at request time — fixture places it there), battery 100. Riders: A pickup Executive Airport → Newman Library, requestAtMin 0; B pickup Lane Field → Executive Airport, requestAtMin 10. No V2.
- S1 (Scenario 2): V1 at Executive Airport battery 100 with A preassigned (Given: "has picked up Rider A" → fixture: A preassigned + already carried: represent via preassigned + requestAtMin 0 for A; the sim picks A up immediately at Executive Airport); V2 at Depot battery 100. B: Lane Field → Executive Airport, requestAtMin 15.
- S2 (Scenario 3): V1 at Newman Library battery 100 (just dropped A — fixture: A pre-served: preassigned to V1 with pickup Executive Airport → Newman Library requestAtMin 0); V2 at Depot 100; B: ASCEND³ → Executive Airport requestAtMin 0 preassigned to V1 (Given: in V1's queue); C: Newman Library → Lane Field, requestAtMin 5.
- S3 (Scenario 4): V1 at Executive Airport battery 20 carrying A (A preassigned, Executive Airport → Newman Library, requestAtMin 0); V2 at Depot 100; B: Lane Field → ASCEND³ requestAtMin 0 preassigned to V1. (Battery 20 → the Newman Library leg drains it below 15 → low_battery fires after A's dropoff — matches the authored When.)

**Golden tests (write FIRST; they are the sim spec):**
1. `REFERENCE_POLICY` (in the test file, trusted): implements the authored expected behavior — S0: assign B to V1 on request (V1 at Lane Field picks B first, then A) → end-state: B droppedAt Executive Airport with pickupOrder 0, A droppedAt Newman Library pickupOrder 1, both servedBy V1. S1: assign B to V1; reposition V2 to ASCEND³ on its idle event → B servedBy V1, V2 at ASCEND³ never picks up. S2: on C's request, reassign B to V2 + assign C to V1 → C servedBy V1 droppedAt Lane Field; B servedBy V2. S3: on low_battery, reassign B to V2 + charge V1 → V1 at Depot charged:true; B servedBy V2 droppedAt ASCEND³.
2. `NAIVE_POLICY` (assign every request to V1, ignore low_battery): S2 → B servedBy V1 (no reassignment: end-state differs from reference — assert servedBy V1); S3 → V1 never charges (charged:false) and B servedBy V1.
3. Determinism: two runs of the same (setup, policy) give deep-equal EndStates.
4. Hostile policy: returns garbage actions / throws inside → actions ignored / policy exception caught per-event (log line, treated as noop), sim completes.
5. Battery: S3 V1 battery strictly decreases along its route; low_battery fires exactly once.

**Steps:** failing tests → implement `SIM_JS` + harness (`new Function('module', SIM_JS)`-style CommonJS shim returning `{runScenario}`; harness validates policy is a function) → fixtures → green → battery → commit `feat(sim): deterministic rideshare simulator, authored-scenario fixtures, golden reference tests`.

---

### Task B2-2: Sandbox runner for untrusted policy code

**Files:** Create `lib/sim/sandbox.ts`; Test `lib/sim/__tests__/sandbox.test.ts`.

**Interface:** `export async function runPolicyInSandbox(policySource: string, setup: ScenarioSetup, opts?: { timeoutMs?: number }): Promise<{ ok: true; endState: EndState } | { ok: false; failure: string }>`.

**Mechanics:** build script = `SIM_JS` + `\nconst __setup = ` + JSON.stringify(setup) + `;\n` + policySource (must define `decide`) + a runner tail that calls `runScenario(__setup, decide)` and `process.stdout.write('__SIM_RESULT__' + JSON.stringify(endState))`. Spawn `node -e <script>` via `child_process.spawn` with: `env: {}` (NO inherited env — no keys leak to untrusted code), `timeoutMs` default 2000 enforced via `setTimeout` + `child.kill('SIGKILL')`, stdout capped at 1 MB (kill + fail on overflow). Parse the `__SIM_RESULT__` sentinel; validate the parsed object shape with a zod schema of EndState (defensive — untrusted stdout); any exit≠0 / timeout / parse / validation failure → `{ok:false, failure}` with stderr excerpt. Try `--experimental-permission` ONCE at module init (spawnSync probe `node --experimental-permission -e "process.exit(0)"`); include the flag when supported (denies fs/net by default), else proceed without it — env-clearing + no-require script is the floor; doc-comment the tiering honestly.

**Tests (no LLM, all local node):** trusted policy source string round-trips S0 to the reference end-state; `while(true){}` policy → timeout failure within ~timeout; `process.exit(7)` → failure; policy printing garbage before the sentinel → still parses (sentinel split takes LAST occurrence); policy attempting `require('fs')` → failure either way (permission flag) OR — without flag — succeeds only if harmless; assert instead that `process.env` inside the sandbox is empty by a probe policy that returns env keys in the log (must be []).

Commit: `feat(sim): sandboxed child-process runner for untrusted dispatch policies`.

---

### Task B2-3: Grader modules

**Files:** Create `lib/eval/graders/types.ts`, `lib/eval/graders/execution.ts`, `lib/eval/graders/judge.ts`, `lib/eval/graders/prompts.ts`; Test `lib/eval/__tests__/graders.test.ts`.

**types.ts (exact):**
```ts
import type { Entity } from '@/lib/spec/reconstruct';
import type { Scenario } from '@/lib/study/study';
export type LlmFns = {
  complete: typeof import('@/lib/llm/client').llmComplete;
  completeJson: typeof import('@/lib/llm/client').llmCompleteJson;
};
export type GradeInput = {
  pid: string; phaseOrdinal: number; scenarioIdx: 0|1|2|3;
  spec: string; entities: Entity[];
  scenario: Scenario;                       // authored clauses
  oracleSpec: { content: string; hash: string };
  metricDoc: { content: string; hash: string };
  systemPrompt: string;                     // prompt variant content
  fewShot: { role: 'user'|'assistant'; content: string }[];
  llmConfig: import('@/lib/llm/config').LlmConfig;
};
export type Verdict = {
  pass: boolean | null; score: number | null; rationale: string;
  evidence: Record<string, unknown>;        // grader-specific; ALWAYS includes {graderId, simBackend?}
};
export type GraderModule = { id: 'execution-codegen' | 'llm-judge'; grade(input: GradeInput, llm: LlmFns): Promise<Verdict> };
export const DEFAULT_PASS_THRESHOLD = 0.8;  // code-side default; metric.md text is judge-prompt-only (documented)
```
**prompts.ts:** pure prompt builders (unit-testable string assembly): `buildPolicyGenPrompt(spec, entities)` — contract: "emit ONLY a JavaScript code block defining `function decide(world, event)` returning an array of actions from this vocabulary: … Translate the PARTICIPANT'S rules faithfully, including their gaps — do NOT add behaviors they did not specify" + the WorldView/SimEvent/PolicyAction shapes; `buildJudgePrompt(input)` — metric.md verbatim, oracle-spec.md verbatim, scenario clauses (Given/When/Then with text), participant spec + entity model, instruction to output per-clause verdicts grounded in quotes; `buildLlmSimPrompt(policySource, setup)` — "execute this policy mentally against these world rules; return the EndState".
**execution.ts** (`makeExecutionGrader(simBackend: 'deterministic'|'llm'): GraderModule`): (1) `llm.complete` with policy-gen prompt → extract the LAST ```-fenced code block (helper `extractCodeBlock`, exported + tested; no block → pass:null evidence.failure='no code block'); (2) deterministic: `runPolicyInSandbox(policySource, SCENARIOS[scenarioIdx])`; llm backend: `llm.completeJson` with the EndState zod schema; (3) compare end-state to the scenario's expected end-state (`EXPECTED_END_STATES[scenarioIdx]` — exported from `lib/sim/scenarios.ts` as the reference-policy outputs, per-rider servedBy/droppedAt + per-vehicle charged flags): score = matched checks / total checks, pass = score ≥ DEFAULT_PASS_THRESHOLD; evidence = {policySource, endState, expected, perCheck: [...], simBackend}.
**judge.ts:** zod schema `{ clauses: [{clauseId: string, verdict: 'satisfied'|'unsatisfied'|'unclear', quote: string}], overallRationale: string }` (strict, additionalProperties-safe for the API); call `llm.completeJson`; score = satisfied / (satisfied+unsatisfied+unclear) counting ONLY clauses whose clauseId matches an authored clause id (hallucinated ids dropped, noted in evidence); pass = score ≥ DEFAULT_PASS_THRESHOLD; evidence = {clauseVerdicts, droppedIds}.
**Tests (stubs only, keyless):** execution grader with stubbed complete returning a known-good policy block + REAL sandbox → correct pass on S0; stub returning prose without a code block → pass:null; judge with stubbed completeJson returning 3 satisfied / 1 unsatisfied over real clause ids → score 0.75 pass:false; hallucinated clauseId dropped; extractCodeBlock cases (single, multiple→last, none, tildes not supported).

Commit: `feat(eval): execution-codegen + llm-judge graders with injectable LLM fns`.

---

### Task B2-4: Run executor + agreement math

**Files:** Create `app/actions/runs.ts`, `lib/eval/agreement.ts`; Test `lib/eval/__tests__/agreement.test.ts`.

**agreement.ts (pure):** `cohensKappa(a: (boolean|null)[], b: (boolean|null)[]): { kappa: number|null; agreement: number|null; n: number }` — pairwise-complete only (both non-null); kappa null when n===0 or when either rater is constant (p_e===1 edge: if observed also 1 → kappa 1, else 0 — document the convention); `disagreements<T>(items: T[], key: (t:T)=>string, pass: (t:T)=>boolean|null): ...` — helper grouping verdict pairs by (pid,phase,scenario) and returning the discordant ones. Tests: hand-computed κ fixtures (perfect=1, independence≈0, the constant-rater edge, nulls excluded).

**runs.ts (`'use server'`):**
```ts
export type RunRequest = { name: string; pids: string[]; graderId: 'execution-codegen'|'llm-judge'; simBackend: 'deterministic'|'llm'|null; llmConfig: unknown; promptVariantId: string; fewShotSetId: string|null; oracleArtifactId: string; metricArtifactId: string; phaseOrdinals?: number[]; scenarioIdxs?: (0|1|2|3)[] };
export async function createAndExecuteRun(req: RunRequest): Promise<{ runId: string }>;
export type RunSummary = { id: string; name: string; graderId: string; simBackend: string|null; status: string; createdAt: string; verdictCount: number };
export async function listRuns(): Promise<RunSummary[]>;
export type VerdictRow = { id: string; runId: string; pid: string; phaseOrdinal: number; scenarioIdx: number|null; pass: boolean|null; score: number|null; rationale: string; evidence: unknown };
export async function listVerdicts(runId: string): Promise<VerdictRow[]>;
export type AgreementReport = { runA: string; runB: string; kappa: number|null; agreement: number|null; n: number; disagreements: { pid: string; phaseOrdinal: number; scenarioIdx: number|null; passA: boolean|null; passB: boolean|null }[] };
export async function compareRuns(runIdA: string, runIdB: string): Promise<AgreementReport>;
```
`createAndExecuteRun`: requireAuthUser; validate llmConfig via `validateLlmConfig` (throw with its errors); load artifacts/variant/few-shot via evalFrom (throw if missing); insert eval_runs status 'running' (audited); resolve grader (`makeExecutionGrader(simBackend)` or judge); for each pid → `getParticipantProgression(pid)` → for each requested phase ordinal with a non-null snapshot × each requested scenarioIdx (defaults: all 5 ordinals × all 4 scenarios — FIXED-TARGET grading, doc-comment the measurement rationale and the revealed-only alternative left to Hudson): build GradeInput, `await grader.grade(input, realLlmFns)` inside try/catch (catch → verdict pass:null evidence.error), insert eval_verdict (audited) with config_hash = sha256Hex(JSON of {graderId, simBackend, oracleHash, metricHash, promptVariantId, llmConfig}); sequential loop (rate-limit friendly); finally update run status 'complete' (or 'failed' + error when the loop itself threw) — audited. `compareRuns`: join verdicts on (pid,phaseOrdinal,scenarioIdx), feed cohensKappa.

Commit: `feat(eval): run executor with fixed-target grading + Cohen's kappa agreement`.

---

### Task B2-5: Battery + paradigms doc

Full battery; append to `docs/eval-paradigms.md`: entry 6 (world-rules sim mechanics + fixture derivations + the "illegal actions ignored = signal" choice), entry 7 (sandbox tiering: env-clean + timeout floor, permission flag when supported), entry 8 (fixed-target grading rationale + revealed-only alternative flagged for Hudson), entry 9 (κ conventions incl. constant-rater edge). Commit `docs(eval): paradigms entries for sim, sandbox, grading target, agreement`.

## Self-Review
- Spec coverage: B spec §3 modules ✓ (both graders, both backends), §4 sandbox ✓ (env-clean+timeout+size cap+permission probe), §5 runs/verdicts/provenance ✓ (config_hash), agreement ✓ (κ + disagreement rows). Deferred to B3: ALL UI, artifact editing surfaces, annotate→fold flows (actions exist from B1-4).
- The golden tests ARE the sim spec (complete in-plan); types/interfaces exact; no placeholders. Judgment calls documented in-plan: fixture derivations from Given-clauses, DEFAULT_PASS_THRESHOLD code-side, fixed-target grading.
