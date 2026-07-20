'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  createCodebook,
  renameCodebook,
  setActiveCodebook,
} from '@/app/actions/codebook';

/** The nav only needs id + name; the layout maps the full rows down to this. */
export type CodebookOption = { id: string; name: string };

/** Sentinel <option> value for the "New codebook…" affordance — never a real
 *  codebook id (ids are UUIDs). */
const NEW_SENTINEL = '__new__';

/**
 * Per-browser codebook switcher, mounted in the nav chrome on every protected
 * page. The ACTIVE codebook is a cookie (`cb-active-codebook`), so switching
 * here re-points the entire app — every page resolves its codebook through
 * `getOrCreateCodebook()`, which follows the cookie.
 *
 * - <select> of the study's codebooks; picking one calls `setActiveCodebook`
 *   then `router.refresh()` so the Server Components re-render against it.
 * - "New codebook…" (editors only) swaps in an inline name form — no browser
 *   prompt() — and `createCodebook` both inserts and sets the cookie.
 * - ✎ (editors only) renames the ACTIVE codebook inline.
 *
 * The select is CONTROLLED by `activeId`, so choosing the sentinel option
 * never sticks: React snaps the select back to the active codebook while the
 * inline form is open. Server Actions run in a transition (controls disable
 * while the refresh round-trips), mirroring the manager panels.
 */
export default function CodebookSwitcher({
  codebooks,
  activeId,
  canEdit,
}: {
  codebooks: CodebookOption[];
  activeId: string | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // At most one inline form is open at a time.
  const [mode, setMode] = useState<'idle' | 'creating' | 'renaming'>('idle');
  const [draft, setDraft] = useState('');

  const active = codebooks.find((c) => c.id === activeId) ?? null;

  if (codebooks.length === 0) return null;

  function run(fn: () => Promise<unknown>) {
    setError(null);
    startTransition(async () => {
      try {
        await fn();
        setMode('idle');
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Mutation failed.');
      }
    });
  }

  function onSelect(value: string) {
    if (value === NEW_SENTINEL) {
      setError(null);
      setDraft('');
      setMode('creating');
      return;
    }
    if (value && value !== activeId) {
      run(() => setActiveCodebook(value));
    }
  }

  function submitDraft() {
    const name = draft.trim();
    if (!name) return;
    if (mode === 'creating') {
      run(() => createCodebook(name));
    } else if (mode === 'renaming' && active) {
      run(() => renameCodebook(active.id, name));
    }
  }

  return (
    <div className="flex flex-col items-end gap-0.5">
      <div className="flex items-center gap-1.5">
        {mode === 'idle' ? (
          <>
            <select
              aria-label="Active codebook"
              value={activeId ?? ''}
              disabled={isPending}
              onChange={(e) => onSelect(e.target.value)}
              className="max-w-48 border border-foreground/20 bg-background px-1.5 py-0.5 text-xs text-foreground/80 disabled:opacity-50"
            >
              {codebooks.map((cb) => (
                <option key={cb.id} value={cb.id}>
                  {cb.name}
                </option>
              ))}
              {canEdit && (
                <>
                  <option disabled>──────</option>
                  <option value={NEW_SENTINEL}>New codebook…</option>
                </>
              )}
            </select>
            {canEdit && active && (
              <button
                type="button"
                aria-label="Rename codebook"
                title="Rename codebook"
                disabled={isPending}
                onClick={() => {
                  setError(null);
                  setDraft(active.name);
                  setMode('renaming');
                }}
                className="text-xs text-foreground/60 transition hover:text-foreground disabled:opacity-50"
              >
                ✎
              </button>
            )}
          </>
        ) : (
          <>
            <input
              type="text"
              autoFocus
              aria-label={mode === 'creating' ? 'New codebook name' : 'Codebook name'}
              placeholder={mode === 'creating' ? 'New codebook name' : 'Codebook name'}
              value={draft}
              disabled={isPending}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitDraft();
                if (e.key === 'Escape') setMode('idle');
              }}
              className="w-44 border border-foreground/20 bg-background px-1.5 py-0.5 text-xs disabled:opacity-50"
            />
            <button
              type="button"
              disabled={isPending || !draft.trim()}
              onClick={submitDraft}
              className="text-xs text-foreground/60 underline underline-offset-2 transition hover:text-foreground disabled:opacity-50"
            >
              {mode === 'creating' ? 'Create' : 'Save'}
            </button>
            <button
              type="button"
              disabled={isPending}
              onClick={() => setMode('idle')}
              className="text-xs text-foreground/60 transition hover:text-foreground disabled:opacity-50"
            >
              Cancel
            </button>
          </>
        )}
      </div>
      {error && <div className="text-xs text-red-600">{error}</div>}
    </div>
  );
}
