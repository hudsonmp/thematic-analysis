'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import type { CloudSegment } from '@/app/actions/sessions';
import type {
  CompareAnnotationView,
  CompareCoder,
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

/**
 * Post-hoc, READ-ONLY multi-coder Compare matrix (#21, Task 11).
 *
 * Rows = transcript segments in ordinal order; columns = the distinct coders (by
 * display name). Each cell shows the code mnemonics that coder applied to an
 * annotation anchored to that row's segment. This is the diff surface that
 * supports negotiated agreement — it deliberately reads EVERY coder's work,
 * unlike the own-coding view (`/sessions/[id]`), which shows only your own.
 *
 * Agreement heuristic (kept simple, per spec): for a given segment, if the SAME
 * code mnemonic appears in ≥2 coder columns, that segment is "agree" (green). If
 * any code was applied to the row but no mnemonic is shared by ≥2 coders
 * (different codes, or only one coder coded it), the row is "partial/disagree"
 * (amber). A row no coder touched is neutral. Shared mnemonics are highlighted
 * green inside the cells so the agreed code itself is visible, not just the row.
 *
 * Canonical: if any annotation on the session is `is_canonical`, a Canonical
 * column shows the reconciled set (read-only here — the "accept into canonical"
 * action is Task 12).
 *
 * There are NO coding controls on this surface. Independence is preserved by the
 * own-coding view being a separate page; this one never writes.
 */
export default function CompareView({
  sessionId,
  pidLabel,
  segments,
  annotations,
  coders,
}: {
  sessionId: string;
  pidLabel: string;
  segments: CloudSegment[];
  annotations: CompareAnnotationView[];
  coders: CompareCoder[];
}) {
  // Canonical annotations are surfaced in their own column, not as a coder lane.
  const canonicalAnns = useMemo(
    () => annotations.filter((a) => a.isCanonical),
    [annotations],
  );
  const hasCanonical = canonicalAnns.length > 0;

  // Non-canonical coders are the matrix's coder columns. A coder who ONLY has
  // canonical rows (the reconciler) still shows as a column if they also coded
  // normally; `coders` already lists every distinct coder_id present.
  const coderColumns = coders;
  const onlyOneCoder = coderColumns.length === 1;

  // Index annotations by segment, then by coder — only the per-coder NORMAL
  // (non-canonical) annotations populate the coder lanes.
  // segmentId -> coderId -> mnemonics[]
  const bySegment = useMemo(() => {
    const map = new Map<string, Map<string, string[]>>();
    for (const a of annotations) {
      if (a.isCanonical) continue;
      let byCoder = map.get(a.segmentId);
      if (!byCoder) {
        byCoder = new Map<string, string[]>();
        map.set(a.segmentId, byCoder);
      }
      const list = byCoder.get(a.coderId) ?? [];
      for (const c of a.codes) list.push(c.mnemonic);
      byCoder.set(a.coderId, list);
    }
    return map;
  }, [annotations]);

  // Canonical mnemonics per segment (the reconciled set), for the canonical col.
  const canonicalBySegment = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const a of canonicalAnns) {
      const list = map.get(a.segmentId) ?? [];
      for (const c of a.codes) list.push(c.mnemonic);
      map.set(a.segmentId, list);
    }
    return map;
  }, [canonicalAnns]);

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
      for (const mnemonics of byCoder.values()) {
        for (const m of new Set(mnemonics)) {
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
      segments.filter(
        (s) => bySegment.has(s.id) || canonicalBySegment.has(s.id),
      ),
    [segments, bySegment, canonicalBySegment],
  );

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
          Post-hoc, read-only. Every coder&apos;s codes on the same segments — for
          negotiating agreement. Coding stays in{' '}
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
        {hasCanonical && (
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded-sm bg-blue-500/30" />
            Canonical (reconciled)
          </span>
        )}
      </div>

      {onlyOneCoder && (
        <p className="mb-3 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
          Only one coder so far — showing all of{' '}
          <span className="font-semibold">{coderColumns[0]?.coderName}</span>
          &apos;s codes. Agreement needs a second coder.
        </p>
      )}

      {coderColumns.length === 0 ? (
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
                {hasCanonical && (
                  <th className="px-3 py-2 font-semibold align-bottom text-blue-700 dark:text-blue-300">
                    Canonical
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {codedSegments.map((seg) => {
                const signal = segmentSignal.get(seg.id) ?? {
                  agreedMnemonics: new Set<string>(),
                  agreement: 'none' as RowAgreement,
                };
                const byCoder = bySegment.get(seg.id);
                const rowBg =
                  signal.agreement === 'agree'
                    ? 'bg-emerald-500/[0.08]'
                    : signal.agreement === 'partial'
                      ? 'bg-amber-500/[0.07]'
                      : '';
                const canonicalMnemonics = canonicalBySegment.get(seg.id) ?? [];
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
                      const mnemonics = byCoder?.get(c.coderId) ?? [];
                      const unique = [...new Set(mnemonics)];
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
                    {hasCanonical && (
                      <td className="px-3 py-2">
                        {canonicalMnemonics.length === 0 ? (
                          <span className="text-foreground/25">—</span>
                        ) : (
                          <span className="flex flex-wrap gap-1">
                            {[...new Set(canonicalMnemonics)].map((m) => (
                              <span
                                key={m}
                                className="inline-block rounded bg-blue-500/20 px-1.5 py-0.5 text-xs font-mono text-blue-800 dark:text-blue-200"
                              >
                                {m}
                              </span>
                            ))}
                          </span>
                        )}
                      </td>
                    )}
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
        {coderColumns.length === 1 ? '' : 's'}
      </p>
    </main>
  );
}
