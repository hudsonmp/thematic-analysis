'use client';

import type { Entity } from '@/lib/spec/reconstruct';

// ---------------------------------------------------------------------------
// Read-only SPEC-replay view (Specification mode, Task SV2 of the spec-mode
// feature). Renders the participant's reconstructed spec text + entity table as
// they stood at the current playhead instant — see lib/spec/reconstruct.ts. The
// host (SessionPlayer) recomputes the state on each playhead tick and re-renders
// this; this component is PURE PRESENTATIONAL (no editing, no time, no I/O).
//
// The layout is a READ-ONLY port of the participant app's spec column
// (spec-study-app/.../ParticipantFlow.tsx: SpecColumn + EntityElementGrid) so
// the analyst sees the SAME surface the participant saw, minus the editing
// affordances: no +/× controls, no "+ entity"/"+ element" add tiles, no
// editable inputs. Read-only entities render as plain text (entity name + a
// `· element` list); an empty table shows "(no entities recorded)"; the spec
// text shows in a monospace block that preserves whitespace (`whitespace-pre-wrap`),
// the same font/whitespace contract the participant's textarea had.
//
// Design tokens (--rule, --muted, --rule-soft) are the shared editorial palette
// mirrored from spec-study-app into this app's globals.css, so the surface reads
// as the same product.
// ---------------------------------------------------------------------------

/** Small uppercase section label — inlined from the participant app's PanelLabel
 *  (not exported from that repo). Matches the participant column's section heads. */
function PanelLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] uppercase tracking-[0.14em] text-[var(--muted)]">
      {children}
    </h3>
  );
}

/** Read-only entities grid: a `grid-cols-3` of cards, each an entity name over a
 *  `· element` list. Read-only hides every +/× control and the add tiles; an
 *  empty table renders "(no entities recorded)" — exactly the participant app's
 *  EntityElementGrid in its `readOnly` branch. */
function ReadOnlyEntityGrid({ entities }: { entities: Entity[] }) {
  if (entities.length === 0) {
    return (
      <p className="text-xs italic text-[var(--muted)]">(no entities recorded)</p>
    );
  }
  return (
    <div className="grid grid-cols-3 gap-2">
      {entities.map((ent, i) => (
        // Keyed by id when present; index fallback covers a coerced entity whose
        // id was malformed → '' (reconstruct.ts coerces, never drops).
        <div
          key={ent.id || `entity-${i}`}
          className="border border-[var(--rule)] p-2 flex flex-col gap-1 bg-[var(--background)]"
        >
          <div className="text-sm border-b border-dashed border-[var(--rule)] py-1 break-words">
            {ent.name || <span className="text-[var(--muted)]">Entity</span>}
          </div>
          <ul className="space-y-0.5">
            {ent.elements.map((el, ei) => (
              <li
                key={el.id || `element-${i}-${ei}`}
                className="flex gap-1 items-center text-sm"
              >
                <span className="text-[var(--muted)] shrink-0">·</span>
                <span className="min-w-0 break-words py-0.5">
                  {el.name || (
                    <span className="text-[var(--muted)]">element</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/**
 * Read-only spec column at a single playhead instant. PURE presentational: the
 * host reconstructs `{ spec, entities }` (specStateAt) and feeds them here on
 * each tick. No editing, no selection, no annotation — display + scrub only.
 */
export default function SpecReplay({
  spec,
  entities,
  className,
}: {
  /** The reconstructed spec text at the current instant (`''` before any edit). */
  spec: string;
  /** The reconstructed entity table at the current instant (`[]` before any). */
  entities: Entity[];
  /** Layout classes from the host (e.g. `h-[40vh] overflow-y-auto`). */
  className?: string;
}) {
  return (
    <section className={`flex flex-col gap-2 pl-3 ${className ?? ''}`}>
      <PanelLabel>Specifications</PanelLabel>
      <div className="border border-[var(--rule)] bg-[var(--rule-soft)] p-3 flex flex-col gap-2">
        <PanelLabel>Entities &amp; Elements</PanelLabel>
        <ReadOnlyEntityGrid entities={entities} />
        <p
          className="font-mono text-[10px] tracking-tighter text-[var(--muted)] select-none leading-none my-2"
          aria-hidden
        >
          ================================================
        </p>
        {/* The free-form spec text. `whitespace-pre-wrap` preserves the
            participant's newlines/indentation; `break-words` keeps a long
            unbroken token from overflowing. Empty before the first spec edit. */}
        {spec ? (
          <p className="text-[15px] leading-relaxed font-mono whitespace-pre-wrap break-words">
            {spec}
          </p>
        ) : (
          <p className="text-xs italic text-[var(--muted)]">
            (no specification recorded yet)
          </p>
        )}
      </div>
    </section>
  );
}
