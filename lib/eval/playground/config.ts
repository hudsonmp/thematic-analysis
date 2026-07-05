import { EVAL_MODELS, validateLlmConfig, type LlmConfig } from '@/lib/llm/config';
import type { RunRequest } from '@/app/actions/runs';

// ---------------------------------------------------------------------------
// Pure config core for the playground: the model→control matrix and the
// RunRequest assembler. Both are unit-tested (config.test.ts) so contestable
// logic never lives in JSX.
//
// SINGLE SOURCE OF TRUTH: the matrix is a DERIVED VIEW of validateLlmConfig, not
// a re-encoding of the API rules. We PROBE the validator — "does {model, temp}
// validate? does {model, effort} validate for each effort level?" — and keep
// only what it accepts. Consequence: the UI can never present a knob the
// validator (and therefore the Anthropic API) would reject, and when the rules
// in lib/llm/config.ts change, the matrix follows automatically (the tests pin
// the two in lockstep).
// ---------------------------------------------------------------------------

/** Every effort level the schema knows about — the candidate set we probe. Kept
 *  in ladder order (low→max) so a model's accepted `efforts` reads as a prefix
 *  of the ladder in the UI. */
const CANDIDATE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export type ControlMatrix = {
  temperatureAllowed: boolean;
  efforts: NonNullable<LlmConfig['effort']>[];
  models: typeof EVAL_MODELS;
};

/**
 * Which knobs a model accepts — derived by probing `validateLlmConfig`:
 *  - temperatureAllowed: does `{ model, temperature: 0.5 }` validate?
 *  - efforts: the subset of low|medium|high|xhigh|max for which
 *    `{ model, effort }` validates (one probe per candidate, accepted kept).
 * `models` is EVAL_MODELS so the UI's model picker and the validator's model
 * enum stay a single set.
 */
export function controlMatrix(model: LlmConfig['model']): ControlMatrix {
  const temperatureAllowed = validateLlmConfig({ model, temperature: 0.5 }).ok;
  const efforts = CANDIDATE_EFFORTS.filter(
    (effort) => validateLlmConfig({ model, effort }).ok,
  );
  return { temperatureAllowed, efforts: [...efforts], models: EVAL_MODELS };
}

export type PlaygroundConfig = {
  graderId: 'execution-codegen' | 'llm-judge';
  simBackend: 'deterministic' | 'llm' | null; // null when graderId is llm-judge
  llmConfig: LlmConfig;
  promptVariantId: string;
  fewShotSetId: string | null;
  oracleArtifactId: string;
  metricArtifactId: string;
};

/**
 * Assemble + validate a RunRequest from panel state + the current selection.
 * Returns `{ ok: false, error }` — so the Run button can render disabled WITH a
 * reason — when:
 *   - the name is blank,
 *   - the selection is empty,
 *   - the oracle / metric artifact or prompt variant is unset, or
 *   - `validateLlmConfig` rejects the config (its own message is surfaced —
 *     e.g. "temperature is not supported on claude-opus-4-8").
 * On success it echoes the selected ids into a `RunRequest`, normalizing
 * simBackend to null whenever the grader is llm-judge (an llm-judge run has no
 * simulator) and to a concrete value for execution-codegen.
 */
export function buildRunRequest(
  name: string,
  pids: string[],
  cfg: PlaygroundConfig,
): { ok: true; req: RunRequest } | { ok: false; error: string } {
  const cleanName = (name ?? '').trim();
  if (!cleanName) return { ok: false, error: 'Run name is required.' };

  const cleanPids = (pids ?? []).map((p) => (p ?? '').trim()).filter((p) => p !== '');
  if (cleanPids.length === 0) {
    return { ok: false, error: 'Select at least one participant.' };
  }

  if (!cfg.oracleArtifactId) {
    return { ok: false, error: 'Select an oracle-spec artifact.' };
  }
  if (!cfg.metricArtifactId) {
    return { ok: false, error: 'Select a metric artifact.' };
  }
  if (!cfg.promptVariantId) {
    return { ok: false, error: 'Select a prompt variant.' };
  }

  // Validate the LLM config through the single source of truth. Surface the
  // validator's own message so the disabled-Run reason matches what the server
  // action would throw — no drift between the two validation sites.
  const validated = validateLlmConfig(cfg.llmConfig);
  if (!validated.ok) {
    return { ok: false, error: validated.errors.join('; ') };
  }

  // simBackend is meaningful ONLY for the execution grader; an llm-judge run has
  // no simulator, so force null there regardless of what the panel held.
  const simBackend: RunRequest['simBackend'] =
    cfg.graderId === 'llm-judge' ? null : cfg.simBackend ?? 'deterministic';

  const req: RunRequest = {
    name: cleanName,
    pids: cleanPids,
    graderId: cfg.graderId,
    simBackend,
    llmConfig: validated.config,
    promptVariantId: cfg.promptVariantId,
    fewShotSetId: cfg.fewShotSetId,
    oracleArtifactId: cfg.oracleArtifactId,
    metricArtifactId: cfg.metricArtifactId,
  };
  return { ok: true, req };
}
