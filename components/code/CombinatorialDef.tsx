'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { setCombinatorialDefinition } from '@/app/actions/codes';
import type { BucketView } from '@/app/actions/buckets';
import { stagesOf, type DefItem } from '@/lib/codebook/combinatorial';
import CodeCombobox, { type ComboCode } from '@/components/codebook/CodeCombobox';

/**
 * The combinatorial-definition editor on a code's page (v2): the ordered AND
 * of items — modular-bucket references and mandatory singleton codes — with
 * contiguous interchange groups. Primitive codes have no rows. The DAG /
 * empty-bucket / contiguity guards run SERVER-side on save (the engine), and
 * their rejections render verbatim here; the stage preview below the rows is
 * the series-parallel order the coder will be held to (by first evidence,
 * warn-only).
 */

type Row = {
  kind: 'bucket' | 'singleton';
  targetId: string;
  interchangeGroup: string; // keep as text — '' = none
};

export default function CombinatorialDef({
  codeId,
  items,
  buckets,
  allCodes,
  readOnly,
}: {
  codeId: string;
  items: DefItem[];
  buckets: BucketView[];
  allCodes: ComboCode[];
  readOnly: boolean;
}) {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>(() =>
    items.map((it) => ({
      kind: it.kind,
      targetId: it.kind === 'bucket' ? it.bucketId : it.codeId,
      interchangeGroup: it.interchangeGroup === null ? '' : String(it.interchangeGroup),
    })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  const save = async () => {
    setBusy(true);
    setError(null);
    setSavedFlash(false);
    try {
      await setCombinatorialDefinition(
        codeId,
        rows.map((r, i) => ({
          bucketId: r.kind === 'bucket' ? r.targetId : null,
          singletonCodeId: r.kind === 'singleton' ? r.targetId : null,
          position: i + 1,
          interchangeGroup: r.interchangeGroup.trim() === '' ? null : Number(r.interchangeGroup),
        })),
      );
      setSavedFlash(true);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed.');
    } finally {
      setBusy(false);
    }
  };

  const move = (i: number, dir: -1 | 1) => {
    setRows((prev) => {
      const next = [...prev];
      const j = i + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };

  // Live stage preview from the CURRENT rows (pure engine call).
  const preview = stagesOf(
    rows.map((r, i) =>
      r.kind === 'bucket'
        ? ({
            id: `r${i}`,
            position: i + 1,
            interchangeGroup: r.interchangeGroup.trim() === '' ? null : Number(r.interchangeGroup),
            kind: 'bucket',
            bucketId: r.targetId,
          } as DefItem)
        : ({
            id: `r${i}`,
            position: i + 1,
            interchangeGroup: r.interchangeGroup.trim() === '' ? null : Number(r.interchangeGroup),
            kind: 'singleton',
            codeId: r.targetId,
          } as DefItem),
    ),
  );
  const labelOf = (r: Row) =>
    r.kind === 'bucket'
      ? buckets.find((b) => b.id === r.targetId)?.name ?? '(bucket)'
      : allCodes.find((c) => c.id === r.targetId)?.mnemonic ?? '(code)';

  return (
    <section className="mt-8 border border-foreground/15 p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">
          Combinatorial definition{' '}
          <span className="font-normal text-foreground/45">
            · {rows.length === 0 ? 'primitive (no steps)' : `${rows.length} step item${rows.length === 1 ? '' : 's'}`}
          </span>
        </h2>
        {savedFlash && <span className="text-xs text-emerald-700">saved ✓</span>}
      </div>
      <p className="mt-1 max-w-2xl text-xs leading-relaxed text-foreground/55">
        An ordered <b>AND</b> of steps: each row is a modular bucket (≥1 member code fulfills it)
        or a mandatory singleton code. Adjacent rows sharing an interchange group number are
        order-interchangeable. No OR — apparent disjunction is subsumption. Cycles and empty
        buckets are rejected on save.
      </p>

      <div className="mt-3 space-y-1.5">
        {rows.map((r, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2 text-xs">
            <span className="w-8 shrink-0 text-right font-mono text-foreground/40">{i + 1}.</span>
            <select
              disabled={readOnly}
              value={r.kind}
              onChange={(e) =>
                setRows((prev) =>
                  prev.map((x, j) => (j === i ? { ...x, kind: e.target.value as Row['kind'], targetId: '' } : x)),
                )
              }
              className="border border-foreground/25 bg-background px-1.5 py-1 text-foreground"
            >
              <option value="bucket">bucket</option>
              <option value="singleton">mandatory code</option>
            </select>
            {r.kind === 'bucket' ? (
              <select
                disabled={readOnly}
                value={r.targetId}
                onChange={(e) =>
                  setRows((prev) => prev.map((x, j) => (j === i ? { ...x, targetId: e.target.value } : x)))
                }
                className="min-w-48 border border-foreground/25 bg-background px-1.5 py-1 font-mono text-foreground"
              >
                <option value="">choose…</option>
                {buckets.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            ) : r.targetId !== '' ? (
              // Singleton picked: show it as a chip; × clears back to search.
              <span className="inline-flex items-center gap-1 border border-emerald-600/40 bg-emerald-500/10 px-1.5 py-0.5 font-mono">
                {allCodes.find((c) => c.id === r.targetId)?.mnemonic ?? r.targetId.slice(0, 8)}
                {!readOnly && (
                  <button
                    type="button"
                    onClick={() =>
                      setRows((prev) => prev.map((x, j) => (j === i ? { ...x, targetId: '' } : x)))
                    }
                    className="text-foreground/40 hover:text-red-600"
                  >
                    ×
                  </button>
                )}
              </span>
            ) : (
              // The coding screen's searchable picker, not a 60-option select.
              <CodeCombobox
                options={allCodes.filter((c) => c.id !== codeId)}
                placeholder="search a code…"
                disabled={readOnly}
                onPick={(id) =>
                  setRows((prev) => prev.map((x, j) => (j === i ? { ...x, targetId: id } : x)))
                }
              />
            )}
            <label className="flex items-center gap-1 text-foreground/50">
              ≋ group
              <input
                disabled={readOnly}
                value={r.interchangeGroup}
                onChange={(e) =>
                  setRows((prev) =>
                    prev.map((x, j) => (j === i ? { ...x, interchangeGroup: e.target.value } : x)),
                  )
                }
                placeholder="—"
                className="w-10 border border-foreground/25 bg-background px-1 py-1 text-center text-foreground"
                title="Adjacent rows with the same number are order-interchangeable"
              />
            </label>
            {!readOnly && (
              <span className="flex items-center gap-1">
                <button type="button" onClick={() => move(i, -1)} className="text-foreground/40 hover:text-foreground" title="move up">
                  ↑
                </button>
                <button type="button" onClick={() => move(i, 1)} className="text-foreground/40 hover:text-foreground" title="move down">
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
                  className="text-foreground/40 hover:text-red-600"
                  title="remove step"
                >
                  ×
                </button>
              </span>
            )}
          </div>
        ))}
      </div>

      {rows.length > 0 && (
        <p className="mt-2 text-[11px] text-foreground/45">
          order:{' '}
          {preview
            .map((s) =>
              s.itemIds.length > 1
                ? `{${s.itemIds.map((id) => labelOf(rows[Number(id.slice(1))])).join(', ')}}`
                : labelOf(rows[Number(s.itemIds[0].slice(1))]),
            )
            .join(' ≺ ')}{' '}
          · evaluated by first evidence, out-of-order saves with a warn flag
        </p>
      )}

      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

      {!readOnly && (
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setRows((prev) => [...prev, { kind: 'bucket', targetId: '', interchangeGroup: '' }])}
            className="border border-dashed border-foreground/30 px-2 py-1 text-xs text-foreground/60 transition hover:border-foreground hover:text-foreground"
          >
            + step
          </button>
          <button
            type="button"
            disabled={busy || rows.some((r) => r.targetId === '')}
            onClick={() => void save()}
            className="border border-foreground bg-foreground px-2 py-1 text-xs text-background transition hover:opacity-90 disabled:opacity-40"
          >
            {busy ? 'Saving…' : 'Save definition'}
          </button>
          {rows.length === 0 && items.length > 0 && (
            <span className="text-[11px] text-foreground/45">saving with no rows makes the code primitive again</span>
          )}
        </div>
      )}
    </section>
  );
}
