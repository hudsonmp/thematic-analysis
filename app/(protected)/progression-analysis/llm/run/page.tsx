import { listProgressionParticipants } from '@/app/actions/progression';
import { listRuns } from '@/app/actions/runs';
import { listPromptVariants } from '@/app/actions/eval';
import RunReview from '@/components/playground/RunReview';

/**
 * Run-review screen (server page). A dedicated `/llm/run` surface where the
 * participant's specification is reviewed as it EVOLVES across the five phases
 * (mirroring `/progression-analysis`, text-only), with an OPTIONAL run whose
 * verdicts are overlaid per (phase × scenario) and annotated per cell.
 *
 * Loads what the browse + spec-evolution stepper + fold loop need: the
 * participant list (A's read-only, pid-only `listProgressionParticipants`), the
 * run list (`listRuns`, evalFrom-guarded) for the run picker, and the prompt
 * VARIANT lineage (`listPromptVariants`) — the fold panel (mounted in RunReview,
 * Task C-3) folds per-cell annotations into a NEW child variant, so it needs the
 * lineage as the fold base. `listArtifacts`/`listFewShotSets` are NOT loaded:
 * AnnotatePanel's only server prop is `variants` (it re-pulls the unfolded list
 * itself), so those would be unused here.
 *
 * Read-only over study data via progression.ts's studyFrom; identity is
 * pid-only. Server Component: all awaits happen here; the island is a thin
 * `'use client'` boundary.
 */
export default async function LlmRunReviewPage() {
  const [participants, runs, promptVariants] = await Promise.all([
    listProgressionParticipants(),
    listRuns(),
    listPromptVariants(),
  ]);

  return (
    <main className="px-6 py-6">
      <header className="mb-4">
        <h1 className="text-lg font-medium tracking-tight">Run Review</h1>
        <p className="max-w-2xl text-sm text-foreground/60">
          Walk a participant&apos;s specification across its five phases beside the
          authored scenario at each — text-only. Optionally pick a run to overlay
          its grades and annotate per cell; fold the notes into a new prompt
          variant below.
        </p>
      </header>
      <RunReview participants={participants} runs={runs} promptVariants={promptVariants} />
    </main>
  );
}
