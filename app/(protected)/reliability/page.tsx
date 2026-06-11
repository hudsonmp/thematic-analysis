/**
 * The §2.9 inter-rater-reliability surface — temporarily a placeholder.
 *
 * The rendered panel (Cohen's κ / Krippendorff's α over applied codings) is
 * being reworked as coding moves into the session view, so the route renders a
 * short "under revision" card instead. The route + its nav link are kept, and
 * NOTHING is deleted: `components/reliability/*` and `app/actions/reliability.ts`
 * remain in the repo (just no longer mounted here), so the panel can be wired
 * back in once the codebook stabilizes.
 */
export default function ReliabilityPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <div className="border border-foreground/15 bg-panel p-8">
        <h1 className="text-lg font-medium tracking-tight">Reliability</h1>
        <p className="mt-3 text-sm leading-relaxed text-foreground/70">
          Under revision — inter-rater reliability (Cohen&apos;s κ /
          Krippendorff&apos;s α from applied codings) is being reworked as coding
          moves into the session view. Check back as the codebook stabilizes.
        </p>
      </div>
    </main>
  );
}
