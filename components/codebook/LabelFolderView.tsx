'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { CodebookTree, CodeWithRefs } from '@/app/actions/codebook';
import { buildLabelTree, rollupCodesByLabel, type LabelNode } from '@/lib/codebook/labelTree';

// Fallback swatch color for labels with no color set (matches LabelManager's
// DEFAULT_SWATCH so a folder dot and the manager's color picker agree).
const DEFAULT_SWATCH = '#000000';

// Lifecycle status → dot color. Duplicated from MatrixView (not shared): these
// are the four fixed code statuses, orthogonal to the user-defined label palette.
const STATUS_COLOR: Record<string, string> = {
  proposed: '#9ca3af', // gray
  active: '#16a34a', // green
  merged: '#2563eb', // blue
  retired: '#dc2626', // red
};

function statusColor(status: string): string {
  return STATUS_COLOR[status] ?? '#9ca3af';
}

/**
 * A code's chip. Links to its detail page the SAME way MatrixView's CodeChip does
 * — `/codes/<id>` — so navigation is identical across both Scheme views.
 */
function CodeRow({ code }: { code: CodeWithRefs }) {
  return (
    <Link
      href={`/codes/${code.id}`}
      title={`${code.name} (${code.status})`}
      className="flex items-center gap-2 px-2 py-1 text-xs hover:bg-foreground/5 transition"
    >
      <span
        className="inline-block h-2 w-2 rounded-full shrink-0"
        style={{ backgroundColor: statusColor(code.status) }}
        aria-hidden
      />
      <span className="truncate font-mono text-foreground/80">{code.mnemonic}</span>
      <span className="truncate text-foreground/50">{code.name}</span>
    </Link>
  );
}

/**
 * One folder row + its (collapsible) bucket and nested child folders. Each folder
 * owns its OWN open/closed state, so sub-trees expand independently. Indentation
 * is by `depth` so nesting reads Finder-style.
 *
 * The roll-up bucket (`codesByLabel`) already contains every code tagged anywhere
 * in this folder's subtree (decision A), deduped per bucket — so a child folder's
 * codes also appear in its ancestors' buckets, and a multi-label code shows under
 * each folder it belongs to. We render this folder's bucket first, then its child
 * folders below (each with its own bucket), matching the manager's parent-before-
 * children order.
 */
function FolderRow({
  node,
  depth,
  codesByLabel,
}: {
  node: LabelNode;
  depth: number;
  codesByLabel: Map<string, CodeWithRefs[]>;
}) {
  const [open, setOpen] = useState(false);
  const bucket = codesByLabel.get(node.id) ?? [];

  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-foreground/5 transition"
        style={{ paddingLeft: 12 + depth * 16 }}
      >
        {/* Disclosure triangle: rotates when open. Static glyph keeps it deps-free. */}
        <span
          className="inline-block w-3 shrink-0 text-foreground/40 transition-transform"
          style={{ transform: open ? 'rotate(90deg)' : 'none' }}
          aria-hidden
        >
          ▶
        </span>
        <span
          className="inline-block h-2.5 w-2.5 rounded-sm shrink-0"
          style={{ backgroundColor: node.color ?? DEFAULT_SWATCH }}
          aria-hidden
        />
        <span className="truncate font-medium text-foreground/90">{node.name}</span>
        {/* Roll-up count: codes in this folder's WHOLE subtree, deduped. */}
        <span className="ml-auto shrink-0 text-xs text-foreground/40">{bucket.length}</span>
      </button>

      {open && (
        <>
          {/* This folder's bucket (roll-up). Indented one step past the row. */}
          <ul style={{ paddingLeft: 12 + (depth + 1) * 16 }}>
            {bucket.length === 0 ? (
              <li className="px-2 py-1 text-xs text-foreground/20">— no codes</li>
            ) : (
              bucket.map((code) => (
                <li key={code.id}>
                  <CodeRow code={code} />
                </li>
              ))
            )}
          </ul>
          {/* Nested child folders (true tree), each independently collapsible. */}
          {node.children.length > 0 && (
            <ul>
              {node.children.map((child) => (
                <FolderRow
                  key={child.id}
                  node={child}
                  depth={depth + 1}
                  codesByLabel={codesByLabel}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </li>
  );
}

/**
 * Finder-style FOLDER browse of the codebook by its NESTED label vocabulary —
 * the alternative to the facet matrix (toggle lives in SchemeView). Each label is
 * a folder; expanding it lists the codes that roll up to it (codes tagged on the
 * label OR anywhere in its subtree — decision A), and shows its child folders
 * nested beneath. A code carrying multiple labels appears under EACH folder it
 * belongs to; an "Unlabeled" bucket collects codes with no label at all.
 *
 * Roll-up is delegated wholesale to `rollupCodesByLabel` (the unit-tested T2
 * engine) — this component never recomputes it. The tree exposes memberships per
 * code as `labelIds`, so we re-flatten those into the (code_id, label_id) rows the
 * engine consumes. The engine's buckets type as the base `Code`, but each element
 * IS one of the tree's `CodeWithRefs` rows, so we re-resolve them through a code
 * map to recover the richer type for the chip (no data change, just the type).
 */
export default function LabelFolderView({ tree }: { tree: CodebookTree }) {
  const { codes, labels } = tree;

  // Folder tree from the flat labels (roots → nested children, sibling-ordered).
  const folders = useMemo(() => buildLabelTree(labels), [labels]);

  // Roll-up + bucket re-typing. Memberships come off each code's `labelIds`.
  const { byLabel, unlabeled } = useMemo(() => {
    const codeLabels = codes.flatMap((code) =>
      code.labelIds.map((label_id) => ({ code_id: code.id, label_id })),
    );
    const rollup = rollupCodesByLabel(labels, codes, codeLabels);

    // Recover CodeWithRefs from the engine's base-Code buckets (same objects).
    const byId = new Map<string, CodeWithRefs>(codes.map((c) => [c.id, c]));
    const reType = (bucket: { id: string }[]): CodeWithRefs[] =>
      bucket
        .map((c) => byId.get(c.id))
        .filter((c): c is CodeWithRefs => c !== undefined);

    const byLabel = new Map<string, CodeWithRefs[]>();
    for (const [labelId, bucket] of rollup.byLabel) byLabel.set(labelId, reType(bucket));
    return { byLabel, unlabeled: reType(rollup.unlabeled) };
  }, [labels, codes]);

  const [unlabeledOpen, setUnlabeledOpen] = useState(false);

  return (
    <div className="space-y-4">
      {folders.length === 0 ? (
        <p className="text-sm text-foreground/60">
          No labels yet — add a nested label vocabulary on the{' '}
          <Link href="/labels" className="underline hover:text-foreground">
            Labels
          </Link>{' '}
          page, then tag codes to browse them here as folders.
        </p>
      ) : (
        <ul className="divide-y divide-foreground/10 border border-foreground/15">
          {folders.map((node) => (
            <FolderRow key={node.id} node={node} depth={0} codesByLabel={byLabel} />
          ))}
        </ul>
      )}

      {/* Unlabeled bucket — codes with no label at all, at the end. */}
      <div className="border border-foreground/15">
        <button
          type="button"
          onClick={() => setUnlabeledOpen((v) => !v)}
          aria-expanded={unlabeledOpen}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-foreground/5 transition"
        >
          <span
            className="inline-block w-3 shrink-0 text-foreground/40 transition-transform"
            style={{ transform: unlabeledOpen ? 'rotate(90deg)' : 'none' }}
            aria-hidden
          >
            ▶
          </span>
          <span className="truncate font-medium text-foreground/60">Unlabeled</span>
          <span className="ml-auto shrink-0 text-xs text-foreground/40">{unlabeled.length}</span>
        </button>
        {unlabeledOpen && (
          <ul className="pl-7">
            {unlabeled.length === 0 ? (
              <li className="px-2 py-1 text-xs text-foreground/20">— no codes</li>
            ) : (
              unlabeled.map((code) => (
                <li key={code.id}>
                  <CodeRow code={code} />
                </li>
              ))
            )}
          </ul>
        )}
      </div>
    </div>
  );
}
