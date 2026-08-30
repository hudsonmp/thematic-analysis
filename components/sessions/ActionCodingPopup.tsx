'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ActionEntry, ActionMove, ActionObject, ActionSchema } from '@/app/actions/action-schema';
import { mintMove, mintObject, promoteToAction } from '@/app/actions/action-coding';
import {
  answerRows,
  compositionLabel,
  findExactAction,
  groupActive,
  groupObjects,
  keepParentSelection,
  requiredObjectCount,
  toggleObjectSelection,
  triggerLabel,
  validateActionDraft,
  validateComposition,
  type ActionCodingView,
  type AnswerDraft,
  type ManualComposition,
  type ObjectGroup,
  type ObjectRoles,
} from '@/lib/actions/schema';
import {
  EMPTY_FILTERS,
  answerKey,
  hasActiveFilters,
  highlightRuns,
  rankActions,
  structuralSummary,
  type ActionSearchFilters,
  type ActionUsage,
} from '@/lib/actions/search';
import { fuzzyScore } from '@/lib/transcript/fuzzy';
import ObjectRolesPicker from '@/components/actions/ObjectRolesPicker';

/** One chip already on the selection's anchor (a coding row + its detail). */
export type AssignedCoding = { id: string; mnemonic: string; actionCoding?: ActionCodingView };

const POPUP_W = 500;
const MANUAL_W = 560;
const POPUP_MAX_H = 600;
const RESULT_CAP = 50;

/**
 * The last-used facets, remembered across popup remounts for as long as the
 * page session lives (a coder working through one transcript keeps filtering
 * by the same move/objects for a stretch). A reload resets it — by design, the
 * memory is session-scoped, not persisted.
 */
let rememberedFilters: ActionSearchFilters = EMPTY_FILTERS;
let rememberedAdvanced = false;

const CHIP = 'shrink-0 border px-1.5 py-0.5 text-[11px] leading-4 transition focus:outline-none focus-visible:ring-1 focus-visible:ring-foreground';
const chipClass = (on: boolean) =>
  `${CHIP} ${on ? 'border-foreground bg-foreground text-background' : 'border-foreground/20 text-foreground/70 hover:border-foreground/60 hover:text-foreground'}`;

/** Text with the matched chars wrapped in <mark>. */
function Highlighted({ text, indices, className }: { text: string; indices: number[]; className?: string }) {
  return (
    <span className={className}>
      {highlightRuns(text, indices).map((r, i) =>
        r.hit ? (
          <mark key={i} className="bg-yellow-200/70 text-inherit dark:bg-yellow-500/30">
            {r.text}
          </mark>
        ) : (
          <span key={i}>{r.text}</span>
        ),
      )}
    </span>
  );
}
const INPUT = 'border border-foreground/20 bg-background px-2 py-1 text-sm focus:border-foreground focus:outline-none disabled:opacity-60';
const PRIMARY = 'shrink-0 border border-foreground bg-foreground px-2 py-1 text-xs text-background transition hover:opacity-90 disabled:opacity-40';
const GHOST = 'shrink-0 px-1 text-xs text-foreground/50 hover:text-foreground disabled:opacity-40';

/**
 * The selection-spawned popup for the ACTION layer (/coding/action). Same
 * shell and gesture grammar as CodingPopup (↑/↓ · ⏎ assigns · Esc/done/outside
 * click dismiss · pinned Bookmark + Quote rows · leave-to-close after an assign),
 * but the list is the saved ACTIONS (moves × objects), not codebook codes.
 *
 * "Add manually" (lower-right) turns THIS card into the manual composer: two
 * tabs — Action (moves in one column, objects in the other) and Questions (the
 * /actions questions, mandatory ones starred). Either column can also MINT its
 * vocabulary inline ("+ new move" / "+ new object", the latter optionally as a
 * subclass), so a combination the codebook has no word for yet does not send
 * the coder to /actions mid-transcript. Submit:
 *   • an action with the EXACT same moves/objects/answers exists → that action
 *     is applied (no duplicate is ever minted);
 *   • otherwise the coder chooses: code it ad hoc (nothing added to /actions) or
 *     PROMOTE it — the same name/description fields /actions uses appear in the
 *     card, the composition is kept, and the new action is created, attached,
 *     and searchable from then on.
 */
export default function ActionCodingPopup({
  pos,
  quote,
  schema: baseSchema,
  usage = {},
  codebookId,
  assigned,
  busy,
  error,
  onAssign,
  onAssignManual,
  onUnassign,
  onClose,
  onSchemaChanged,
  onBookmark,
  onQuote,
  bookmarked = false,
  onOpenNotes = null,
  onAddSpanNote = null,
}: {
  pos: { x: number; y: number };
  quote: string;
  schema: ActionSchema;
  /** This coder's action usage (count + recency) — ties rank recent/frequent first. */
  usage?: ActionUsage;
  codebookId: string;
  assigned: AssignedCoding[];
  busy: boolean;
  error: string | null;
  /** Apply an EXISTING action (by action id) to the selection. */
  onAssign: (actionId: string) => void;
  /** Apply an ad hoc composition (not promoted) to the selection. */
  onAssignManual: (composition: ManualComposition) => void;
  /** Remove one coding (by coding row id) from the selection's anchor. */
  onUnassign: (codingId: string) => void;
  onClose: () => void;
  /** An action / move / object was created from here → the parent refetches the schema. */
  onSchemaChanged: () => void;
  onBookmark: () => void;
  onQuote: () => void;
  bookmarked?: boolean;
  onOpenNotes?: (() => void) | null;
  onAddSpanNote?: ((body: string) => Promise<void>) | null;
}) {
  // Vocabulary minted from inside this card. The parent refetch (onSchemaChanged)
  // is a round trip the composer must not wait on, so a minted move/object is
  // spliced in locally and pickable at once; entries drop out of the overlay as
  // soon as the refreshed prop carries them.
  const [minted, setMinted] = useState<{ moves: ActionMove[]; objects: ActionObject[] }>({ moves: [], objects: [] });
  const schema = useMemo<ActionSchema>(() => {
    const newMoves = minted.moves.filter((m) => !baseSchema.moves.some((x) => x.id === m.id));
    const newObjects = minted.objects.filter((o) => !baseSchema.objects.some((x) => x.id === o.id));
    if (newMoves.length === 0 && newObjects.length === 0) return baseSchema;
    return { ...baseSchema, moves: [...baseSchema.moves, ...newMoves], objects: [...baseSchema.objects, ...newObjects] };
  }, [baseSchema, minted]);

  const [view, setView] = useState<'search' | 'manual'>('search');
  const [query, setQuery] = useState('');
  const PINNED = 2;
  const [cursor, setCursor] = useState(PINNED);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [expandedChip, setExpandedChip] = useState<string | null>(null);
  const [hasAssigned, setHasAssigned] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [savingNote, setSavingNote] = useState(false);
  const [noteFlash, setNoteFlash] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const noteRef = useRef<HTMLTextAreaElement | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  // Light-dismiss via a DOCUMENT listener (no backdrop) — same reasoning as
  // CodingPopup: a new drag-selection in the transcript both dismisses this
  // card and starts the next selection in one gesture.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!cardRef.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

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

  useEffect(() => {
    if (view === 'search') inputRef.current?.focus();
  }, [view]);

  const vocab = useMemo(() => ({ moves: schema.moves, objects: schema.objects, roles: schema.roles }), [schema]);

  // Facets: move (single) · objects (AND) · advanced: roles (OR), answers (OR).
  // Seeded from the session-scoped memory; every change writes it back.
  const [filters, setFiltersState] = useState<ActionSearchFilters>(rememberedFilters);
  const [advanced, setAdvancedState] = useState(rememberedAdvanced);
  const [objectQuery, setObjectQuery] = useState('');
  const setFilters = (next: ActionSearchFilters) => {
    rememberedFilters = next;
    setFiltersState(next);
    setCursor(PINNED);
  };
  const setAdvanced = (v: boolean) => {
    rememberedAdvanced = v;
    setAdvancedState(v);
  };
  const toggleIn = (xs: string[], id: string) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]);

  // Actions already on this anchor drop out of the pickable list (they are chips).
  const assignedActionIds = useMemo(
    () => new Set(assigned.map((c) => c.actionCoding?.actionId).filter((x): x is string => !!x)),
    [assigned],
  );
  const pickable = useMemo(() => schema.actions.filter((a) => !assignedActionIds.has(a.id)), [schema.actions, assignedActionIds]);
  // Live: filters AND query, ranked exact-name → keyword → usage → position.
  const rankedAll = useMemo(() => rankActions(query, pickable, filters, schema, usage), [query, pickable, filters, schema, usage]);
  const ranked = useMemo(() => rankedAll.slice(0, RESULT_CAP), [rankedAll]);
  const rowCount = ranked.length + PINNED;
  const safeCursor = Math.min(cursor, rowCount - 1);

  // Object facet chips: top-level objects (filtered by the object search box);
  // a parent's subclasses appear nested only when relevant — the parent is
  // selected, or the object search names one of them.
  const objectGroups = useMemo(() => {
    const oq = objectQuery.trim();
    return groupObjects(schema.objects)
      .map((g) => {
        const rootHit = oq === '' || !!fuzzyScore(oq, g.root.name);
        const childHits = g.children.filter((c) => oq !== '' && !!fuzzyScore(oq, c.name));
        const show = rootHit || childHits.length > 0;
        const expanded = filters.objectIds.includes(g.root.id) || childHits.length > 0 || g.children.some((c) => filters.objectIds.includes(c.id));
        return { g, show, children: expanded ? (oq === '' || rootHit ? g.children : childHits) : [] };
      })
      .filter((x) => x.show);
  }, [schema.objects, objectQuery, filters.objectIds]);
  const mcQuestions = useMemo(() => schema.questions.filter((q) => q.kind === 'multiple_choice' && q.options.length > 0), [schema.questions]);
  const advancedCount = filters.roleIds.length + filters.answerKeys.length;

  useEffect(() => {
    listRef.current?.querySelectorAll('[data-row]')[safeCursor]?.scrollIntoView({ block: 'nearest' });
  }, [safeCursor]);

  const assign = (actionId: string) => {
    setHasAssigned(true);
    onAssign(actionId);
  };

  function assignFocused() {
    if (busy) return;
    if (safeCursor === 0) return onBookmark();
    if (safeCursor === 1) return onQuote();
    const r = ranked[safeCursor - PINNED];
    if (r) assign(r.action.id);
  }

  function moveCursor(delta: number) {
    setCursor((c) => Math.max(0, Math.min(c + delta, rowCount - 1)));
  }

  function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveCursor(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveCursor(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      assignFocused();
    } else if (e.key === 'Escape') {
      onClose();
    }
  }

  const saveNote = async () => {
    const body = noteRef.current?.value.trim() ?? '';
    if (body === '' || !onAddSpanNote) return;
    setSavingNote(true);
    setNoteError(null);
    try {
      await onAddSpanNote(body);
      setNoteOpen(false);
      setNoteFlash(true);
    } catch (e) {
      setNoteError(e instanceof Error ? e.message : 'Failed to save.');
    } finally {
      setSavingNote(false);
    }
  };

  const width = view === 'manual' ? MANUAL_W : POPUP_W;
  const left = Math.min(pos.x, (typeof window !== 'undefined' ? window.innerWidth : 9999) - width - 16);
  const top = Math.min(pos.y + 8, (typeof window !== 'undefined' ? window.innerHeight : 9999) - POPUP_MAX_H - 16);

  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-label="Assign actions to the selection"
      data-comment-card
      className="fixed z-50 flex flex-col border border-foreground/25 bg-background shadow-2xl"
      style={{ left: Math.max(8, left), top: Math.max(8, top), width, maxHeight: POPUP_MAX_H }}
      onMouseLeave={() => {
        // Leave-to-close only in the picker, and only once something was
        // assigned — the manual composer is a form; a stray mouse exit must
        // not throw it away.
        if (view === 'search' && hasAssigned && !busy) onClose();
      }}
      onKeyDown={(e) => {
        const tag = (e.target as HTMLElement).tagName;
        const inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
        if (view === 'search' && !inField) {
          // Typing anywhere in the card (e.g. after clicking a facet chip)
          // goes straight to the search box — the char lands there because the
          // browser delivers the keypress/input to the newly focused element.
          if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && e.key !== ' ') {
            inputRef.current?.focus();
            return;
          }
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            moveCursor(e.key === 'ArrowDown' ? 1 : -1);
            return;
          }
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            assignFocused();
          }
        }
        if (e.key === 'Escape') onClose();
      }}
    >
      <div className="border-b border-foreground/15 px-3 py-2">
        <div className="flex items-baseline justify-between gap-2">
          <p className="min-w-0 flex-1 truncate text-xs italic text-foreground/50">&ldquo;{quote}&rdquo;</p>
          {onOpenNotes && (
            <button type="button" onClick={onOpenNotes} title="Open this anchor's margin thread" className={GHOST}>
              🗨 notes
            </button>
          )}
          <button type="button" onClick={onClose} className={GHOST}>
            done
          </button>
        </div>

        {/* Codings already on this anchor. Click a chip label to inspect its
            moves × objects × answers; × removes THAT coding (the bracket stays). */}
        {assigned.length > 0 && (
          <div className="mt-1.5 space-y-1">
            <div className="flex flex-wrap gap-1">
              {assigned.map((c) => (
                <span
                  key={c.id}
                  className="inline-flex items-center gap-1 border border-emerald-600/40 bg-emerald-500/10 px-1.5 py-0.5 text-xs"
                >
                  <button
                    type="button"
                    onClick={() => setExpandedChip((x) => (x === c.id ? null : c.id))}
                    className="font-mono font-medium text-foreground"
                    title={c.actionCoding?.actionId ? 'Reusable action — click to inspect' : 'Ad hoc combination (not promoted) — click to inspect'}
                  >
                    {c.mnemonic}
                    {c.actionCoding && !c.actionCoding.actionId && <span className="ml-1 text-[10px] text-foreground/40">ad hoc</span>}
                  </button>
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
            {expandedChip && (() => {
              const c = assigned.find((x) => x.id === expandedChip);
              const d = c?.actionCoding;
              if (!d) return null;
              return (
                <div className="border-l-2 border-emerald-600/30 pl-2 text-[12px] text-foreground/75">
                  <p>
                    <span className="text-foreground/45">{d.actionId ? 'action' : 'ad hoc'} · </span>
                    {compositionLabel(d, vocab)}
                  </p>
                  <AnswerList answers={d.answers} schema={schema} />
                </div>
              );
            })()}
          </div>
        )}

        {view === 'search' && (
          <>
            <div className="mt-1.5 flex items-center gap-1.5">
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setCursor(PINNED);
                }}
                onKeyDown={onSearchKeyDown}
                placeholder="Search actions… (↑/↓ · ⏎ assign)"
                aria-label="Search actions — matches name, description, move, objects, roles, and answers"
                className={`${INPUT} min-w-0 flex-1`}
              />
              <button
                type="button"
                onClick={() => setAdvanced(!advanced)}
                aria-pressed={advanced}
                aria-label="Toggle advanced filters (role, answer)"
                title="Advanced filters: role · question answer"
                className={chipClass(advanced || advancedCount > 0)}
              >
                Filters{advancedCount > 0 ? ` · ${advancedCount}` : ''}
              </button>
              {(hasActiveFilters(filters) || query !== '') && (
                <button
                  type="button"
                  onClick={() => {
                    setFilters(EMPTY_FILTERS);
                    setQuery('');
                    setObjectQuery('');
                    inputRef.current?.focus();
                  }}
                  className={GHOST}
                  title="Clear search and all filters"
                >
                  clear
                </button>
              )}
            </div>

            {/* Facet strip. Filters are AND across categories; objects AND
                within (every picked object must be present); roles/answers OR
                within. The result list narrows live with every toggle. */}
            {schema.moves.length > 0 && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1" role="radiogroup" aria-label="Filter by move">
                <span className="w-12 shrink-0 text-[10px] uppercase tracking-wider text-foreground/45">move</span>
                <button
                  type="button"
                  role="radio"
                  aria-checked={filters.moveId === null}
                  onClick={() => setFilters({ ...filters, moveId: null })}
                  className={chipClass(filters.moveId === null)}
                >
                  All
                </button>
                {schema.moves.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    role="radio"
                    aria-checked={filters.moveId === m.id}
                    title={m.description ?? undefined}
                    onClick={() => setFilters({ ...filters, moveId: filters.moveId === m.id ? null : m.id })}
                    className={chipClass(filters.moveId === m.id)}
                  >
                    {m.name}
                  </button>
                ))}
              </div>
            )}
            {schema.objects.length > 0 && (
              <div className="mt-1 flex flex-wrap items-center gap-1" role="group" aria-label="Filter by objects (all selected must be present)">
                <span className="w-12 shrink-0 text-[10px] uppercase tracking-wider text-foreground/45">objects</span>
                <input
                  value={objectQuery}
                  onChange={(e) => setObjectQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape' && objectQuery !== '') {
                      e.stopPropagation();
                      setObjectQuery('');
                    }
                  }}
                  placeholder="Search objects…"
                  aria-label="Search objects"
                  className={`${INPUT} w-28 py-0.5 text-[11px]`}
                />
                {objectGroups.map(({ g, children }) => (
                  <span key={g.root.id} className="contents">
                    <button
                      type="button"
                      aria-pressed={filters.objectIds.includes(g.root.id)}
                      title={g.root.description ?? (g.children.length > 0 ? `${g.root.name} or any of its ${g.children.length} subclasses` : undefined)}
                      onClick={() => setFilters({ ...filters, objectIds: toggleIn(filters.objectIds, g.root.id) })}
                      className={chipClass(filters.objectIds.includes(g.root.id))}
                    >
                      {g.root.name}
                      {g.children.length > 0 && <span className="ml-1 opacity-60">▾</span>}
                    </button>
                    {children.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        aria-pressed={filters.objectIds.includes(c.id)}
                        aria-label={`${g.root.name} › ${c.name}`}
                        title={c.description ?? `${g.root.name} › ${c.name}`}
                        onClick={() => setFilters({ ...filters, objectIds: toggleIn(filters.objectIds, c.id) })}
                        className={`${chipClass(filters.objectIds.includes(c.id))} ml-1 border-dashed`}
                      >
                        <span className="opacity-50">›</span> {c.name}
                      </button>
                    ))}
                  </span>
                ))}
                {objectGroups.length === 0 && <span className="text-[11px] italic text-foreground/40">no object matches</span>}
              </div>
            )}
            {advanced && (
              <div className="mt-1 space-y-1 border-t border-dashed border-foreground/15 pt-1">
                {schema.roles.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Filter by role (any selected)">
                    <span className="w-12 shrink-0 text-[10px] uppercase tracking-wider text-foreground/45">role</span>
                    {schema.roles.map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        aria-pressed={filters.roleIds.includes(r.id)}
                        title={r.description ?? undefined}
                        onClick={() => setFilters({ ...filters, roleIds: toggleIn(filters.roleIds, r.id) })}
                        className={chipClass(filters.roleIds.includes(r.id))}
                      >
                        {r.name}
                      </button>
                    ))}
                  </div>
                )}
                {mcQuestions.map((q) => (
                  <div key={q.id} className="flex flex-wrap items-center gap-1" role="group" aria-label={`Filter by answer: ${q.prompt}`}>
                    <span className="w-12 shrink-0 truncate text-[10px] uppercase tracking-wider text-foreground/45" title={q.prompt}>
                      answer
                    </span>
                    <span className="max-w-[40%] truncate text-[11px] text-foreground/55" title={q.prompt}>
                      {q.prompt}
                    </span>
                    {q.options.map((o) => {
                      const k = answerKey(q.id, o.id);
                      return (
                        <button
                          key={o.id}
                          type="button"
                          aria-pressed={filters.answerKeys.includes(k)}
                          onClick={() => setFilters({ ...filters, answerKeys: toggleIn(filters.answerKeys, k) })}
                          className={chipClass(filters.answerKeys.includes(k))}
                        >
                          {o.label}
                        </button>
                      );
                    })}
                  </div>
                ))}
                {schema.roles.length === 0 && mcQuestions.length === 0 && (
                  <p className="text-[11px] italic text-foreground/40">No roles or multiple-choice questions to filter by.</p>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {view === 'search' ? (
        <>
          <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1">
            <div data-row className={`flex items-center ${safeCursor === 0 ? 'bg-foreground/[0.06]' : ''}`}>
              <button
                type="button"
                disabled={busy}
                onClick={onBookmark}
                className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1 text-left disabled:opacity-40"
                title={bookmarked ? 'Remove this bookmark (assigning an action also resolves it)' : 'Mark this selection to come back to later'}
              >
                <span aria-hidden>🔖</span>
                {bookmarked ? (
                  <span className="text-sm text-red-700 dark:text-red-400">Remove bookmark</span>
                ) : (
                  <>
                    <span className="text-sm text-violet-700 dark:text-violet-300">Bookmark</span>
                    <span className="truncate text-[11px] text-foreground/40">come back to this later</span>
                  </>
                )}
              </button>
            </div>
            <div data-row>
              <button
                type="button"
                disabled={busy}
                onClick={onQuote}
                className={`flex w-full items-center gap-2 px-3 py-1 text-left disabled:opacity-40 ${safeCursor === 1 ? 'bg-foreground/[0.06]' : ''}`}
                title="Flag this selection as a quotable excerpt"
              >
                <span aria-hidden>❝</span>
                <span className="text-sm text-yellow-700 dark:text-yellow-300">Quote</span>
                <span className="truncate text-[11px] text-foreground/40">flag a quotable excerpt</span>
              </button>
            </div>
            {schema.actions.length === 0 ? (
              <p className="px-3 py-2 text-xs italic text-foreground/40">
                No saved actions yet — add one manually below.
              </p>
            ) : ranked.length === 0 ? (
              <p className="px-3 py-2 text-xs italic text-foreground/40">
                No action matches{hasActiveFilters(filters) ? ' these filters' : ''} — loosen the filters or add one manually below.
              </p>
            ) : (
              <p className="px-3 pb-0.5 text-[10px] uppercase tracking-wider text-foreground/40">
                {rankedAll.length === pickable.length ? `${pickable.length} actions` : `${rankedAll.length} of ${pickable.length} actions`}
                {rankedAll.length > RESULT_CAP ? ` · showing ${RESULT_CAP}` : ''}
              </p>
            )}
            {ranked.map((r, i) => {
              const a = r.action;
              const focused = i + PINNED === safeCursor;
              const expanded = expandedId === a.id || hoveredId === a.id;
              const used = usage[a.id]?.count ?? 0;
              return (
                <div
                  key={a.id}
                  data-row
                  onMouseEnter={() => setHoveredId(a.id)}
                  onMouseLeave={() => setHoveredId((h) => (h === a.id ? null : h))}
                >
                  <div className={`flex items-start gap-2 px-3 py-1 ${focused ? 'bg-foreground/[0.06]' : ''}`}>
                    {/* Clicking the result CODES the highlight (like picking a legacy code). */}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => assign(a.id)}
                      aria-label={`Assign ${a.name}`}
                      title="Assign to the selection (⏎ assigns the focused row)"
                      className="min-w-0 flex-1 text-left disabled:opacity-40"
                    >
                      <span className="flex items-baseline gap-2">
                        <Highlighted text={a.name} indices={r.nameIndices} className="font-mono text-[14px] font-medium text-foreground" />
                        {used > 0 && (
                          <span className="shrink-0 font-mono text-[10px] text-foreground/35" title={`You have applied this action ${used} time${used === 1 ? '' : 's'}`}>
                            ×{used}
                          </span>
                        )}
                      </span>
                      <span className="block truncate text-[11px] uppercase tracking-wide text-foreground/55">{structuralSummary(a, schema)}</span>
                      {a.description && !expanded && (
                        <Highlighted text={a.description} indices={r.descIndices} className="block truncate text-[12px] text-foreground/60" />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => setExpandedId(expanded ? null : a.id)}
                      aria-label={`${expanded ? 'Hide' : 'Show'} details for ${a.name}`}
                      title="Details (description, answers)"
                      className="mt-0.5 shrink-0 border border-foreground/25 px-1.5 text-xs leading-5 text-foreground/60 transition hover:border-foreground hover:text-foreground"
                    >
                      {expanded ? '–' : 'i'}
                    </button>
                  </div>
                  {expanded && (
                    <div className="mx-3 mb-1 border-l-2 border-foreground/15 py-0.5 pl-2 text-[13px] text-foreground/80">
                      <p>{a.description ? <Highlighted text={a.description} indices={r.descIndices} /> : <em>No description.</em>}</p>
                      <AnswerList answers={a.answers} schema={schema} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="border-t border-foreground/15 px-3 py-2">
            {noteOpen ? (
              <div className="space-y-1.5">
                <textarea
                  autoFocus
                  rows={2}
                  ref={noteRef}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                      e.preventDefault();
                      void saveNote();
                    }
                    if (e.key === 'Escape') setNoteOpen(false);
                  }}
                  placeholder="Note on this span — appears in the margin beside it…"
                  className={`${INPUT} w-full text-xs`}
                />
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[11px] text-foreground/40">Saves to this span (margin comment).</span>
                  <button type="button" onClick={() => setNoteOpen(false)} className={GHOST}>
                    cancel
                  </button>
                  <button type="button" disabled={savingNote} onClick={() => void saveNote()} className={PRIMARY}>
                    {savingNote ? 'Saving…' : 'Save note'}
                  </button>
                </div>
                {noteError && <p className="text-xs text-red-600">{noteError}</p>}
              </div>
            ) : (
              <div className="flex items-center gap-1.5">
                {onAddSpanNote && (
                  <button
                    type="button"
                    onClick={() => {
                      setNoteFlash(false);
                      setNoteOpen(true);
                    }}
                    title="Write a margin note on this span"
                    className="shrink-0 border border-dashed border-yellow-600/50 px-2 py-1 text-xs text-yellow-800/90 transition hover:border-yellow-600 hover:text-yellow-700 dark:text-yellow-400/90"
                  >
                    {noteFlash ? 'note saved ✓' : '✎ note'}
                  </button>
                )}
                <span className="min-w-0 flex-1" />
                {/* Lower-right: turn THIS card into the manual composer. */}
                <button
                  type="button"
                  onClick={() => setView('manual')}
                  className="shrink-0 border border-dashed border-foreground/30 px-2 py-1 text-xs text-foreground/60 transition hover:border-foreground hover:text-foreground"
                  title="Compose moves × objects by hand (and optionally promote it to a reusable action)"
                >
                  Add manually
                </button>
              </div>
            )}
            {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
          </div>
        </>
      ) : (
        <ManualComposer
          schema={schema}
          codebookId={codebookId}
          busy={busy}
          error={error}
          onBack={() => setView('search')}
          onAssignExisting={(actionId) => {
            assign(actionId);
            setView('search');
          }}
          onAssignManual={(c) => {
            setHasAssigned(true);
            onAssignManual(c);
            setView('search');
          }}
          onPromoted={(actionId) => {
            onSchemaChanged();
            assign(actionId);
            setView('search');
          }}
          onMintedMove={(move) => {
            setMinted((m) => ({ ...m, moves: [...m.moves, move] }));
            onSchemaChanged();
          }}
          onMintedObject={(object) => {
            setMinted((m) => ({ ...m, objects: [...m.objects, object] }));
            onSchemaChanged();
          }}
        />
      )}
    </div>
  );
}

/** Answers of an action/coding as a compact list (question → option/text, with triggers). */
function AnswerList({ answers, schema }: { answers: ActionEntry['answers']; schema: ActionSchema }) {
  if (answers.length === 0) return null;
  return (
    <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
      {answers.map((ans) => {
        const q = schema.questions.find((x) => x.id === ans.questionId);
        if (!q) return null;
        const opt = ans.optionId ? q.options.find((o) => o.id === ans.optionId) : null;
        const trig = triggerLabel(opt?.trigger, schema);
        return (
          <div key={ans.questionId} className="contents">
            <dt className="text-foreground/50">{q.prompt}</dt>
            <dd>
              {opt ? opt.label : ans.freeText}
              {trig && <span className="text-foreground/50"> → triggers {trig}</span>}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/**
 * The manual composer: Action tab (moves | objects) + Questions tab, the same
 * vocabulary, rules, and fields as /actions' ActionForm. On submit it resolves an
 * exact existing action, else asks to promote; promoting reveals the /actions
 * name/description fields and creates the action (server-side dedup again).
 */
function ManualComposer({
  schema,
  codebookId,
  busy,
  error,
  onBack,
  onAssignExisting,
  onAssignManual,
  onPromoted,
  onMintedMove,
  onMintedObject,
}: {
  schema: ActionSchema;
  codebookId: string;
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onAssignExisting: (actionId: string) => void;
  onAssignManual: (c: ManualComposition) => void;
  onPromoted: (actionId: string) => void;
  /** A move was created (or resolved to an existing one) from the move column. */
  onMintedMove: (move: ActionMove) => void;
  /** Same for the object column — including subclasses. */
  onMintedObject: (object: ActionObject) => void;
}) {
  const [tab, setTab] = useState<'action' | 'questions'>('action');
  const [moveIds, setMoveIds] = useState<string[]>([]);
  const [objectIds, setObjectIds] = useState<string[]>([]);
  // Optional role per picked object (migration 50). Entries for objects that
  // were later unpicked are ignored by the key/validation, so no cleanup needed.
  const [objectRoles, setObjectRoles] = useState<ObjectRoles>({});
  const [answers, setAnswers] = useState<Record<string, AnswerDraft>>({});
  const [touched, setTouched] = useState(false);
  // After a valid submit with NO exact match: ask promote / don't.
  const [askPromote, setAskPromote] = useState(false);
  // Promote chosen: the /actions name + description fields appear.
  const [promoting, setPromoting] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  // Inline vocabulary minting: which column's form is open, and its draft.
  const [minting, setMinting] = useState<'move' | 'object' | null>(null);
  const [mintName, setMintName] = useState('');
  const [mintParentId, setMintParentId] = useState('');
  const [mintBusy, setMintBusy] = useState(false);

  const moveLites = schema.moves.map((m) => ({ id: m.id, name: m.name, minObjects: m.minObjects }));
  const qLites = schema.questions.map((q) => ({
    id: q.id,
    prompt: q.prompt,
    kind: q.kind,
    required: q.required,
    options: q.options.map((o) => ({ id: o.id, label: o.label })),
  }));
  const composition: ManualComposition = { moveIds, objectIds, objectRoles, answers };
  const problems = validateComposition(composition, moveLites, qLites, schema.roles);
  const need = requiredObjectCount(moveLites, moveIds);
  const requiredCount = schema.questions.filter((q) => q.required).length;
  const missingRequired = problems.filter((p) => p.endsWith('is required.')).length;
  const exact = useMemo(
    () => findExactAction(schema.actions, { moveIds, objectIds, objectRoles, answers: answerRows(answers, qLites) }, qLites),
    // qLites is derived from schema each render; the key inputs are below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [schema, moveIds, objectIds, objectRoles, answers],
  );

  // Any change to the composition withdraws a pending promote question — the
  // answer was about the OLD combination.
  function edit<T>(set: (v: T) => void, v: T) {
    setAskPromote(false);
    set(v);
  }

  function submit() {
    setTouched(true);
    setLocalError(null);
    if (problems.length > 0) {
      // Jump to the tab that holds the first problem.
      setTab(problems[0].endsWith('is required.') ? 'questions' : 'action');
      return;
    }
    if (exact) {
      onAssignExisting(exact.id);
      return;
    }
    setAskPromote(true);
  }

  async function promote() {
    const draft = { name, description, moveIds, objectIds, objectRoles, answers };
    const ps = validateActionDraft(draft, moveLites, qLites, schema.roles);
    if (ps.length > 0) {
      setLocalError(ps.join(' '));
      return;
    }
    setSaving(true);
    setLocalError(null);
    try {
      const { actionId } = await promoteToAction(codebookId, draft);
      onPromoted(actionId);
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : 'Failed to create the action.');
    } finally {
      setSaving(false);
    }
  }

  function openMint(kind: 'move' | 'object') {
    setLocalError(null);
    setMintName('');
    setMintParentId('');
    setMinting(kind);
  }

  /**
   * Create the move/object and select it in the same gesture. A name the
   * codebook already has resolves to THAT entry rather than a second one, so
   * the id that lands in the composition is always the canonical row.
   */
  async function mint() {
    const name = mintName.trim();
    const kind = minting;
    if (name === '' || mintBusy || kind === null) return;
    setMintBusy(true);
    setLocalError(null);
    try {
      if (kind === 'move') {
        const { move } = await mintMove(codebookId, { name });
        onMintedMove(move);
        edit(setMoveIds, [move.id]);
      } else {
        const parentId = mintParentId || null;
        const { object } = await mintObject(codebookId, { name, parentId });
        onMintedObject(object);
        // A fresh subclass REFINES its parent (same rule as toggleObjectSelection):
        // the parent leaves the selection, sibling subclasses stay.
        setAskPromote(false);
        setObjectIds((ids) =>
          ids.includes(object.id) ? ids : [...ids.filter((x) => x !== parentId), object.id],
        );
      }
      setMinting(null);
      setMintName('');
      setMintParentId('');
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : 'Could not add it.');
    } finally {
      setMintBusy(false);
    }
  }

  /** The inline "+ new …" form shared by both columns. */
  const mintForm = (kind: 'move' | 'object') => {
    if (minting !== kind) {
      return (
        <button
          type="button"
          disabled={busy || saving}
          onClick={() => openMint(kind)}
          className="mt-1 w-full border border-dashed border-foreground/30 px-2 py-1 text-left text-xs text-foreground/55 transition hover:border-foreground hover:text-foreground disabled:opacity-40"
        >
          + new {kind}
        </button>
      );
    }
    const roots = groupObjects(schema.objects).map((g) => g.root);
    return (
      <div className="mt-1 space-y-1 border border-dashed border-foreground/30 p-1.5">
        <input
          autoFocus
          value={mintName}
          disabled={mintBusy}
          onChange={(e) => setMintName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void mint();
            }
            if (e.key === 'Escape') {
              e.stopPropagation();
              setMinting(null);
            }
          }}
          placeholder={kind === 'move' ? 'Localize' : 'Goal'}
          aria-label={`New ${kind} name`}
          className={`${INPUT} w-full py-0.5 text-xs`}
        />
        {kind === 'object' && roots.length > 0 && (
          <select
            value={mintParentId}
            disabled={mintBusy}
            onChange={(e) => setMintParentId(e.target.value)}
            aria-label="Parent object (leave empty for a top-level object)"
            className={`${INPUT} w-full py-0.5 text-xs`}
          >
            <option value="">— top-level object —</option>
            {roots.map((o) => (
              <option key={o.id} value={o.id}>
                subclass of {o.name}
              </option>
            ))}
          </select>
        )}
        <div className="flex items-center gap-1">
          <span className="flex-1" />
          <button type="button" disabled={mintBusy} onClick={() => setMinting(null)} className={GHOST}>
            cancel
          </button>
          <button type="button" disabled={mintBusy || mintName.trim() === ''} onClick={() => void mint()} className={PRIMARY}>
            {mintBusy ? 'Adding…' : 'Add'}
          </button>
        </div>
      </div>
    );
  };

  const chipClass = (on: boolean) =>
    `flex cursor-pointer items-center gap-1.5 border px-2 py-1 text-sm ${on ? 'border-foreground bg-foreground/5' : 'border-foreground/15'}`;

  // One object group = one row. A parent with subclasses, once picked, reveals
  // a refinement strip: keep the parent as-is, or narrow to one or more of its
  // subclasses (the parent id is swapped out for the subclass ids).
  const objectRow = (g: ObjectGroup<ActionObject>) => {
    const active = groupActive(objectIds, g);
    const refined = g.children.some((c) => objectIds.includes(c.id));
    return (
      <div key={g.root.id} className="flex flex-col gap-1">
        <label className={chipClass(active)} title={g.root.description ?? undefined}>
          <input
            type="checkbox"
            checked={active}
            disabled={busy || saving}
            onChange={() => edit(setObjectIds, toggleObjectSelection(objectIds, g, g.root.id))}
            className="sr-only"
          />
          <span className="flex-1">{g.root.name}</span>
          {g.children.length > 0 && (
            <span className="font-mono text-[10px] text-foreground/45" title={`${g.children.length} subclass${g.children.length === 1 ? '' : 'es'}`}>
              {g.children.length} sub
            </span>
          )}
        </label>
        {active && g.children.length > 0 && (
          <div className="ml-3 flex flex-col gap-1 border-l border-dashed border-foreground/25 pl-2" role="group" aria-label={`${g.root.name} subclasses`}>
            <label className={`${chipClass(!refined)} text-xs`} title={`Code the selection as ${g.root.name} without a subclass`}>
              <input
                type="checkbox"
                checked={!refined}
                disabled={busy || saving || !refined}
                onChange={() => edit(setObjectIds, keepParentSelection(objectIds, g))}
                className="sr-only"
              />
              <span className="text-foreground/60">keep</span> {g.root.name}
            </label>
            {g.children.map((c) => (
              <label key={c.id} className={`${chipClass(objectIds.includes(c.id))} text-xs`} title={c.description ?? undefined}>
                <input
                  type="checkbox"
                  checked={objectIds.includes(c.id)}
                  disabled={busy || saving}
                  onChange={() => edit(setObjectIds, toggleObjectSelection(objectIds, g, c.id))}
                  className="sr-only"
                />
                <span className="text-foreground/40">›</span>
                {c.name}
              </label>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <div className="flex items-center gap-1 border-b border-foreground/15 px-3 pt-2 text-xs">
        {(
          [
            ['action', `Action · ${moveIds.length === 1 ? '1 move' : 'no move'} × ${objectIds.length} object${objectIds.length === 1 ? '' : 's'}`],
            ['questions', `Questions${requiredCount > 0 ? ` · ${requiredCount - missingRequired}/${requiredCount} required` : ''}`],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={`-mb-px border-b-2 px-2 py-1 ${tab === k ? 'border-foreground text-foreground' : 'border-transparent text-foreground/50 hover:text-foreground'}`}
          >
            {label}
          </button>
        ))}
        <span className="flex-1" />
        <button type="button" onClick={onBack} className={GHOST}>
          ← back to search
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {tab === 'action' ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <fieldset className="border border-foreground/15 p-2">
              <legend className="px-1 text-[11px] uppercase tracking-wider text-foreground/50">
                move <span className="normal-case tracking-normal text-foreground/40">· pick one; two moves at once = two actions</span>
              </legend>
              {schema.moves.length === 0 && <p className="text-xs text-foreground/45">No moves yet.</p>}
              <div className="flex flex-col gap-1" role="radiogroup" aria-label="Move">
                {schema.moves.map((m) => (
                  <label
                    key={m.id}
                    className={`flex cursor-pointer items-center gap-1.5 border px-2 py-1 text-sm ${moveIds.includes(m.id) ? 'border-foreground bg-foreground/5' : 'border-foreground/15'}`}
                    title={m.description ?? undefined}
                  >
                    <input
                      type="radio"
                      name="action-coding-move"
                      checked={moveIds.includes(m.id)}
                      disabled={busy || saving}
                      onChange={() => edit(setMoveIds, [m.id])}
                      className="sr-only"
                    />
                    {m.name}
                    {m.minObjects > 1 && <span className="font-mono text-[10px] text-foreground/45">≥{m.minObjects}</span>}
                  </label>
                ))}
              </div>
              {mintForm('move')}
            </fieldset>
            <fieldset className="border border-foreground/15 p-2">
              <legend className="px-1 text-[11px] uppercase tracking-wider text-foreground/50">
                objects <span className="normal-case tracking-normal text-foreground/40">· need ≥ {need}, {objectIds.length} picked</span>
              </legend>
              {schema.objects.length === 0 && <p className="text-xs text-foreground/45">No objects yet.</p>}
              <div className="flex flex-col gap-1">{groupObjects(schema.objects).map(objectRow)}</div>
              {mintForm('object')}
            </fieldset>
            <div className="sm:col-span-2">
              <ObjectRolesPicker
                objectIds={objectIds}
                objects={schema.objects}
                roles={schema.roles}
                value={objectRoles}
                onChange={(next) => edit(setObjectRoles, next)}
                disabled={busy || saving}
              />
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {schema.questions.length === 0 && <p className="text-xs text-foreground/45">No questions defined on /actions.</p>}
            {schema.questions.map((q) => {
              const a = answers[q.id];
              const chosen = q.kind === 'multiple_choice' && a?.optionId ? q.options.find((o) => o.id === a.optionId) : null;
              const followUp = chosen?.followUpQuestionId ? schema.questions.find((x) => x.id === chosen.followUpQuestionId) : null;
              const trig = triggerLabel(chosen?.trigger, schema);
              const missing = touched && q.required && problems.some((p) => p === `“${q.prompt}” is required.`);
              return (
                <div key={q.id}>
                  <label className="block text-sm">
                    {q.prompt}
                    {q.required ? (
                      <span className="ml-1 text-[10px] uppercase tracking-wide text-red-600" title="mandatory">
                        * required
                      </span>
                    ) : (
                      <span className="ml-1 text-[10px] uppercase tracking-wide text-foreground/35">optional</span>
                    )}
                    {q.description && <span className="block text-xs text-foreground/50">{q.description}</span>}
                    {q.kind === 'multiple_choice' ? (
                      <select
                        value={a?.optionId ?? ''}
                        disabled={busy || saving}
                        onChange={(e) => edit(setAnswers, { ...answers, [q.id]: { optionId: e.target.value || null } })}
                        className={`${INPUT} mt-1 block ${missing ? 'border-red-500' : ''}`}
                      >
                        <option value="">— unanswered —</option>
                        {q.options.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        value={a?.text ?? ''}
                        disabled={busy || saving}
                        onChange={(e) => edit(setAnswers, { ...answers, [q.id]: { text: e.target.value } })}
                        className={`${INPUT} mt-1 block w-full ${missing ? 'border-red-500' : ''}`}
                      />
                    )}
                  </label>
                  {(trig || followUp) && (
                    <p className="mt-0.5 text-xs text-foreground/50">
                      {trig && (
                        <>
                          → triggers <span className="text-foreground/80">{trig}</span>
                        </>
                      )}
                      {trig && followUp && ' · '}
                      {followUp && (
                        <>
                          follow-up: <span className="text-foreground/80">{followUp.prompt}</span>
                        </>
                      )}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {promoting && (
          <div className="mt-3 space-y-2 border-t border-dashed border-foreground/20 pt-3">
            <p className="text-[11px] uppercase tracking-wider text-foreground/50">New reusable action</p>
            <p className="text-xs text-foreground/60">{compositionLabel(composition, schema)}</p>
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-[11px] text-foreground/50">name</span>
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Create entity"
                  disabled={saving}
                  className={`${INPUT} w-48`}
                  aria-label="Action name"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void promote();
                    }
                  }}
                />
              </label>
              <label className="flex flex-1 flex-col gap-1">
                <span className="text-[11px] text-foreground/50">description (optional)</span>
                <input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="When the participant…"
                  disabled={saving}
                  className={`${INPUT} w-full`}
                  aria-label="Action description"
                />
              </label>
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-foreground/15 px-3 py-2">
        {touched && problems.length > 0 && (
          <ul className="mb-1 text-xs text-red-700">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        {askPromote && !promoting ? (
          <div className="space-y-1.5">
            <p className="text-xs text-foreground/70">
              No saved action has exactly this combination (<span className="text-foreground/90">{compositionLabel(composition, schema)}</span>). Promote it to a reusable action?
            </p>
            <div className="flex items-center gap-2">
              <span className="flex-1" />
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setAskPromote(false);
                  onAssignManual(composition);
                }}
                className="shrink-0 border border-foreground/30 px-2 py-1 text-xs text-foreground/80 transition hover:border-foreground hover:text-foreground disabled:opacity-40"
                title="Code this span with the combination as-is; nothing is added to /actions"
              >
                Don&apos;t promote — code as ad hoc
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setAskPromote(false);
                  setPromoting(true);
                }}
                className={PRIMARY}
                title="Create a reusable action from this combination (appears on /actions)"
              >
                Promote to Action
              </button>
            </div>
          </div>
        ) : promoting ? (
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[11px] text-foreground/40">Creates the action on /actions and attaches it here.</span>
            <button type="button" disabled={saving} onClick={() => setPromoting(false)} className={GHOST}>
              cancel
            </button>
            <button type="button" disabled={saving || busy || !name.trim()} onClick={() => void promote()} className={PRIMARY}>
              {saving ? 'Creating…' : 'Create + assign'}
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[11px] text-foreground/40">
              {exact ? (
                <>
                  Matches saved action <span className="font-mono text-foreground/70">{exact.name}</span> — submit applies it.
                </>
              ) : !touched && problems.length > 0 ? (
                problems[0]
              ) : (
                'Exact matches reuse the saved action; otherwise you choose whether to promote.'
              )}
            </span>
            <button type="button" disabled={busy} onClick={submit} className={PRIMARY}>
              {exact ? `Apply ${exact.name}` : 'Submit'}
            </button>
          </div>
        )}
        {(localError || error) && <p className="mt-1 text-xs text-red-600">{localError ?? error}</p>}
      </div>
    </>
  );
}
