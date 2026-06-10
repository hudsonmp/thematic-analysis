'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { linkCitation, unlinkCitation, type CitationRole } from '@/app/actions/citations';
import type { Tables } from '@/lib/types/cb-db';

type Citation = Tables<'cb_citations'>;

const ROLES: readonly CitationRole[] = ['derived_from', 'near_miss'];

/**
 * Links/unlinks the codebook's citations to THIS code with a role
 * (derived_from | near_miss). The linked set comes from the server
 * (`linkedCitationIds`); we hold it locally for snappy toggles and roll back on
 * error. Re-selecting a role on an already-linked citation re-calls
 * linkCitation (the action upserts on the PK, so it just updates the role).
 */
export default function CitationLinker({
  codeId,
  citations,
  linkedCitationIds,
}: {
  codeId: string;
  citations: Citation[];
  linkedCitationIds: string[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [linked, setLinked] = useState<Set<string>>(new Set(linkedCitationIds));
  // Per-citation chosen role (defaults to derived_from). Local only — the link
  // row stores the role server-side; this drives the next link call.
  const [roles, setRoles] = useState<Record<string, CitationRole>>({});

  function roleFor(id: string): CitationRole {
    return roles[id] ?? 'derived_from';
  }

  function run(fn: () => Promise<unknown>, optimistic: () => void, rollback: () => void) {
    setError(null);
    optimistic();
    startTransition(async () => {
      try {
        await fn();
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Citation link failed.');
        rollback();
      }
    });
  }

  function link(id: string) {
    const role = roleFor(id);
    run(
      () => linkCitation(codeId, id, role),
      () => setLinked((s) => new Set(s).add(id)),
      () => setLinked(new Set(linkedCitationIds)),
    );
  }
  function unlink(id: string) {
    run(
      () => unlinkCitation(codeId, id),
      () =>
        setLinked((s) => {
          const n = new Set(s);
          n.delete(id);
          return n;
        }),
      () => setLinked(new Set(linkedCitationIds)),
    );
  }
  function changeRole(id: string, role: CitationRole) {
    setRoles((r) => ({ ...r, [id]: role }));
    // If already linked, persist the role change immediately.
    if (linked.has(id)) {
      run(() => linkCitation(codeId, id, role), () => {}, () => {});
    }
  }

  if (citations.length === 0) {
    return (
      <p className="text-sm text-foreground/50">
        No citations in this codebook yet — paste BibTeX on the Citations page to add some.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {error && <p className="text-sm text-red-600">{error}</p>}
      <ul className="divide-y divide-foreground/10 border border-foreground/15">
        {citations.map((c) => {
          const isLinked = linked.has(c.id);
          return (
            <li key={c.id} className="flex items-center gap-2 px-3 py-2 flex-wrap">
              <div className="flex-1 min-w-48">
                <p className="text-sm">
                  <span className="font-mono text-foreground/60">{c.bibtex_key}</span>
                  {c.title ? ` — ${c.title}` : ''}
                </p>
                {(c.authors || c.year) && (
                  <p className="text-xs text-foreground/40">
                    {[c.authors, c.year].filter(Boolean).join(' · ')}
                  </p>
                )}
              </div>
              <select
                value={roleFor(c.id)}
                disabled={isPending}
                onChange={(e) => changeRole(c.id, e.target.value as CitationRole)}
                className="border border-foreground/15 px-1.5 py-0.5 text-xs bg-background"
                aria-label={`Role for ${c.bibtex_key}`}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              {isLinked ? (
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => unlink(c.id)}
                  className="border border-foreground/30 px-2 py-0.5 text-xs text-red-600 hover:bg-red-600 hover:text-background transition disabled:opacity-50"
                >
                  Unlink
                </button>
              ) : (
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => link(c.id)}
                  className="border border-foreground/30 px-2 py-0.5 text-xs hover:bg-foreground hover:text-background transition disabled:opacity-50"
                >
                  Link
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
