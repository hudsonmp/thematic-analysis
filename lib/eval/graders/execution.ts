// Execution-codegen grader (Task B2-3).
//
// PIPELINE: (1) ask the model to translate the participant's spec into a
// `function decide(world, event)` policy; (2) run that policy against the
// authored scenario — in the DETERMINISTIC backend via the sandbox child
// (lib/sim/sandbox.ts), or in the LLM backend by asking a model to simulate it;
// (3) compare the resulting end-state to the reference end-state and score it.
//
// GRADING CONTRACT (plan B2-3, encoded in lib/sim/scenarios.ts): compare ONLY
// per-rider servedBy + droppedAt and per-vehicle charged. pickupOrder and
// vehicle POSITION are NOT graded — S0's B-first order is unreachable under
// atomic movement by a faithful immediate-assign policy, and S1's "V2
// repositions" is invisible in the end-state (documented blind spot). Total
// checks = 2×riders + 1×vehicles.
//
// SECURITY: the generated policy is UNTRUSTED. It reaches the sim ONLY through
// the sandbox child (env-cleared, timeboxed) — never the in-process harness
// (plan Global Constraints). The LLM backend never runs the code at all; it
// hands the source to a model as text.
//
// VERDICT HONESTY: no code block, a sandbox { ok:false }, or an unusable LLM
// EndState → pass:null with the reason in evidence — never a fabricated verdict.

import { z } from 'zod';
import { runPolicyInSandbox } from '@/lib/sim/sandbox';
import { SCENARIOS, EXPECTED_END_STATES, type ExpectedEndState } from '@/lib/sim/scenarios';
import type { EndState, LandmarkName, RiderId, VehicleId } from '@/lib/sim/harness';
import { DEFAULT_PASS_THRESHOLD, type GradeInput, type GraderModule, type LlmFns, type Verdict } from './types';
import { buildPolicyGenPrompt, buildLlmSimPrompt, extractCodeBlock } from './prompts';

type SimBackend = 'deterministic' | 'llm';

const GRADER_ID = 'execution-codegen' as const;

// Landmark / id vocabularies for the LLM-backend EndState schema. As in
// sandbox.ts, harness.ts exports these only as TYPES, so they are re-declared
// locally with a `satisfies` proof (a rename in harness breaks the build here).
const LANDMARK_NAMES = [
  'Depot / Charging',
  'Newman Library',
  'Lane Field',
  'Executive Airport',
  'ASCEND³',
] as const satisfies readonly LandmarkName[];
const VEHICLE_IDS = ['V1', 'V2'] as const satisfies readonly VehicleId[];
const RIDER_IDS = ['A', 'B', 'C'] as const satisfies readonly RiderId[];

// EndState schema for the LLM simulation backend: the model's JSON output is
// untrusted the same way the sandbox's stdout is, so it is validated before
// scoring. (The deterministic backend gets an already-validated EndState from
// the sandbox.)
const endStateSchema = z.object({
  riders: z.array(
    z.object({
      id: z.enum(RIDER_IDS),
      servedBy: z.enum(VEHICLE_IDS).nullable(),
      droppedAt: z.enum(LANDMARK_NAMES).nullable(),
      pickupOrder: z.number().nullable(),
    }),
  ),
  vehicles: z.array(
    z.object({
      id: z.enum(VEHICLE_IDS),
      at: z.enum(LANDMARK_NAMES),
      battery: z.number(),
      charged: z.boolean(),
    }),
  ),
  log: z.array(z.string()),
  completed: z.boolean(),
});

/** One graded field comparison. `field` names WHICH check (servedBy/droppedAt
 *  per rider, charged per vehicle); `match` is whether actual === expected. */
type Check = {
  target: string; // e.g. 'rider A servedBy', 'vehicle V1 charged'
  field: 'servedBy' | 'droppedAt' | 'charged';
  expected: unknown;
  actual: unknown;
  match: boolean;
};

/** Build the per-check list from the reference end-state (grading contract):
 *  per-rider servedBy + droppedAt, per-vehicle charged. NOTHING else. */
function buildChecks(endState: EndState, expected: ExpectedEndState): Check[] {
  const checks: Check[] = [];
  for (const rc of expected.riders) {
    const r = endState.riders.find((x) => x.id === rc.id);
    checks.push({
      target: `rider ${rc.id} servedBy`,
      field: 'servedBy',
      expected: rc.servedBy,
      actual: r ? r.servedBy : undefined,
      match: !!r && r.servedBy === rc.servedBy,
    });
    checks.push({
      target: `rider ${rc.id} droppedAt`,
      field: 'droppedAt',
      expected: rc.droppedAt,
      actual: r ? r.droppedAt : undefined,
      match: !!r && r.droppedAt === rc.droppedAt,
    });
  }
  for (const vc of expected.vehicles) {
    const v = endState.vehicles.find((x) => x.id === vc.id);
    checks.push({
      target: `vehicle ${vc.id} charged`,
      field: 'charged',
      expected: vc.charged,
      actual: v ? v.charged : undefined,
      match: !!v && v.charged === vc.charged,
    });
  }
  return checks;
}

/** A pass:null verdict that ALWAYS carries the evidence contract keys. */
function ungradable(simBackend: SimBackend, failure: string, extra: Record<string, unknown> = {}): Verdict {
  return {
    pass: null,
    score: null,
    rationale: `execution grader could not grade: ${failure}`,
    evidence: { graderId: GRADER_ID, simBackend, failure, ...extra },
  };
}

/**
 * Obtain the end-state for a generated policy.
 *  - deterministic: run it in the sandbox child against SCENARIOS[idx].
 *  - llm: ask the injected completeJson to simulate it and validate the shape.
 * Returns a discriminated result so the caller can produce an honest pass:null
 * on any failure without ever throwing.
 */
async function runPolicy(
  simBackend: SimBackend,
  policySource: string,
  input: GradeInput,
  llm: LlmFns,
): Promise<{ ok: true; endState: EndState } | { ok: false; failure: string }> {
  const setup = SCENARIOS[input.scenarioIdx];
  if (simBackend === 'deterministic') {
    return runPolicyInSandbox(policySource, setup);
  }
  // LLM backend: the model plays the simulator. Its output is untrusted JSON,
  // validated against the EndState schema before we score it.
  try {
    const { value } = await llm.completeJson(input.llmConfig, {
      system: input.systemPrompt,
      messages: [
        ...input.fewShot,
        { role: 'user', content: buildLlmSimPrompt(policySource, setup) },
      ],
      schema: endStateSchema,
      schemaName: 'EndState',
    });
    return { ok: true, endState: value };
  } catch (err) {
    return { ok: false, failure: `llm simulation failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Build an execution-codegen grader bound to a sim backend. The returned module
 * satisfies the shared GraderModule contract; the run executor (B2-4) resolves
 * it via `makeExecutionGrader(simBackend)` and calls `grade(input, realLlmFns)`.
 */
export function makeExecutionGrader(simBackend: SimBackend): GraderModule {
  return {
    id: GRADER_ID,
    async grade(input: GradeInput, llm: LlmFns): Promise<Verdict> {
      // Step 1 — codegen. A thrown LLM error is an honest ungradable, not a
      // crash of the whole run.
      let genText: string;
      try {
        const { text } = await llm.complete(input.llmConfig, {
          system: input.systemPrompt,
          messages: [
            ...input.fewShot,
            { role: 'user', content: buildPolicyGenPrompt(input.spec, input.entities) },
          ],
        });
        genText = text;
      } catch (err) {
        return ungradable(simBackend, `codegen call failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      const policySource = extractCodeBlock(genText);
      if (policySource === null) {
        return ungradable(simBackend, 'no code block', { genText });
      }

      // Step 2 — execute.
      const run = await runPolicy(simBackend, policySource, input, llm);
      if (!run.ok) {
        return ungradable(simBackend, run.failure, { policySource });
      }

      // Step 3 — score against the reference end-state (grading contract).
      const expected = EXPECTED_END_STATES[input.scenarioIdx];
      const perCheck = buildChecks(run.endState, expected);
      const matched = perCheck.filter((c) => c.match).length;
      const total = perCheck.length;
      const score = total === 0 ? 0 : matched / total;
      const pass = score >= DEFAULT_PASS_THRESHOLD;

      return {
        pass,
        score,
        rationale: `${matched}/${total} end-state checks matched the reference (servedBy/droppedAt per rider, charged per vehicle).`,
        evidence: {
          graderId: GRADER_ID,
          simBackend,
          policySource,
          endState: run.endState,
          expected,
          perCheck,
        },
      };
    },
  };
}
