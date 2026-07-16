'use client';

import { useState } from 'react';
import Link from 'next/link';

type Familiarization = {
  sessionId: string;
  position: number;
  pidLabel: string;
  collection: string;
};

/** One tour step: what it is, why it exists, where to try it. */
type Step = {
  title: string;
  body: string;
  href: string;
  linkLabel: string;
};

const STEPS: Step[] = [
  {
    title: 'Comments & highlights',
    body:
      'The default mode. Select transcript text and just start typing — a margin comment opens seeded with your first keystroke (⏎ saves). A highlight cannot be saved without a comment: a highlight that says nothing is nothing. Yellow spans are commented excerpts; click one to open its thread.',
    href: '/sessions',
    linkLabel: 'Open a session',
  },
  {
    title: 'Codes & brackets',
    body:
      'Switch to Code mode, select text, and the coding popup opens: search (↑/↓), ⌘⏎ or + assigns, clicking a row shows the code’s definition first. Coded spans render as a bracket + chip block in the right margin — never as a text highlight (that grammar belongs to comments). One bracket can carry many codes; × removes a code (the bracket stays), ✎ re-selects what it covers.',
    href: '/sessions',
    linkLabel: 'Try coding',
  },
  {
    title: 'New codes go to the triage queue',
    body:
      'Creating a code mid-transcript asks only for a name (and optional definition). Classification happens later in the codebook’s Triage queue — capture and classification are different mental modes, and the queue is where you load the scheme once and apply it to everything you captured.',
    href: '/codebook',
    linkLabel: 'Open the triage queue',
  },
  {
    title: 'The code tree (facets & values)',
    body:
      'The codebook is organized by DIMENSIONS (facets): each is a question askable of every code, its values are the answers, and values nest. A code can answer two values on one dimension — that’s a cross-cut, not a duplicate. Drag codes onto values, ⌘D duplicates a value, ⌘⌫ (twice) deletes.',
    href: '/codebook',
    linkLabel: 'Open the tree',
  },
  {
    title: 'The codebook as a document (PDF)',
    body:
      'A readable, nested listing of every code with full metadata — the fastest way to learn the instrument before coding. Export PDF prints it (the app chrome strips automatically).',
    href: '/codebook/view',
    linkLabel: 'Read the codebook',
  },
  {
    title: 'Flags on the timeline',
    body:
      'Live-observation flags mark moments on the video timeline and in the flag list. They deliberately do NOT tint the transcript text — the transcript reads continuously; time-anchored events live on the time bar.',
    href: '/sessions',
    linkLabel: 'See the timeline',
  },
  {
    title: 'Specification mode',
    body:
      'The Specification tab replays the participant’s spec exactly as it evolved, synced to the video playhead — scrub the video and watch the spec change. This is the product stream beside the transcript’s process stream.',
    href: '/sessions',
    linkLabel: 'Open spec mode',
  },
  {
    title: 'LLM chat replay',
    body:
      'The participant’s conversation with the help assistant, aligned to the same clock as the transcript and flags — so you can see what they asked, when, and what they did next.',
    href: '/sessions',
    linkLabel: 'View a chat',
  },
  {
    title: 'Speakers & progress',
    body:
      'Speaker names render bold at each turn. On the sessions index, set YOUR per-session status (Not started → In progress → Individual coding); Reconciliation is session-wide and overrides everyone’s. The shared comment field coordinates the team.',
    href: '/sessions',
    linkLabel: 'Sessions index',
  },
  {
    title: 'Compare (after independent coding)',
    body:
      'Once you and a colleague have both coded a session, Compare overlays your codings pairwise — green where you both applied a code, amber where only one of you did — and the Canonical lane records the reconciled decision. Don’t open it before your independent pass is done.',
    href: '/sessions',
    linkLabel: 'Sessions index',
  },
];

/**
 * The card-walk tour. Progress is local state only — re-reading the guide is free
 * and nothing here is a gate. The final step is the admin-curated familiarization
 * list: the sessions to WATCH (not code) first, because coding an interaction you
 * have never seen end-to-end produces anchor-hunting, not analysis.
 */
export default function GuideTour({
  familiarization,
}: {
  familiarization: Familiarization[];
}) {
  const [step, setStep] = useState(0);
  const total = STEPS.length + 1; // + the familiarization finale
  const atEnd = step >= STEPS.length;
  const current = STEPS[Math.min(step, STEPS.length - 1)];

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <header className="mb-6">
        <h1 className="text-lg font-medium tracking-tight">Coder&rsquo;s guide</h1>
        <p className="text-sm text-foreground/60">
          {step + 1} / {total}
        </p>
        <div className="mt-2 h-1 w-full bg-foreground/10">
          <div
            className="h-1 bg-foreground transition-all"
            style={{ width: `${((step + 1) / total) * 100}%` }}
          />
        </div>
      </header>

      {!atEnd ? (
        <section className="rounded border border-foreground/15 p-5">
          <h2 className="text-base font-semibold tracking-tight">{current.title}</h2>
          <p className="mt-2 text-sm leading-relaxed text-foreground/75">{current.body}</p>
          <Link
            href={current.href}
            className="mt-3 inline-block text-sm underline underline-offset-2 hover:text-foreground"
          >
            {current.linkLabel} →
          </Link>
        </section>
      ) : (
        <section className="rounded border border-emerald-600/30 bg-emerald-500/5 p-5">
          <h2 className="text-base font-semibold tracking-tight">
            Before you code: watch these sessions
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-foreground/75">
            Data familiarization comes before analysis: watch these end-to-end —
            comment freely, code nothing yet. The list is curated by the study admin.
          </p>
          {familiarization.length === 0 ? (
            <p className="mt-3 text-sm italic text-foreground/50">
              No familiarization sessions have been assigned yet — check with the
              admin.
            </p>
          ) : (
            <ol className="mt-3 space-y-1.5">
              {familiarization.map((f, i) => (
                <li key={f.sessionId}>
                  <Link
                    href={`/sessions/${f.sessionId}`}
                    className="flex items-center gap-2 rounded border border-foreground/15 px-3 py-2 text-sm transition hover:border-foreground/40"
                  >
                    <span className="text-xs text-foreground/40">{i + 1}.</span>
                    <span className="font-mono text-xs">{f.pidLabel}</span>
                    <span className="text-xs text-foreground/40">{f.collection}</span>
                    <span className="ml-auto text-xs text-foreground/50">watch →</span>
                  </Link>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}

      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setStep((s) => Math.max(s - 1, 0))}
          disabled={step === 0}
          className="rounded border border-foreground/25 px-3 py-1.5 text-sm transition hover:border-foreground disabled:opacity-40"
        >
          ← Back
        </button>
        {!atEnd ? (
          <button
            type="button"
            onClick={() => setStep((s) => s + 1)}
            className="rounded border border-foreground bg-foreground px-3 py-1.5 text-sm text-background transition hover:opacity-90"
          >
            Next →
          </button>
        ) : (
          <Link
            href="/sessions"
            className="rounded border border-foreground bg-foreground px-3 py-1.5 text-sm text-background transition hover:opacity-90"
          >
            Start watching →
          </Link>
        )}
        <span className="ml-auto text-xs text-foreground/40">
          Revisit any time — Guide, in the Recording menu.
        </span>
      </div>
    </main>
  );
}
