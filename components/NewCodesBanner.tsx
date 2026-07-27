'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { markCodesSeen, type NewCode } from '@/app/actions/code-news';

/**
 * The new-code banner: codes a CO-CODER minted since this coder last
 * acknowledged the list. Rendered by the protected layout on every page, so
 * the news reaches whichever surface the coder opens next; "Got it" advances
 * the per-user watermark (one write) and refreshes the tree.
 *
 * Emergent codes are the point — during independent coding they are how the
 * instrument drifts apart silently — so chips reuse the player's origin
 * shades (lime = emergent, emerald = a priori).
 */
export default function NewCodesBanner({ codes }: { codes: NewCode[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(false);

  if (codes.length === 0 || hidden) return null;

  const byCreator = new Map<string, NewCode[]>();
  for (const c of codes) {
    const list = byCreator.get(c.creatorName) ?? [];
    list.push(c);
    byCreator.set(c.creatorName, list);
  }

  const dismiss = () => {
    setBusy(true);
    setHidden(true); // optimistic — the banner's job is done for this visit
    markCodesSeen()
      .then(() => router.refresh())
      .catch(() => setBusy(false));
  };

  return (
    <div className="border-b border-sky-600/25 bg-sky-500/[0.07] px-6 py-2 text-sm print:hidden">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-foreground/70">
          New code{codes.length === 1 ? '' : 's'} since you last looked:
        </span>
        {[...byCreator.entries()].map(([creator, list]) => (
          <span key={creator} className="flex flex-wrap items-center gap-1.5">
            {list.map((c) => (
              <span
                key={c.id}
                title={`${c.codebookName} · ${c.origin.replace('_', ' ')} · by ${creator}`}
                className={`border px-1.5 py-0.5 font-mono text-[11px] ${
                  c.origin === 'emergent'
                    ? 'border-lime-600/50 bg-lime-500/20'
                    : 'border-emerald-600/40 bg-emerald-500/10'
                }`}
              >
                {c.mnemonic}
              </span>
            ))}
            <span className="text-xs text-foreground/50">from {creator}</span>
          </span>
        ))}
        <button
          type="button"
          onClick={dismiss}
          disabled={busy}
          className="ml-auto border border-foreground/25 px-2 py-0.5 text-xs transition hover:bg-foreground/5 disabled:opacity-40"
        >
          Got it
        </button>
      </div>
    </div>
  );
}
