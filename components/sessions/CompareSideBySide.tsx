'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { CloudSegment } from '@/app/actions/sessions';
import type { CompareAnnotationView, CompareCoder } from '@/app/actions/annotations';
import {
  addAnnotation,
  addCodeToAnnotation,
  removeCodeFromAnnotation,
  deleteAnnotation,
} from '@/app/actions/annotations';
import {
  addCompareNote,
  setCompareNoteResolved,
  deleteCompareNote,
  type CompareNoteView,
} from '@/app/actions/compareNotes';
import { assignHues, hueForCode, washFor, accentFor, chipBgFor, overlapStyle } from '@/lib/codebook/colors';

/**
 * SIDE-BY-SIDE compare: two full transcripts — the viewer's coding on the left,
 * one chosen coder's on the right — rendered like the coding screen (washed
 * text + chip brackets in a gutter), on ONE shared grid so every segment is a
 * single row: identical line numbers, identical vertical alignment.
 *
 * COLOR: each code mnemonic gets a stable hue (lib/codebook/colors) — the same
 * code is the same color in BOTH panes, so cross-pane agreement reads as color
 * match and disagreement as color mismatch. A segment carrying several codes
 * paints the first code's wash plus a 3px bottom band per additional code
 * (overlapStyle), so within-pane overlap is visible instead of blended away.
 * A chip both coders applied on the same row gets a solid ring + ✓.
 *
 * REVIEW LAYER (cb_compare_notes): each viewer's panel is their OWN
 * interpretation of the diff — notes they authored plus change requests
 * addressed to them. From here the viewer can (a) leave a comment, (b) mark a
 * segment requesting the OTHER coder change their coding, or (c) change their
 * OWN coding directly (add a code to the row, remove a chip, delete a bracket
 * — the same server actions the coding screen uses).
 */

function formatTime(ms: number): string {
  const t = Math.floor(ms / 1000);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

type PaneAnn = { ann: CompareAnnotationView; mnemonics: string[] };

export default function CompareSideBySide({
  sessionId,
  versionId,
  segments,
  annotations,
  me,
  other,
  notes,
  codeOptions,
}: {
  sessionId: string;
  versionId: string | null;
  segments: CloudSegment[];
  annotations: CompareAnnotationView[];
  me: CompareCoder;
  other: CompareCoder | null;
  notes: CompareNoteView[];
  /** Active codebook codes for the add-a-code picker. */
  codeOptions: { id: string; mnemonic: string }[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [hideUncoded, setHideUncoded] = useState(false);
  // One open per-row composer at a time: {segId, kind} — 'note' | 'request' | 'add'.
  const [composer, setComposer] = useState<{ segId: string; kind: 'note' | 'request' | 'add' } | null>(null);
  const [noteBody, setNoteBody] = useState('');
  const [codeQuery, setCodeQuery] = useState('');

  const segIdxById = useMemo(() => new Map(segments.map((s, i) => [s.id, i])), [segments]);

  // The color registry: EVERY mnemonic this screen can show (both coders'
  // annotations + the add-picker's options) gets a hue with guaranteed
  // separation, so confusable codes never share a look. Deterministic per set.
  const hues = useMemo(
    () =>
      assignHues([
        ...annotations.flatMap((a) => a.codes.map((c) => c.mnemonic)),
        ...codeOptions.map((c) => c.mnemonic),
      ]),
    [annotations, codeOptions],
  );
  const hueOf = (m: string) => hues.get(m) ?? hueForCode(m);

  // Per coder: segment index → annotation brackets covering it (multi-cue spans
  // cover every segment from anchor to end). Canonical rows stay out — they are
  // the reconciled OUTPUT, not either coder's claim.
  const paneBySegIdx = useMemo(() => {
    const build = (coderId: string | null) => {
      const m = new Map<number, PaneAnn[]>();
      if (!coderId) return m;
      for (const a of annotations) {
        if (a.isCanonical || a.coderId !== coderId) continue;
        const si = segIdxById.get(a.segmentId);
        if (si === undefined) continue;
        const eiRaw = a.endSegmentId ? segIdxById.get(a.endSegmentId) : si;
        const ei = eiRaw === undefined ? si : eiRaw;
        const mnems = [...new Set(a.codes.map((c) => c.mnemonic))];
        for (let u = Math.min(si, ei); u <= Math.max(si, ei); u++) {
          const list = m.get(u) ?? [];
          list.push({ ann: a, mnemonics: mnems });
          m.set(u, list);
        }
      }
      return m;
    };
    return { mine: build(me.coderId), theirs: build(other?.coderId ?? null) };
  }, [annotations, segIdxById, me.coderId, other]);

  // The viewer's REVIEW PANEL: notes I authored + change requests addressed to
  // me. (The other coder sees a different panel on their screen — by design.)
  const notesBySegId = useMemo(() => {
    const m = new Map<string, CompareNoteView[]>();
    for (const n of notes) {
      if (n.authorId !== me.coderId && n.aboutCoderId !== me.coderId) continue;
      const list = m.get(n.segmentId) ?? [];
      list.push(n);
      m.set(n.segmentId, list);
    }
    return m;
  }, [notes, me.coderId]);

  function run(fn: () => Promise<unknown>) {
    setError(null);
    startTransition(async () => {
      try {
        await fn();
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Action failed.');
      }
    });
  }

  function distinctMnemonics(list: PaneAnn[]): string[] {
    const out: string[] = [];
    for (const p of list) for (const m of p.mnemonics) if (!out.includes(m)) out.push(m);
    return out;
  }

  function addCodeToRow(seg: CloudSegment, codeId: string) {
    if (!versionId) {
      setError('No transcript version — cannot code.');
      return;
    }
    // Whole-segment anchor: on sentence-restored versions the segment IS the
    // sentence unit, so row-level coding here matches the coding screen's
    // sentence enforcement. If I already have a bracket on this row, extend it
    // instead of stacking a second bracket for the same span.
    const existing = (paneBySegIdx.mine.get(segIdxById.get(seg.id) ?? -1) ?? []).find(
      (p) => p.ann.segmentId === seg.id && !p.ann.endSegmentId,
    );
    run(async () => {
      if (existing) {
        await addCodeToAnnotation(existing.ann.id, codeId);
      } else {
        await addAnnotation({
          sessionId,
          versionId,
          segmentId: seg.id,
          endSegmentId: null,
          charStart: 0,
          charEnd: seg.text.length,
          quoteText: seg.text,
          tStartMs: seg.startMs,
          tEndMs: seg.endMs,
          kind: 'code',
          codeIds: [codeId],
        });
      }
      setComposer(null);
      setCodeQuery('');
    });
  }

  function submitNote(seg: CloudSegment, kind: 'comment' | 'change_request') {
    const body = noteBody.trim();
    if (!body) return;
    run(async () => {
      await addCompareNote({
        sessionId,
        segmentId: seg.id,
        aboutCoderId: kind === 'change_request' ? (other?.coderId ?? null) : null,
        kind,
        body,
      });
      setComposer(null);
      setNoteBody('');
    });
  }

  if (segments.length === 0) {
    return <p className="p-4 text-sm text-foreground/60">No transcript.</p>;
  }

  const filteredCodes = codeOptions.filter((c) =>
    c.mnemonic.toLowerCase().includes(codeQuery.toLowerCase()),
  );

  return (
    <div>
      {error && (
        <p className="mb-3 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}

      <div className="mb-2 flex items-center gap-4 text-xs text-foreground/60">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={hideUncoded} onChange={(e) => setHideUncoded(e.target.checked)} />
          hide rows neither of you coded
        </label>
        <span className="text-foreground/40">
          same code on both sides → matching color + ✓ · stacked bottom bars = overlapping codes on one line
        </span>
      </div>

      {/* ONE grid, one row per segment: number rail · my text · my chips · their text · their chips.
          Shared rows are what guarantees identical line numbers and alignment. */}
      <div className="overflow-x-auto rounded border border-foreground/15">
        <div className="grid min-w-[64rem] grid-cols-[2.5rem_minmax(0,1fr)_11.5rem_minmax(0,1fr)_11.5rem]">
          {/* Captions */}
          <div className="sticky top-0 z-10 border-b border-foreground/15 bg-background px-1 py-2" />
          <div className="sticky top-0 z-10 border-b border-foreground/15 bg-background px-3 py-2 text-sm font-semibold">
            {me.coderName} <span className="font-normal text-foreground/45">(you)</span>
          </div>
          <div className="sticky top-0 z-10 border-b border-foreground/15 bg-background px-2 py-2 text-xs text-foreground/45">
            your codes
          </div>
          <div className="sticky top-0 z-10 border-b border-l border-foreground/15 bg-background px-3 py-2 text-sm font-semibold">
            {other?.coderName ?? 'no other coder'}
          </div>
          <div className="sticky top-0 z-10 border-b border-foreground/15 bg-background px-2 py-2 text-xs text-foreground/45">
            their codes
          </div>

          {segments.map((seg, si) => {
            const mine = paneBySegIdx.mine.get(si) ?? [];
            const theirs = paneBySegIdx.theirs.get(si) ?? [];
            const rowNotes = notesBySegId.get(seg.id) ?? [];
            if (hideUncoded && mine.length === 0 && theirs.length === 0 && rowNotes.length === 0) return null;

            const myMnems = distinctMnemonics(mine);
            const theirMnems = distinctMnemonics(theirs);
            const shared = new Set(myMnems.filter((m) => theirMnems.includes(m)));
            const speaker =
              si === 0 || segments[si - 1].speaker !== seg.speaker ? seg.speaker : null;
            const isComposing = composer?.segId === seg.id;

            const chipEl = (m: string, side: 'mine' | 'theirs', ann?: CompareAnnotationView) => (
              <span
                key={`${m}:${ann?.id ?? 'x'}`}
                className="inline-flex items-center gap-0.5 rounded-sm border px-1.5 py-0.5 font-mono text-[11px]"
                style={{ backgroundColor: chipBgFor(hueOf(m)), borderColor: accentFor(hueOf(m)) }}
                title={shared.has(m) ? `${m} — both of you applied this here` : m}
              >
                {m}
                {shared.has(m) && <span aria-hidden>✓</span>}
                {side === 'mine' && ann && (
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => {
                      const code = ann.codes.find((c) => c.mnemonic === m);
                      if (code) run(() => removeCodeFromAnnotation(ann.id, code.id));
                    }}
                    title={`Remove ${m} from your bracket`}
                    className="px-0.5 text-foreground/40 hover:text-red-600"
                  >
                    ×
                  </button>
                )}
              </span>
            );

            return (
              <div key={seg.id} className="contents">
                {/* line number — segment idx+1, same numbering as the coding screen */}
                <div className="select-none border-b border-foreground/5 px-1 py-1 text-right font-mono text-[10px] leading-5 text-foreground/25">
                  {seg.idx + 1}
                </div>

                {/* MY text */}
                <div
                  className="border-b border-foreground/5 px-3 py-1 text-sm leading-relaxed"
                  style={myMnems.length ? overlapStyle(myMnems.map(hueOf)) : undefined}
                  title={myMnems.length ? myMnems.join(' · ') : undefined}
                >
                  <span className="mr-1.5 font-mono text-[10px] text-foreground/35">[{formatTime(seg.startMs)}]</span>
                  {speaker && <span className="mr-1.5 font-semibold">{speaker}:</span>}
                  <span className="text-foreground/80">{seg.text}</span>
                </div>

                {/* MY chips + review panel */}
                <div className="border-b border-foreground/5 px-2 py-1">
                  <div className="flex flex-wrap items-center gap-1">
                    {mine.map((p) => p.mnemonics.map((m) => chipEl(m, 'mine', p.ann)))}
                    {mine.length > 0 && (
                      <button
                        type="button"
                        disabled={isPending}
                        onClick={() => {
                          if (confirm('Delete your bracket on this line (codes go with it)?')) {
                            run(() => deleteAnnotation(mine[0].ann.id));
                          }
                        }}
                        className="px-1 text-[10px] text-foreground/35 hover:text-red-600"
                        title="Delete your bracket on this line"
                      >
                        delete
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setComposer(isComposing && composer.kind === 'add' ? null : { segId: seg.id, kind: 'add' });
                        setCodeQuery('');
                      }}
                      className="px-1 text-[10px] text-foreground/35 hover:text-foreground"
                      title="Add a code to this line (your coding)"
                    >
                      + code
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setComposer(isComposing && composer.kind === 'note' ? null : { segId: seg.id, kind: 'note' });
                        setNoteBody('');
                      }}
                      className="px-1 text-[10px] text-foreground/35 hover:text-foreground"
                      title="Note to self about this line"
                    >
                      ✎ note
                    </button>
                  </div>

                  {/* review panel entries for THIS viewer */}
                  {rowNotes.map((n) => (
                    <div
                      key={n.id}
                      className={`mt-1 rounded-sm border px-1.5 py-1 text-[11px] leading-snug ${
                        n.kind === 'change_request'
                          ? n.resolvedAt
                            ? 'border-foreground/15 text-foreground/40 line-through'
                            : 'border-amber-600/40 bg-amber-500/10 text-amber-900'
                          : 'border-foreground/15 text-foreground/60'
                      }`}
                    >
                      {n.kind === 'change_request' && (
                        <span className="mr-1 font-sans text-[9px] uppercase tracking-wide">
                          {n.aboutCoderId === me.coderId ? 'change requested of you' : `you asked ${other?.coderName ?? 'them'}`}
                        </span>
                      )}
                      {n.body}
                      <span className="ml-1.5 inline-flex gap-1">
                        {n.kind === 'change_request' && (
                          <button
                            type="button"
                            disabled={isPending}
                            onClick={() => run(() => setCompareNoteResolved(n.id, !n.resolvedAt))}
                            className="text-foreground/40 underline hover:text-foreground"
                          >
                            {n.resolvedAt ? 'reopen' : 'resolve'}
                          </button>
                        )}
                        {n.authorId === me.coderId && (
                          <button
                            type="button"
                            disabled={isPending}
                            onClick={() => run(() => deleteCompareNote(n.id))}
                            className="text-foreground/40 underline hover:text-red-600"
                          >
                            delete
                          </button>
                        )}
                      </span>
                    </div>
                  ))}

                  {/* composers */}
                  {isComposing && composer.kind === 'add' && (
                    <div className="mt-1 rounded-sm border border-foreground/20 bg-background p-1.5">
                      <input
                        autoFocus
                        value={codeQuery}
                        onChange={(e) => setCodeQuery(e.target.value)}
                        placeholder="filter codes…"
                        className="mb-1 w-full border-b border-foreground/15 bg-transparent px-1 py-0.5 text-[11px] outline-none"
                      />
                      <div className="flex max-h-32 flex-col gap-0.5 overflow-y-auto">
                        {filteredCodes.slice(0, 30).map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            disabled={isPending}
                            onClick={() => addCodeToRow(seg, c.id)}
                            className="rounded-sm px-1 py-0.5 text-left font-mono text-[11px] hover:bg-foreground/5"
                            style={{ borderLeft: `3px solid ${accentFor(hueOf(c.mnemonic))}` }}
                          >
                            {c.mnemonic}
                          </button>
                        ))}
                        {filteredCodes.length === 0 && (
                          <span className="px-1 text-[11px] text-foreground/40">no match</span>
                        )}
                      </div>
                    </div>
                  )}
                  {isComposing && (composer.kind === 'note' || composer.kind === 'request') && (
                    <div className="mt-1 rounded-sm border border-foreground/20 bg-background p-1.5">
                      <textarea
                        autoFocus
                        value={noteBody}
                        onChange={(e) => setNoteBody(e.target.value)}
                        rows={2}
                        placeholder={
                          composer.kind === 'request'
                            ? `what should ${other?.coderName ?? 'they'} change here?`
                            : 'note to self…'
                        }
                        className="w-full resize-none bg-transparent px-1 py-0.5 text-[11px] outline-none"
                      />
                      <div className="flex gap-2">
                        <button
                          type="button"
                          disabled={isPending || !noteBody.trim()}
                          onClick={() => submitNote(seg, composer.kind === 'request' ? 'change_request' : 'comment')}
                          className="rounded-sm bg-foreground px-1.5 py-0.5 text-[10px] text-background disabled:opacity-40"
                        >
                          save
                        </button>
                        <button
                          type="button"
                          onClick={() => setComposer(null)}
                          className="text-[10px] text-foreground/50 hover:text-foreground"
                        >
                          cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* THEIR text */}
                <div
                  className="border-b border-l border-foreground/5 px-3 py-1 text-sm leading-relaxed"
                  style={theirMnems.length ? overlapStyle(theirMnems.map(hueOf)) : undefined}
                  title={theirMnems.length ? theirMnems.join(' · ') : undefined}
                >
                  <span className="mr-1.5 font-mono text-[10px] text-foreground/35">[{formatTime(seg.startMs)}]</span>
                  {speaker && <span className="mr-1.5 font-semibold">{speaker}:</span>}
                  <span className="text-foreground/80">{seg.text}</span>
                </div>

                {/* THEIR chips + request-change affordance */}
                <div className="border-b border-foreground/5 px-2 py-1">
                  <div className="flex flex-wrap items-center gap-1">
                    {theirs.map((p) => p.mnemonics.map((m) => chipEl(m, 'theirs')))}
                    {other && (
                      <button
                        type="button"
                        onClick={() => {
                          setComposer(
                            isComposing && composer.kind === 'request' ? null : { segId: seg.id, kind: 'request' },
                          );
                          setNoteBody('');
                        }}
                        className="px-1 text-[10px] text-foreground/35 hover:text-amber-700"
                        title={`Ask ${other.coderName} to change their coding on this line`}
                      >
                        ⚑ request change
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* per-code color legend for every code visible on this screen */}
      <Legend annotations={annotations} meId={me.coderId} otherId={other?.coderId ?? null} hueOf={hueOf} />
    </div>
  );
}

/** Every code either pane shows, chip-colored — the shared color key. */
function Legend({
  annotations,
  meId,
  otherId,
  hueOf,
}: {
  annotations: CompareAnnotationView[];
  meId: string;
  otherId: string | null;
  hueOf: (m: string) => number;
}) {
  const mnems = useMemo(() => {
    const s = new Set<string>();
    for (const a of annotations) {
      if (a.isCanonical) continue;
      if (a.coderId !== meId && a.coderId !== otherId) continue;
      for (const c of a.codes) s.add(c.mnemonic);
    }
    return [...s].sort();
  }, [annotations, meId, otherId]);
  if (mnems.length === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {mnems.map((m) => (
        <span
          key={m}
          className="rounded-sm border px-1.5 py-0.5 font-mono text-[10px]"
          style={{ backgroundColor: washFor(hueOf(m)), borderColor: accentFor(hueOf(m)) }}
        >
          {m}
        </span>
      ))}
    </div>
  );
}
