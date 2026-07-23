'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createCode, type CodeOrigin } from '@/app/actions/codes';
import { createCodebookMemo } from '@/app/actions/codebook-memos';
import { splitDefinition } from '@/lib/codebook/definition';
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
  /** The disconfirming pattern — the near-miss this code is NOT. Shown in the
   *  expanded row (it's the highest-leverage field for coder agreement) but
   *  deliberately EXCLUDED from search: matching a code by text it explicitly
   *  does not cover would rank exactly the wrong codes. */
  counterExample: string | null;
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
  onBookmark,
  bookmarked = false,
  onOpenNotes = null,
  onAddSpanNote = null,
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
  /** Pin a BOOKMARK on the selection — "come back to this later". One-shot:
   *  creates the anchor and closes the popup. When `bookmarked`, the same row
   *  REMOVES the existing bookmark instead (the parent flips the callback). */
  onBookmark: () => void;
  /** True when the popup was reopened ON an existing bookmark annotation — the
   *  bookmark's "later" is now: row 0 becomes Remove, and any assign resolves
   *  the bookmark into a coded span (server-side kind promotion). */
  bookmarked?: boolean;
  /** Present when the popup sits on an EXISTING anchor: hands off to that
   *  anchor's margin thread (the popup closes). This is how a bookmark takes a
   *  note — "why I flagged this" — without re-growing a composer in here. */
  onOpenNotes?: (() => void) | null;
  /** Present on an EXISTING anchor: persist a margin note ON THIS SPAN without
   *  leaving the popup (it appears beside the span like any comment). This is
   *  what people MEAN when they "add a memo to a bookmark" — the codebook-level
   *  ✎ memo deliberately does something else (a missing-code lead), so both
   *  exist side by side with distinct labels. */
  onAddSpanNote?: ((body: string) => Promise<void>) | null;
}) {
  const [query, setQuery] = useState('');
  // Row 0 is the pinned Bookmark option; codes occupy 1..N. The cursor STARTS on
  // the top code (1) so the type-query-then-Enter muscle memory still assigns —
  // Bookmark is one ArrowUp away, never the accidental default.
  const [cursor, setCursor] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  const [newSlug, setNewSlug] = useState('');
  const [newDefinition, setNewDefinition] = useState('');
  const [newOrigin, setNewOrigin] = useState<CodeOrigin>('emergent');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Footer composers: 'note' = a margin comment ON THIS SPAN (existing anchors
  // only); 'memo' = a codebook-level missing-code lead. One shared uncontrolled
  // textarea — same caret-safety reasoning as the comment composer.
  const [composerKind, setComposerKind] = useState<'memo' | 'note' | null>(null);
  const [savingMemo, setSavingMemo] = useState(false);
  const [savedFlash, setSavedFlash] = useState<'memo' | 'note' | null>(null);
  const [memoError, setMemoError] = useState<string | null>(null);
  const memoRef = useRef<HTMLTextAreaElement | null>(null);

  const saveComposer = async () => {
    const kind = composerKind;
    const body = memoRef.current?.value.trim() ?? '';
    if (body === '' || kind === null) return;
    setSavingMemo(true);
    setMemoError(null);
    try {
      if (kind === 'note' && onAddSpanNote) {
        await onAddSpanNote(body);
      } else {
        await createCodebookMemo(codebookId, body);
      }
      setComposerKind(null);
      // A memo save is otherwise invisible from here (memos live with the
      // codebook); a note save shows in the margin but the eye is HERE. Flash
      // the button label either way so the save is never in doubt.
      setSavedFlash(kind);
    } catch (e) {
      setMemoError(e instanceof Error ? e.message : 'Failed to save.');
    } finally {
      setSavingMemo(false);
    }
  };

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
      // doesn't come to mind. Only the APPLIED side of a 'Literature == Applied'
      // definition is searched: mid-coding you reach for the operational rule, and
      // a hit inside the literature blurb would rank codes by provenance prose the
      // popup doesn't even show.
      fuzzyRank(
        query,
        codes,
        (c) =>
          `${c.mnemonic} ${splitDefinition(c.definition).applied} ${c.exemplars.join(' ')}`,
      )
        .map((m) => m.item)
        .filter((c) => !assignedIds.has(c.id))
        .slice(0, 50),
    [query, codes, assignedIds],
  );
  // Row space: 0 = the pinned Bookmark option, 1..N = the ranked codes. With no
  // codes at all the clamp lands on 0, so Enter bookmarks — the only action left.
  const rowCount = ranked.length + 1;
  const safeCursor = Math.min(cursor, rowCount - 1);

  // Focus the search on open — the popup exists to be typed into.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Keep the focused row in view as ↑/↓ move it. The Bookmark row carries
  // data-row too, so [data-row] indexes line up with the cursor space.
  useEffect(() => {
    listRef.current
      ?.querySelectorAll('[data-row]')
      [safeCursor]?.scrollIntoView({ block: 'nearest' });
  }, [safeCursor]);

  function assignFocused() {
    if (busy) return;
    if (safeCursor === 0) {
      onBookmark();
      return;
    }
    const code = ranked[safeCursor - 1];
    if (code) onAssign(code.id);
  }

  function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, rowCount - 1));
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
    // The typed slug IS the mnemonic (the code's sole identifier). Normalize it to a
    // safe identifier form and reject a collision rather than silently mangling it.
    // NO facet answers: the code lands unclassified → the triage queue picks it up.
    // Definition falls back to the slug so cb_code_versions' NOT NULL is satisfied
    // without demanding prose mid-coding. The SELECTED TEXT is captured as the code's
    // first exemplar — a code born from a span is defined, in part, by that span.
    const mnemonic = normalizeSlug(typed);
    if (codes.some((c) => c.mnemonic === mnemonic)) {
      setCreateError(`The slug "${mnemonic}" is already in use.`);
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const seedExemplar = quote.trim();
      const codeId = await createCode({
        codebookId,
        mnemonic,
        origin: newOrigin,
        version: {
          definition: newDefinition.trim() || mnemonic,
          include_if: [],
          exclude_if: [],
          exemplars: seedExemplar ? [{ text: seedExemplar }] : [],
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
            {onOpenNotes && (
              <button
                type="button"
                onClick={onOpenNotes}
                title="Open this anchor's margin thread to add a note"
                className="shrink-0 text-xs text-foreground/50 underline-offset-2 hover:text-foreground hover:underline"
              >
                🗨 notes
              </button>
            )}
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
                  className="inline-flex items-center gap-1 border border-emerald-600/40 bg-emerald-500/10 px-1.5 py-0.5 text-xs"
                >
                  <span className="font-mono font-medium text-foreground">{c.mnemonic}</span>
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
              // Back to the TOP CODE (row 1), not the Bookmark row — typing a
              // query means hunting a code; Enter must assign the best match.
              setCursor(1);
            }}
            onKeyDown={onSearchKeyDown}
            placeholder="Search codes… (↑/↓ · ⌘⏎ assign)"
            aria-label="Search codes"
            className="mt-1.5 w-full border border-foreground/20 bg-background px-2 py-1 text-sm focus:border-foreground focus:outline-none"
          />
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1">
          {/* Pinned row 0: BOOKMARK — "come back to this later". One-shot: click
              (or ↑ to it + Enter) drops a bookmark anchor on the selection and
              closes the popup. Deliberately NOT the default cursor position.
              ✎ memo rides at the row's right edge: bookmark and memo are the two
              DEFER gestures (span-level / codebook-level), so they live together
              at the top rather than memo hiding in the footer. */}
          <div data-row className={`flex items-center ${safeCursor === 0 ? 'bg-foreground/[0.06]' : ''}`}>
            <button
              type="button"
              disabled={busy}
              onClick={onBookmark}
              className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1 text-left disabled:opacity-40"
              title={
                bookmarked
                  ? 'Remove this bookmark (assigning a code below also resolves it)'
                  : 'Mark this selection to come back to later'
              }
            >
              <span aria-hidden>🔖</span>
              {bookmarked ? (
                <>
                  <span className="text-sm text-red-700 dark:text-red-400">
                    Remove bookmark
                  </span>
                  <span className="truncate text-[11px] text-foreground/40">
                    or assign a code to resolve it
                  </span>
                </>
              ) : (
                <>
                  <span className="text-sm text-violet-700 dark:text-violet-300">Bookmark</span>
                  <span className="truncate text-[11px] text-foreground/40">
                    come back to this later
                  </span>
                </>
              )}
            </button>
            <button
              type="button"
              onClick={() => {
                setSavedFlash(null);
                setComposerKind((k) => (k === 'memo' ? null : 'memo'));
              }}
              title="Note a code you know is missing — codebook-level, not tied to this span"
              className="mr-2 shrink-0 border border-dashed border-amber-600/40 px-2 py-0.5 text-xs text-amber-800/80 transition hover:border-amber-600 hover:text-amber-700 dark:text-amber-400/80"
            >
              {savedFlash === 'memo' ? 'memo saved ✓' : '✎ memo'}
            </button>
          </div>
          {composerKind === 'memo' && (
            <div className="space-y-1.5 border-b border-foreground/10 px-3 py-2">
              <textarea
                autoFocus
                rows={2}
                ref={memoRef}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault();
                    void saveComposer();
                  }
                  if (e.key === 'Escape') setComposerKind(null);
                }}
                placeholder="Missing-code lead — e.g. epistemic vigilance (Sperber)…"
                className="w-full border border-foreground/20 bg-background px-2 py-1 text-xs focus:border-foreground focus:outline-none"
              />
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[11px] text-foreground/40">
                  Codebook-level — Memos box here + canvas panel.
                </span>
                <button
                  type="button"
                  onClick={() => setComposerKind(null)}
                  className="shrink-0 px-1 text-xs text-foreground/50 hover:text-foreground"
                >
                  cancel
                </button>
                <button
                  type="button"
                  disabled={savingMemo}
                  onClick={() => void saveComposer()}
                  className="shrink-0 border border-foreground bg-foreground px-2 py-1 text-xs text-background transition hover:opacity-90 disabled:opacity-40"
                >
                  {savingMemo ? 'Saving…' : 'Save memo'}
                </button>
              </div>
              {memoError && <p className="text-xs text-red-600">{memoError}</p>}
            </div>
          )}
          {ranked.length === 0 && (
            <p className="px-3 py-2 text-xs italic text-foreground/40">
              No code matches — create one below.
            </p>
          )}
          {ranked.map((c, i) => {
            const focused = i + 1 === safeCursor;
            // Details reveal on HOVER as well as click: hovering is transient
            // (leave → collapse), a click PINS the expansion open. Both show the
            // same block — slug alone is recognition-hostile for terse slugs, so
            // the meaning must be one glance away, not one commit away.
            const expanded = expandedId === c.id || hoveredId === c.id;
            return (
              <div
                key={c.id}
                data-row
                onMouseEnter={() => setHoveredId(c.id)}
                onMouseLeave={() => setHoveredId((h) => (h === c.id ? null : h))}
              >
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
                    <span className="font-mono text-[15px] font-medium text-foreground">{c.mnemonic}</span>
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
                  <div className="mx-3 mb-1 border-l-2 border-foreground/15 py-0.5 pl-2 text-[13px] text-foreground/80">
                    {/* APPLIED definition only. The literature half of a
                        'Literature == Applied' definition is provenance, and the
                        popup is a coding surface — the codebook views show both. */}
                    <p>{splitDefinition(c.definition).applied || <em>No definition yet.</em>}</p>
                    {c.exemplars.length > 0 && (
                      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-foreground/70">
                        {c.exemplars.map((ex, i) => (
                          <li key={i} className="italic">
                            “{ex}”
                          </li>
                        ))}
                      </ul>
                    )}
                    {c.counterExample && (
                      <p className="mt-1 text-foreground/70">
                        <span className="text-[11px] uppercase tracking-wide text-red-700/60 dark:text-red-400/60">
                          not:{' '}
                        </span>
                        {c.counterExample}
                      </p>
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
          {!showNew && composerKind !== 'note' ? (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setShowNew(true)}
                className="min-w-0 flex-1 border border-dashed border-foreground/30 px-2 py-1 text-xs text-foreground/60 transition hover:border-foreground hover:text-foreground"
              >
                + New code (lands in the triage queue)
              </button>
              {/* A NOTE lives on this span (margin comment) — gold like the
                  marginalia it writes to. (✎ memo, the codebook-level defer,
                  lives up beside Bookmark — the other defer gesture.) */}
              {onAddSpanNote && (
                <button
                  type="button"
                  onClick={() => {
                    setSavedFlash(null);
                    setComposerKind('note');
                  }}
                  title="Write a margin note on this span (shows beside it, like any comment)"
                  className="shrink-0 border border-dashed border-yellow-600/50 px-2 py-1 text-xs text-yellow-800/90 transition hover:border-yellow-600 hover:text-yellow-700 dark:text-yellow-400/90"
                >
                  {savedFlash === 'note' ? 'note saved ✓' : '✎ note'}
                </button>
              )}
            </div>
          ) : composerKind === 'note' ? (
            <div className="space-y-1.5">
              <textarea
                autoFocus
                rows={2}
                ref={memoRef}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault();
                    void saveComposer();
                  }
                  if (e.key === 'Escape') setComposerKind(null);
                }}
                placeholder="Note on this span — appears in the margin beside it…"
                className="w-full border border-foreground/20 bg-background px-2 py-1 text-xs focus:border-foreground focus:outline-none"
              />
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[11px] text-foreground/40">
                  Saves to this span (margin comment).
                </span>
                <button
                  type="button"
                  onClick={() => setComposerKind(null)}
                  className="shrink-0 px-1 text-xs text-foreground/50 hover:text-foreground"
                >
                  cancel
                </button>
                <button
                  type="button"
                  disabled={savingMemo}
                  onClick={() => void saveComposer()}
                  className="shrink-0 border border-foreground bg-foreground px-2 py-1 text-xs text-background transition hover:opacity-90 disabled:opacity-40"
                >
                  {savingMemo ? 'Saving…' : 'Save note'}
                </button>
              </div>
              {memoError && <p className="text-xs text-red-600">{memoError}</p>}
            </div>
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
                placeholder="Slug — the code's identifier (e.g. reassign-driver)"
                className="w-full border border-foreground/20 bg-background px-2 py-1 font-mono text-sm focus:border-foreground focus:outline-none"
              />
              <textarea
                value={newDefinition}
                onChange={(e) => setNewDefinition(e.target.value)}
                rows={2}
                placeholder="Definition (optional — defaults to the slug)"
                className="w-full border border-foreground/20 bg-background px-2 py-1 text-xs focus:border-foreground focus:outline-none"
              />
              {quote.trim() !== '' && (
                <div className="border-l-2 border-amber-400 pl-2 text-[11px] text-foreground/50">
                  <span className="text-foreground/40">Exemplar (from selection): </span>
                  <span className="italic">
                    “{quote.trim().length > 120 ? quote.trim().slice(0, 120) + '…' : quote.trim()}”
                  </span>
                </div>
              )}
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
