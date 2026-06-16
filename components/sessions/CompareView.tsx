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

/** Format a millisecond offset as `mm:ss` (minutes uncapped past 60). */
function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** Trim a transcript line to a short cell snippet (no mid-word cut past ~80ch). */
function snippet(text: string, max = 80): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max).trimEnd()}…`;
}

/** A code chip (mnemonic) rendered in a coder's cell. */
function CodeChip({ mnemonic, agree }: { mnemonic: string; agree: boolean }) {
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-xs font-mono ${
        agree
          ? 'bg-emerald-500/20 text-emerald-800 dark:text-emerald-200'
          : 'bg-foreground/10 text-foreground/80'
      }`}
    >
      {mnemonic}
    </span>
  );
}

type RowAgreement = 'agree' | 'partial' | 'none';

/** A candidate code for a segment: a real `code_id` + its mnemonic. */
type Candidate = { id: string; mnemonic: string };

/**
 * Post-hoc multi-coder Compare matrix with a NEGOTIATED CANONICAL layer
 * (#21, Tasks 11–12).
 *
 * Rows = transcript segments in temporal (video) order; columns = the distinct coders (by
 * display name) plus a Canonical column. Each coder cell shows the code mnemonics
 * that coder applied to an annotation anchored to the row's segment. This is the
 * diff surface that supports negotiated agreement — it reads EVERY coder's work,
 * unlike the own-coding view (`/sessions/[id]`), which shows only your own.
 *
 * Agreement heuristic (unchanged): for a given segment, if the SAME code mnemonic
 * appears in ≥2 coder columns, that segment is "agree" (green). Any code on the
 * row with no ≥2-coder shared mnemonic is "partial/disagree" (amber). A row no
 * coder touched is neutral. Shared mnemonics are highlighted green inside cells.
 *
 * CANONICAL (Task 12): after coding independently, a reconciler distills each
 * segment's disagreement into a single authoritative coding — the CANONICAL set
 * used for export/analysis downstream (SP-C / SP-3). The Canonical column is
 * therefore NOT read-only: per row it offers a picker over that segment's
 * CANDIDATE codes (the union of every coder's codes there), an "Accept" button
 * (→ `acceptIntoCanonical`, one canonical row per segment — accepting again
 * REPLACES), and a "Clear" affordance (→ `removeCanonical`). The per-coder coding
 * cells stay read-only; independence is preserved because independent coding
 * lives only on the own-coding page.
 *
 * After every mutation we `router.refresh()` so the server re-reads `canonical`.
 */
export default function CompareView({
  sessionId,
  versionId,
  pidLabel,
  segments,
  annotations,
  coders,
  canonical,
}: {
  sessionId: string;
  versionId: string | null;
  pidLabel: string;
  segments: CloudSegment[];
  annotations: CompareAnnotationView[];
  coders: CompareCoder[];
  canonical: CanonicalView[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // The segment whose canonical picker is currently open (one at a time).
  const [openSegmentId, setOpenSegmentId] = useState<string | null>(null);
  // Picker selection: segmentId -> set of selected candidate code ids.
  const [selection, setSelection] = useState<Record<string, Set<string>>>({});

  // The matrix's coder columns. `coders` lists every distinct coder_id present,
  // including a reconciler who also coded normally.
  const coderColumns = coders;
  const onlyOneCoder = coderColumns.length === 1;

  // Index per-coder annotations by segment, carrying real {id, mnemonic} so the
  // canonical picker can offer actual code ids — NOT just mnemonics.
  // The `is_canonical` rows never populate coder lanes (they are the reconciled
  // output, surfaced from the `canonical` prop instead).
  // segmentId -> coderId -> Candidate[]
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

  // Canonical (reconciled) coding per segment, from the authoritative `canonical`
  // prop (NOT the annotations' isCanonical flag). One entry per segment.
  const canonicalBySegment = useMemo(() => {
    const map = new Map<string, CanonicalView>();
    for (const c of canonical) map.set(c.segmentId, c);
    return map;
  }, [canonical]);
  const hasCanonical = canonical.length > 0;

  // Candidate codes per segment: the de-duped union (by code id) of every coder's
  // codes on that segment — the menu the reconciler accepts FROM.
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

  // For each segment: which mnemonics are shared by ≥2 coders (the agreed set),
  // and the row-level agreement signal.
  const segmentSignal = useMemo(() => {
    const map = new Map<
      string,
      { agreedMnemonics: Set<string>; agreement: RowAgreement }
    >();
    for (const seg of segments) {
      const byCoder = bySegment.get(seg.id);
      if (!byCoder || byCoder.size === 0) {
        map.set(seg.id, { agreedMnemonics: new Set(), agreement: 'none' });
        continue;
      }
      // Count, per mnemonic, how many DISTINCT coders applied it.
      const coderCountByMnemonic = new Map<string, number>();
      for (const list of byCoder.values()) {
        for (const m of new Set(list.map((c) => c.mnemonic))) {
          coderCountByMnemonic.set(m, (coderCountByMnemonic.get(m) ?? 0) + 1);
        }
      }
      const agreedMnemonics = new Set<string>();
      for (const [m, n] of coderCountByMnemonic) {
        if (n >= 2) agreedMnemonics.add(m);
      }
      map.set(seg.id, {
        agreedMnemonics,
        agreement: agreedMnemonics.size > 0 ? 'agree' : 'partial',
      });
    }
    return map;
  }, [segments, bySegment]);

  // Only show rows that at least one coder (or canonical) touched — a transcript
  // can be hundreds of segments and the matrix is a diff, not a full transcript.
  const codedSegments = useMemo(
    () =>
      segments.filter((s) => bySegment.has(s.id) || canonicalBySegment.has(s.id)),
    [segments, bySegment, canonicalBySegment],
  );

  // ----- canonical mutations -------------------------------------------------
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
    // Seed the selection from whatever is already canonical for this segment so
    // accepting after a tweak is additive/replacing, not a surprise reset.
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
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-lg font-medium tracking-tight">
            Compare{' '}
            <span className="font-mono text-foreground/50">({pidLabel})</span>
          </h1>
          <Link
            href={`/sessions/${sessionId}`}
            className="rounded border border-foreground/30 px-2 py-1 text-xs text-foreground/70 hover:text-foreground"
          >
            ← My coding
          </Link>
        </div>
        <p className="mt-1 text-sm text-foreground/60">
          Post-hoc. Every coder&apos;s codes on the same segments — for negotiating
          agreement and distilling the{' '}
          <span className="text-blue-700 dark:text-blue-300">canonical</span>{' '}
          (authoritative) coding per segment. Independent coding stays in{' '}
          <Link
            href={`/sessions/${sessionId}`}
            className="underline hover:text-foreground"
          >
            your own view
          </Link>
          .
        </p>
      </header>

      {/* Legend */}
      <div className="mb-3 flex flex-wrap items-center gap-4 text-xs text-foreground/70">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-sm bg-emerald-500/30" />
          Agreement (≥2 coders share a code)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-sm bg-amber-500/30" />
          Partial / disagreement (different or single-coder codes)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-sm bg-blue-500/30" />
          Canonical (reconciled, authoritative)
        </span>
      </div>

      {error && (
        <p
          className="mb-3 rounded border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
          role="alert"
        >
          {error}
        </p>
      )}

      {onlyOneCoder && (
        <p className="mb-3 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
          Only one coder so far — showing all of{' '}
          <span className="font-semibold">{coderColumns[0]?.coderName}</span>
          &apos;s codes. Agreement needs a second coder.
        </p>
      )}

      {coderColumns.length === 0 && !hasCanonical ? (
        <p className="rounded border border-foreground/15 px-4 py-6 text-sm text-foreground/60">
          No annotations on this session yet.
        </p>
      ) : codedSegments.length === 0 ? (
        <p className="rounded border border-foreground/15 px-4 py-6 text-sm text-foreground/60">
          No coded segments yet.
        </p>
      ) : (
        <div className="overflow-x-auto rounded border border-foreground/15">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-foreground/15 bg-foreground/[0.03] text-left">
                <th className="w-72 px-3 py-2 font-semibold align-bottom">
                  Segment
                </th>
                {coderColumns.map((c) => (
                  <th
                    key={c.coderId}
                    className="px-3 py-2 font-semibold align-bottom"
                  >
                    {c.coderName}
                  </th>
                ))}
                <th className="w-72 px-3 py-2 font-semibold align-bottom text-blue-700 dark:text-blue-300">
                  Canonical
                </th>
              </tr>
            </thead>
            <tbody>
              {codedSegments.map((seg) => {
                const signal = segmentSignal.get(seg.id) ?? {
                  agreedMnemonics: new Set<string>(),
                  agreement: 'none' as RowAgreement,
                };
                const byCoder = bySegment.get(seg.id);
                const canonicalEntry = canonicalBySegment.get(seg.id);
                const candidates = candidatesBySegment.get(seg.id) ?? [];
                const isOpen = openSegmentId === seg.id;
                const sel = selection[seg.id] ?? new Set<string>();
                const rowBg =
                  canonicalEntry
                    ? 'bg-blue-500/[0.06]'
                    : signal.agreement === 'agree'
                      ? 'bg-emerald-500/[0.08]'
                      : signal.agreement === 'partial'
                        ? 'bg-amber-500/[0.07]'
                        : '';
                return (
                  <tr
                    key={seg.id}
                    className={`border-b border-foreground/10 align-top ${rowBg}`}
                  >
                    <td className="px-3 py-2">
                      <span className="font-mono text-xs text-foreground/40">
                        [{formatTime(seg.startMs)}]
                      </span>{' '}
                      <span className="text-foreground/70">
                        {snippet(seg.text)}
                      </span>
                    </td>
                    {coderColumns.map((c) => {
                      const list = byCoder?.get(c.coderId) ?? [];
                      const unique = [...new Set(list.map((x) => x.mnemonic))];
                      return (
                        <td key={c.coderId} className="px-3 py-2">
                          {unique.length === 0 ? (
                            <span className="text-foreground/25">—</span>
                          ) : (
                            <span className="flex flex-wrap gap-1">
                              {unique.map((m) => (
                                <CodeChip
                                  key={m}
                                  mnemonic={m}
                                  agree={signal.agreedMnemonics.has(m)}
                                />
                              ))}
                            </span>
                          )}
                        </td>
                      );
                    })}
                    {/* Canonical column: current reconciled set + accept/clear. */}
                    <td className="px-3 py-2">
                      {canonicalEntry && canonicalEntry.codes.length > 0 && (
                        <span className="mb-1.5 flex flex-wrap gap-1">
                          {canonicalEntry.codes.map((cd) => (
                            <span
                              key={cd.id}
                              className="inline-block rounded bg-blue-500/20 px-1.5 py-0.5 text-xs font-mono text-blue-800 dark:text-blue-200"
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
                              {candidates.map((cd) => (
                                <label
                                  key={cd.id}
                                  className="flex items-center gap-1.5 text-xs"
                                >
                                  <input
                                    type="checkbox"
                                    checked={sel.has(cd.id)}
                                    onChange={() =>
                                      toggleCandidate(seg.id, cd.id)
                                    }
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
      )}

      <p className="mt-3 text-xs text-foreground/40">
        {codedSegments.length} coded segment
        {codedSegments.length === 1 ? '' : 's'} · {coderColumns.length} coder
        {coderColumns.length === 1 ? '' : 's'} · {canonical.length} canonical
      </p>
    </main>
  );
}
