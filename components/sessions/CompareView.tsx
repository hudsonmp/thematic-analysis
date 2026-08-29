'use client';

import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { CloudSegment } from '@/app/actions/sessions';
import {
  acceptIntoCanonical,
  removeCanonical,
  type CompareAnnotationView,
  type CompareCoder,
  type CanonicalView,
} from '@/app/actions/annotations';
import type { SpecTimelineResult } from '@/app/actions/spec';
import type { CompareNoteView } from '@/app/actions/compareNotes';
import { specStateAt } from '@/lib/spec/reconstruct';
import SpecReplay from './SpecReplay';
import CompareSideBySide from './CompareSideBySide';

/** Format a millisecond offset as `mm:ss` (minutes uncapped past 60). */
function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** A code chip in a lane. `shared` = both coders applied this mnemonic here. */
function CodeChip({ mnemonic, shared }: { mnemonic: string; shared: boolean }) {
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 font-mono text-xs ${
        shared
          ? 'bg-emerald-500/20 text-emerald-800 dark:text-emerald-200'
          : 'bg-amber-500/15 text-amber-900 dark:text-amber-200'
      }`}
    >
      {mnemonic}
    </span>
  );
}

/** A candidate code for a segment: a real `code_id` + its mnemonic. */
type Candidate = { id: string; mnemonic: string };

/**
 * The PAIRWISE compare overlay: my coding | one chosen coder's coding, per
 * transcript segment, with the negotiated CANONICAL lane kept from the matrix era.
 *
 * WHY PAIRWISE. Reconciliation is a conversation between two codings at a time —
 * the disagreements you can actually discuss and resolve are "you said X, I said
 * Y", and an N-coder matrix buries that pair under columns you are not talking
 * about. The picker chooses the counterpart; the viewer is always the left lane.
 *
 * Agreement semantics (pairwise, mnemonic-keyed like the old ≥2-of-N heuristic):
 *   green chip  — BOTH of us applied this mnemonic to this segment;
 *   amber chip  — exactly one of us did (the discussable residue).
 * Row tint follows: any shared mnemonic → green; both coded, nothing shared →
 * amber; only one coded → neutral (a coverage gap, not a disagreement).
 *
 * The CANONICAL lane is unchanged in spirit: candidates stay the union of EVERY
 * coder's codes on the segment (not just the visible pair), so canonizing never
 * under-offers a code from a coder who isn't currently selected.
 *
 * The SPECIFICATION tab shows the participant's FINAL spec (specStateAt at the
 * stream's end) as shared context. Coders do not code the spec today — annotations
 * anchor to transcript segments — so there is nothing per-coder to overlay there
 * yet; the tab says so rather than pretending.
 */
export default function CompareView({
  sessionId,
  versionId,
  pidLabel,
  segments,
  annotations,
  coders,
  canonical,
  myUid,
  specTimeline,
  notes,
  codeOptions,
}: {
  sessionId: string;
  versionId: string | null;
  pidLabel: string;
  segments: CloudSegment[];
  annotations: CompareAnnotationView[];
  coders: CompareCoder[];
  canonical: CanonicalView[];
  /** The signed-in viewer — the fixed LEFT lane. */
  myUid: string;
  specTimeline: SpecTimelineResult;
  /** Review-layer notes (cb_compare_notes) for the side-by-side tab. */
  notes: CompareNoteView[];
  /** Active codebook codes for the side-by-side add-a-code picker. */
  codeOptions: { id: string; mnemonic: string }[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'side-by-side' | 'table' | 'specification'>('side-by-side');
  const [openSegmentId, setOpenSegmentId] = useState<string | null>(null);
  const [selection, setSelection] = useState<Record<string, Set<string>>>({});

  const others = useMemo(
    () => coders.filter((c) => c.coderId !== myUid),
    [coders, myUid],
  );
  const [vsCoderId, setVsCoderId] = useState<string | null>(others[0]?.coderId ?? null);
  const vsCoder = others.find((c) => c.coderId === vsCoderId) ?? others[0] ?? null;

  // segmentId -> coderId -> Candidate[] (canonical rows excluded — they are the
  // reconciled OUTPUT, surfaced from the `canonical` prop).
  const bySegment = useMemo(() => {
    const map = new Map<string, Map<string, Candidate[]>>();
    for (const a of annotations) {
      if (a.isCanonical) continue;
      let byCoder = map.get(a.segmentId);
      if (!byCoder) {
        byCoder = new Map<string, Candidate[]>();
        map.set(a.segmentId, byCoder);
      }
      const list = byCoder.get(a.coderId) ?? [];
      for (const c of a.codes) list.push({ id: c.id, mnemonic: c.mnemonic });
      byCoder.set(a.coderId, list);
    }
    return map;
  }, [annotations]);

  const canonicalBySegment = useMemo(() => {
    const map = new Map<string, CanonicalView>();
    for (const c of canonical) map.set(c.segmentId, c);
    return map;
  }, [canonical]);

  // Candidates = the ALL-coder union per segment (see doc comment).
  const candidatesBySegment = useMemo(() => {
    const map = new Map<string, Candidate[]>();
    for (const [segId, byCoder] of bySegment) {
      const seen = new Map<string, Candidate>();
      for (const list of byCoder.values()) {
        for (const c of list) if (!seen.has(c.id)) seen.set(c.id, c);
      }
      map.set(segId, [...seen.values()].sort((a, b) => a.mnemonic.localeCompare(b.mnemonic)));
    }
    return map;
  }, [bySegment]);

  // Rows: segments that I, the selected coder, or canonical touched. (A segment
  // only a THIRD coder touched is out of this pair's conversation.)
  const rows = useMemo(() => {
    return segments
      .map((seg) => {
        const byCoder = bySegment.get(seg.id);
        const mine = [...new Set((byCoder?.get(myUid) ?? []).map((c) => c.mnemonic))];
        const theirs = vsCoder
          ? [...new Set((byCoder?.get(vsCoder.coderId) ?? []).map((c) => c.mnemonic))]
          : [];
        const canonicalEntry = canonicalBySegment.get(seg.id) ?? null;
        if (mine.length === 0 && theirs.length === 0 && !canonicalEntry) return null;

        const shared = new Set(mine.filter((m) => theirs.includes(m)));
        const tint =
          shared.size > 0
            ? 'bg-emerald-500/[0.08]'
            : mine.length > 0 && theirs.length > 0
              ? 'bg-amber-500/[0.07]'
              : canonicalEntry
                ? 'bg-blue-500/[0.06]'
                : '';
        return { seg, mine, theirs, shared, canonicalEntry, tint };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
  }, [segments, bySegment, myUid, vsCoder, canonicalBySegment]);

  const agreementSummary = useMemo(() => {
    let both = 0;
    let agree = 0;
    for (const r of rows) {
      if (r.mine.length > 0 && r.theirs.length > 0) {
        both += 1;
        if (r.shared.size > 0) agree += 1;
      }
    }
    return { both, agree };
  }, [rows]);

  // The participant's FINAL spec — the stream replayed past its last edit.
  const finalSpec = useMemo(
    () => specStateAt(specTimeline, Number.MAX_SAFE_INTEGER),
    [specTimeline],
  );
  const hasSpecData =
    specTimeline.specEdits.length > 0 || specTimeline.entityEdits.length > 0;

  // ----- canonical mutations (unchanged plumbing) ----------------------------
  function run(fn: () => Promise<unknown>) {
    setError(null);
    startTransition(async () => {
      try {
        await fn();
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Canonical action failed.');
      }
    });
  }

  function toggleCandidate(segmentId: string, codeId: string) {
    setSelection((prev) => {
      const next = new Set(prev[segmentId] ?? []);
      if (next.has(codeId)) next.delete(codeId);
      else next.add(codeId);
      return { ...prev, [segmentId]: next };
    });
  }

  function openPicker(seg: CloudSegment) {
    const existing = canonicalBySegment.get(seg.id);
    setSelection((prev) => ({
      ...prev,
      [seg.id]: new Set(existing ? existing.codes.map((c) => c.id) : []),
    }));
    setOpenSegmentId(seg.id);
  }

  function accept(seg: CloudSegment) {
    if (versionId === null) {
      setError('This session has no original transcript version — cannot canonize.');
      return;
    }
    const codeIds = [...(selection[seg.id] ?? [])];
    if (codeIds.length === 0) {
      setError('Pick at least one code to accept into canonical.');
      return;
    }
    run(async () => {
      await acceptIntoCanonical({
        sessionId,
        versionId,
        segmentId: seg.id,
        tStartMs: seg.startMs,
        tEndMs: seg.endMs,
        codeIds,
      });
      setOpenSegmentId(null);
    });
  }

  function clear(seg: CloudSegment) {
    run(async () => {
      await removeCanonical(seg.id, sessionId);
      setOpenSegmentId(null);
    });
  }

  return (
    <main className="px-6 py-6">
      <header className="mb-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-medium tracking-tight">
            Compare{' '}
            <span className="font-mono text-foreground/50">({pidLabel})</span>
          </h1>

          {/* The pair picker: me (fixed) vs ONE chosen counterpart. */}
          <label className="flex items-center gap-2 text-xs text-foreground/60">
            <span>
              My coding <span className="text-foreground/35">vs</span>
            </span>
            <select
              value={vsCoder?.coderId ?? ''}
              onChange={(e) => setVsCoderId(e.target.value || null)}
              disabled={others.length === 0}
              className="rounded border border-foreground/20 bg-background px-2 py-1 text-xs disabled:opacity-50"
            >
              {others.length === 0 && <option value="">no other coder yet</option>}
              {others.map((c) => (
                <option key={c.coderId} value={c.coderId}>
                  {c.coderName}
                </option>
              ))}
            </select>
          </label>

          <div role="tablist" className="flex rounded border border-foreground/20 text-xs">
            {(['side-by-side', 'table', 'specification'] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={`px-3 py-1 capitalize first:rounded-l last:rounded-r ${
                  tab === t
                    ? 'bg-foreground text-background'
                    : 'text-foreground/70 hover:text-foreground'
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          <Link
            href={`/sessions/${sessionId}`}
            className="ml-auto rounded border border-foreground/30 px-2 py-1 text-xs text-foreground/70 hover:text-foreground"
          >
            ← My coding
          </Link>
        </div>
      </header>

      {error && (
        <p
          className="mb-3 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300"
          role="alert"
        >
          {error}
        </p>
      )}

      {tab === 'side-by-side' ? (
        <CompareSideBySide
          sessionId={sessionId}
          versionId={versionId}
          segments={segments}
          annotations={annotations}
          me={{
            coderId: myUid,
            coderName: coders.find((c) => c.coderId === myUid)?.coderName ?? 'you',
          }}
          other={vsCoder}
          notes={notes}
          codeOptions={codeOptions}
        />
      ) : tab === 'specification' ? (
        <div className="max-w-3xl">
          <SpecReplay
            spec={finalSpec.spec}
            entities={finalSpec.entities}
            hasSpecData={hasSpecData}
            anchorResolved
          />
        </div>
      ) : others.length === 0 && canonical.length === 0 ? (
        <p className="rounded border border-amber-500/40 bg-amber-500/10 px-4 py-6 text-sm text-amber-800 dark:text-amber-200">
          No other coder has coded this session yet — there is nothing to compare
          against. Your own coding lives in{' '}
          <Link href={`/sessions/${sessionId}`} className="underline">
            your view
          </Link>
          .
        </p>
      ) : rows.length === 0 ? (
        <p className="rounded border border-foreground/15 px-4 py-6 text-sm text-foreground/60">
          Neither of you has coded any segment yet.
        </p>
      ) : (
        <>
          {/* Legend + pairwise agreement summary. */}
          <div className="mb-3 flex flex-wrap items-center gap-4 text-xs text-foreground/70">
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-3 w-3 rounded-sm bg-emerald-500/30" />
              both applied
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-3 w-3 rounded-sm bg-amber-500/30" />
              only one of you
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-3 w-3 rounded-sm bg-blue-500/30" />
              canonical (reconciled)
            </span>
            {agreementSummary.both > 0 && (
              <span className="text-foreground/50">
                {agreementSummary.agree}/{agreementSummary.both} co-coded segments
                share ≥1 code
              </span>
            )}
          </div>

          <div className="overflow-x-auto rounded border border-foreground/15">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-foreground/15 bg-foreground/[0.03] text-left">
                  <th className="w-[38%] px-3 py-2 align-bottom font-semibold">Segment</th>
                  <th className="px-3 py-2 align-bottom font-semibold">Mine</th>
                  <th className="px-3 py-2 align-bottom font-semibold">
                    {vsCoder?.coderName ?? '—'}
                  </th>
                  <th className="w-64 px-3 py-2 align-bottom font-semibold text-blue-700 dark:text-blue-300">
                    Canonical
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ seg, mine, theirs, shared, canonicalEntry, tint }) => {
                  const candidates = candidatesBySegment.get(seg.id) ?? [];
                  const isOpen = openSegmentId === seg.id;
                  const sel = selection[seg.id] ?? new Set<string>();
                  return (
                    <tr key={seg.id} className={`border-b border-foreground/10 align-top ${tint}`}>
                      <td className="px-3 py-2">
                        <span className="font-mono text-xs text-foreground/40">
                          [{formatTime(seg.startMs)}]
                        </span>{' '}
                        {/* FULL text, not a snippet: a pairwise diff is read like a
                            transcript, and a truncated line hides exactly the words
                            the disagreement is about. */}
                        <span className="whitespace-pre-wrap text-foreground/75">{seg.text}</span>
                      </td>
                      {[mine, theirs].map((lane, i) => (
                        <td key={i} className="px-3 py-2">
                          {lane.length === 0 ? (
                            <span className="text-foreground/25">—</span>
                          ) : (
                            <span className="flex flex-wrap gap-1">
                              {lane.map((m) => (
                                <CodeChip key={m} mnemonic={m} shared={shared.has(m)} />
                              ))}
                            </span>
                          )}
                        </td>
                      ))}
                      <td className="px-3 py-2">
                        {canonicalEntry && canonicalEntry.codes.length > 0 && (
                          <span className="mb-1.5 flex flex-wrap gap-1">
                            {canonicalEntry.codes.map((cd) => (
                              <span
                                key={cd.id}
                                className="inline-block rounded bg-blue-500/20 px-1.5 py-0.5 font-mono text-xs text-blue-800 dark:text-blue-200"
                              >
                                {cd.mnemonic}
                              </span>
                            ))}
                          </span>
                        )}

                        {isOpen ? (
                          <div className="rounded border border-blue-500/30 bg-background/60 p-2">
                            {candidates.length === 0 ? (
                              <p className="text-xs text-foreground/50">
                                No coder codes on this segment to canonize.
                              </p>
                            ) : (
                              <div className="flex flex-col gap-1">
                                {/* Candidates: the ALL-coder union, not just this
                                    pair — canonizing must never under-offer a code
                                    from a coder who isn't currently selected. */}
                                {candidates.map((cd) => (
                                  <label key={cd.id} className="flex items-center gap-1.5 text-xs">
                                    <input
                                      type="checkbox"
                                      checked={sel.has(cd.id)}
                                      onChange={() => toggleCandidate(seg.id, cd.id)}
                                    />
                                    <span className="font-mono">{cd.mnemonic}</span>
                                  </label>
                                ))}
                              </div>
                            )}
                            <div className="mt-2 flex items-center gap-2">
                              <button
                                type="button"
                                disabled={isPending || candidates.length === 0}
                                onClick={() => accept(seg)}
                                className="rounded bg-blue-600 px-2 py-0.5 text-xs font-medium text-white transition hover:bg-blue-500 disabled:opacity-50"
                              >
                                {canonicalEntry ? 'Replace' : 'Accept'}
                              </button>
                              <button
                                type="button"
                                disabled={isPending}
                                onClick={() => setOpenSegmentId(null)}
                                className="rounded border border-foreground/20 px-2 py-0.5 text-xs text-foreground/70 transition hover:bg-foreground/5 disabled:opacity-50"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              disabled={isPending}
                              onClick={() => openPicker(seg)}
                              className="rounded border border-blue-500/40 px-2 py-0.5 text-xs text-blue-700 transition hover:bg-blue-500/10 disabled:opacity-50 dark:text-blue-300"
                            >
                              {canonicalEntry ? 'Edit →' : '→ canonical'}
                            </button>
                            {canonicalEntry && (
                              <button
                                type="button"
                                disabled={isPending}
                                onClick={() => clear(seg)}
                                className="rounded border border-foreground/20 px-2 py-0.5 text-xs text-foreground/60 transition hover:bg-foreground/5 disabled:opacity-50"
                              >
                                Clear
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="mt-3 text-xs text-foreground/40">
            {rows.length} segment{rows.length === 1 ? '' : 's'} in this pair&apos;s
            conversation · {canonical.length} canonical
          </p>
        </>
      )}
    </main>
  );
}
