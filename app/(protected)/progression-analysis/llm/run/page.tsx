import { listProgressionParticipants } from '@/app/actions/progression';
import { listRuns } from '@/app/actions/runs';
import RunReview from '@/components/playground/RunReview';

/**
 * Run-review screen (server page). A dedicated `/llm/run` surface where the
 * participant's specification is reviewed as it EVOLVES across the five phases
 * (mirroring `/progression-analysis`, text-only), with an OPTIONAL run whose
 * verdicts can later be overlaid per (phase × scenario).
 *
 * This page (Task C-2) loads only what the browse + spec-evolution stepper
 * needs: the participant list (A's read-only, pid-only `listProgressionParticipants`)
 * and the run list (`listRuns`, evalFrom-guarded) for the run picker. The run
 * picker holds a selected run id in island state, but the verdict OVERLAY and
 * per-cell ANNOTATE are Task C-3 — when C-3 wires the fold panel it will also
 * load + pass `listPromptVariants()` / `listArtifacts(...)` / `listFewShotSets()`
 * here (they are intentionally omitted now to avoid unused-prop lint).
 *
 * Read-only over study data via progression.ts's studyFrom; identity is
 * pid-only. Server Component: all awaits happen here; the island is a thin
 * `'use client'` boundary.
 */
export default async function LlmRunReviewPage() {
  const [participants, runs] = await Promise.all([listProgressionParticipants(), listRuns()]);

  return (
    <main className="px-6 py-6">
      <header className="mb-4">
        <h1 className="text-lg font-medium tracking-tight">Run Review</h1>
        <p className="max-w-2xl text-sm text-foreground/60">
          Walk a participant&apos;s specification across its five phases beside the
          authored scenario at each — text-only. Optionally pick a run to review a
          run&apos;s grades and annotate per cell.
        </p>
      </header>
      <RunReview participants={participants} runs={runs} />
    </main>
  );
}
