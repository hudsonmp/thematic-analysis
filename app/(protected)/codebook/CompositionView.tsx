'use client';

import { useState } from 'react';
import type { CombinatorialContext } from '@/app/actions/buckets';
import BucketManager from '@/components/buckets/BucketManager';
import CombinatorialDef from '@/components/code/CombinatorialDef';
import CodeCombobox from '@/components/codebook/CodeCombobox';

/**
 * The BUCKETS view of the codebook page — the set/subset authoring surface the
 * v2 spec puts on the schema tree page. Both halves of the relation live here:
 *
 *   COMPOSITION (top) — which codes are combinatorial and what steps compose
 *   them. Pick any code (or click an existing composite) and its ordered-AND
 *   editor opens inline; saving with no rows makes it primitive again.
 *
 *   BUCKETS (below) — the running list of modular buckets those steps draw
 *   from: members, mandatory ★, per-coder forks, push/pull, snapshots.
 */
export default function CompositionView({
  codebookId,
  ctx,
  codeOptions,
}: {
  codebookId: string;
  ctx: CombinatorialContext;
  codeOptions: { id: string; mnemonic: string }[];
}) {
  const [selectedCodeId, setSelectedCodeId] = useState<string | null>(null);

  const combinatorialCodes = codeOptions.filter((c) => (ctx.defs[c.id]?.length ?? 0) > 0);
  const selected = selectedCodeId
    ? codeOptions.find((c) => c.id === selectedCodeId) ?? null
    : null;

  const stepSummary = (codeId: string): string => {
    const items = ctx.defs[codeId] ?? [];
    return items
      .map((it) =>
        it.kind === 'bucket'
          ? ctx.buckets.find((b) => b.id === it.bucketId)?.name ?? 'bucket'
          : codeOptions.find((c) => c.id === it.codeId)?.mnemonic ?? 'code',
      )
      .join(' + ');
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <section className="mx-auto max-w-4xl px-6 pt-8">
        <h1 className="text-lg font-medium tracking-tight">Composition</h1>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-foreground/60">
          A combinatorial code is an ordered <b>AND</b> of steps — buckets (≥1 member code
          fulfills each) and mandatory singleton codes. Pick a code to define or edit its steps;
          the buckets themselves are managed below.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          {combinatorialCodes.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setSelectedCodeId(c.id === selectedCodeId ? null : c.id)}
              title={stepSummary(c.id)}
              className={`rounded-sm border px-1.5 py-0.5 font-mono text-[12px] transition ${
                c.id === selectedCodeId
                  ? 'border-foreground bg-foreground text-background'
                  : 'border-sky-600/40 bg-sky-500/10 hover:border-sky-600'
              }`}
            >
              {c.mnemonic} <span className="opacity-60">⌗{ctx.defs[c.id].length}</span>
            </button>
          ))}
          {combinatorialCodes.length === 0 && (
            <span className="text-xs italic text-foreground/40">
              no combinatorial codes yet — pick one to start
            </span>
          )}
          <CodeCombobox
            options={codeOptions.filter((c) => !(ctx.defs[c.id]?.length > 0))}
            placeholder="make a code combinatorial…"
            onPick={(id) => setSelectedCodeId(id)}
          />
        </div>

        {selected && (
          <CombinatorialDef
            key={selected.id}
            codeId={selected.id}
            items={ctx.defs[selected.id] ?? []}
            buckets={ctx.buckets}
            allCodes={codeOptions}
            readOnly={false}
          />
        )}
      </section>

      <div className="mt-4 border-t border-foreground/10">
        <BucketManager
          codebookId={codebookId}
          buckets={ctx.buckets}
          defs={ctx.defs}
          latestSnapshotId={ctx.latestSnapshotId}
          codeOptions={codeOptions}
          readOnly={false}
          embedded
        />
      </div>
    </div>
  );
}
