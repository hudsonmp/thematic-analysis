// Pure prompt builders + the code-block extractor for the graders (Task B2-3).
//
// PURE STRING ASSEMBLY, by design: nothing here calls an LLM, reads env, or
// touches I/O. That makes every builder unit-testable without a key and keeps
// the "what we ask the model" surface reviewable in isolation from the "how we
// call the model" surface (the injected LlmFns).
//
// The shared vocabulary block below is the ground-truth contract the sim
// enforces (lib/sim/harness.ts). It is embedded verbatim into the policy-gen
// and llm-sim prompts so the model targets the exact WorldView/SimEvent/
// PolicyAction shapes the sandbox will run against — a drift between this prose
// and harness.ts would silently degrade generated policies, so keep it in sync.

import type { Entity } from '@/lib/spec/reconstruct';
import type { ScenarioSetup } from '@/lib/sim/harness';
import type { GradeInput } from './types';

/** The sim vocabulary, as prose the model reads. Mirror of lib/sim/harness.ts:
 *  WorldView (read-only snapshot), SimEvent (what the policy is consulted on),
 *  PolicyAction (the closed action set the policy may return). */
const SIM_VOCABULARY = `The simulator consults your policy on each SimEvent with a read-only WorldView and expects an array of PolicyActions back.

WorldView (read-only, handed to you each event):
  {
    timeMin: number,
    vehicles: { id: 'V1'|'V2', at: Landmark, battery: number, queue: RiderId[], carrying: RiderId|null }[],
    riders:   { id: 'A'|'B'|'C', pickup: Landmark, dropoff: Landmark, requested: boolean, pickedUpBy: 'V1'|'V2'|null, droppedAt: Landmark|null }[]
  }

Landmark is one of: 'Depot / Charging', 'Newman Library', 'Lane Field', 'Executive Airport', 'ASCEND³'.

SimEvent (what you are consulted on):
  { type: 'ride_request', rider: RiderId }
  { type: 'dropoff_complete', vehicle: 'V1'|'V2', rider: RiderId }
  { type: 'low_battery', vehicle: 'V1'|'V2' }   // fired once when a vehicle crosses below 15% battery
  { type: 'idle', vehicle: 'V1'|'V2' }

PolicyAction (the ONLY actions you may return; return an array, possibly empty or [{ act: 'noop' }]):
  { act: 'assign', vehicle: 'V1'|'V2', rider: RiderId }   // append rider to that vehicle's queue
  { act: 'reassign', rider: RiderId, to: 'V1'|'V2' }      // move a queued rider to another vehicle
  { act: 'reposition', vehicle: 'V1'|'V2', to: Landmark } // drive an idle vehicle to a landmark
  { act: 'charge', vehicle: 'V1'|'V2' }                   // send a vehicle to the Depot to recharge
  { act: 'noop' }

World rules you do NOT control: vehicles serve their queue FIFO, one passenger at a time; travel time is Manhattan distance; battery drains with distance; illegal actions are ignored.`;

/** Render an entity table as compact prose the model can read. */
function renderEntities(entities: Entity[]): string {
  if (entities.length === 0) return '(the participant recorded no entities)';
  return entities
    .map((e) => {
      const els = e.elements.map((el) => el.name).join(', ') || '(no elements)';
      return `- ${e.name}: ${els}`;
    })
    .join('\n');
}

/**
 * Policy-generation prompt (execution grader step 1). Contract: emit ONLY a JS
 * code block defining `function decide(world, event)` that returns an array of
 * PolicyActions — and translate the PARTICIPANT'S rules faithfully, gaps
 * included. The faithfulness clause is load-bearing: the grader measures what
 * the participant SPECIFIED, so adding "sensible" behavior they never wrote
 * would inflate scores and destroy the measurement.
 */
export function buildPolicyGenPrompt(spec: string, entities: Entity[]): string {
  return `You are translating a participant's dispatch specification into an executable policy.

Emit ONLY a single JavaScript code block defining:

    function decide(world, event) { ... }

that returns an array of PolicyActions from the vocabulary below. Output the code block and nothing else.

${SIM_VOCABULARY}

CRITICAL — translate the PARTICIPANT'S rules faithfully, INCLUDING their gaps. Do not add behaviors they did not specify: if the participant never says what to do on low_battery, your decide must do nothing on low_battery. You are transcribing their spec into code, NOT designing a good dispatcher. Under-specification in the spec must surface as under-specification (noops / omissions) in the policy.

=== PARTICIPANT SPECIFICATION ===
${spec || '(the participant wrote no specification)'}

=== PARTICIPANT ENTITY MODEL ===
${renderEntities(entities)}
`;
}

/** Render the authored Given/When/Then clauses with ids, so the judge can
 *  cite them by id in its per-clause verdicts. */
function renderClauses(input: GradeInput): string {
  return input.scenario.clauses
    .map((c) => `[${c.id}] ${c.type}: ${c.text}`)
    .join('\n');
}

/**
 * Judge prompt (llm-judge grader). Embeds metric.md and oracle-spec.md VERBATIM
 * (the researcher's rubric and ground-truth reference, unparaphrased), the
 * authored scenario clauses with ids, and the participant's spec + entity
 * model. Instructs a per-clause verdict grounded in a quote from the spec.
 */
export function buildJudgePrompt(input: GradeInput): string {
  return `You are grading whether a participant's specification satisfies the authored requirements for one scenario. Judge the SPECIFICATION TEXT — not a hypothetical better spec.

=== METRIC (how to grade — verbatim) ===
${input.metricDoc.content}

=== ORACLE SPECIFICATION (ground-truth reference — verbatim) ===
${input.oracleSpec.content}

=== SCENARIO: ${input.scenario.title} ===
Authored clauses (cite these by their [id]):
${renderClauses(input)}

=== PARTICIPANT SPECIFICATION ===
${input.spec || '(the participant wrote no specification)'}

=== PARTICIPANT ENTITY MODEL ===
${renderEntities(input.entities)}

For EACH authored clause above, return a verdict:
  - 'satisfied'   — the participant's spec clearly addresses this clause.
  - 'unsatisfied' — the spec addresses it but incorrectly, or contradicts it.
  - 'unclear'     — the spec is silent or too ambiguous to tell.
Ground every verdict in a short quote from the PARTICIPANT SPECIFICATION (empty quote when 'unclear'/'unsatisfied' because the spec is silent). Use the clause's exact [id]. Do not invent clause ids.`;
}

/**
 * LLM-sim prompt (execution grader, `llm` backend): ask the model to mentally
 * execute the policy against the world rules and return the EndState. Used only
 * when the execution grader runs with `simBackend: 'llm'` (the LLM-as-simulator
 * paradigm) instead of the deterministic sandbox.
 */
export function buildLlmSimPrompt(policySource: string, setup: ScenarioSetup): string {
  return `Execute this dispatch policy mentally against the world rules and scenario setup, then return the resulting EndState.

${SIM_VOCABULARY}

The EndState you must return:
  {
    riders:   { id: RiderId, servedBy: 'V1'|'V2'|null, droppedAt: Landmark|null, pickupOrder: number|null }[],
    vehicles: { id: 'V1'|'V2', at: Landmark, battery: number, charged: boolean }[],
    log: string[],
    completed: boolean
  }

=== SCENARIO SETUP ===
${JSON.stringify(setup, null, 2)}

=== POLICY (function decide) ===
${policySource}

Simulate faithfully: serve queues FIFO, one passenger at a time, apply the world rules above, and report the EndState after all events are processed.`;
}

/**
 * Extract the LAST backtick-fenced code block from `text`, stripping an
 * optional language tag on the opening fence. Returns null when no backtick
 * fence is present.
 *
 * WHY LAST: models routinely narrate with an illustrative snippet before the
 * final answer; the last block is the deliverable. WHY BACKTICKS ONLY: the
 * policy-gen prompt asks for a ```-fenced block; tilde fences (~~~) are a
 * CommonMark alternative we deliberately do NOT accept, so an accidental tilde
 * block is treated as "no block" rather than silently parsed (matches the
 * grader's no-code-block → pass:null honesty path).
 */
export function extractCodeBlock(text: string): string | null {
  // LINE-ORIENTED fence pairing (not a single global regex). A fence is a line
  // whose first non-whitespace characters are three backticks — so a stray
  // ``` INSIDE prose ("use a ```js block…") is NOT a fence and cannot open a
  // phantom block that mis-pairs with a later closer (B2-3 gate: the old
  // regex returned "" on exactly such well-formed-but-narrated model output).
  // We pair each opener to the next fence line and keep the LAST COMPLETE
  // block; a dangling opener with no closer is ignored (never captured).
  const isFence = (line: string): boolean => /^\s*```/.test(line);
  const lines = text.split('\n');
  let last: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (!isFence(lines[i])) {
      i++;
      continue;
    }
    // Opening fence at i (its language tag is dropped — we start the body on
    // the next line). Collect until the next fence line closes the block.
    const body: string[] = [];
    let j = i + 1;
    let closed = false;
    while (j < lines.length) {
      if (isFence(lines[j])) {
        closed = true;
        break;
      }
      body.push(lines[j]);
      j++;
    }
    if (!closed) break; // dangling opener — not a complete block
    last = body.join('\n');
    i = j + 1; // resume after the closing fence
  }
  return last;
}
