'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  createLabel,
  renameLabel,
  deleteLabel,
  reorderLabels,
  setLabelParent,
} from '@/app/actions/labels';
import { buildLabelTree, descendantIds, type LabelNode } from '@/lib/codebook/labelTree';
import type { Tables } from '@/lib/types/cb-db';

type Label = Tables<'cb_labels'>;

// Fallback swatch color for labels with no color set (matches the native
// <input type=color> default so the picker and the dot agree).
const DEFAULT_SWATCH = '#000000';

/** A label flattened from the tree for rendering: the node plus its tree depth. */
type FlatRow = { label: Label; depth: number };

/**
 * Pre-order (depth-first) flatten of the label forest into render rows, each
 * carrying its `depth` so the row can be indented. A parent is always emitted
 * immediately before its children, matching the Finder-style folder view.
 */
function flattenTree(nodes: LabelNode[], depth = 0, out: FlatRow[] = []): FlatRow[] {
  for (const node of nodes) {
    out.push({ label: node, depth });
    flattenTree(node.children, depth + 1, out);
  }
  return out;
}

/**
 * Label manager (codebook-scoped). The researcher curates the NESTED vocabulary
 * used to ORGANIZE/GROUP codes by theme — "Scientific Reasoning → Experimentation
 * → Hypothesizing" — which a code is then tagged with (LabelTagger on the code
 * page) and the matrix can filter by. This is the categorical / "what kind"
 * axis, independent of episodes (temporal), facets, flags, and observations.
 *
 * Labels render as an INDENTED TREE (buildLabelTree → pre-order flatten): each
 * row keeps the existing inline rename (onBlur), recolor (native color picker),
 * delete, and ↑/↓ reorder — but reorder is scoped to the row's SIBLING GROUP
 * (labels sharing a parent_id), and a per-row parent <select> re-parents the
 * label (cycle-safe: the row's own label and its descendants are excluded so the
 * UI can never form a loop). The add form gains an optional parent picker.
 *
 * Server Actions are called from event handlers (never during render) and
 * `router.refresh()` re-runs the parent Server Component to re-fetch the list.
 * Mutations run in a transition so the panel shows a coarse "saving" state and
 * disables controls while the refresh round-trips.
 */
export default function LabelManager({
  codebookId,
  labels,
}: {
  codebookId: string;
  labels: Label[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // new-label form. No color input: a new label's color is auto-assigned
  // server-side (golden-angle by its sibling-group position), so the researcher
  // never picks. `parentId` is '' for top level, else the chosen parent's id.
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');

  function run(fn: () => Promise<unknown>) {
    setError(null);
    startTransition(async () => {
      try {
        await fn();
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Mutation failed.');
      }
    });
  }

  // Indented render order: roots → children, parents before their children.
  const rows = flattenTree(buildLabelTree(labels));

  // Move the label by `delta` (-1 up / +1 down) WITHIN its sibling group (labels
  // sharing the same parent_id) and persist the new sibling order. Passing only
  // the sibling ids to `reorderLabels` keeps each group's 0..n sequence intact —
  // reordering the whole flat list would corrupt cross-group positions.
  function move(label: Label, delta: number) {
    // The label's siblings, in current display order (rows already in pre-order,
    // so siblings appear in the same relative order they were built in).
    const siblingIds = rows
      .filter((r) => r.label.parent_id === label.parent_id)
      .map((r) => r.label.id);
    const index = siblingIds.indexOf(label.id);
    const next = index + delta;
    if (next < 0 || next >= siblingIds.length) return;
    [siblingIds[index], siblingIds[next]] = [siblingIds[next], siblingIds[index]];
    run(() => reorderLabels(siblingIds));
  }

  return (
    <main className="px-6 py-6">
      <header className="mb-4">
        <h1 className="text-lg font-medium tracking-tight">
          Labels{' '}
          {isPending && (
            <span className="text-sm font-normal text-foreground/40">· saving…</span>
          )}
        </h1>
      </header>

      {error && (
        <p className="mb-3 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}

      {/* Existing labels — indented tree */}
      {rows.length === 0 ? (
        <p className="mb-6 text-sm text-foreground/50">
          No labels yet. Add one below.
        </p>
      ) : (
        <ul className="mb-6 divide-y divide-foreground/10 border border-foreground/15">
          {rows.map(({ label: lbl, depth }) => {
            // Siblings of this row, in display order, to disable ↑/↓ at the ends.
            const siblingIds = rows
              .filter((r) => r.label.parent_id === lbl.parent_id)
              .map((r) => r.label.id);
            const siblingIndex = siblingIds.indexOf(lbl.id);
            // Cycle-safe parent options: every OTHER label except this row's own
            // descendants (re-parenting under a descendant would close a loop).
            const blocked = descendantIds(labels, lbl.id);
            const parentOptions = labels.filter(
              (l) => l.id !== lbl.id && !blocked.has(l.id),
            );
            return (
              <li key={lbl.id} className="flex items-center gap-2 px-3 py-2">
                {/* Indent by depth so nesting reads Finder-style. */}
                <span style={{ width: depth * 16 }} aria-hidden="true" />
                <input
                  type="color"
                  value={lbl.color ?? DEFAULT_SWATCH}
                  disabled={isPending}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v !== (lbl.color ?? DEFAULT_SWATCH)) {
                      run(() => renameLabel(lbl.id, { name: lbl.name, color: v }));
                    }
                  }}
                  className="h-7 w-7 cursor-pointer border border-foreground/15 bg-background p-0.5"
                  aria-label={`Color for ${lbl.name}`}
                  title="Pick color"
                />
                <input
                  defaultValue={lbl.name}
                  disabled={isPending}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v && v !== lbl.name) run(() => renameLabel(lbl.id, { name: v }));
                  }}
                  className="flex-1 border border-foreground/15 bg-background px-2 py-1 text-sm"
                  aria-label={`Rename label ${lbl.name}`}
                />
                {/* Re-parent: '' → top level; descendants excluded so no cycle. */}
                <select
                  value={lbl.parent_id ?? ''}
                  disabled={isPending}
                  onChange={(e) => {
                    const v = e.target.value;
                    run(() => setLabelParent(lbl.id, v || null));
                  }}
                  className="max-w-40 border border-foreground/15 bg-background px-1 py-1 text-xs"
                  aria-label={`Parent of ${lbl.name}`}
                  title="Move under a parent label"
                >
                  <option value="">— top level</option>
                  {parentOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={isPending || siblingIndex === 0}
                    onClick={() => move(lbl, -1)}
                    aria-label={`Move ${lbl.name} up`}
                    title="Move up"
                    className="px-1 text-foreground/40 hover:text-foreground disabled:opacity-30"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    disabled={isPending || siblingIndex === siblingIds.length - 1}
                    onClick={() => move(lbl, 1)}
                    aria-label={`Move ${lbl.name} down`}
                    title="Move down"
                    className="px-1 text-foreground/40 hover:text-foreground disabled:opacity-30"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => {
                      if (confirm(`Delete label "${lbl.name}"?`)) {
                        run(() => deleteLabel(lbl.id));
                      }
                    }}
                    aria-label={`Delete label ${lbl.name}`}
                    className="px-1 text-red-600 hover:underline disabled:opacity-50"
                  >
                    ×
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* Add label */}
      <div className="border-t border-foreground/10 pt-4">
        <p className="mb-2 text-xs uppercase tracking-wider text-foreground/50">
          New label
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-foreground/50">name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Metacognition"
              disabled={isPending}
              className="w-56 border border-foreground/15 bg-background px-2 py-1 text-sm"
              aria-label="New label name"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-foreground/50">parent</span>
            <select
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
              disabled={isPending}
              className="w-56 border border-foreground/15 bg-background px-2 py-1 text-sm"
              aria-label="New label parent"
            >
              <option value="">— top level</option>
              {/* Full list, indented to read the existing nesting at a glance. */}
              {rows.map(({ label: p, depth }) => (
                <option key={p.id} value={p.id}>
                  {`${'  '.repeat(depth)}${p.name}`}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={isPending}
            onClick={() => {
              const n = name.trim();
              if (!n) {
                setError('Label needs a name.');
                return;
              }
              run(async () => {
                // No color passed → auto-assigned by sibling position server-side.
                await createLabel(codebookId, { name: n, parentId: parentId || undefined });
                setName('');
                setParentId('');
              });
            }}
            className="border border-foreground px-3 py-1 text-sm transition hover:bg-foreground hover:text-background disabled:opacity-50"
          >
            Add label
          </button>
          <span className="self-center text-[11px] text-foreground/40">
            color auto-assigned
          </span>
        </div>
      </div>
    </main>
  );
}
