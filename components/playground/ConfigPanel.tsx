'use client';

import { useEffect, useState } from 'react';
import { EVAL_MODELS, type EvalModel, type LlmConfig } from '@/lib/llm/config';
import { controlMatrix, type PlaygroundConfig } from '@/lib/eval/playground/config';
import type { EvalArtifact, FewShotSet, PromptVariant } from '@/app/actions/eval';
import ArtifactEditor from '@/components/playground/ArtifactEditor';
import VariantEditor from '@/components/playground/VariantEditor';
import FewShotPicker from '@/components/playground/FewShotPicker';

// ---------------------------------------------------------------------------
// Config panel island. Holds every knob of a run's configuration and assembles a
// PlaygroundConfig, lifted to Playground via onChange (Playground feeds it to
// buildRunRequest when the run panel lands in B3-3).
//
// MODEL-CONDITIONAL KNOBS: the temperature slider and effort <select> are gated
// by controlMatrix(model) — a PROBE of validateLlmConfig — so the UI can never
// offer a knob the validator (and the API) would reject:
//   - temperature slider shown ONLY when controlMatrix(model).temperatureAllowed
//   - effort <select> over controlMatrix(model).efforts (hidden when empty)
// When the model changes, any now-invalid knob is dropped from llmConfig (an
// effort not in the new model's set, a temperature on a model that forbids it) —
// enforced in an effect so the assembled config is always validator-clean.
//
// GRADER → BACKEND: sim-backend <select> shows ONLY for execution-codegen; for
// llm-judge it is hidden and simBackend is forced null (buildRunRequest also
// normalizes this, but the UI mirrors the rule).
// ---------------------------------------------------------------------------

const MAX_TOKENS_CEILING = 16000;

export default function ConfigPanel({
  oracleArtifacts,
  metricArtifacts,
  promptVariants,
  fewShotSets,
  onChange,
}: {
  oracleArtifacts: EvalArtifact[];
  metricArtifacts: EvalArtifact[];
  promptVariants: PromptVariant[];
  fewShotSets: FewShotSet[];
  onChange: (cfg: PlaygroundConfig) => void;
}) {
  const [graderId, setGraderId] = useState<PlaygroundConfig['graderId']>('execution-codegen');
  const [simBackend, setSimBackend] = useState<'deterministic' | 'llm'>('deterministic');
  const [model, setModel] = useState<EvalModel>('claude-opus-4-8');
  const [temperature, setTemperature] = useState<number>(0.5);
  const [effort, setEffort] = useState<NonNullable<LlmConfig['effort']> | ''>('high');
  const [maxTokens, setMaxTokens] = useState<number>(4000);

  const [oracleArtifactId, setOracleArtifactId] = useState<string>(oracleArtifacts[0]?.id ?? '');
  const [metricArtifactId, setMetricArtifactId] = useState<string>(metricArtifacts[0]?.id ?? '');
  const [promptVariantId, setPromptVariantId] = useState<string>(promptVariants[0]?.id ?? '');
  const [fewShotSetId, setFewShotSetId] = useState<string | null>(null);

  const matrix = controlMatrix(model);

  // Change the model AND drop any now-invalid effort in the same event handler
  // (not an effect — "you might not need an effect": derive the reset from the
  // event, keeping the assembled llmConfig validator-clean without a cascading
  // render). Temperature needs no reset: it's simply omitted from llmConfig when
  // the new model forbids it (see the assembly below).
  function changeModel(next: EvalModel) {
    setModel(next);
    const nextEfforts = controlMatrix(next).efforts;
    if (effort !== '' && !nextEfforts.includes(effort)) {
      setEffort(nextEfforts.length > 0 ? nextEfforts[nextEfforts.length - 1] : '');
    }
  }

  // Assemble llmConfig, omitting knobs the model forbids (temperature on a
  // temperature-forbidding model, effort when the set is empty / unset).
  const llmConfig: LlmConfig = { model };
  if (matrix.temperatureAllowed) llmConfig.temperature = temperature;
  if (matrix.efforts.length > 0 && effort !== '') llmConfig.effort = effort;
  if (Number.isFinite(maxTokens)) llmConfig.maxTokens = maxTokens;

  // Lift the assembled config whenever any input changes.
  useEffect(() => {
    onChange({
      graderId,
      simBackend: graderId === 'llm-judge' ? null : simBackend,
      llmConfig,
      promptVariantId,
      fewShotSetId,
      oracleArtifactId,
      metricArtifactId,
    });
    // llmConfig is derived from the primitive knob state below; listing those
    // avoids a new-object-identity render loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    graderId,
    simBackend,
    model,
    temperature,
    effort,
    maxTokens,
    promptVariantId,
    fewShotSetId,
    oracleArtifactId,
    metricArtifactId,
  ]);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        {/* Grader */}
        <label className="space-y-1 text-sm">
          <span className="text-xs font-semibold uppercase tracking-wider text-foreground/50">
            Grader
          </span>
          <select
            value={graderId}
            onChange={(e) => setGraderId(e.target.value as PlaygroundConfig['graderId'])}
            aria-label="Grader"
            className="w-full border border-rule bg-background px-2 py-1.5 outline-none focus:border-foreground/40"
          >
            <option value="execution-codegen">execution-codegen</option>
            <option value="llm-judge">llm-judge</option>
          </select>
        </label>

        {/* Sim backend — execution-codegen only */}
        {graderId === 'execution-codegen' && (
          <label className="space-y-1 text-sm">
            <span className="text-xs font-semibold uppercase tracking-wider text-foreground/50">
              Sim backend
            </span>
            <select
              value={simBackend}
              onChange={(e) => setSimBackend(e.target.value as 'deterministic' | 'llm')}
              aria-label="Sim backend"
              className="w-full border border-rule bg-background px-2 py-1.5 outline-none focus:border-foreground/40"
            >
              <option value="deterministic">deterministic</option>
              <option value="llm">llm</option>
            </select>
          </label>
        )}

        {/* Model */}
        <label className="space-y-1 text-sm">
          <span className="text-xs font-semibold uppercase tracking-wider text-foreground/50">
            Model
          </span>
          <select
            value={model}
            onChange={(e) => changeModel(e.target.value as EvalModel)}
            aria-label="Model"
            className="w-full border border-rule bg-background px-2 py-1.5 outline-none focus:border-foreground/40"
          >
            {EVAL_MODELS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>

        {/* Effort — only when the model accepts any */}
        {matrix.efforts.length > 0 && (
          <label className="space-y-1 text-sm">
            <span className="text-xs font-semibold uppercase tracking-wider text-foreground/50">
              Effort
            </span>
            <select
              value={effort}
              onChange={(e) =>
                setEffort(e.target.value as NonNullable<LlmConfig['effort']> | '')
              }
              aria-label="Effort"
              className="w-full border border-rule bg-background px-2 py-1.5 outline-none focus:border-foreground/40"
            >
              <option value="">(default)</option>
              {matrix.efforts.map((eff) => (
                <option key={eff} value={eff}>
                  {eff}
                </option>
              ))}
            </select>
          </label>
        )}

        {/* maxTokens */}
        <label className="space-y-1 text-sm">
          <span className="text-xs font-semibold uppercase tracking-wider text-foreground/50">
            Max tokens
          </span>
          <input
            type="number"
            min={1}
            max={MAX_TOKENS_CEILING}
            step={100}
            value={maxTokens}
            onChange={(e) => setMaxTokens(e.target.valueAsNumber)}
            aria-label="Max tokens"
            className="w-full border border-rule bg-background px-2 py-1.5 outline-none focus:border-foreground/40"
          />
        </label>

        {/* Temperature — only when the model accepts it */}
        {matrix.temperatureAllowed && (
          <label className="space-y-1 text-sm">
            <span className="text-xs font-semibold uppercase tracking-wider text-foreground/50">
              Temperature · {temperature.toFixed(2)}
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={temperature}
              onChange={(e) => setTemperature(e.target.valueAsNumber)}
              aria-label="Temperature"
              className="w-full accent-foreground"
            />
          </label>
        )}
      </div>

      <VariantEditor
        variants={promptVariants}
        selectedId={promptVariantId}
        onSelect={setPromptVariantId}
      />

      <div className="grid grid-cols-2 gap-3">
        <ArtifactEditor
          kind="oracle_spec"
          label="Oracle spec"
          artifacts={oracleArtifacts}
          selectedId={oracleArtifactId}
          onSelect={setOracleArtifactId}
        />
        <ArtifactEditor
          kind="metric"
          label="Metric"
          artifacts={metricArtifacts}
          selectedId={metricArtifactId}
          onSelect={setMetricArtifactId}
        />
      </div>

      <FewShotPicker sets={fewShotSets} selectedId={fewShotSetId} onSelect={setFewShotSetId} />
    </div>
  );
}
