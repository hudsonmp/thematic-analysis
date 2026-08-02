'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  batchPullMyForks,
  cutSnapshot,
  deleteBucket,
  pushForkToModular,
  saveMyForkDelta,
  setBucketMembers,
  upsertBucket,
  type BucketView,
} from '@/app/actions/buckets';
import type { DefItem, ForkDelta } from '@/lib/codebook/combinatorial';
import CodeCombobox, { type ComboCode } from '@/components/codebook/CodeCombobox';

/**
 * Modular-bucket manager (v2). Two edit SCOPES per bucket, chosen explicitly:
 *
 *   modular — edits the shared canonical list. Every fork that hasn't
 *             overridden the attribute pulls it automatically.
 *   my fork — records only a Δ (added codes, mandatory flips, caption);
 *             the modular bucket is untouched until PUSH (double-confirm).
 *
 * Deletions at modular NEVER auto-pull into forks: they surface here as
 * pending-deletion flags with explicit keep/accept resolution. Batch pull
 * refreshes every fork's `seen` list and cuts a 'pull' snapshot — run it
 * between coding sessions, not mid-session.
 */
export default function BucketManager({
  codebookId,
  buckets,
  defs,
  latestSnapshotId,
  codeOptions,
  readOnly,
  embedded = false,
}: {
  codebookId: string;
  buckets: BucketView[];
  defs: Record<string, DefItem[]>;
  latestSnapshotId: string | null;
  codeOptions: ComboCode[];
  readOnly: boolean;
  /** True when rendered INSIDE another page (the /codebook Buckets tab) —
   *  section semantics instead of a page <main>. */
  embedded?: boolean;
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

  // Which combinatorial codes reference a bucket (shown so a delete refusal is
  // explicable, and so the "general action" reads with its uses).
  const usedBy = (bucketId: string): string[] =>
    Object.entries(defs)
      .filter(([, items]) => items.some((i) => i.kind === 'bucket' && i.bucketId === bucketId))
      .map(([codeId]) => codeOptions.find((c) => c.id === codeId)?.mnemonic ?? codeId.slice(0, 8));

  const Root = embedded ? 'section' : 'main';
  return (
    <Root className={embedded ? 'mx-auto max-w-4xl px-6 py-6' : 'mx-auto max-w-4xl px-6 py-10'}>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-medium tracking-tight">Modular buckets</h1>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-foreground/60">
            The running list of shared steps. A bucket names a <b>general action</b> (e.g. Review);
            it is fulfilled when ≥1 member code is assigned. Combinatorial codes are ordered ANDs
            of these buckets — authored on each code&apos;s page.
          </p>
        </div>
        {!readOnly && (
          <div className="flex items-center gap-2 text-xs">
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => batchPullMyForks(codebookId))}
              title="Refresh every fork's seen-list (deletion flags derive from the gap) + cut a 'pull' snapshot. Between coding sessions only."
              className="border border-foreground/25 px-2 py-1 transition hover:border-foreground disabled:opacity-40"
            >
              batch pull my forks
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => cutSnapshot(codebookId, 'manual'))}
              className="border border-foreground/25 px-2 py-1 transition hover:border-foreground disabled:opacity-40"
            >
              cut snapshot
            </button>
          </div>
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
              placeholder="short description — pushes/pulls like any attribute"
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

      {/* Buckets */}
      <section className="mt-6 space-y-4">
        {buckets.length === 0 && (
          <p className="text-sm text-foreground/50">
            No buckets yet. Create the first general action above, then compose codes from it on
            their code pages.
          </p>
        )}
        {buckets.map((b) => (
          <BucketCard
            key={b.id}
            bucket={b}
            usedBy={usedBy(b.id)}
            codeOptions={codeOptions}
            codebookId={codebookId}
            busy={busy}
            readOnly={readOnly}
            run={run}
          />
        ))}
      </section>
    </Root>
  );
}

function BucketCard({
  bucket,
  usedBy,
  codeOptions,
  codebookId,
  busy,
  readOnly,
  run,
}: {
  bucket: BucketView;
  usedBy: string[];
  codeOptions: ComboCode[];
  codebookId: string;
  busy: boolean;
  readOnly: boolean;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [scope, setScope] = useState<'modular' | 'fork'>('modular');
  const [pushArmed, setPushArmed] = useState(false);

  const mnemonicOf = (codeId: string) =>
    codeOptions.find((c) => c.id === codeId)?.mnemonic ?? codeId.slice(0, 8);

  const delta: ForkDelta = bucket.myDelta ?? {};
  const addedIds = new Set((delta.addedCodes ?? []).map((a) => a.codeId));
  const hasDelta =
    (delta.addedCodes?.length ?? 0) > 0 ||
    Object.keys(delta.mandatoryOverrides ?? {}).length > 0 ||
    delta.caption !== undefined ||
    (delta.removedCodeIds?.length ?? 0) > 0;

  const saveDelta = (next: ForkDelta) => run(() => saveMyForkDelta(bucket.id, next));

  const addMember = (codeId: string) => {
    if (!codeId) return;
    if (scope === 'modular') {
      const next = [...bucket.modularMembers, { codeId, mandatory: false }];
      void run(() => setBucketMembers(bucket.id, next));
    } else {
      void saveDelta({
        ...delta,
        addedCodes: [...(delta.addedCodes ?? []), { codeId, mandatory: false }],
      });
    }
  };

  const toggleMandatory = (codeId: string, current: boolean) => {
    if (scope === 'modular') {
      const next = bucket.modularMembers.map((m) =>
        m.codeId === codeId ? { ...m, mandatory: !m.mandatory } : m,
      );
      void run(() => setBucketMembers(bucket.id, next));
    } else {
      void saveDelta({
        ...delta,
        mandatoryOverrides: { ...(delta.mandatoryOverrides ?? {}), [codeId]: !current },
      });
    }
  };

  const removeMember = (codeId: string) => {
    if (scope === 'modular') {
      const next = bucket.modularMembers.filter((m) => m.codeId !== codeId);
      void run(() => setBucketMembers(bucket.id, next));
    } else if (addedIds.has(codeId)) {
      void saveDelta({
        ...delta,
        addedCodes: (delta.addedCodes ?? []).filter((a) => a.codeId !== codeId),
      });
    } else {
      void saveDelta({
        ...delta,
        removedCodeIds: [...(delta.removedCodeIds ?? []), codeId],
      });
    }
  };

  // Pending modular deletions (never auto-pulled): keep = re-add to MY fork;
  // accept = drop it from my seen list so the flag clears.
  const resolveDeletion = (codeId: string, keep: boolean) => {
    const mem = bucket.pendingDeletions.find((m) => m.codeId === codeId);
    const nextSeen = (delta.seen ?? []).filter((m) => m.codeId !== codeId);
    void saveDelta({
      ...delta,
      seen: nextSeen,
      ...(keep && mem
        ? { addedCodes: [...(delta.addedCodes ?? []), mem] }
        : {}),
    });
  };

  return (
    <div className="border border-foreground/15 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-medium">
            {bucket.name}
            {hasDelta && (
              <span className="ml-2 rounded-sm bg-sky-500/15 px-1 text-[10px] uppercase tracking-wide text-sky-800 dark:text-sky-300">
                my Δ
              </span>
            )}
          </h2>
          <p className="text-xs italic text-foreground/50">{bucket.caption ?? 'no caption'}</p>
          {usedBy.length > 0 && (
            <p className="mt-0.5 text-[11px] text-foreground/40">
              used by: <span className="font-mono">{usedBy.join(', ')}</span>
            </p>
          )}
        </div>
        {!readOnly && (
          <div className="flex shrink-0 items-center gap-2 text-[11px]">
            <label className="flex items-center gap-1 text-foreground/50">
              edit scope
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value as 'modular' | 'fork')}
                className="border border-foreground/25 bg-background px-1 py-0.5 text-foreground"
              >
                <option value="modular">modular (shared)</option>
                <option value="fork">my fork (Δ only)</option>
              </select>
            </label>
            {hasDelta &&
              (pushArmed ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setPushArmed(false);
                    void run(() => pushForkToModular(codebookId, bucket.id));
                  }}
                  className="border border-red-600 bg-red-600/10 px-1.5 py-0.5 text-red-700 dark:text-red-400"
                  title="Second confirm — this mutates the SHARED bucket (last-write-wins, logged)"
                >
                  confirm push?
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setPushArmed(true)}
                  title="Push my Δ (added codes, mandatory flips, caption) to the modular bucket — double-confirm"
                  className="border border-foreground/25 px-1.5 py-0.5 transition hover:border-foreground"
                >
                  push Δ → modular
                </button>
              ))}
            {usedBy.length === 0 && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => deleteBucket(bucket.id))}
                className="text-foreground/40 hover:text-red-600"
                title="Delete this bucket (only possible while no code references it)"
              >
                delete
              </button>
            )}
          </div>
        )}
      </div>

      {/* Pending modular deletions — never auto-pulled. */}
      {bucket.pendingDeletions.length > 0 && (
        <div className="mt-2 border border-amber-600/40 bg-amber-500/10 px-2 py-1.5 text-xs">
          <p className="font-medium text-amber-800 dark:text-amber-300">
            Deleted at modular since your last pull — resolve manually:
          </p>
          {bucket.pendingDeletions.map((m) => (
            <p key={m.codeId} className="mt-1 flex items-center gap-2">
              <span className="font-mono">{mnemonicOf(m.codeId)}</span>
              <button
                type="button"
                disabled={busy || readOnly}
                onClick={() => resolveDeletion(m.codeId, true)}
                className="underline hover:no-underline"
              >
                keep in my fork
              </button>
              <button
                type="button"
                disabled={busy || readOnly}
                onClick={() => resolveDeletion(m.codeId, false)}
                className="underline hover:no-underline"
              >
                accept deletion
              </button>
            </p>
          ))}
        </div>
      )}

      {/* Effective members under MY fork. */}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {bucket.members.map((m) => {
          const isAdded = addedIds.has(m.codeId);
          const overridden = m.codeId in (delta.mandatoryOverrides ?? {});
          return (
            <span
              key={m.codeId}
              className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-[11px] ${
                isAdded
                  ? 'border-sky-600/40 bg-sky-500/10'
                  : 'border-emerald-600/40 bg-emerald-500/10'
              }`}
              title={isAdded ? 'fork-local (unpushed — cannot substitute into standard slots)' : 'modular member'}
            >
              {mnemonicOf(m.codeId)}
              <button
                type="button"
                disabled={busy || readOnly}
                onClick={() => toggleMandatory(m.codeId, m.mandatory)}
                title={`mandatory: ${m.mandatory ? 'yes' : 'no'}${overridden ? ' (fork override)' : ''} — click to flip in the ${scope} scope`}
                className={m.mandatory ? 'text-amber-700' : 'text-foreground/30 hover:text-foreground/70'}
              >
                ★
              </button>
              {!readOnly && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => removeMember(m.codeId)}
                  title={scope === 'modular' ? 'remove from the SHARED bucket' : 'remove from MY fork only'}
                  className="text-foreground/40 hover:text-red-600"
                >
                  ×
                </button>
              )}
            </span>
          );
        })}
        {bucket.members.length === 0 && (
          <span className="text-xs italic text-foreground/40">
            empty — a combinatorial code cannot reference an empty bucket
          </span>
        )}
      </div>

      {!readOnly && (
        <div className="mt-2 flex items-center gap-2">
          {/* The coding screen's searchable picker, not a 60-option native
              select: type-to-search, ⏎ adds to the active scope immediately. */}
          <CodeCombobox
            options={codeOptions.filter((c) => !bucket.members.some((m) => m.codeId === c.id))}
            placeholder={`add a member code… (→ ${scope === 'modular' ? 'shared bucket' : 'my fork'})`}
            disabled={busy}
            onPick={addMember}
          />
        </div>
      )}
    </div>
  );
}
