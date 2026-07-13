// Grader contract for the eval harness (Task B2-3).
//
// TWO graders implement ONE contract. `execution-codegen` compiles a
// participant's spec into a dispatch policy and runs it against the authored
// scenarios; `llm-judge` asks a model whether the spec's own text satisfies the
// authored Given/When/Then clauses. Both return the SAME `Verdict` shape so the
// run executor (B2-4) can store them side by side and compute agreement.
//
// DESIGN — INJECTABLE LLM FNS (plan Global Constraints): `grade` takes an
// `LlmFns` argument. Production passes the real B1 client (`{ llmComplete,
// llmCompleteJson }`); tests pass keyless stubs. NOTHING in this module (or the
// graders that build on it) reads `process.env` or constructs an Anthropic
// client — that lives entirely behind the injected fns, so every grader test
// runs offline with deterministic stubs.
//
// VERDICT HONESTY (plan Global Constraints): a grader NEVER fabricates a
// pass/fail when its machinery failed to produce evidence. No code block from
// codegen, a sandbox `{ ok: false }`, a judge `completeJson` that throws or
// returns an unusable shape → `pass: null` with the reason recorded in
// `evidence`. `null` means "could not grade", distinct from `false` ("graded,
// did not meet the bar").

import type { Entity } from '@/lib/spec/reconstruct';
import type { Scenario } from '@/lib/study/study';

/** The injected LLM surface. Typed against the REAL client fns so a stub that
 *  satisfies this type is call-compatible with production — a stub drift
 *  becomes a compile error, not a runtime surprise. */
export type LlmFns = {
  complete: typeof import('@/lib/llm/client').llmComplete;
  completeJson: typeof import('@/lib/llm/client').llmCompleteJson;
};

/** Everything a grader needs to score one participant snapshot against one
 *  scenario. Assembled by the run executor (B2-4) from artifacts, the prompt
 *  variant, the authored study, and the reconstructed spec/entities. */
export type GradeInput = {
  pid: string;
  phaseOrdinal: number;
  scenarioIdx: 0 | 1 | 2 | 3;
  spec: string;
  entities: Entity[];
  scenario: Scenario; // authored clauses (Given/When/Then)
  oracleSpec: { content: string; hash: string };
  metricDoc: { content: string; hash: string };
  systemPrompt: string; // prompt-variant content
  fewShot: { role: 'user' | 'assistant'; content: string }[];
  llmConfig: import('@/lib/llm/config').LlmConfig;
};

/** The single verdict shape both graders return.
 *  - `pass: null` ⇒ ungradable (machinery failed); `evidence` carries the why.
 *  - `score: null` ⇒ no score computable (same failure cases as pass:null).
 *  - `evidence` is grader-specific but ALWAYS includes `{ graderId }`, and for
 *    the execution grader `{ simBackend }` too (documented per grader). */
export type Verdict = {
  pass: boolean | null;
  score: number | null;
  rationale: string;
  evidence: Record<string, unknown>;
};

export type GraderModule = {
  id: 'execution-codegen' | 'llm-judge';
  grade(input: GradeInput, llm: LlmFns): Promise<Verdict>;
};

/** Code-side pass bar for BOTH graders: score ≥ this ⇒ pass. metric.md's own
 *  threshold text is embedded in the JUDGE PROMPT (so the model reasons under
 *  the researcher's rubric) but is NOT parsed back into code — the code-side
 *  bar is fixed here for reproducibility across metric.md edits (documented). */
export const DEFAULT_PASS_THRESHOLD = 0.8;
