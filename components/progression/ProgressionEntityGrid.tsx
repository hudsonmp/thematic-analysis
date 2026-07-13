'use client';

import type { Entity } from '@/lib/spec/reconstruct';
import type { EntityDiff } from '@/lib/progression/progression';

// ---------------------------------------------------------------------------
// The participant's entity/element grid at one phase, with the step's diff
// overlaid: entities/elements ADDED this phase get an accent ring + "+" mark;
// REMOVED ones (present in the previous phase, gone now) render as ghost cards,
// struck through, so the researcher sees what disappeared without consulting
// two steps. diff === null (Requirement step / no prior step) renders plain —
// the same visual as SpecReplay's ReadOnlyEntityGrid, whose card layout this
// mirrors (grid-cols-3, name over a `· element` list).
// Matching is by TRIMMED name, identical to lib/progression/diffEntities.
// ---------------------------------------------------------------------------

export default function ProgressionEntityGrid({
  entities,
  diff,
}: {
  entities: Entity[];
  diff: EntityDiff | null;
}) {
  const addedEnt = new Set(diff?.addedEntities ?? []);
  const changed = new Map((diff?.changedEntities ?? []).map((c) => [c.name, c]));

  if (entities.length === 0 && (diff?.removedEntities.length ?? 0) === 0) {
    return <p className="text-xs italic text-[var(--muted)]">(no entities recorded)</p>;
  }

  return (
    <div className="grid grid-cols-3 gap-2">
      {entities.map((ent, i) => {
        const name = ent.name.trim();
        const isAdded = addedEnt.has(name);
        const change = changed.get(name);
        const addedEls = new Set(change?.addedElements ?? []);
        return (
          <div
            key={ent.id || `entity-${i}`}
            className={`border p-2 flex flex-col gap-1 bg-[var(--background)] ${
              isAdded ? 'border-emerald-600/70 ring-1 ring-emerald-600/30' : 'border-[var(--rule)]'
            }`}
          >
            <div className="text-sm border-b border-dashed border-[var(--rule)] py-1 break-words">
              {isAdded && <span className="mr-1 text-emerald-700" aria-label="added this phase">+</span>}
              {ent.name || <span className="text-[var(--muted)]">Entity</span>}
            </div>
            <ul className="space-y-0.5">
              {ent.elements.map((el, ei) => {
                const elAdded = addedEls.has(el.name.trim());
                return (
                  <li key={el.id || `element-${i}-${ei}`} className="flex gap-1 items-center text-sm">
                    <span className="text-[var(--muted)] shrink-0">·</span>
                    <span className={`min-w-0 break-words py-0.5 ${elAdded ? 'text-emerald-700' : ''}`}>
                      {elAdded && <span className="mr-0.5">+</span>}
                      {el.name || <span className="text-[var(--muted)]">element</span>}
                    </span>
                  </li>
                );
              })}
              {/* Elements REMOVED from this (persisting) entity this phase. */}
              {(change?.removedElements ?? []).map((elName) => (
                <li key={`removed-${elName}`} className="flex gap-1 items-center text-sm">
                  <span className="text-[var(--muted)] shrink-0">·</span>
                  <span className="min-w-0 break-words py-0.5 line-through text-red-700/60">{elName}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      {/* Ghost cards for entities removed this phase. */}
      {(diff?.removedEntities ?? []).map((name) => (
        <div
          key={`removed-${name}`}
          className="border border-dashed border-red-700/40 p-2 bg-[var(--background)] opacity-60"
        >
          <div className="text-sm py-1 break-words line-through text-red-700/70">{name}</div>
          <p className="text-[10px] uppercase tracking-wider text-red-700/50">removed this phase</p>
        </div>
      ))}
    </div>
  );
}
