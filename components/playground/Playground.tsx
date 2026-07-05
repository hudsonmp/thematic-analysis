'use client';

import { useState } from 'react';
import type { ProgressionParticipant } from '@/app/actions/progression';
import type { EvalArtifact, FewShotSet, PromptVariant } from '@/app/actions/eval';
import type { VerdictRow } from '@/app/actions/runs';
import type { PlaygroundConfig } from '@/lib/eval/playground/config';
import CohortPanel from '@/components/playground/CohortPanel';
import ConfigPanel from '@/components/playground/ConfigPanel';
import RunPanel from '@/components/playground/RunPanel';
import AnnotatePanel, { AnnotateContext } from '@/components/playground/AnnotatePanel';
import AgreementView from '@/components/playground/AgreementView';

// ---------------------------------------------------------------------------
// Playground island shell. Holds the state this island owns: the participant
// selection Set (B3-1), the assembled run config (B3-2, lifted from ConfigPanel),
// the current run (runId + its verdicts, lifted from RunPanel so fold-into-variant
// can read the run under inspection), and — as of B3-4 — the session's PENDING
// annotations plus the prompt-variant LINEAGE.
//
// FOLD LOOP (B3-4, closed in B3-4b): the annotate box lives deep in the grid
// (VerdictGrid → VerdictDetail, files this task does not own). Playground provides
// AnnotateContext so a save surfaces up as an `onSaved` signal WITHOUT editing that
// chain; Playground turns it into a monotonic `annotationRefresh` token threaded to
// AnnotatePanel, which re-pulls the unfolded-annotation list (the newly-saved note
// appears as a checkbox). AnnotatePanel folds the CHECKED, still-unfolded rows into a
// new child variant; on success Playground prepends it to `variants` (state, seeded
// from the server prop) and threads THAT state to ConfigPanel — so the folded variant
// is immediately selectable for the next run.
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
  // Variant lineage lifted to state so a fold can add a selectable variant.
  const [variants, setVariants] = useState<PromptVariant[]>(promptVariants);
  // Monotonic token: bumped on every note-save so AnnotatePanel re-pulls the
  // unfolded-annotation list (the fold panel's checkbox source).
  const [annotationRefresh, setAnnotationRefresh] = useState(0);

  function onRunLoaded(runId: string, rows: VerdictRow[]) {
    setCurrentRunId(runId);
    setVerdicts(rows);
  }

  function onSaved() {
    setAnnotationRefresh((n) => n + 1);
  }

  function onFolded(variant: PromptVariant) {
    setVariants((prev) => [variant, ...prev]);
  }

  return (
    <AnnotateContext.Provider value={{ onSaved }}>
      <div className="flex gap-6">
        <CohortPanel
          participants={participants}
          selected={selected}
          onSelectedChange={setSelected}
        />

        <section className="min-w-0 flex-1 space-y-4">
          {/* ConfigPanel (and its VariantEditor) snapshot the variant list into
              local state at mount. A fold prepends a variant to `variants`; keying
              ConfigPanel on the lineage size remounts it with the fresh list so the
              folded variant is immediately selectable for the next run — the only
              way to refresh those un-owned children without editing them. */}
          <ConfigPanel
            key={`cfg-${variants.length}`}
            oracleArtifacts={oracleArtifacts}
            metricArtifacts={metricArtifacts}
            promptVariants={variants}
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

          <AnnotatePanel
            refreshToken={annotationRefresh}
            variants={variants}
            onFolded={onFolded}
          />

          {/* AgreementView (B3-5) is self-contained: it loads its own run list on
              mount and compares any two runs, independent of this island's
              selection/config/current-run state. It is the empirical fork-resolver
              (B spec §3) — κ + the disagreement browser — and presents the split
              cells without adjudicating which grader is right. */}
          <AgreementView />
        </section>
      </div>
    </AnnotateContext.Provider>
  );
}
