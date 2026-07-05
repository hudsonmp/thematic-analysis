import { describe, expect, it } from 'vitest';
import { buildRunRequest, controlMatrix, type PlaygroundConfig } from '../config';
import { EVAL_MODELS, type LlmConfig } from '@/lib/llm/config';

// ---------------------------------------------------------------------------
// config.test.ts — the contract that PINS the control matrix to
// validateLlmConfig. Every assertion below is derived by PROBING the validator,
// so if lib/llm/config.ts's cross-field API rules change (temperature removed on
// a new model, a new effort level, etc.), these tests break and force the UI's
// knob set back into sync. The ground-truth expectations (opus rejects temp /
// allows xhigh; sonnet allows temp / tops at 'max'; haiku rejects effort) are
// asserted as OUTCOMES of the probe, never hardcoded into controlMatrix.
// ---------------------------------------------------------------------------

describe('controlMatrix — derived view of validateLlmConfig', () => {
  it('exposes the closed model set (EVAL_MODELS)', () => {
    expect(controlMatrix('claude-opus-4-8').models).toEqual(EVAL_MODELS);
  });

  it('claude-opus-4-8: rejects temperature, allows xhigh effort', () => {
    const m = controlMatrix('claude-opus-4-8');
    expect(m.temperatureAllowed).toBe(false);
    expect(m.efforts).toContain('xhigh');
    // opus supports the full effort ladder.
    expect(m.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('claude-sonnet-4-6: allows temperature, EXCLUDES xhigh (tops at max)', () => {
    const m = controlMatrix('claude-sonnet-4-6');
    expect(m.temperatureAllowed).toBe(true);
    expect(m.efforts).not.toContain('xhigh');
    expect(m.efforts).toEqual(['low', 'medium', 'high', 'max']);
  });

  it('claude-haiku-4-5: allows temperature, rejects effort entirely (empty efforts)', () => {
    const m = controlMatrix('claude-haiku-4-5');
    expect(m.temperatureAllowed).toBe(true);
    expect(m.efforts).toEqual([]);
  });
});

// A config the validator accepts for the given model — used as the happy-path
// base so buildRunRequest tests exercise only the branch under test.
function validCfg(overrides: Partial<PlaygroundConfig> = {}): PlaygroundConfig {
  return {
    graderId: 'execution-codegen',
    simBackend: 'deterministic',
    llmConfig: { model: 'claude-opus-4-8', effort: 'high', maxTokens: 4000 },
    promptVariantId: 'variant-1',
    fewShotSetId: null,
    oracleArtifactId: 'oracle-1',
    metricArtifactId: 'metric-1',
    ...overrides,
  };
}

describe('buildRunRequest — assemble + validate', () => {
  it('fails on empty pids with a specific message', () => {
    const r = buildRunRequest('run', [], validCfg());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/participant|pid/i);
  });

  it('fails on empty name with a specific message', () => {
    const r = buildRunRequest('   ', ['p1'], validCfg());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/name/i);
  });

  it('fails on unset oracle artifact with a specific message', () => {
    const r = buildRunRequest('run', ['p1'], validCfg({ oracleArtifactId: '' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/oracle/i);
  });

  it('fails on unset metric artifact with a specific message', () => {
    const r = buildRunRequest('run', ['p1'], validCfg({ metricArtifactId: '' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/metric/i);
  });

  it('fails on unset prompt variant with a specific message', () => {
    const r = buildRunRequest('run', ['p1'], validCfg({ promptVariantId: '' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/variant/i);
  });

  it('fails on an invalid llmConfig, surfacing the validator message', () => {
    // temperature on opus is a guaranteed API 400 — the validator rejects it,
    // and buildRunRequest must surface THAT message (not a generic one).
    const bad = buildRunRequest(
      'run',
      ['p1'],
      validCfg({ llmConfig: { model: 'claude-opus-4-8', temperature: 0.5 } as LlmConfig }),
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/temperature/i);
  });

  it('succeeds on a valid config, echoing the ids into the RunRequest', () => {
    const r = buildRunRequest('my run', ['p1', 'p2'], validCfg());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.req.name).toBe('my run');
      expect(r.req.pids).toEqual(['p1', 'p2']);
      expect(r.req.graderId).toBe('execution-codegen');
      expect(r.req.simBackend).toBe('deterministic');
      expect(r.req.promptVariantId).toBe('variant-1');
      expect(r.req.fewShotSetId).toBeNull();
      expect(r.req.oracleArtifactId).toBe('oracle-1');
      expect(r.req.metricArtifactId).toBe('metric-1');
      expect(r.req.llmConfig).toEqual({ model: 'claude-opus-4-8', effort: 'high', maxTokens: 4000 });
    }
  });

  it('forces simBackend null when graderId is llm-judge', () => {
    // Even if the caller passes a backend, an llm-judge run has no sim backend.
    const r = buildRunRequest(
      'judge run',
      ['p1'],
      validCfg({
        graderId: 'llm-judge',
        simBackend: 'deterministic',
        llmConfig: { model: 'claude-sonnet-4-6', temperature: 0.3 },
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.req.graderId).toBe('llm-judge');
      expect(r.req.simBackend).toBeNull();
    }
  });

  it('keeps a deterministic|llm sim backend for execution-codegen', () => {
    const r = buildRunRequest('sim run', ['p1'], validCfg({ simBackend: 'llm' }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.req.simBackend).toBe('llm');
  });

  // --- gate NIT pins: previously-untested buildRunRequest branches ----------

  it('defaults a null execution-codegen sim backend to deterministic', () => {
    // execution-codegen NEEDS a backend; a null one falls back to deterministic
    // (config.ts `?? 'deterministic'`). Pin so a regression to another default
    // or a dropped fallback fails a test.
    const r = buildRunRequest('run', ['p1'], validCfg({ graderId: 'execution-codegen', simBackend: null }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.req.simBackend).toBe('deterministic');
  });

  it('passes a non-null fewShotSetId through unchanged', () => {
    const r = buildRunRequest('run', ['p1'], validCfg({ fewShotSetId: 'fs-42' }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.req.fewShotSetId).toBe('fs-42');
  });

  it('trims and drops blank pids, keeping only the real ones', () => {
    const r = buildRunRequest('run', ['  p1  ', '', '   ', 'p2'], validCfg());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.req.pids).toEqual(['p1', 'p2']);
  });
});
