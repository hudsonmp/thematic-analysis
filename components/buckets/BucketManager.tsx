'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  cutSnapshot,
  deleteBucket,
  setBucketMembers,
  upsertBucket,
  type BucketView,
  type SlotItem,
} from '@/app/actions/buckets';
import CodeCombobox, { type ComboCode } from '@/components/codebook/CodeCombobox';

/**
 * The MODULAR bucket reference (v2, per-slot fork model): the shared canonical
 * list only. Editing here is editing the CANONICAL — every step slot that
 * never overrode an attribute pulls the change automatically at read time.
 *
 * FORKS ARE NOT HERE by design: a fork is an overlay on one code's STEP SLOT,
 * so it is edited in that code's drawer (STEPS section on the tree page). The
 * ★ on this page is the bucket's BASELINE mandatory flag; a slot can override
 * it locally without touching this list.
 */
export default function BucketManager({
  codebookId,
  buckets,
  defs,
  latestSnapshotId,
  codeOptions,
  readOnly,
}: {
  codebookId: string;
  buckets: BucketView[];
  defs: Record<string, SlotItem[]>;
  latestSnapshotId: string | null;
  codeOptions: ComboCode[];
  readOnly: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newCaption, setNewCaption] = useState('');

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Operation failed.');
    } finally {
      setBusy(false);
    }
  };

  // Which combinatorial codes reference a bucket (delete refusals become
  // explicable, and a "general action" reads with its uses).
  const usedBy = (bucketId: string): string[] =>
    Object.entries(defs)
      .filter(([, items]) => items.some((i) => i.kind === 'bucket' && i.bucketId === bucketId))
      .map(([codeId]) => codeOptions.find((c) => c.id === codeId)?.mnemonic ?? codeId.slice(0, 8));

  const mnemonicOf = (codeId: string) =>
    codeOptions.find((c) => c.id === codeId)?.mnemonic ?? codeId.slice(0, 8);

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-medium tracking-tight">Modular buckets</h1>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-foreground/60">
            The shared canonical list of general actions (e.g. Review). Codes compose these into
            steps in each code&apos;s drawer on the tree page — where a step needs its own variant,
            it forks the slot THERE; this page is the modular baseline every slot pulls from.
          </p>
        </div>
        {!readOnly && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => cutSnapshot(codebookId, 'manual'))}
            className="border border-foreground/25 px-2 py-1 text-xs transition hover:border-foreground disabled:opacity-40"
          >
            cut snapshot
          </button>
        )}
      </header>
      <p className="mt-1 text-[11px] text-foreground/40">
        latest snapshot: {latestSnapshotId ? latestSnapshotId.slice(0, 8) : 'none yet'} · every
        assignment records the snapshot it was coded under
      </p>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      {/* Create */}
      {!readOnly && (
        <section className="mt-6 flex flex-wrap items-end gap-2 border border-foreground/15 p-3">
          <label className="flex flex-col gap-1 text-xs text-foreground/60">
            New bucket (a general action)
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. Review"
              className="border border-foreground/25 bg-background px-2 py-1 text-sm text-foreground"
            />
          </label>
          <label className="flex min-w-64 flex-1 flex-col gap-1 text-xs text-foreground/60">
            Caption (what fulfills it)
            <input
              value={newCaption}
              onChange={(e) => setNewCaption(e.target.value)}
              placeholder="short description shown in every slot that uses it"
              className="border border-foreground/25 bg-background px-2 py-1 text-sm text-foreground"
            />
          </label>
          <button
            type="button"
            disabled={busy || !newName.trim()}
            onClick={() =>
              void run(async () => {
                await upsertBucket({ codebookId, name: newName, caption: newCaption || null });
                setNewName('');
                setNewCaption('');
              })
            }
            className="border border-foreground bg-foreground px-3 py-1.5 text-sm text-background transition hover:opacity-90 disabled:opacity-40"
          >
            Add
          </button>
        </section>
      )}

      {/* The modular list */}
      <section className="mt-6 space-y-4">
        {buckets.length === 0 && (
          <p className="text-sm text-foreground/50">
            No buckets yet. Create the first general action above — or straight from a code&apos;s
            STEPS section on the tree page.
          </p>
        )}
        {buckets.map((b) => {
          const uses = usedBy(b.id);
          return (
            <div key={b.id} className="border border-foreground/15 p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="text-sm font-medium">{b.name}</h2>
                  <p className="text-xs italic text-foreground/50">{b.caption ?? 'no caption'}</p>
                  {uses.length > 0 && (
                    <p className="mt-0.5 text-[11px] text-foreground/40">
                      used by: <span className="font-mono">{uses.join(', ')}</span>
                    </p>
                  )}
                </div>
                {!readOnly && uses.length === 0 && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run(() => deleteBucket(b.id))}
                    className="text-xs text-foreground/40 hover:text-red-600"
                    title="Delete this bucket (only possible while no code references it)"
                  >
                    delete
                  </button>
                )}
              </div>

              <div className="mt-2 flex flex-wrap gap-1.5">
                {b.members.map((mem) => (
                  <span
                    key={mem.codeId}
                    className="inline-flex items-center gap-1 rounded-sm border border-emerald-600/40 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[11px]"
                  >
                    {mnemonicOf(mem.codeId)}
                    <button
                      type="button"
                      disabled={busy || readOnly}
                      onClick={() =>
                        void run(() =>
                          setBucketMembers(
                            b.id,
                            b.members.map((x) =>
                              x.codeId === mem.codeId ? { ...x, mandatory: !x.mandatory } : x,
                            ),
                          ),
                        )
                      }
                      title={`baseline mandatory: ${mem.mandatory ? 'yes' : 'no'} — slots can override locally`}
                      className={mem.mandatory ? 'text-amber-700' : 'text-foreground/30 hover:text-foreground/70'}
                    >
                      ★
                    </button>
                    {!readOnly && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void run(() =>
                            setBucketMembers(
                              b.id,
                              b.members.filter((x) => x.codeId !== mem.codeId),
                            ),
                          )
                        }
                        title="remove from the SHARED bucket (slots that saw it will flag the deletion)"
                        className="text-foreground/40 hover:text-red-600"
                      >
                        ×
                      </button>
                    )}
                  </span>
                ))}
                {b.members.length === 0 && (
                  <span className="text-xs italic text-foreground/40">
                    empty — a step cannot reference an empty bucket
                  </span>
                )}
              </div>

              {!readOnly && (
                <div className="mt-2">
                  <CodeCombobox
                    options={codeOptions.filter((c) => !b.members.some((mem) => mem.codeId === c.id))}
                    placeholder="add a member code to the shared bucket…"
                    disabled={busy}
                    onPick={(id) =>
                      void run(() =>
                        setBucketMembers(b.id, [...b.members, { codeId: id, mandatory: false }]),
                      )
                    }
                  />
                </div>
              )}
            </div>
          );
        })}
      </section>
    </main>
  );
}
