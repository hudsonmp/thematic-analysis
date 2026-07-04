// Pure LLM-config validation (no SDK import, no server-only) so it unit-tests
// under vitest and can be shared by server actions AND the UI. Every rule here
// encodes API ground truth from the claude-api reference (cached 2026-06) —
// the point is to reject a config at the edge with a readable message instead
// of letting the Anthropic API 400 mid-run with a grader half-finished.

import { z } from 'zod';

/** The closed set of models the eval harness may call. Exact ID strings from
 *  the claude-api reference — no date suffixes (a suffixed ID 404s). */
export const EVAL_MODELS = [
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
] as const;

export type EvalModel = (typeof EVAL_MODELS)[number];

export type LlmConfig = {
  model: EvalModel;
  temperature?: number;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
};

/**
 * Strict schema + cross-field rules for an eval-harness LLM call config.
 * Exported (not just `validateLlmConfig`) so actions can compose it into their
 * own input schemas without re-stating the model rules.
 *
 * Cross-field rules, each cited to the claude-api reference:
 *  1. `temperature` is REJECTED (400) on claude-opus-4-8 — sampling params
 *     (`temperature`/`top_p`/`top_k`) were removed in the 4.7+ API. Allowed on
 *     sonnet-4-6 / haiku-4-5, range 0..1 inclusive.
 *  2. `output_config.effort` is valid on claude-opus-4-8 + claude-sonnet-4-6
 *     only (NOT haiku-4-5, which errors); the 'xhigh' level is opus-only.
 *  3. `maxTokens` is an integer 1..16000 — the non-streaming SDK-timeout
 *     ceiling (above ~16K the SDK requires streaming to avoid HTTP timeouts).
 *     Raise this bound only when the client layer gains streaming.
 */
export const llmConfigSchema = z
  .object({
    model: z.enum(EVAL_MODELS, {
      error: `model must be one of: ${EVAL_MODELS.join(', ')}`,
    }),
    temperature: z
      .number({ error: 'temperature must be a number' })
      .min(0, 'temperature must be in 0..1 (inclusive; the API rejects values outside this range)')
      .max(1, 'temperature must be in 0..1 (inclusive; the API rejects values outside this range)')
      .optional(),
    maxTokens: z
      .number({ error: 'maxTokens must be a number' })
      .int('maxTokens must be an integer')
      .min(1, 'maxTokens must be at least 1')
      .max(
        16000,
        'maxTokens must be <= 16000 (non-streaming SDK-timeout ceiling; raise only when the client layer gains streaming)',
      )
      .optional(),
    effort: z
      .enum(['low', 'medium', 'high', 'xhigh', 'max'], {
        error: "effort must be one of: 'low', 'medium', 'high', 'xhigh', 'max'",
      })
      .optional(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    // Rule 1 (claude-api reference): sampling params were removed on opus-4-8
    // (4.7+ API) — sending temperature there is a guaranteed 400.
    if (cfg.temperature !== undefined && cfg.model === 'claude-opus-4-8') {
      ctx.addIssue({
        code: 'custom',
        path: ['temperature'],
        message:
          'temperature is not supported on claude-opus-4-8 (removed in the 4.7+ API — the request would 400)',
      });
    }
    // Rule 2a (claude-api reference): output_config.effort errors on haiku-4-5.
    if (cfg.effort !== undefined && cfg.model === 'claude-haiku-4-5') {
      ctx.addIssue({
        code: 'custom',
        path: ['effort'],
        message:
          'effort is not supported on claude-haiku-4-5 (output_config.effort is valid on claude-opus-4-8 and claude-sonnet-4-6 only)',
      });
    }
    // Rule 2b (claude-api reference): the 'xhigh' effort level is opus-only —
    // sonnet-4-6 supports low|medium|high|max but not xhigh.
    if (cfg.effort === 'xhigh' && cfg.model !== 'claude-opus-4-8') {
      ctx.addIssue({
        code: 'custom',
        path: ['effort'],
        message: "effort 'xhigh' is opus-only (claude-opus-4-8); sonnet-4-6 tops out at 'max'",
      });
    }
  });

/**
 * Validate an unknown value into an `LlmConfig`, flattening zod issues into
 * readable `"path: message"` strings. Discriminated on `ok` so callers can't
 * touch `config` without handling the failure branch.
 */
export function validateLlmConfig(
  raw: unknown,
): { ok: true; config: LlmConfig } | { ok: false; errors: string[] } {
  const result = llmConfigSchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map((issue) =>
        issue.path.length > 0
          ? `${issue.path.join('.')}: ${issue.message}`
          : issue.message,
      ),
    };
  }
  return { ok: true, config: result.data };
}
