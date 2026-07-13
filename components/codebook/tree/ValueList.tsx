'use client';

import type { FacetWithValues } from '@/app/actions/codebook';
import { buildTree, type TreeNode } from '@/lib/codebook/tree';
import type { Tables } from '@/lib/types/cb-db';

type FacetValue = Tables<'cb_facet_values'>;

/**
 * The answer picker for ONE dimension: a compact vertical LIST, not a wrapped row of
 * boxes.
 *
 * A wrapped row reflows as values are added, so the same value sits in a different
 * place each time you look — and a picker whose geometry moves cannot be learned. A
 * list is stable: the third value is always the third row, so after a dozen codes you
 * are hitting a position, not reading a label. That is the whole ergonomic point of
 * batching classification in the first place.
 *
 * Nesting is shown by INDENT ALONE. The `↳` glyph it replaces was decoration: it said
 * "this is a child" a second time, in a column where indentation had already said it,
 * and it cost horizontal room in a 384px rail.
 *
 * Selection semantics are the model's, not the widget's:
 *   - values are an IS-A chain, so picking a PARENT is a complete, coarser answer;
 *   - picking a child ENTAILS its parent — you never pick both;
 *   - a `multi` dimension admits several answers (the cross-cutting case); a `single`
 *     one REPLACES on pick, or a code would silently carry two answers on a dimension
 *     declared to allow one.
 */
export default function ValueList({
  facet,
  selectedIds,
  onToggle,
  disabled = false,
}: {
  facet: FacetWithValues;
  selectedIds: string[];
  /** Called with the clicked value; the caller applies single/multi semantics. */
  onToggle: (valueId: string) => void;
  disabled?: boolean;
}) {
  const multi = facet.cardinality === 'multi';

  function rows(nodes: TreeNode<FacetValue>[], depth = 0): React.ReactNode[] {
    return nodes.flatMap((v) => {
      const on = selectedIds.includes(v.id);
      return [
        <button
          key={v.id}
          type="button"
          disabled={disabled}
          onClick={() => onToggle(v.id)}
          style={{ paddingLeft: 6 + depth * 14 }}
          title={
            depth > 0
              ? 'A finer answer. Choosing it entails its parent — do not pick both.'
              : undefined
          }
          className={`flex w-full items-center gap-2 py-0.5 pr-1.5 text-left text-xs transition ${
            on
              ? 'bg-foreground/[0.06] font-medium text-foreground'
              : 'text-foreground/65 enabled:hover:bg-foreground/[0.03]'
          } disabled:opacity-50`}
        >
          {/* A square for multi, a dot for single — the shape says how many answers
              this dimension will accept, before you find out by clicking. */}
          <span
            aria-hidden
            className={`inline-block h-2.5 w-2.5 shrink-0 border ${
              multi ? '' : 'rounded-full'
            } ${on ? 'border-foreground bg-foreground' : 'border-foreground/30'}`}
          />
          <span className="truncate">{v.label}</span>
        </button>,
        ...rows(v.children, depth + 1),
      ];
    });
  }

  if (facet.values.length === 0) {
    return <p className="py-1 text-xs italic text-foreground/40">no values yet</p>;
  }

  return <div className="flex flex-col">{rows(buildTree(facet.values))}</div>;
}
