'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  getCombinatorialContext,
  pushItemForkToModular,
  saveItemForkDelta,
  upsertBucket,
  type CombinatorialContext,
  type SlotItem,
} from '@/app/actions/buckets';
import { setCombinatorialDefinition } from '@/app/actions/codes';
import CodeCombobox from '@/components/codebook/CodeCombobox';
import { stagesOf, type ForkDelta } from '@/lib/codebook/combinatorial';

/**
 * STEPS — the combinatorial definition, edited INSIDE the code drawer (the
 * schema tree page), matching Hudson's model: a code is an ordered AND of
 * step slots; each bucket slot shows its EFFECTIVE members (modular + THIS
 * slot's fork Δ) and is controlled right here — toggle mandatory ★
 * (slot-local override, never a modular write), append a code to the slot
 * (fork-local until pushed), push a fork-added code to the modular bucket
 * (double-confirm; lands NON-mandatory — the mandatory meaning stays with
 * this slot), resolve modular deletions (keep/accept), reorder steps, mark
 * adjacent steps interchangeable.
 *
 * SELF-LOADING: the section fetches its own context on mount so the drawer
 * works identically wherever it's hosted (canvas inspector, triage queue,
 * code page) with zero prop-drilling through the canvas. Structure edits
 * preserve item ids (setCombinatorialDefinition diffs), so slot forks and
 * decomposition links survive a reorder.
 */

type Row = {
  /** Existing cb_code_bucket_items id, or null for a not-yet-saved step. */
  id: string | null;
  kind: 'bucket' | 'singleton';
  targetId: string;
  interchangeGroup: string; // text — '' = none
};

export default function StepsSection({
  codeId,
  codebookId,
}: {
  codeId: string;
  codebookId: string;
}) {
  const router = useRouter();
  const [ctx, setCtx] = useState<CombinatorialContext | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null); // null until ctx loads
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [structureDirty, setStructureDirty] = useState(false);
  const [newBucketOpen, setNewBucketOpen] = useState(false);
  const [newBucketName, setNewBucketName] = useState('');
  const [newBucketCaption, setNewBucketCaption] = useState('');
  const [pushArmedItem, setPushArmedItem] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const next = await getCombinatorialContext(codebookId);
    setCtx(next);
    setRows(
      (next.defs[codeId] ?? []).map((it) => ({
        id: it.id,
        kind: it.kind,
        targetId: it.kind === 'bucket' ? it.bucketId : it.codeId,
        interchangeGroup: it.interchangeGroup === null ? '' : String(it.interchangeGroup),
      })),
    );
    setStructureDirty(false);
  }, [codebookId, codeId]);

  useEffect(() => {
    let cancelled = false;
    void getCombinatorialContext(codebookId).then((next) => {
      if (cancelled) return;
      setCtx(next);
      setRows(
        (next.defs[codeId] ?? []).map((it) => ({
          id: it.id,
          kind: it.kind,
          targetId: it.kind === 'bucket' ? it.bucketId : it.codeId,
          interchangeGroup: it.interchangeGroup === null ? '' : String(it.interchangeGroup),
        })),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [codebookId, codeId]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await reload();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed.');
    } finally {
      setBusy(false);
    }
  };

  if (ctx === null || rows === null) {
    return (
      <section className="border-t border-foreground/10 pt-3">
        <p className="mb-0.5 text-[11px] uppercase tracking-wide text-foreground/35">Steps</p>
        <p className="text-[11px] italic text-foreground/40">loading…</p>
      </section>
    );
  }

  const slotById = new Map((ctx.defs[codeId] ?? []).map((it) => [it.id, it]));
  const codeById = new Map(ctx.codes.map((c) => [c.id, c]));
  const mnemonicOf = (id: string) => codeById.get(id)?.mnemonic ?? id.slice(0, 8);
  const bucketById = new Map(ctx.buckets.map((b) => [b.id, b]));

  const saveStructure = () =>
    run(() =>
      setCombinatorialDefinition(
        codeId,
        rows.map((r, i) => ({
          id: r.id,
          bucketId: r.kind === 'bucket' ? r.targetId : null,
          singletonCodeId: r.kind === 'singleton' ? r.targetId : null,
          position: i + 1,
          interchangeGroup: r.interchangeGroup.trim() === '' ? null : Number(r.interchangeGroup),
        })),
      ),
    );

  const move = (i: number, dir: -1 | 1) => {
    setRows((prev) => {
      if (!prev) return prev;
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
    setStructureDirty(true);
  };

  // ---- slot-fork edits (persist immediately — they touch no structure) -----

  const forkOf = (slot: SlotItem): ForkDelta => slot.fork ?? {};

  const toggleMandatory = (slot: SlotItem, codeIdToFlip: string, current: boolean) =>
    run(() =>
      saveItemForkDelta(slot.id, {
        ...forkOf(slot),
        mandatoryOverrides: {
          ...(forkOf(slot).mandatoryOverrides ?? {}),
          [codeIdToFlip]: !current,
        },
      }),
    );

  const addToSlot = (slot: SlotItem, addId: string) =>
    run(() =>
      saveItemForkDelta(slot.id, {
        ...forkOf(slot),
        addedCodes: [...(forkOf(slot).addedCodes ?? []), { codeId: addId, mandatory: false }],
      }),
    );

  const removeFromSlot = (slot: SlotItem, remId: string) => {
    const delta = forkOf(slot);
    const isForkAdd = (delta.addedCodes ?? []).some((a) => a.codeId === remId);
    return run(() =>
      saveItemForkDelta(
        slot.id,
        isForkAdd
          ? { ...delta, addedCodes: (delta.addedCodes ?? []).filter((a) => a.codeId !== remId) }
          : { ...delta, removedCodeIds: [...(delta.removedCodeIds ?? []), remId] },
      ),
    );
  };

  const resolveDeletion = (slot: SlotItem, delId: string, keep: boolean) => {
    const delta = forkOf(slot);
    const mem = slot.pendingDeletions.find((x) => x.codeId === delId);
    return run(() =>
      saveItemForkDelta(slot.id, {
        ...delta,
        seen: (delta.seen ?? []).filter((x) => x.codeId !== delId),
        ...(keep && mem ? { addedCodes: [...(delta.addedCodes ?? []), mem] } : {}),
      }),
    );
  };

  // Live series-parallel order preview from the CURRENT rows (pure engine).
  const preview = stagesOf(
    rows.map((r, i) =>
      r.kind === 'bucket'
        ? {
            id: `r${i}`,
            position: i + 1,
            interchangeGroup: r.interchangeGroup.trim() === '' ? null : Number(r.interchangeGroup),
            kind: 'bucket' as const,
            bucketId: r.targetId,
          }
        : {
            id: `r${i}`,
            position: i + 1,
            interchangeGroup: r.interchangeGroup.trim() === '' ? null : Number(r.interchangeGroup),
            kind: 'singleton' as const,
            codeId: r.targetId,
          },
    ),
  );
  const rowLabel = (r: Row) =>
    r.kind === 'bucket' ? bucketById.get(r.targetId)?.name ?? '(bucket)' : mnemonicOf(r.targetId);

  return (
    <section className="space-y-2 border-t border-foreground/10 pt-3">
      <p className="text-[11px] uppercase tracking-wide text-foreground/35">
        Steps
        <span className="ml-1 normal-case tracking-normal text-foreground/40">
          · {rows.length === 0 ? 'primitive — no steps' : `ordered AND of ${rows.length}`}
        </span>
      </p>

      {rows.map((r, i) => {
        const slot = r.id ? slotById.get(r.id) : undefined;
        return (
          <div key={r.id ?? `new-${i}`} className="border border-foreground/15 p-2">
            {/* Step header: order controls + identity + interchange group. */}
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="w-5 shrink-0 text-right font-mono text-foreground/40">{i + 1}.</span>
              <span className="min-w-0 flex-1 truncate font-medium">
                {rowLabel(r)}
                {r.kind === 'singleton' && (
                  <span className="ml-1 text-[10px] uppercase tracking-wide text-foreground/40">
                    mandatory code
                  </span>
                )}
              </span>
              <label className="flex items-center gap-1 text-[11px] text-foreground/50">
                ≋
                <input
                  disabled={busy}
                  value={r.interchangeGroup}
                  onChange={(e) => {
                    const v = e.target.value;
                    setRows((prev) => prev!.map((x, j) => (j === i ? { ...x, interchangeGroup: v } : x)));
                    setStructureDirty(true);
                  }}
                  placeholder="—"
                  title="Adjacent steps with the same number are order-interchangeable"
                  className="w-8 border border-foreground/25 bg-background px-1 py-0.5 text-center text-foreground"
                />
              </label>
              <button type="button" disabled={busy} onClick={() => move(i, -1)} title="move up" className="text-foreground/40 hover:text-foreground">
                ↑
              </button>
              <button type="button" disabled={busy} onClick={() => move(i, 1)} title="move down" className="text-foreground/40 hover:text-foreground">
                ↓
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setRows((prev) => prev!.filter((_, j) => j !== i));
                  setStructureDirty(true);
                }}
                title="remove step (its slot fork dies with it)"
                className="text-foreground/40 hover:text-red-600"
              >
                ×
              </button>
            </div>
            {slot?.kind === 'bucket' && slot.bucketCaption && (
              <p className="mt-0.5 text-[11px] italic text-foreground/45">{slot.bucketCaption}</p>
            )}

            {/* Pending modular deletions on this slot — never auto-pulled. */}
            {slot && slot.pendingDeletions.length > 0 && (
              <div className="mt-1.5 border border-amber-600/40 bg-amber-500/10 px-2 py-1 text-[11px]">
                <span className="font-medium text-amber-800 dark:text-amber-300">
                  deleted at modular — resolve:
                </span>
                {slot.pendingDeletions.map((d) => (
                  <span key={d.codeId} className="ml-2 inline-flex items-center gap-1">
                    <span className="font-mono">{mnemonicOf(d.codeId)}</span>
                    <button type="button" disabled={busy} onClick={() => void resolveDeletion(slot, d.codeId, true)} className="underline hover:no-underline">
                      keep
                    </button>
                    <button type="button" disabled={busy} onClick={() => void resolveDeletion(slot, d.codeId, false)} className="underline hover:no-underline">
                      accept
                    </button>
                  </span>
                ))}
              </div>
            )}

            {/* Bucket slot: the EFFECTIVE members, controlled here. */}
            {slot?.kind === 'bucket' ? (
              <>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {slot.effectiveMembers.map((mem) => {
                    const isForkAdd = (slot.fork?.addedCodes ?? []).some((a) => a.codeId === mem.codeId);
                    return (
                      <span
                        key={mem.codeId}
                        className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-[11px] ${
                          isForkAdd ? 'border-sky-600/40 bg-sky-500/10' : 'border-emerald-600/40 bg-emerald-500/10'
                        }`}
                        title={isForkAdd ? 'appended to THIS step only (fork-local until pushed)' : 'modular member'}
                      >
                        {mnemonicOf(mem.codeId)}
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void toggleMandatory(slot, mem.codeId, mem.mandatory)}
                          title={`mandatory in THIS step: ${mem.mandatory ? 'yes' : 'no'} — slot-local, never a modular write`}
                          className={mem.mandatory ? 'text-amber-700' : 'text-foreground/30 hover:text-foreground/70'}
                        >
                          ★
                        </button>
                        {isForkAdd &&
                          (pushArmedItem === `${slot.id}|${mem.codeId}` ? (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => {
                                setPushArmedItem(null);
                                void run(() => pushItemForkToModular(slot.id));
                              }}
                              title="Second confirm — adds the fork's appended codes to the SHARED bucket, NON-mandatory (mandatory stays slot-local)"
                              className="border border-red-600 bg-red-600/10 px-1 text-[10px] text-red-700 dark:text-red-400"
                            >
                              confirm?
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => setPushArmedItem(`${slot.id}|${mem.codeId}`)}
                              title="Push to the modular bucket (double-confirm). Lands NON-mandatory — the ★ stays local to this step."
                              className="text-sky-700 hover:text-sky-500"
                            >
                              ⇧
                            </button>
                          ))}
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void removeFromSlot(slot, mem.codeId)}
                          title={isForkAdd ? 'remove the appended code' : 'remove from THIS step only (fork-local removal)'}
                          className="text-foreground/40 hover:text-red-600"
                        >
                          ×
                        </button>
                      </span>
                    );
                  })}
                </div>
                <div className="mt-1.5">
                  <CodeCombobox
                    options={ctx.codes.filter(
                      (c) => c.id !== codeId && !slot.effectiveMembers.some((mem) => mem.codeId === c.id),
                    )}
                    placeholder="append a code to this step…"
                    disabled={busy}
                    onPick={(id) => void addToSlot(slot, id)}
                  />
                </div>
              </>
            ) : slot?.kind === 'singleton' ? null : (
              // Not yet saved (or target unpicked): choose what this step is.
              <div className="mt-1.5">
                {r.kind === 'bucket' ? (
                  <select
                    disabled={busy}
                    value={r.targetId}
                    onChange={(e) => {
                      const v = e.target.value;
                      setRows((prev) => prev!.map((x, j) => (j === i ? { ...x, targetId: v } : x)));
                      setStructureDirty(true);
                    }}
                    className="border border-foreground/25 bg-background px-1.5 py-1 text-xs text-foreground"
                  >
                    <option value="">choose a bucket…</option>
                    {ctx.buckets.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                ) : r.targetId === '' ? (
                  <CodeCombobox
                    options={ctx.codes.filter((c) => c.id !== codeId)}
                    placeholder="search the mandatory code…"
                    disabled={busy}
                    onPick={(id) => {
                      setRows((prev) => prev!.map((x, j) => (j === i ? { ...x, targetId: id } : x)));
                      setStructureDirty(true);
                    }}
                  />
                ) : (
                  <span className="inline-flex items-center gap-1 border border-emerald-600/40 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[11px]">
                    {mnemonicOf(r.targetId)}
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* Series-parallel order preview. */}
      {rows.length > 0 && (
        <p className="text-[11px] text-foreground/45">
          order:{' '}
          {preview
            .map((st) =>
              st.itemIds.length > 1
                ? `{${st.itemIds.map((id) => rowLabel(rows[Number(id.slice(1))])).join(', ')}}`
                : rowLabel(rows[Number(st.itemIds[0].slice(1))]),
            )
            .join(' ≺ ')}{' '}
          · first-evidence, out-of-order saves with a warn flag
        </p>
      )}

      {/* Add a step: an existing bucket, a brand-new bucket, or a mandatory code. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <select
          disabled={busy}
          value=""
          onChange={(e) => {
            const v = e.target.value;
            if (!v) return;
            if (v === '__new__') {
              setNewBucketOpen(true);
              return;
            }
            setRows((prev) => [...(prev ?? []), { id: null, kind: 'bucket', targetId: v, interchangeGroup: '' }]);
            setStructureDirty(true);
          }}
          className="border border-dashed border-foreground/30 bg-background px-2 py-1 text-xs text-foreground/60"
        >
          <option value="">+ bucket step…</option>
          {ctx.buckets.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
          <option value="__new__">new bucket…</option>
        </select>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setRows((prev) => [...(prev ?? []), { id: null, kind: 'singleton', targetId: '', interchangeGroup: '' }]);
            setStructureDirty(true);
          }}
          className="border border-dashed border-foreground/30 px-2 py-1 text-xs text-foreground/60 transition hover:border-foreground hover:text-foreground"
        >
          + mandatory code
        </button>
        {structureDirty && (
          <button
            type="button"
            disabled={busy || rows.some((r) => r.targetId === '')}
            onClick={() => void saveStructure()}
            className="border border-foreground bg-foreground px-2 py-1 text-xs text-background transition hover:opacity-90 disabled:opacity-40"
          >
            {busy ? 'Saving…' : 'Save steps'}
          </button>
        )}
      </div>

      {/* Inline new-bucket creation — the modular list grows from HERE, mid-flow. */}
      {newBucketOpen && (
        <div className="flex flex-wrap items-end gap-1.5 border border-foreground/15 p-2">
          <label className="flex flex-col gap-0.5 text-[11px] text-foreground/50">
            new bucket (a general action)
            <input
              value={newBucketName}
              onChange={(e) => setNewBucketName(e.target.value)}
              placeholder="e.g. Review"
              className="border border-foreground/25 bg-background px-1.5 py-1 text-xs text-foreground"
            />
          </label>
          <label className="flex min-w-48 flex-1 flex-col gap-0.5 text-[11px] text-foreground/50">
            caption
            <input
              value={newBucketCaption}
              onChange={(e) => setNewBucketCaption(e.target.value)}
              placeholder="what fulfills it"
              className="border border-foreground/25 bg-background px-1.5 py-1 text-xs text-foreground"
            />
          </label>
          <button
            type="button"
            disabled={busy || !newBucketName.trim()}
            onClick={() =>
              void run(async () => {
                const id = await upsertBucket({
                  codebookId,
                  name: newBucketName,
                  caption: newBucketCaption || null,
                });
                setRows((prev) => [...(prev ?? []), { id: null, kind: 'bucket', targetId: id, interchangeGroup: '' }]);
                setStructureDirty(true);
                setNewBucketOpen(false);
                setNewBucketName('');
                setNewBucketCaption('');
              })
            }
            className="border border-foreground bg-foreground px-2 py-1 text-xs text-background transition hover:opacity-90 disabled:opacity-40"
          >
            create
          </button>
          <button type="button" onClick={() => setNewBucketOpen(false)} className="px-1 text-xs text-foreground/50 hover:text-foreground">
            cancel
          </button>
        </div>
      )}

      <p className="text-[11px] leading-snug text-foreground/40">
        A step is fulfilled by ≥1 of its codes; ★ = mandatory <i>in this step</i>. Appended codes
        (blue) live on this step only until pushed (⇧) to the shared bucket — the push lands them
        non-mandatory. No OR: apparent disjunction is subsumption.
      </p>

      {error && <p className="text-xs text-red-600">{error}</p>}
    </section>
  );
}
