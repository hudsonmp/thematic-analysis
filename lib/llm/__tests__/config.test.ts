import { describe, expect, it } from 'vitest';
import { EVAL_MODELS, validateLlmConfig } from '@/lib/llm/config';

/** Narrowing helper: asserts failure and returns the errors for substring checks. */
function expectInvalid(raw: unknown): string[] {
  const result = validateLlmConfig(raw);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected ok:false');
  expect(result.errors.length).toBeGreaterThan(0);
  return result.errors;
}

describe('validateLlmConfig — valid configs', () => {
  it('accepts sonnet with temperature 0.7', () => {
    const result = validateLlmConfig({ model: 'claude-sonnet-4-6', temperature: 0.7 });
    expect(result).toEqual({
      ok: true,
      config: { model: 'claude-sonnet-4-6', temperature: 0.7 },
    });
  });

  it("accepts opus with effort 'xhigh' and NO temperature", () => {
    const result = validateLlmConfig({ model: 'claude-opus-4-8', effort: 'xhigh' });
    expect(result).toEqual({
      ok: true,
      config: { model: 'claude-opus-4-8', effort: 'xhigh' },
    });
  });

  it('accepts bare haiku (model only)', () => {
    const result = validateLlmConfig({ model: 'claude-haiku-4-5' });
    expect(result).toEqual({ ok: true, config: { model: 'claude-haiku-4-5' } });
  });

  it("accepts sonnet with effort 'max' and maxTokens at the 16000 ceiling", () => {
    const result = validateLlmConfig({
      model: 'claude-sonnet-4-6',
      effort: 'max',
      maxTokens: 16000,
    });
    expect(result).toEqual({
      ok: true,
      config: { model: 'claude-sonnet-4-6', effort: 'max', maxTokens: 16000 },
    });
  });

  // Pin the INCLUSIVE bounds the range error message promises (review NIT).
  it('accepts temperature exactly 0 on sonnet (inclusive lower bound)', () => {
    const result = validateLlmConfig({ model: 'claude-sonnet-4-6', temperature: 0 });
    expect(result).toEqual({ ok: true, config: { model: 'claude-sonnet-4-6', temperature: 0 } });
  });

  it('accepts temperature exactly 1 on sonnet (inclusive upper bound)', () => {
    const result = validateLlmConfig({ model: 'claude-sonnet-4-6', temperature: 1 });
    expect(result).toEqual({ ok: true, config: { model: 'claude-sonnet-4-6', temperature: 1 } });
  });
});

describe('validateLlmConfig — model-conditional rules', () => {
  it('rejects temperature on claude-opus-4-8 (removed in the 4.7+ API)', () => {
    const errors = expectInvalid({ model: 'claude-opus-4-8', temperature: 0.5 });
    expect(errors.join('\n')).toMatch(
      /temperature is not supported on claude-opus-4-8/,
    );
  });

  it('rejects temperature 1.5 (above the 0..1 range)', () => {
    const errors = expectInvalid({ model: 'claude-sonnet-4-6', temperature: 1.5 });
    expect(errors.join('\n')).toMatch(/temperature/);
    expect(errors.join('\n')).toMatch(/0\.\.1|<=\s*1|at most 1|between 0 and 1/i);
  });

  it('rejects temperature -0.1 (below the 0..1 range)', () => {
    const errors = expectInvalid({ model: 'claude-sonnet-4-6', temperature: -0.1 });
    expect(errors.join('\n')).toMatch(/temperature/);
    expect(errors.join('\n')).toMatch(/0\.\.1|>=\s*0|at least 0|between 0 and 1/i);
  });

  it('rejects effort on claude-haiku-4-5', () => {
    const errors = expectInvalid({ model: 'claude-haiku-4-5', effort: 'high' });
    expect(errors.join('\n')).toMatch(/effort is not supported on claude-haiku-4-5/);
  });

  it("rejects effort 'xhigh' on sonnet (xhigh is opus-only)", () => {
    const errors = expectInvalid({ model: 'claude-sonnet-4-6', effort: 'xhigh' });
    expect(errors.join('\n')).toMatch(/xhigh.*opus/i);
  });

  it('rejects an unknown model with an error listing the three EVAL_MODELS', () => {
    const errors = expectInvalid({ model: 'gpt-4' });
    const joined = errors.join('\n');
    for (const model of EVAL_MODELS) {
      expect(joined).toContain(model);
    }
  });

  it('rejects maxTokens 20000 (above the non-streaming ceiling)', () => {
    const errors = expectInvalid({ model: 'claude-opus-4-8', maxTokens: 20000 });
    expect(errors.join('\n')).toMatch(/non-streaming/);
  });
});

describe('validateLlmConfig — strict shape', () => {
  it('rejects null', () => {
    expectInvalid(null);
  });

  it('rejects a bare string', () => {
    expectInvalid('str');
  });

  it('rejects unrecognized keys (strict parse)', () => {
    const errors = expectInvalid({ model: 'claude-haiku-4-5', junk: true });
    expect(errors.join('\n')).toMatch(/junk/);
  });
});
