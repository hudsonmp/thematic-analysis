import { listProgressionParticipants } from '@/app/actions/progression';
import { listArtifacts, listFewShotSets, listPromptVariants } from '@/app/actions/eval';
import Playground from '@/components/playground/Playground';

/**
 * LLM Eval playground (server page). Loads the participant list (reuse A's
 * read-only, pid-only `listProgressionParticipants`) plus the initial eval
 * artifacts / prompt variants / few-shot sets (B1 actions, evalFrom-guarded)
 * and hands them to the client island. B3 adds NO new server actions and NO new
 * DB access — every mutation/run routes through the shipped B1/B2-4 actions
 * from the island's handlers. Server Component: all awaits happen here; the
 * island is a thin `'use client'` boundary.
 */
export default async function LlmEvalPage() {
  const [participants, oracleArtifacts, metricArtifacts, promptVariants, fewShotSets] =
    await Promise.all([
      listProgressionParticipants(),
      listArtifacts('oracle_spec'),
      listArtifacts('metric'),
      listPromptVariants(),
      listFewShotSets(),
    ]);

  return (
    <main className="px-6 py-6">
      <header className="mb-4">
        <h1 className="text-lg font-medium tracking-tight">LLM Eval</h1>
        <p className="max-w-2xl text-sm text-foreground/60">
          Select the participants to grade, then configure a run — grader,
          model, prompt variant, and the oracle-spec / metric artifacts it
          references. Runs produce a verdict grid with per-phase improvement
          deltas; disagreements between graders surface for you to adjudicate.
        </p>
      </header>
      <Playground
        participants={participants}
        oracleArtifacts={oracleArtifacts}
        metricArtifacts={metricArtifacts}
        promptVariants={promptVariants}
        fewShotSets={fewShotSets}
      />
    </main>
  );
}
