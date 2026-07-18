'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createCode, type CodeOrigin } from '@/app/actions/codes';
import { normalizeSlug } from '@/lib/codebook/mnemonic';
import { fuzzyRank } from '@/lib/transcript/fuzzy';

/** What the popup knows about a code — enough to assign it AND to read it before
 *  assigning (definition/origin expand on click). */
export type PopupCode = {
  id: string;
  mnemonic: string;
  origin: string;
  definition: string | null;
  /** Exemplar texts from the code's current version (jsonb → strings). Shown when
   *  a row is expanded, and searched alongside the slug + definition. */
  exemplars: string[];
};

const POPUP_W = 400;
const POPUP_MAX_H = 480;

/**
 * The selection-spawned coding popup — the replacement for the old fixed middle
 * panel. It appears where the selection ended, over the transcript, and dies on
 * Esc / Done / outside click.
 *
 * The gesture grammar it enforces (each mapped to a different intent):
 *   ↑/↓          move the focus row
 *   ⌘⏎ or ⏎     ASSIGN the focused code to the selection
 *   click a row  EXPAND its metadata (definition, origin) — reading is not assigning;
 *                you often need to reread a definition before you commit to it
 *   [+] on a row ASSIGN by mouse (slower than ⌘⏎, but discoverable)
 *
 * Assigning does NOT close the popup: multiple codes group onto the same selection
 * (one annotation, many codes), so the popup stays until the coder says done. The
 * pending selection stays painted in the transcript (the synthetic pending highlight)
 * precisely because focus moves INTO this popup and the native selection dies.
 *
 * The New-code section carries only the slug + optional definition + origin. NO facet
 * answers on purpose: a code born mid-transcript lands UNCLASSIFIED and surfaces in
 * the codebook's triage queue — classification is a different cognitive mode from
 * capture, and the queue is where it happens (Exploration is optional by construction).
 */
export default function CodingPopup({
  pos,
  quote,
  codes,
  assigned,
  busy,
  error,
  codebookId,
  studyLabel,
  onAssign,
  onUnassign,
  onClose,
  onCodeCreated,
}: {
  pos: { x: number; y: number };
  quote: string;
  codes: PopupCode[];
  /** Codes already on the current selection's annotation — chips with ×. */
  assigned: PopupCode[];
  busy: boolean;
  error: string | null;
  codebookId: string;
  studyLabel: string;
  onAssign: (codeId: string) => void;
  onUnassign: (codeId: string) => void;
  onClose: () => void;
  /** New code persisted → parent refreshes its code list, then we auto-assign. */
  onCodeCreated: (codeId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  const [newSlug, setNewSlug] = useState('');
  const [newDefinition, setNewDefinition] = useState('');
  const [newOrigin, setNewOrigin] = useState<CodeOrigin>('emergent');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  // Light-dismiss via a DOCUMENT listener, not a backdrop div: a full-screen
  // backdrop would swallow the mousedown that starts the coder's NEXT selection,
  // making "select different text while the popup is open" cost an extra dead
  // click. With no backdrop, dragging a new selection in the transcript both
  // dismisses this popup (mousedown outside) and starts the new selection in one
  // gesture — the mouseup then spawns the next popup.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!cardRef.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

  // FIX (copy): opening the popup focuses the search input, which kills the native
  // selection — so ⌘C over the transcript would copy NOTHING while the popup is
  // open. Serve the captured quote instead whenever the copy would otherwise be
  // empty; a real selection elsewhere (e.g. inside the popup's inputs) still wins.
  useEffect(() => {
    const onCopy = (e: ClipboardEvent) => {
      const native = window.getSelection()?.toString() ?? '';
      if (native !== '') return;
      e.preventDefault();
      e.clipboardData?.setData('text/plain', quote);
    };
    document.addEventListener('copy', onCopy);
    return () => document.removeEventListener('copy', onCopy);
  }, [quote]);

  // Assigned codes drop out of the pickable list — offering a no-op row ("already
  // assigned") as a primary action would be a lie; they're visible as chips instead.
  const assignedIds = useMemo(() => new Set(assigned.map((c) => c.id)), [assigned]);
  const ranked = useMemo(
    () =>
      // Search matches the SLUG (mnemonic) + definition + exemplars — the code's
      // meaning, not a display name. Matching exemplars lets a coder find a code by
      // recalling an instance ("the one about reassigning drivers") when the slug
      // doesn't come to mind.
      fuzzyRank(
        query,
        codes,
        (c) => `${c.mnemonic} ${c.definition ?? ''} ${c.exemplars.join(' ')}`,
      )
        .map((m) => m.item)
        .filter((c) => !assignedIds.has(c.id))
        .slice(0, 50),
    [query, codes, assignedIds],
  );
  const safeCursor = Math.min(cursor, Math.max(ranked.length - 1, 0));

  // Focus the search on open — the popup exists to be typed into.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Keep the focused row in view as ↑/↓ move it.
  useEffect(() => {
    listRef.current
      ?.querySelectorAll('[data-row]')
      [safeCursor]?.scrollIntoView({ block: 'nearest' });
  }, [safeCursor]);

  function assignFocused() {
    const code = ranked[safeCursor];
    if (code && !busy) onAssign(code.id);
  }

  function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, ranked.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === 'Enter') {
      // Both ⏎ and ⌘⏎ assign: ⌘⏎ is the documented gesture, bare ⏎ is the muscle
      // memory from every list-picker — punishing it with a dead key helps nobody.
      e.preventDefault();
      assignFocused();
    } else if (e.key === 'Escape') {
      onClose();
    }
  }

  async function createAndAssign() {
    const typed = newSlug.trim();
    if (!typed || creating || busy) return;
    // The typed slug IS the mnemonic (the code's sole identifier). Normalize to the
    // canonical UPPER-KEBAB form and reject a collision against the current snapshot
    // rather than silently mangling it. NO facet answers: the code lands unclassified
    // → the triage queue picks it up. Definition falls back to the slug so
    // cb_code_versions' NOT NULL is satisfied without demanding prose mid-coding.
    const mnemonic = normalizeSlug(typed);
    if (codes.some((c) => c.mnemonic === mnemonic)) {
      setCreateError(`The slug "${mnemonic}" is already in use.`);
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const codeId = await createCode({
        codebookId,
        mnemonic,
        origin: newOrigin,
        version: {
          definition: newDefinition.trim() || mnemonic,
          include_if: [],
          exclude_if: [],
          exemplars: [],
        },
        studyLabel,
      });
      setNewSlug('');
      setNewDefinition('');
      setShowNew(false);
      onCodeCreated(codeId);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : 'Failed to create the code.');
    } finally {
      setCreating(false);
    }
  }

  // Clamp to the viewport so a selection near an edge never spawns an off-screen
  // popup (the old comment popover's trick, kept).
  const left = Math.min(pos.x, (typeof window !== 'undefined' ? window.innerWidth : 9999) - POPUP_W - 16);
  const top = Math.min(pos.y + 8, (typeof window !== 'undefined' ? window.innerHeight : 9999) - POPUP_MAX_H - 16);

  return (
    <>
      <div
        ref={cardRef}
        role="dialog"
        aria-label="Assign codes to the selection"
        data-comment-card
        className="fixed z-50 flex flex-col border border-foreground/25 bg-background shadow-2xl"
        style={{ left: Math.max(8, left), top: Math.max(8, top), width: POPUP_W, maxHeight: POPUP_MAX_H }}
        onKeyDown={(e) => {
          // ⌘⏎ assigns from anywhere in the card EXCEPT text fields — those own
          // their Enter semantics (the search input assigns on bare ⏎ already, so
          // handling ⌘⏎ here too would fire assignFocused TWICE from one keystroke:
          // once from the input's handler, once from this bubbled one — and the
          // double-fire lands before `busy` re-renders, creating duplicate anchors).
          const tag = (e.target as HTMLElement).tagName;
          if (tag !== 'INPUT' && tag !== 'TEXTAREA' && (e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            assignFocused();
          }
          if (e.key === 'Escape') onClose();
        }}
      >
        <div className="border-b border-foreground/15 px-3 py-2">
          <div className="flex items-baseline justify-between gap-2">
            <p className="min-w-0 flex-1 truncate text-xs italic text-foreground/50">
              &ldquo;{quote}&rdquo;
            </p>
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 text-xs text-foreground/50 underline-offset-2 hover:text-foreground hover:underline"
            >
              done
            </button>
          </div>

          {/* Codes already grouped on this selection. The × removes ONE code; the
              annotation survives until its last code goes. */}
          {assigned.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {assigned.map((c) => (
                <span
                  key={c.id}
                  className="inline-flex items-center gap-1 border border-emerald-600/40 bg-emerald-500/10 px-1.5 py-0.5 text-[11px]"
                >
                  <span className="font-mono">{c.mnemonic}</span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onUnassign(c.id)}
                    aria-label={`Remove ${c.mnemonic} from this selection`}
                    className="text-foreground/40 hover:text-red-600"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={onSearchKeyDown}
            placeholder="Search codes… (↑/↓ · ⌘⏎ assign)"
            aria-label="Search codes"
            className="mt-1.5 w-full border border-foreground/20 bg-background px-2 py-1 text-sm focus:border-foreground focus:outline-none"
          />
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1">
          {ranked.length === 0 && (
            <p className="px-3 py-2 text-xs italic text-foreground/40">
              No code matches — create one below.
            </p>
          )}
          {ranked.map((c, i) => {
            const focused = i === safeCursor;
            const expanded = expandedId === c.id;
            return (
              <div key={c.id} data-row>
                <div
                  className={`flex items-center gap-2 px-3 py-1 ${
                    focused ? 'bg-foreground/[0.06]' : ''
                  }`}
                >
                  {/* Clicking the ROW reads; it does not assign. Reading a definition
                      is how you decide NOT to use a code, and a picker where looking
                      costs a commit teaches people to stop looking. */}
                  <button
                    type="button"
                    onClick={() => setExpandedId(expanded ? null : c.id)}
                    className="min-w-0 flex-1 text-left"
                  >
                    {/* Collapsed = the SLUG only (the code's identity). Click to
                        expand definition + exemplars before committing. */}
                    <span className="font-mono text-sm">{c.mnemonic}</span>
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onAssign(c.id)}
                    aria-label={`Assign ${c.mnemonic}`}
                    title="Assign to the selection (⌘⏎ assigns the focused row)"
                    className="shrink-0 border border-foreground/25 px-1.5 text-xs leading-5 text-foreground/60 transition hover:border-foreground hover:text-foreground disabled:opacity-40"
                  >
                    +
                  </button>
                </div>
                {expanded && (
                  <div className="mx-3 mb-1 border-l-2 border-foreground/15 py-0.5 pl-2 text-xs text-foreground/60">
                    <p>{c.definition ?? <em>No definition yet.</em>}</p>
                    {c.exemplars.length > 0 && (
                      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-foreground/55">
                        {c.exemplars.map((ex, i) => (
                          <li key={i} className="italic">
                            “{ex}”
                          </li>
                        ))}
                      </ul>
                    )}
                    <p className="mt-0.5 text-[11px] uppercase tracking-wide text-foreground/35">
                      {c.origin.replace('_', ' ')}
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="border-t border-foreground/15 px-3 py-2">
          {!showNew ? (
            <button
              type="button"
              onClick={() => setShowNew(true)}
              className="w-full border border-dashed border-foreground/30 px-2 py-1 text-xs text-foreground/60 transition hover:border-foreground hover:text-foreground"
            >
              + New code (lands in the triage queue)
            </button>
          ) : (
            <div className="space-y-1.5">
              <input
                autoFocus
                value={newSlug}
                onChange={(e) => setNewSlug(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void createAndAssign();
                  }
                  if (e.key === 'Escape') setShowNew(false);
                }}
                placeholder="Slug (the code's identifier · UPPER-KEBAB)"
                className="w-full border border-foreground/20 bg-background px-2 py-1 font-mono text-sm focus:border-foreground focus:outline-none"
              />
              <textarea
                value={newDefinition}
                onChange={(e) => setNewDefinition(e.target.value)}
                rows={2}
                placeholder="Definition (optional — defaults to the name)"
                className="w-full border border-foreground/20 bg-background px-2 py-1 text-xs focus:border-foreground focus:outline-none"
              />
              <div className="flex items-center gap-2">
                <select
                  value={newOrigin}
                  onChange={(e) => setNewOrigin(e.target.value as CodeOrigin)}
                  aria-label="Origin"
                  className="border border-foreground/20 bg-background px-1.5 py-1 text-xs focus:border-foreground focus:outline-none"
                >
                  <option value="emergent">emergent</option>
                  <option value="pilot">pilot</option>
                  <option value="a_priori">a priori</option>
                </select>
                <span className="min-w-0 flex-1 truncate text-[11px] text-foreground/40">
                  No classification here — it surfaces in the triage queue.
                </span>
                <button
                  type="button"
                  disabled={creating || busy || !newSlug.trim()}
                  onClick={() => void createAndAssign()}
                  className="shrink-0 border border-foreground bg-foreground px-2 py-1 text-xs text-background transition hover:opacity-90 disabled:opacity-40"
                >
                  {creating ? 'Creating…' : 'Create + assign'}
                </button>
              </div>
              {createError && <p className="text-xs text-red-600">{createError}</p>}
            </div>
          )}
          {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
        </div>
      </div>
    </>
  );
}
