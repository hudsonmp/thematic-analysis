'use client';

import { useState } from 'react';
import type { ExemplarT } from '@/lib/types/contracts';
import type { Tables } from '@/lib/types/cb-db';

type CodeVersion = Tables<'cb_code_versions'>;

function asStringArray(j: unknown): string[] {
  return Array.isArray(j) ? j.filter((x): x is string => typeof x === 'string') : [];
}
function asExemplars(j: unknown): ExemplarT[] {
  return Array.isArray(j) ? (j as ExemplarT[]) : [];
}

function FieldList({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="text-xs uppercase tracking-wider text-foreground/40">{label}</p>
      <ul className="list-disc pl-5 text-sm">
        {items.map((it, i) => (
          <li key={i}>{it}</li>
        ))}
      </ul>
    </div>
  );
}

function FieldText({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div>
      <p className="text-xs uppercase tracking-wider text-foreground/40">{label}</p>
      <p className="text-sm whitespace-pre-wrap">{value}</p>
    </div>
  );
}

/**
 * Read-only version history. Lists every version (newest first, as
 * `listCodeVersions` returns them); the row for `currentVersionId` is badged.
 * Each row expands to show that version's full anatomy snapshot — pure display,
 * no editing (edits always go through AnatomyEditor → saveNewVersion, which
 * appends rather than mutates, so old versions are immutable history).
 */
export default function VersionHistory({
  versions,
  currentVersionId,
}: {
  versions: CodeVersion[];
  currentVersionId: string | null;
}) {
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setOpenIds((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  if (versions.length === 0) {
    return <p className="text-sm text-foreground/50">No versions recorded.</p>;
  }

  return (
    <ul className="divide-y divide-foreground/10 border border-foreground/15">
      {versions.map((v) => {
        const open = openIds.has(v.id);
        const isCurrent = v.id === currentVersionId;
        return (
          <li key={v.id}>
            <button
              type="button"
              onClick={() => toggle(v.id)}
              className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-foreground/5"
              aria-expanded={open}
            >
              <span className="font-mono text-sm">v{v.version}</span>
              {isCurrent && (
                <span className="text-[10px] uppercase tracking-wider border border-green-600 text-green-700 px-1">
                  current
                </span>
              )}
              <span className="text-sm text-foreground/60 truncate flex-1">
                {v.change_note || <span className="text-foreground/30">no change note</span>}
              </span>
              <span className="text-xs text-foreground/40">
                {new Date(v.created_at).toLocaleString()}
              </span>
              <span className="text-foreground/40">{open ? '−' : '+'}</span>
            </button>
            {open && (
              <div className="px-3 pb-3 space-y-3 bg-foreground/[0.02]">
                <FieldText label="Definition" value={v.definition} />
                <FieldList label="Include if" items={asStringArray(v.include_if)} />
                <FieldList label="Exclude if" items={asStringArray(v.exclude_if)} />
                {(() => {
                  const xs = asExemplars(v.exemplars);
                  if (xs.length === 0) return null;
                  return (
                    <div>
                      <p className="text-xs uppercase tracking-wider text-foreground/40">
                        Exemplars
                      </p>
                      <ul className="space-y-1 text-sm">
                        {xs.map((x, i) => (
                          <li key={i} className="border-l-2 border-foreground/15 pl-2">
                            <span>{x.text}</span>
                            {x.episode_ref && (
                              <span className="text-xs text-foreground/40">
                                {' '}
                                [{x.episode_ref.module_id} · scenario{' '}
                                {x.episode_ref.scenario_idx + 1} · {x.episode_ref.phase}]
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })()}
                <FieldText label="Disconfirming pattern" value={v.disconfirming_pattern} />
                <FieldText label="Prediction" value={v.prediction} />
                <FieldText label="Prediction falsifier" value={v.prediction_falsifier} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
