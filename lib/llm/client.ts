// Server-only Anthropic client layer for the eval harness. Thin by design:
// config validation lives in the pure lib/llm/config.ts (shared with the UI),
// and retry/display policy lives with callers — this module only owns building
// the request from a validated LlmConfig and normalizing the response shape.

import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';
import { validateLlmConfig, type LlmConfig } from '@/lib/llm/config';

export type LlmMessage = { role: 'user' | 'assistant'; content: string };

export type LlmUsage = { inputTokens: number; outputTokens: number };

/**
 * Build the client at CALL time, never at module scope: a missing key must not
 * break builds or tests that merely import a module which imports this one —
 * it should fail exactly when (and only when) someone actually runs a grader.
 */
function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set — add it to .env.local to run LLM graders.',
    );
  }
  return new Anthropic();
}

/** Re-validate (defense in depth — the UI validates too) and throw readably. */
function assertValidConfig(cfg: LlmConfig): void {
  const result = validateLlmConfig(cfg);
  if (!result.ok) {
    throw new Error(`llm client: invalid config — ${result.errors.join('; ')}`);
  }
}

/**
 * One non-streaming completion, returning the concatenated text blocks + token
 * usage. Request-building rules (claude-api reference): `temperature` is
 * spread ONLY when defined (the validator already guarantees it never reaches
 * claude-opus-4-8, where it 400s); `output_config: { effort }` only when
 * defined (effort is opus/sonnet-only). `max_tokens` defaults to 8192 and the
 * validator caps it at 16000 — the non-streaming SDK-timeout ceiling.
 *
 * Deliberately catches NOTHING: the SDK's typed errors
 * (`Anthropic.RateLimitError`, `Anthropic.APIConnectionError`, …) propagate so
 * callers can branch most-specific-first and own retry/display policy.
 */
export async function llmComplete(
  cfg: LlmConfig,
  opts: { system: string; messages: LlmMessage[] },
): Promise<{ text: string; usage: LlmUsage }> {
  assertValidConfig(cfg);
  const response = await getClient().messages.create({
    model: cfg.model,
    max_tokens: cfg.maxTokens ?? 8192,
    system: opts.system,
    messages: opts.messages,
    ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
    ...(cfg.effort !== undefined ? { output_config: { effort: cfg.effort } } : {}),
  });
  return {
    text: response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join(''),
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  };
}

/**
 * Structured-output completion via `client.messages.parse` +
 * `output_config.format` (claude-api reference: the recommended structured-
 * outputs path; the old top-level `output_format` is deprecated).
 *
 * NOTE on the installed SDK surface (@anthropic-ai/sdk 0.110.0, verified in
 * node_modules): `zodOutputFormat(schema)` takes ONLY the schema — there is no
 * name parameter, and the wire-level `JSONOutputFormat` is `{ type, schema }`
 * with no name field. `schemaName` is therefore kept for interface stability
 * with B2 callers and used in the no-parsed-output error below; wire it
 * through to the API if a later SDK adds a name slot.
 *
 * Same error policy as `llmComplete`: typed SDK errors propagate uncaught.
 */
export async function llmCompleteJson<T>(
  cfg: LlmConfig,
  opts: {
    system: string;
    messages: LlmMessage[];
    schema: z.ZodType<T>;
    schemaName: string;
  },
): Promise<{ value: T; usage: LlmUsage }> {
  assertValidConfig(cfg);
  const response = await getClient().messages.parse({
    model: cfg.model,
    max_tokens: cfg.maxTokens ?? 8192,
    system: opts.system,
    messages: opts.messages,
    ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
    output_config: {
      ...(cfg.effort !== undefined ? { effort: cfg.effort } : {}),
      format: zodOutputFormat(opts.schema),
    },
  });
  if (response.parsed_output == null) {
    // Most commonly stop_reason "max_tokens" (output truncated mid-JSON) or
    // "refusal" — either way the structured value never materialized.
    throw new Error(
      `llmCompleteJson: no parsed output for schema "${opts.schemaName}" (stop_reason: ${response.stop_reason})`,
    );
  }
  return {
    value: response.parsed_output,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  };
}
