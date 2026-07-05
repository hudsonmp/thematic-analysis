'use client';

import { useState } from 'react';
import type { ProgressionParticipant } from '@/app/actions/progression';
import type { EvalArtifact, FewShotSet, PromptVariant } from '@/app/actions/eval';
import CohortPanel from '@/components/playground/CohortPanel';

// ---------------------------------------------------------------------------
// Playground island shell. Holds the participant selection Set (the single
// piece of state this task owns) and renders the cohort multiselect. The
// config + run panels land in B3-2 / B3-3; the initial artifacts, prompt
// variants, and few-shot sets are loaded server-side and threaded here so
// those later tasks have them without a re-fetch. For now they are surfaced as
// counts in the placeholder — genuinely consumed (no unused-prop lint), and a
// truthful "these are loaded and ready" signal.
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

  return (
    <div className="flex gap-6">
      <CohortPanel
        participants={participants}
        selected={selected}
        onSelectedChange={setSelected}
      />

      <section className="min-w-0 flex-1 space-y-3">
        <div className="border border-dashed border-foreground/15 px-4 py-6 text-sm text-foreground/60">
          <p className="font-medium text-foreground/70">Config + run panels land in B3-2 / B3-3.</p>
          <p className="mt-1">
            {selected.size} participant{selected.size === 1 ? '' : 's'} selected ·{' '}
            {oracleArtifacts.length} oracle spec{oracleArtifacts.length === 1 ? '' : 's'} ·{' '}
            {metricArtifacts.length} metric{metricArtifacts.length === 1 ? '' : 's'} ·{' '}
            {promptVariants.length} prompt variant{promptVariants.length === 1 ? '' : 's'} ·{' '}
            {fewShotSets.length} few-shot set{fewShotSets.length === 1 ? '' : 's'} loaded.
          </p>
        </div>
      </section>
    </div>
  );
}
