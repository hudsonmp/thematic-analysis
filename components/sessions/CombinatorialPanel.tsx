'use client';

import { useMemo, useState } from 'react';
import type { BucketView } from '@/app/actions/buckets';
import type { AssignmentChildInput } from '@/app/actions/assignments';
import { subsumption, type DefItem } from '@/lib/codebook/combinatorial';
import type { PopupCode } from './CodingPopup';

/**
 * The SKIPPABLE decomposition popup for a combinatorial code (v2 spec):
 * the parent's ordered AND items — named buckets (candidate children,
 * mandatory ★ items) and singleton codes — with entailment PRE-FILL from
 * in-span assignments (auto-checked, provenance "via c₁" for subsumption).
 *
 * Statuses map to the three exits:
 *   Save links     → decomposed (partial or full — both valid)
 *   Skip           → attested (assertion without documented evidence)
 *   Mark pending   → pending (not yet asserted; blocks IRR until resolved)
 *
 * Candidates come from two sources, both LINKED (never copied):
 *   · codes on the SAME annotation (top-down: tick → assigned on save)
 *   · other in-span assignments (bottom-up promotion: existing spans ⊆ parent)
 * Order is evaluated server-side on save (first evidence); a violation WARNS.
 */

export type InSpanAssignment = {
  annotationId: string;
  codeId: string;
  mnemonic: string;
  /** First sentence ordinal of the assignment's span (display + ordering). */
  startOrd: number;
  quote: string;
};

type PickKey = string; // `${annotationId|self}|${codeId}`

export default function CombinatorialPanel({
  parentCode,
  items,
  buckets,
  defs,
  codesById,
  assignedCodeIds,
  inSpan,
  busy,
  onSave,
  onSkip,
  onPending,
}: {
  parentCode: PopupCode;
  items: DefItem[];
  buckets: BucketView[];
  defs: Record<string, DefItem[]>;
  codesById: Map<string, PopupCode>;
  /** Codes already assigned on the SAME annotation as the parent. */
  assignedCodeIds: string[];
  /** Other in-span assignments (their spans ⊆ the parent's span). */
  inSpan: InSpanAssignment[];
  busy: boolean;
  onSave: (
    links: AssignmentChildInput[],
    assignFirstCodeIds: string[],
  ) => Promise<{ orderViolated: boolean; complete: boolean } | void>;
  onSkip: () => void;
  onPending: () => void;
}) {
  const bucketById = useMemo(() => new Map(buckets.map((b) => [b.id, b])), [buckets]);

  // ---- entailment pre-fill --------------------------------------------------
  // Direct: an in-span / same-annotation code admissible in an item's bucket.
  // Subsumption: an in-span COMBINATORIAL code c₁ whose buckets entail a subset
  // of the parent's buckets (fork view for c₁, MODULAR view for the parent —
  // unpushed fork codes cannot substitute into standard slots).
  const prefill = useMemo(() => {
    const picks = new Map<string, Set<PickKey>>(); // itemId → keys
    const via = new Map<PickKey, string>(); // key → subsuming code id ("via c₁")
    const add = (itemId: string, key: PickKey) => {
      const s = picks.get(itemId) ?? new Set<PickKey>();
      s.add(key);
      picks.set(itemId, s);
    };
    const sources: { annotationId: string | null; codeId: string }[] = [
      ...assignedCodeIds.map((c) => ({ annotationId: null, codeId: c })),
      ...inSpan.map((a) => ({ annotationId: a.annotationId, codeId: a.codeId })),
    ];
    const forkMembers = (bid: string) => bucketById.get(bid)?.members ?? [];
    const modularMembers = (bid: string) => bucketById.get(bid)?.modularMembers ?? [];

    for (const it of items) {
      if (it.kind === 'singleton') {
        for (const s of sources) {
          if (s.codeId === it.codeId) add(it.id, `${s.annotationId ?? 'self'}|${s.codeId}`);
        }
        continue;
      }
      const admissible = new Set(forkMembers(it.bucketId).map((m) => m.codeId));
      for (const s of sources) {
        if (admissible.has(s.codeId)) add(it.id, `${s.annotationId ?? 'self'}|${s.codeId}`);
      }
    }
    // Subsumption pass — only combinatorial in-span codes can substitute.
    for (const s of sources) {
      const subItems = defs[s.codeId];
      if (!subItems?.length || s.codeId === parentCode.id) continue;
      const mapping = subsumption(
        { codeId: s.codeId, items: subItems },
        { codeId: parentCode.id, items },
        forkMembers,
        modularMembers,
      );
      if (!mapping) continue;
      for (const mm of mapping) {
        const key: PickKey = `${s.annotationId ?? 'self'}|${s.codeId}`;
        add(mm.parentItemId, key);
        via.set(key, s.codeId);
      }
    }
    return { picks, via };
  }, [items, assignedCodeIds, inSpan, defs, bucketById, parentCode.id]);

  const [picked, setPicked] = useState<Map<string, Set<PickKey>>>(
    () => new Map([...prefill.picks].map(([k, v]) => [k, new Set(v)])),
  );
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ orderViolated: boolean; complete: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = (itemId: string, key: PickKey) => {
    setPicked((prev) => {
      const next = new Map([...prev].map(([k, v]) => [k, new Set(v)]));
      const s = next.get(itemId) ?? new Set<PickKey>();
      if (s.has(key)) s.delete(key);
      else s.add(key);
      next.set(itemId, s);
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const links: AssignmentChildInput[] = [];
      const assignFirst: string[] = [];
      for (const it of items) {
        for (const key of picked.get(it.id) ?? []) {
          const [ann, codeId] = key.split('|');
          if (ann === 'self') {
            if (!assignedCodeIds.includes(codeId)) assignFirst.push(codeId);
            links.push({
              childAnnotationId: 'SELF',
              childCodeId: codeId,
              itemId: it.id,
              viaCodeId: prefill.via.get(key) ?? null,
            });
          } else {
            links.push({
              childAnnotationId: ann,
              childCodeId: codeId,
              itemId: it.id,
              viaCodeId: prefill.via.get(key) ?? null,
            });
          }
        }
      }
      const r = await onSave(links, [...new Set(assignFirst)]);
      if (r) setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save decomposition.');
    } finally {
      setSaving(false);
    }
  };

  // Candidate rows for a bucket item: every admissible member, with its source
  // options (self / each in-span assignment carrying it).
  const candidatesFor = (it: DefItem): { key: PickKey; codeId: string; label: string; mandatory: boolean; viaOf: string | null }[] => {
    const out: { key: PickKey; codeId: string; label: string; mandatory: boolean; viaOf: string | null }[] = [];
    const pushSources = (codeId: string, mandatory: boolean) => {
      const mnemonic = codesById.get(codeId)?.mnemonic ?? codeId.slice(0, 8);
      // self row always offered (top-down: tick → assign on save)
      const selfKey: PickKey = `self|${codeId}`;
      out.push({ key: selfKey, codeId, label: mnemonic, mandatory, viaOf: prefill.via.get(selfKey) ?? null });
      for (const a of inSpan.filter((x) => x.codeId === codeId)) {
        const k: PickKey = `${a.annotationId}|${codeId}`;
        out.push({
          key: k,
          codeId,
          label: `${mnemonic} · s${a.startOrd + 1} “${a.quote.slice(0, 24)}${a.quote.length > 24 ? '…' : ''}”`,
          mandatory,
          viaOf: prefill.via.get(k) ?? null,
        });
      }
    };
    if (it.kind === 'singleton') {
      pushSources(it.codeId, true);
    } else {
      for (const m of bucketById.get(it.bucketId)?.members ?? []) pushSources(m.codeId, m.mandatory);
      // subsuming combinatorial codes appear as candidates too (via c₁)
      for (const [key, viaCode] of prefill.via) {
        if ((prefill.picks.get(it.id) ?? new Set()).has(key) && !out.some((o) => o.key === key)) {
          const mnemonic = codesById.get(viaCode)?.mnemonic ?? viaCode.slice(0, 8);
          out.push({ key, codeId: viaCode, label: `${mnemonic} (subsumes)`, mandatory: false, viaOf: viaCode });
        }
      }
    }
    return out;
  };

  const stagesLabel = (it: DefItem) =>
    it.interchangeGroup !== null ? `pos ${it.position} · ≋ group ${it.interchangeGroup}` : `pos ${it.position}`;

  return (
    <div className="border-t border-foreground/15 bg-foreground/[0.02] px-3 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <p className="min-w-0 text-sm">
          <span className="font-mono font-medium">{parentCode.mnemonic}</span>{' '}
          <span className="text-xs text-foreground/50">— fulfill its steps (skippable)</span>
        </p>
        <button type="button" onClick={onSkip} className="shrink-0 text-xs text-foreground/50 underline-offset-2 hover:underline">
          skip (attest)
        </button>
      </div>

      <div className="mt-2 space-y-2">
        {items.map((it) => {
          const bucket = it.kind === 'bucket' ? bucketById.get(it.bucketId) : null;
          const cands = candidatesFor(it);
          const sel = picked.get(it.id) ?? new Set<PickKey>();
          const fulfilled = sel.size > 0;
          const mandatoryMissing =
            it.kind === 'bucket' && fulfilled
              ? (bucket?.members ?? [])
                  .filter((m) => m.mandatory && ![...sel].some((k) => k.endsWith(`|${m.codeId}`)))
                  .map((m) => codesById.get(m.codeId)?.mnemonic ?? m.codeId)
              : [];
          return (
            <div key={it.id} className={`border px-2 py-1.5 ${fulfilled ? 'border-emerald-600/40' : 'border-foreground/15'}`}>
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-xs font-medium">
                  {it.kind === 'bucket' ? (bucket?.name ?? 'bucket') : `${codesById.get(it.codeId)?.mnemonic ?? 'code'} (required)`}
                  {fulfilled && <span className="ml-1 text-emerald-700">✓</span>}
                </p>
                <span className="shrink-0 text-[10px] uppercase tracking-wide text-foreground/35">{stagesLabel(it)}</span>
              </div>
              {bucket?.caption && <p className="text-[11px] italic text-foreground/45">{bucket.caption}</p>}
              <div className="mt-1 flex flex-wrap gap-1">
                {cands.map((c) => {
                  const on = sel.has(c.key);
                  return (
                    <button
                      key={c.key}
                      type="button"
                      disabled={busy || saving}
                      onClick={() => toggle(it.id, c.key)}
                      title={c.viaOf ? `auto-checked via ${codesById.get(c.viaOf)?.mnemonic ?? c.viaOf} (subsumption)` : undefined}
                      className={`rounded-sm border px-1.5 py-0.5 font-mono text-[11px] transition ${
                        on
                          ? 'border-emerald-600/50 bg-emerald-500/15'
                          : 'border-foreground/20 text-foreground/60 hover:border-foreground/50'
                      }`}
                    >
                      {c.mandatory && <span title="mandatory member">★ </span>}
                      {c.label}
                      {c.viaOf && <span className="ml-0.5 text-sky-700"> via</span>}
                    </button>
                  );
                })}
                {cands.length === 0 && <span className="text-[11px] italic text-foreground/40">no candidates</span>}
              </div>
              {mandatoryMissing.length > 0 && (
                <p className="mt-1 text-[11px] text-amber-700">
                  mandatory not assigned: {mandatoryMissing.join(', ')} (attesting implies them)
                </p>
              )}
            </div>
          );
        })}
      </div>

      {result && (
        <p className={`mt-1.5 text-xs ${result.orderViolated ? 'text-amber-700' : 'text-emerald-700'}`}>
          {result.orderViolated
            ? '⚠ order-violated: first evidence runs against the step order (saved anyway — warn, never block).'
            : result.complete
              ? 'Saved — all steps evidenced.'
              : 'Saved — partial decomposition (attested-with-some-evidence).'}
        </p>
      )}
      {error && <p className="mt-1.5 text-xs text-red-600">{error}</p>}

      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          disabled={busy || saving}
          onClick={() => void save()}
          className="border border-foreground bg-foreground px-2 py-1 text-xs text-background transition hover:opacity-90 disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Save decomposition'}
        </button>
        <button
          type="button"
          disabled={busy || saving}
          onClick={onPending}
          title="Not yet asserted — resolves before any cross-coder contact; blocks IRR until then"
          className="border border-amber-600/50 px-2 py-1 text-xs text-amber-800 transition hover:border-amber-600 disabled:opacity-40 dark:text-amber-400"
        >
          mark pending
        </button>
        <span className="min-w-0 flex-1 truncate text-[11px] text-foreground/40">
          Save = decomposed · skip = attested · children stay if the parent is deleted.
        </span>
      </div>
    </div>
  );
}
