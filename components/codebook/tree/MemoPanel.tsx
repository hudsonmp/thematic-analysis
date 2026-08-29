'use client';

import { useRef, useState } from 'react';
import {
  createCodebookMemo,
  deleteCodebookMemo,
  listCodebookMemos,
  setCodebookMemoResolved,
  type CodebookMemo,
} from '@/app/actions/codebook-memos';

/**
 * The codebook's memo list — "codes I know I'm missing" (see codebook-memos.ts
 * for why these are neither stub codes nor annotations). Rendered inside the
 * canvas's right panel, third sibling of the inspector and the triage queue.
 *
 * Data flow: the PARENT fetches the initial list in its toggle click (this
 * repo bans setState-in-effect, so mount-time fetching is the opener's job);
 * every mutation here refetches and lifts the fresh list via `onChanged`, so
 * reopening the panel later shows current rows without a second initial load.
 */
export default function MemoPanel({
  codebookId,
  memos,
  onChanged,
}: {
  codebookId: string;
  /** null while the parent's initial fetch is in flight. */
  memos: CodebookMemo[] | null;
  onChanged: (next: CodebookMemo[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  const refetch = async () => onChanged(await listCodebookMemos(codebookId));

  const add = async () => {
    const body = bodyRef.current?.value.trim() ?? '';
    if (body === '') return;
    setBusy(true);
    setError(null);
    try {
      await createCodebookMemo(codebookId, body);
      if (bodyRef.current) bodyRef.current.value = '';
      await refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save the memo.');
    } finally {
      setBusy(false);
    }
  };

  const setResolved = async (id: string, resolved: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await setCodebookMemoResolved(id, resolved);
      await refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update the memo.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await deleteCodebookMemo(id);
      await refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete the memo.');
    } finally {
      setBusy(false);
    }
  };

  const open = (memos ?? []).filter((m) => m.resolved_at === null);
  const resolved = (memos ?? []).filter((m) => m.resolved_at !== null);

  return (
    <div className="space-y-4 text-sm">
      <div>
        <textarea
          ref={bodyRef}
          rows={2}
          placeholder="e.g. epistemic vigilance — Sperber et al.; saw it in P07's pushback"
          aria-label="New memo"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              void add();
            }
          }}
          className="w-full border border-foreground/20 bg-background px-2 py-1 text-xs focus:border-foreground focus:outline-none"
        />
        <div className="mt-1 flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void add()}
            className="border border-foreground px-2 py-0.5 text-xs transition hover:bg-foreground hover:text-background disabled:opacity-40"
          >
            Add memo
          </button>
          <span className="text-[10px] text-foreground/40">⌘⏎ saves</span>
        </div>
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}
      {memos === null && <p className="text-xs italic text-foreground/40">Loading…</p>}

      {open.length > 0 && (
        <ul className="space-y-2">
          {open.map((m) => (
            <li key={m.id} className="border-l-2 border-amber-500/60 pl-2">
              <p className="whitespace-pre-wrap text-xs leading-relaxed">{m.body}</p>
              <div className="mt-0.5 flex items-center gap-2 text-[10px] text-foreground/40">
                {new Date(m.created_at).toLocaleDateString()}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void setResolved(m.id, true)}
                  className="underline-offset-2 hover:text-foreground hover:underline disabled:opacity-40"
                >
                  resolve
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void remove(m.id)}
                  className="hover:text-red-600 disabled:opacity-40"
                >
                  delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {memos !== null && open.length === 0 && (
        <p className="text-xs italic text-foreground/40">No open memos.</p>
      )}

      {resolved.length > 0 && (
        <details>
          <summary className="cursor-pointer text-[11px] uppercase tracking-wide text-foreground/40">
            Resolved ({resolved.length})
          </summary>
          <ul className="mt-2 space-y-2">
            {resolved.map((m) => (
              <li key={m.id} className="border-l-2 border-foreground/15 pl-2 opacity-60">
                <p className="whitespace-pre-wrap text-xs leading-relaxed line-through decoration-foreground/30">
                  {m.body}
                </p>
                <div className="mt-0.5 flex items-center gap-2 text-[10px] text-foreground/40">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void setResolved(m.id, false)}
                    className="underline-offset-2 hover:text-foreground hover:underline disabled:opacity-40"
                  >
                    reopen
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void remove(m.id)}
                    className="hover:text-red-600 disabled:opacity-40"
                  >
                    delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
