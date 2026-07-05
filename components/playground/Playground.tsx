'use client';

import { useState } from 'react';
import type { ProgressionParticipant } from '@/app/actions/progression';
import type { EvalArtifact, FewShotSet, PromptVariant } from '@/app/actions/eval';
import { buildRunRequest, type PlaygroundConfig } from '@/lib/eval/playground/config';
import CohortPanel from '@/components/playground/CohortPanel';
import ConfigPanel from '@/components/playground/ConfigPanel';

// ---------------------------------------------------------------------------
// Playground island shell. Holds the two pieces of state this island owns: the
// participant selection Set (B3-1) and the assembled run config (B3-2, lifted
// from ConfigPanel). The initial artifacts / prompt variants / few-shot sets are
// loaded server-side and threaded to ConfigPanel's editors (they are edited in
// place — each editor saves a new version/variant/set via a B1 action). The run
// panel + verdict grid land in B3-3; here we surface the current run-readiness
// (buildRunRequest over the selection + config) so the config's validity is
// visible and every prop is genuinely consumed.
// ---------------------------------------------------------------------------

export default function Playground({
  participants,
  oracleArtifacts,
  metricArtifacts,
  promptVariants,
  fewShotSets,
}: {
  participants: ProgressionParticipant[];
  oracleArtifacts: EvalArtifact[];
  metricArtifacts: EvalArtifact[];
  promptVariants: PromptVariant[];
  fewShotSets: FewShotSet[];
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [config, setConfig] = useState<PlaygroundConfig | null>(null);

  // Run-readiness preview: buildRunRequest returns the disabled reason when the
  // selection/config isn't runnable. The actual Run button lands in B3-3; this
  // just reflects the config's validity as the researcher edits.
  const readiness = config
    ? buildRunRequest('preview', [...selected], config)
    : ({ ok: false, error: 'Configure a run.' } as const);

  return (
    <div className="flex gap-6">
      <CohortPanel
        participants={participants}
        selected={selected}
        onSelectedChange={setSelected}
      />

      <section className="min-w-0 flex-1 space-y-3">
        <ConfigPanel
          oracleArtifacts={oracleArtifacts}
          metricArtifacts={metricArtifacts}
          promptVariants={promptVariants}
          fewShotSets={fewShotSets}
          onChange={setConfig}
        />

        <div
          className={`border px-4 py-3 text-sm ${
            readiness.ok
              ? 'border-emerald-600/30 bg-emerald-600/5 text-foreground/70'
              : 'border-dashed border-foreground/15 text-foreground/60'
          }`}
        >
          {readiness.ok ? (
            <p>
              Ready to run · {selected.size} participant{selected.size === 1 ? '' : 's'} ·{' '}
              {readiness.req.graderId}
              {readiness.req.simBackend ? ` · ${readiness.req.simBackend}` : ''} ·{' '}
              {config?.llmConfig.model}. Run panel lands in B3-3.
            </p>
          ) : (
            <p>{readiness.error}</p>
          )}
        </div>
      </section>
    </div>
  );
}
