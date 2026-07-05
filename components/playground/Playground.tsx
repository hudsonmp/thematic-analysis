'use client';

import { useState } from 'react';
import type { ProgressionParticipant } from '@/app/actions/progression';
import type { EvalArtifact, FewShotSet, PromptVariant } from '@/app/actions/eval';
import type { VerdictRow } from '@/app/actions/runs';
import type { PlaygroundConfig } from '@/lib/eval/playground/config';
import CohortPanel from '@/components/playground/CohortPanel';
import ConfigPanel from '@/components/playground/ConfigPanel';
import RunPanel from '@/components/playground/RunPanel';

// ---------------------------------------------------------------------------
// Playground island shell. Holds the state this island owns: the participant
// selection Set (B3-1), the assembled run config (B3-2, lifted from ConfigPanel),
// and — as of B3-3 — the current run (runId + its verdicts, lifted from RunPanel
// so a later fold-into-variant task can read the run under inspection). The
// initial artifacts / prompt variants / few-shot sets are loaded server-side and
// threaded to ConfigPanel's editors (edited in place — each editor saves a new
// version/variant/set via a B1 action). RunPanel gates its Run button on
// buildRunRequest(name, selection, config) and renders the verdict grid.
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
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [verdicts, setVerdicts] = useState<VerdictRow[] | null>(null);

  function onRunLoaded(runId: string, rows: VerdictRow[]) {
    setCurrentRunId(runId);
    setVerdicts(rows);
  }

  return (
    <div className="flex gap-6">
      <CohortPanel
        participants={participants}
        selected={selected}
        onSelectedChange={setSelected}
      />

      <section className="min-w-0 flex-1 space-y-4">
        <ConfigPanel
          oracleArtifacts={oracleArtifacts}
          metricArtifacts={metricArtifacts}
          promptVariants={promptVariants}
          fewShotSets={fewShotSets}
          onChange={setConfig}
        />

        <RunPanel
          participants={participants}
          selected={selected}
          config={config}
          currentRunId={currentRunId}
          verdicts={verdicts}
          onRunLoaded={onRunLoaded}
        />
      </section>
    </div>
  );
}
