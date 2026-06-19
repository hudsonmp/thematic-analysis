# Nested labels + folder browse for the codebook

- **Date:** 2026-06-19
- **Repo:** `thematic-analysis`
- **Branch:** `feat/nested-labels` (worktree `~/ta-labels`, off `main` @ 18f302f)
- **Status:** DRAFT — awaiting Hudson's spec review.

## Problem

A researcher can tag codes with labels (the categorical "what kind" axis), but the
vocabulary is **flat** and assignment is uneven across surfaces. Hudson wants:

1. Assign labels **when creating a code in the Codebook tab** (the bulk grid — the one
   create path that lacks labels today) *and* after creation (exists via `LabelTagger`).
2. **Nested labels** of arbitrary depth — e.g. `Scientific Reasoning → Experimentation →
   Hypothesizing` ("sub-sub label if I want").
3. Browse the codebook as **folders in list form** (Apple Finder–style), grouping codes
   by label/sublabel.
4. **Multi-label**, stored once: a code may carry several labels; in the DB it lives once
   with N membership rows; in the UI it appears under *every* folder it belongs to.

## Resolved decisions

- **(A) Roll-up grouping (Hudson, 2026-06-19).** Clicking a parent folder shows **every
  code in its subtree** — directly tagged + tagged on any descendant. The parent folder
  represents the whole theme; a code tagged only at a leaf is still visible at the theme
  level. Expand to narrow. (Not literal Finder-strict.)
- **Keep the junction, not an array column.** `cb_code_labels` (existing many-to-many)
  already satisfies "stored once, no row duplication": the code lives once in `cb_codes`,
  its label set is N join-rows. A literal `uuid[]` would lose the FK cascade and make the
  subtree roll-up join ugly. DB normalized; UI denormalized (render under each folder).
- **Nesting = one column.** Add `parent_id` (self-referential FK) to `cb_labels`.
  Adjacency list, arbitrary depth, no hard cap.
- **No new read path.** `listCodebookTree` already returns `labels[] + codes[] +
  cb_code_labels memberships` in one aggregate read (feeds the Scheme page). Once labels
  carry `parent_id`, the folder view is a **pure in-memory fold** over data already loaded.
- **Reuse existing assignment pickers.** Create-time (grid + `SessionCodeCreator`) and
  post-creation (`LabelTagger`). No drag-to-assign in v1.

## Data model

One additive, backward-compatible migration `docs/migrations/32_label_nesting.sql`:

```sql
alter table cb_labels
  add column if not exists parent_id uuid references cb_labels(id) on delete set null;
create index if not exists cb_labels_parent_idx on cb_labels(codebook_id, parent_id);
```

- `on delete set null` is the **safety net only**; the application `deleteLabel` action
  *promotes* a deleted label's children to its own parent before deleting (see below), so
  a deleted folder collapses up one level rather than orphaning children to root or
  cascading a subtree delete.
- `position` becomes ordering **within a sibling group** (siblings sharing `parent_id`),
  not codebook-global.
- `lib/types/cb-db.ts`: hand-add `parent_id: string | null` to `cb_labels`
  Row/Insert/Update (regen needs the live schema; this keeps `tsc` green pre-apply).
- **Applying the migration to the live VT project is GATED on Hudson** (additive + nullable
  → safe, but it is a real write to the live DB). The feature does not function at runtime
  until applied.

## Pure assembly module — `lib/codebook/labelTree.ts`

Mirrors the `anchor.ts`/`folderGrouping.ts` pure-module pattern (no I/O, fully unit-tested):

- `buildLabelTree(labels): LabelNode[]` — roots → children, each sibling group ordered by
  `position` then `created_at`.
- `descendantIds(labels, labelId): Set<string>` — the subtree under a label (excl. self).
- `wouldCreateCycle(labels, labelId, newParentId): boolean` — true iff `newParentId ===
  labelId` or `newParentId ∈ descendantIds(labelId)`. Guards reparenting.
- `rollupCodesByLabel(labels, codes, codeLabels): Map<labelId, Code[]>` — for each code,
  walk each of its labels **up their ancestor chains** and bucket the code under every
  ancestor encountered. **Dedup per folder** (a code with two labels both under
  `Scientific Reasoning` appears once there). Also yields an `unlabeled` bucket.

## Server actions — `app/actions/labels.ts`

- `createLabel(codebookId, { name, color, parentId? })` — `parentId` optional; `nextPosition`
  scoped to `(codebook_id, parent_id)`. New node ⇒ no cycle possible.
- `setLabelParent(labelId, parentId | null)` — NEW. Rejects if `wouldCreateCycle`. Resets
  `position` to end of the destination sibling group.
- `deleteLabel(id)` — promote children first: `update cb_labels set parent_id = <node.parent_id>
  where parent_id = id`, then delete the node (its own `cb_code_labels` tags cascade — that
  label is gone; children + their tags survive, reparented).
- `reorderLabels(orderedIds)` — unchanged; caller passes a single sibling group.
- `setCodeLabels` — unchanged (replace-the-set on a code).

## UI surfaces

**1. `LabelManager` (`/labels`) — nesting CRUD.** Render labels as an indented tree
(`buildLabelTree`). Per label: a **parent selector** (options = all labels except self +
descendants, plus "— top level"; calls `setLabelParent`); reorder within siblings via
existing ↑/↓; rename/recolor/delete as today. Add-form gains an optional parent select
(create-under-parent).

**2. Codebook bulk grid (`/codebook`, `CodebookEntry`) — create-time labels.**
- `app/(protected)/codebook/page.tsx`: pass `tree.labels` into `CodebookEntry`.
- `CodebookEntry`: a **Labels column** — per-row multi-select from an indented tree picker
  (mirrors the enum-multi facet cell). Stores selected label ids per row.
- `app/actions/codes.ts` `createCodesBulkWithFacets`: accept `labelWritesByIndex:
  Record<number, string[]>`; after each `createCode`, if labels present call
  `setCodeLabels(newId, ids)`. (Mirrors the existing `facetWritesByIndex` flow.)

**3. Scheme page (`/`) — folder browse.** A `Matrix | Folders` view toggle (client state;
default Matrix to stay non-disruptive). `Folders` renders a new
`components/codebook/LabelFolderView.tsx`:
- Consumes the same `tree`; builds the folder tree + `rollupCodesByLabel` via `labelTree.ts`.
- Finder-style expandable rows (disclosure triangles), codes listed under their folders,
  a code appearing under **every** folder it belongs to (multi-membership), roll-up on
  parent expand, per-folder code count, an `Unlabeled` bucket, click a code → its detail page.

## Edge cases

- **Cycles** — blocked by `wouldCreateCycle` in `setLabelParent`.
- **Delete with children** — promote-to-grandparent (no orphan-to-root, no subtree wipe).
- **Multi-membership** — a code under several sibling subtrees shows under each; deduped
  *within* a folder.
- **Empty / deep trees** — arbitrary depth; folds are linear in (labels + memberships).
- **Color** — keep per-label `autoColor`; child-tinting is out of scope.

## Constraints

- **Next.js 16 is modified** — read `AGENTS.md` + `node_modules/next/dist/docs/` before any
  Next API change. Pages stay Server Components; client components call Server Actions from
  handlers only (never during render); `router.refresh()` to re-read.
- **Study tables READ-ONLY.** This feature touches only researcher-owned `cb_labels`,
  `cb_code_labels`, `cb_codes` — `check-no-study-writes.sh` must stay green.
- **Branch `feat/nested-labels` in `~/ta-labels`; never main; never merge.** Hudson runs
  `:3200` on main and merges himself.
- **Verify via `tsc --noEmit` + `vitest`.** Do NOT run `npm run build` / `next dev`
  (shared `.next`; the worktree's symlinked `node_modules` rejects `next dev` anyway).
- **Migration apply to the live DB is gated on Hudson's explicit OK.**

## Decomposition (build order)

1. **Migration + types** — `parent_id` column + index; hand-add to `cb-db.ts`.
2. **Pure `labelTree.ts` + label actions** — tree/rollup/cycle helpers (unit-tested);
   `createLabel(parentId)`, `setLabelParent`, `deleteLabel` promote, sibling-scoped
   `nextPosition`.
3. **`LabelManager` nesting UI** — indented tree, parent selector, create-under-parent.
4. **Create-time labels in the bulk grid** — Labels column + `labelWritesByIndex` thread.
5. **Scheme folder view** — `LabelFolderView` + Matrix|Folders toggle.

Dependencies: 2 needs 1; 3/4/5 need 2; 4 also needs 1; 5 needs 1+2. Linear execution
order: 1 → 2 → 3 → 4 → 5.

## Out of scope (v1)

- Drag-to-assign / move-code-between-folders in the folder view (assignment stays in the
  three pickers).
- Making Folders the default Scheme view.
- Child-color inheritance / tinting.
- `parent_code_id` (code subcoding) — a separate, untouched hierarchy.
