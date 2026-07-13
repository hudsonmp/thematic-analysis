'use client';

import { useState, useSyncExternalStore, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { addCodeFacetValue } from '@/app/actions/codes';
import { createFacetValue } from '@/app/actions/facets';
import type { CodeWithRefs } from '@/app/actions/codebook';
import {
  groupFromPair,
  groupOf,
  looseCodes,
  pruneGroups,
  removeFromGroups,
  type StagedGroup,
} from '@/lib/codebook/staging';

// ---------------------------------------------------------------------------
// The staged-group store: localStorage, read through useSyncExternalStore.
//
// getSnapshot MUST return a stable reference or React re-renders forever, so the parsed
// array is memoised against the RAW string it came from — a new object every call would
// look like a change on every render. The cache is keyed per storage key so two
// dimensions' piles never alias.
//
// A same-tab write does not fire the `storage` event (browsers only notify OTHER tabs),
// so writes dispatch their own event; both are subscribed, which is what makes the box
// consistent across tabs as well as within one.
// ---------------------------------------------------------------------------

const EVENT = 'cb-staging-changed';
const EMPTY: StagedGroup[] = [];
const cache = new Map<string, { raw: string; parsed: StagedGroup[] }>();

function readGroups(storageKey: string): StagedGroup[] {
  let raw: string;
  try {
    raw = window.localStorage.getItem(storageKey) ?? '[]';
  } catch {
    return EMPTY;
  }
  const hit = cache.get(storageKey);
  if (hit && hit.raw === raw) return hit.parsed;

  let parsed: StagedGroup[];
  try {
    const value: unknown = JSON.parse(raw);
    parsed = Array.isArray(value) ? (value as StagedGroup[]) : EMPTY;
  } catch {
    parsed = EMPTY; // corrupt entry → an empty pile, never a crashed canvas
  }
  cache.set(storageKey, { raw, parsed });
  return parsed;
}

function writeGroups(storageKey: string, groups: StagedGroup[]): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(groups));
  } catch {
    /* a full or blocked store must not take the canvas down with it */
  }
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}

/** The server has no localStorage, so it renders an empty pile — and the client's first
 *  paint matches, then reconciles. Returning a fresh [] here would break hydration. */
function emptySnapshot(): StagedGroup[] {
  return EMPTY;
}

/**
 * The staging box: loose codes on the canvas, provisionally grouped, before they are
 * committed to the scheme.
 *
 * This is the INDUCTIVE path — axial coding. Categories EMERGE from grouped
 * observations rather than being imposed from a paper. It is the exact inverse of the
 * deductive pin, and both are legitimate; the thing that matters is that they terminate
 * in the SAME schema, or the codebook ends up with two kinds of category that mean
 * different things.
 *
 * So a group is nothing until you PROMOTE it. It is "a facet value you have not named
 * yet". Dragging three codes together says *these belong to one thing*; naming and
 * promoting says *and that thing is called X* — at which point it becomes a real facet
 * value and its members become codes answering it. No `cb_groups` table, no second
 * hierarchy.
 *
 * Groups live in localStorage, not the database, and that is deliberate. A group
 * persisted as a row is a category you have committed to WITHOUT naming — precisely the
 * artefact that rots, half-formed clusters nobody remembers the reason for, surviving in
 * the schema because deleting them feels like losing work. Provisional forces the
 * question "what IS this?" while the answer is still fresh, and makes abandoning a bad
 * grouping free.
 *
 * Drag targets:
 *   code → code            group them
 *   code → group           join that group
 *   code → a VALUE node    answer it (handled by FacetCanvas, which owns the nodes)
 *   code → the loose pile  pull it back out
 */
export default function StagingBox({
  facetId,
  facetLabel,
  unfiled,
  onDragCode,
}: {
  facetId: string;
  facetLabel: string;
  /** Codes with no answer on THIS dimension. Unfiled is always relative to one facet:
   *  being filed on Space says nothing about whether a code is filed on Locus. */
  unfiled: CodeWithRefs[];
  /** Told which code is being dragged, so the canvas nodes can become drop targets. */
  onDragCode: (codeId: string | null) => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [naming, setNaming] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');

  const storageKey = `cb:staging:${facetId}`;

  // localStorage read through useSyncExternalStore rather than
  // useEffect-then-setState: the store IS the source of truth, so mirroring it into
  // component state means two copies that can disagree — and setting state inside an
  // effect renders the empty box for one frame before the groups appear. It also gets
  // CROSS-TAB sync for free, which staged groups genuinely need: two tabs on the same
  // codebook must not each hold a private, diverging pile.
  const groups = useSyncExternalStore(subscribe, () => readGroups(storageKey), emptySnapshot);

  function persist(next: StagedGroup[]) {
    writeGroups(storageKey, pruneGroups(next));
  }

  const loose = looseCodes(unfiled, groups);
  const byId = new Map(unfiled.map((c) => [c.id, c]));

  function onDropOnCode(target: string, dragged: string) {
    if (target === dragged) return;
    const existing = groupOf(groups, target);
    // Dropping onto a code that is ALREADY grouped joins that group rather than making
    // a nested one — a group is a flat candidate value, not a tree. Depth comes later,
    // from the value chain, once the thing has a name.
    persist(
      existing
        ? groups.map((g) =>
            g.id === existing.id
              ? { ...g, codeIds: [...new Set([...g.codeIds, dragged])] }
              : { ...g, codeIds: g.codeIds.filter((id) => id !== dragged) },
          )
        : groupFromPair(groups, crypto.randomUUID(), target, dragged),
    );
  }

  function promote(group: StagedGroup, label: string) {
    start(async () => {
      const value = await createFacetValue(facetId, {
        key: crypto.randomUUID(),
        label,
        parentId: null,
      });
      for (const codeId of group.codeIds) await addCodeFacetValue(codeId, value.id);
      persist(groups.filter((g) => g.id !== group.id));
      setNaming(null);
      router.refresh();
    });
  }

  if (unfiled.length === 0) {
    return null;
  }

  return (
    <div className="pointer-events-auto absolute bottom-6 left-6 z-20 max-h-[55%] w-64 overflow-y-auto border border-foreground/20 bg-background/95 shadow-lg backdrop-blur">
      <div className="sticky top-0 border-b border-foreground/15 bg-background/95 px-3 py-2">
        <p className="text-xs font-medium tracking-tight">Unfiled</p>
        <p className="text-[11px] leading-snug text-foreground/45">
          {unfiled.length} code{unfiled.length === 1 ? '' : 's'} with no answer on{' '}
          {facetLabel}. Drag onto a value to file — or onto each other to group.
        </p>
      </div>

      <div className="space-y-2 p-2">
        {groups.map((g) => (
          <div
            key={g.id}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              const dragged = e.dataTransfer.getData('text/code-id');
              if (dragged) {
                persist(
                  groups.map((x) =>
                    x.id === g.id
                      ? { ...x, codeIds: [...new Set([...x.codeIds, dragged])] }
                      : { ...x, codeIds: x.codeIds.filter((id) => id !== dragged) },
                  ),
                );
              }
            }}
            className="border border-dashed border-foreground/30 p-1.5"
          >
            {naming === g.id ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const label = draftName.trim();
                  if (label) promote(g, label);
                }}
              >
                <input
                  autoFocus
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Escape' && setNaming(null)}
                  placeholder="What IS this group?"
                  className="w-full border-b border-foreground/40 bg-transparent px-1 py-0.5 text-xs focus:border-foreground focus:outline-none"
                />
                <p className="mt-1 text-[10px] leading-snug text-foreground/40">
                  Naming it promotes it to a value of {facetLabel}; its {g.codeIds.length}{' '}
                  code{g.codeIds.length === 1 ? '' : 's'} become answers to it.
                </p>
              </form>
            ) : (
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  setNaming(g.id);
                  setDraftName('');
                }}
                className="mb-1 w-full text-left text-[11px] text-foreground/50 underline-offset-2 hover:text-foreground hover:underline"
              >
                unnamed group ({g.codeIds.length}) — name it to promote →
              </button>
            )}

            <div className="space-y-0.5">
              {g.codeIds.map((id) => {
                const c = byId.get(id);
                if (!c) return null;
                return (
                  <CodeChip
                    key={id}
                    code={c}
                    onDragStart={() => onDragCode(id)}
                    onDragEnd={() => onDragCode(null)}
                    onDropCode={(dragged) => onDropOnCode(id, dragged)}
                  />
                );
              })}
            </div>
          </div>
        ))}

        {/* The loose pile is itself a drop target: dragging a code out of a group and
            back here un-groups it, which must be as cheap as grouping was. */}
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const dragged = e.dataTransfer.getData('text/code-id');
            if (dragged) persist(removeFromGroups(groups, dragged));
          }}
          className="min-h-8 space-y-0.5"
        >
          {loose.map((c) => (
            <CodeChip
              key={c.id}
              code={c}
              onDragStart={() => onDragCode(c.id)}
              onDragEnd={() => onDragCode(null)}
              onDropCode={(dragged) => onDropOnCode(c.id, dragged)}
            />
          ))}
          {loose.length === 0 && groups.length > 0 && (
            <p className="px-1 py-1 text-[10px] italic text-foreground/30">
              drop here to un-group
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function CodeChip({
  code,
  onDragStart,
  onDragEnd,
  onDropCode,
}: {
  code: CodeWithRefs;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDropCode: (draggedId: string) => void;
}) {
  const [over, setOver] = useState(false);
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/code-id', code.id);
        e.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        const dragged = e.dataTransfer.getData('text/code-id');
        if (dragged) onDropCode(dragged);
      }}
      title={code.name}
      className={`cursor-grab truncate border px-1.5 py-1 text-[11px] transition active:cursor-grabbing ${
        over
          ? 'border-foreground bg-foreground/[0.06]'
          : 'border-foreground/20 text-foreground/70 hover:border-foreground/50'
      }`}
    >
      <span className="font-mono text-foreground/50">{code.mnemonic}</span>{' '}
      {code.name}
    </div>
  );
}
