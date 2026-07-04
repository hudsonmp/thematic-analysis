import { listProgressionParticipants } from '@/app/actions/progression';
import ProgressionViewer from '@/components/progression/ProgressionViewer';

/**
 * Progression analysis (server page). Lists participants WITH study snapshots
 * (participant-first — includes the snapshot-only PIDs that have no cb_session;
 * their cohort renders "—") and hands them to the client viewer, which fetches
 * one participant's 5-phase progression on selection. Read-only over study
 * data via studyFrom; identity is pid-only.
 */
export default async function ProgressionAnalysisPage() {
  const participants = await listProgressionParticipants();

  return (
    <main className="px-6 py-6">
      <header className="mb-4">
        <h1 className="text-lg font-medium tracking-tight">Progression</h1>
        <p className="max-w-2xl text-sm text-foreground/60">
          Each participant&apos;s specification at its five phase boundaries — the
          requirement-only draft, then the revision after each scenario. Entity
          changes vs the prior phase are highlighted; the authored scenario the
          participant saw sits beside their spec.
        </p>
      </header>
      <ProgressionViewer participants={participants} />
    </main>
  );
}
