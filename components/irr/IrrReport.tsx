'use client';

import { useState } from 'react';
import {
  computeIrr,
  type IrrReport,
  type IrrSessionOption,
  type CooccurrenceView,
} from '@/app/actions/irr';

/**
 * The reliability + code co-occurrence surface (David Smith's Tuesday method).
 *
 * ONE thing to read for agreement — per-code κ at the SENTENCE level (each segment
 * of the restored transcript is one sentence), reported strict AND overlap-relaxed
 * (±1 adjacent unit = agreement, David's rule). IRR here is a DIAGNOSTIC for
 * systematic disagreement, not a number to headline.
 *
 * ONE thing to read for redundancy — the code × code co-occurrence HEAT MAP. Two
 * codes that co-occur strongly AND agree poorly are merge candidates. A code-subset
 * selector restricts both the table and the map. Read-only; never changes coding.
 */

function num(x: number | null): string {
  return x === null ? '—' : x.toFixed(2);
}
function pct(x: number | null): string {
  return x === null ? '—' : `${Math.round(x * 100)}%`;
}
function band(k: number | null): string {
  if (k === null) return 'n/a';
  if (k < 0.21) return 'slight';
  if (k < 0.41) return 'fair';
  if (k < 0.61) return 'moderate';
  if (k < 0.81) return 'substantial';
  return 'almost perfect';
}

export default function IrrReportView({ sessions }: { sessions: IrrSessionOption[] }) {
  const [sessionId, setSessionId] = useState(sessions[0]?.sessionId ?? '');
  const session = sessions.find((s) => s.sessionId === sessionId) ?? sessions[0];
  const [coderAId, setCoderAId] = useState(session?.coders[0]?.id ?? '');
  const [coderBId, setCoderBId] = useState(session?.coders[1]?.id ?? '');
  const [minInstances, setMinInstances] = useState(3);
  const [winStartMin, setWinStartMin] = useState('');
  const [winEndMin, setWinEndMin] = useState('');
  const [report, setReport] = useState<IrrReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Code-subset filter: null = all codes. Populated from report.allCodes after the
  // first compute; changing it recomputes with the restricted set.
  const [selectedCodes, setSelectedCodes] = useState<Set<string> | null>(null);

  if (sessions.length === 0) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-12 text-sm text-foreground/60">
        No session has two coders with code annotations yet. Reliability needs one
        session independently double-coded.
      </main>
    );
  }

  const compute = (codeFilter: string[] | null) => {
    if (!sessionId || !coderAId || !coderBId || coderAId === coderBId) {
      setError('Pick a session and two different coders.');
      return;
    }
    setBusy(true);
    setError(null);
    const toMs = (v: string) => (v.trim() === '' ? null : Math.round(Number(v) * 60000));
    computeIrr({
      sessionId,
      coderAId,
      coderBId,
      minInstances,
      windowStartMs: toMs(winStartMin),
      windowEndMs: toMs(winEndMin),
      codeFilter,
    })
      .then((r) => setReport(r))
      .catch((e) => setError(String(e?.message ?? e)))
      .finally(() => setBusy(false));
  };

  const run = () => compute(selectedCodes ? [...selectedCodes] : null);

  const onSession = (id: string) => {
    setSessionId(id);
    const s = sessions.find((x) => x.sessionId === id);
    setCoderAId(s?.coders[0]?.id ?? '');
    setCoderBId(s?.coders[1]?.id ?? '');
    setReport(null);
    setSelectedCodes(null);
  };

  const toggleCode = (code: string) => {
    const base = selectedCodes ?? new Set(report?.allCodes ?? []);
    const next = new Set(base);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    setSelectedCodes(next);
    compute([...next]);
  };
  const setAllCodes = (on: boolean) => {
    const next = on ? new Set(report?.allCodes ?? []) : new Set<string>();
    setSelectedCodes(next);
    compute([...next]);
  };

  const aprioriUnderpowered = report
    ? report.perCode.filter((p) => p.origin === 'a_priori' && p.underpowered).length
    : 0;

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <header>
        <h1 className="text-lg font-medium tracking-tight">Reliability &amp; code co-occurrence</h1>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-foreground/60">
          Agreement is computed at the <b>sentence level</b> (one sentence per segment), with
          overlap counted as agreement. It is a <i>diagnostic for systematic disagreement</i>, not a
          headline number. The heat map flags codes that co-occur yet agree poorly — merge
          candidates. Reads the coding; never changes it.
        </p>
      </header>

      <ConceptPanel />

      {/* Controls */}
      <section className="mt-5 flex flex-wrap items-end gap-4 border border-foreground/15 p-4">
        <label className="flex flex-col gap-1 text-xs text-foreground/60">
          Session
          <select
            value={sessionId}
            onChange={(e) => onSession(e.target.value)}
            className="border border-foreground/25 bg-background px-2 py-1 text-sm text-foreground"
          >
            {sessions.map((s) => (
              <option key={s.sessionId} value={s.sessionId}>
                {s.pidLabel} ({s.coders.length} coders)
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-foreground/60">
          Coder A
          <select
            value={coderAId}
            onChange={(e) => setCoderAId(e.target.value)}
            className="border border-foreground/25 bg-background px-2 py-1 text-sm text-foreground"
          >
            {session?.coders.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.nCode})
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-foreground/60">
          Coder B
          <select
            value={coderBId}
            onChange={(e) => setCoderBId(e.target.value)}
            className="border border-foreground/25 bg-background px-2 py-1 text-sm text-foreground"
          >
            {session?.coders.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.nCode})
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-foreground/60">
          Min units/code
          <input
            type="number"
            min={1}
            max={100}
            value={minInstances}
            onChange={(e) => setMinInstances(Number(e.target.value))}
            className="w-20 border border-foreground/25 bg-background px-2 py-1 text-sm text-foreground"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-foreground/60">
          Window min–max (min)
          <span className="flex items-center gap-1">
            <input
              type="number"
              placeholder="0"
              value={winStartMin}
              onChange={(e) => setWinStartMin(e.target.value)}
              className="w-14 border border-foreground/25 bg-background px-2 py-1 text-sm text-foreground"
            />
            <span className="text-foreground/40">–</span>
            <input
              type="number"
              placeholder="end"
              value={winEndMin}
              onChange={(e) => setWinEndMin(e.target.value)}
              className="w-14 border border-foreground/25 bg-background px-2 py-1 text-sm text-foreground"
            />
          </span>
        </label>
        <button
          type="button"
          onClick={run}
          disabled={busy}
          className="border border-foreground bg-foreground px-3 py-1.5 text-sm text-background transition hover:opacity-90 disabled:opacity-40"
        >
          {busy ? 'Computing…' : 'Compute'}
        </button>
      </section>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      {/* v2 GATE: pendings are unasserted — IRR is blocked until every one
          resolves (attest / decompose / delete), BEFORE any cross-coder contact. */}
      {report && report.pendingCount > 0 && (
        <section className="mt-6 border border-amber-600/60 bg-amber-500/10 p-4">
          <p className="text-sm font-medium text-amber-900 dark:text-amber-300">
            IRR blocked — {report.pendingCount} pending assignment
            {report.pendingCount === 1 ? '' : 's'} on this session.
          </p>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-amber-900/80 dark:text-amber-300/80">
            A pending code is <i>not yet asserted</i>. Resolve every pending (attest, decompose,
            or delete it in the session player) before computing agreement or any cross-coder
            discussion of this session — otherwise the numbers describe half-made decisions.
          </p>
        </section>
      )}

      {report && report.pendingCount === 0 && (
        <>
          {/* v2: snapshot scope — IRR is reported WITH its snapshot id. */}
          <p className="mt-4 text-xs text-foreground/55">
            {report.snapshotId ? (
              <>
                snapshot <span className="font-mono">{report.snapshotId.slice(0, 8)}</span> — all
                assignments share it; this is reportable IRR.
              </>
            ) : (
              <span className="text-amber-700">
                {report.snapshotNote ?? 'no shared snapshot'} — read as calibration, not reportable
                IRR (cut a snapshot on the Buckets page before the next IRR session).
              </span>
            )}
          </p>

          {/* Code-subset selector */}
          <CodeFilter
            allCodes={report.allCodes}
            origin={report.codeOrigin}
            selected={selectedCodes}
            onToggle={toggleCode}
            onSetAll={setAllCodes}
          />

          {/* Headline */}
          <section className="mt-6 grid gap-3 sm:grid-cols-3">
            {report.headline.map((h, i) => (
              <div key={i} className="border border-foreground/15 p-4">
                <div className="text-xs uppercase tracking-wide text-foreground/45">{h.label}</div>
                <div className="mt-1 font-mono text-2xl">
                  {h.value}
                  {h.label.includes('κ') && h.value !== '—' && (
                    <span className="ml-2 align-middle text-xs text-foreground/45">
                      {band(Number(h.value))}
                    </span>
                  )}
                </div>
                <div className="mt-1 text-xs text-foreground/50">{h.sub}</div>
              </div>
            ))}
          </section>
          <p className="mt-3 text-xs leading-relaxed text-foreground/55">
            {report.coderA.name} vs {report.coderB.name} · {report.note}.
            {aprioriUnderpowered > 0 && (
              <>
                {' '}
                <span className="text-amber-700">
                  {aprioriUnderpowered} a-priori code{aprioriUnderpowered === 1 ? '' : 's'}{' '}
                  underpowered here — too few units to certify.
                </span>
              </>
            )}
          </p>

          <PerCodeTable report={report} />
          <CooccurrenceHeatmap co={report.cooccurrence} />

          {/* v2 descriptives: child-level agreement is descriptive only —
              decomposition RATE per coder×code + the ~15% audit sample. */}
          {report.decomposition.length > 0 && (
            <details className="mt-8 border border-foreground/15 px-4 py-3 text-sm">
              <summary className="cursor-pointer font-medium text-foreground/80">
                Decomposition rate{' '}
                <span className="font-normal text-foreground/45">· per coder × code (descriptive)</span>
              </summary>
              <table className="mt-2 text-xs">
                <tbody>
                  {report.decomposition
                    .filter((d) => d.total > 0)
                    .sort((a, b) => a.code.localeCompare(b.code) || a.coder.localeCompare(b.coder))
                    .map((d, i) => (
                      <tr key={i} className="border-b border-foreground/10">
                        <td className="py-1 pr-3 font-mono">{d.code}</td>
                        <td className="py-1 pr-3 text-foreground/60">{d.coder}</td>
                        <td className="py-1 pr-3 text-right font-mono">
                          {d.decomposed}/{d.total}
                        </td>
                        <td className="py-1 text-right font-mono text-foreground/60">
                          {Math.round((d.decomposed / d.total) * 100)}%
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </details>
          )}
          {report.auditSample.length > 0 && (
            <details className="mt-3 border border-foreground/15 px-4 py-3 text-sm">
              <summary className="cursor-pointer font-medium text-foreground/80">
                Audit sample{' '}
                <span className="font-normal text-foreground/45">
                  · {report.auditSample.length} combinatorial assignment
                  {report.auditSample.length === 1 ? '' : 's'} to fully decompose (~15%, deterministic)
                </span>
              </summary>
              <ul className="mt-2 space-y-1 text-xs">
                {report.auditSample.map((a, i) => (
                  <li key={i} className="font-mono">
                    {a.code} <span className="text-foreground/50">· {a.coder} · ann {a.annotationId.slice(0, 8)}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </main>
  );
}

/**
 * The conceptual frame — collapsible. David's method in three ideas: agreement is a
 * process check, sentences are the shared unit, and the heat map finds redundant
 * codes. Kept dense and specific to this study.
 */
function ConceptPanel() {
  return (
    <details className="mt-5 border border-foreground/15 bg-foreground/[0.02] px-4 py-3 text-sm">
      <summary className="cursor-pointer text-sm font-medium text-foreground/80">
        How to read this — three ideas
      </summary>
      <div className="mt-3 space-y-3 leading-relaxed text-foreground/70">
        <p>
          <b>1 · IRR is a process check, not a trophy number.</b> The point is not the κ; it is that
          you and the other coder took the time to agree on what the codes mean. Use it to find{' '}
          <i>systematic</i> disagreement (a code you consistently split on), fix the definition, and
          move on. κ = agreement minus luck: <span className="font-mono">κ = (p₀ − pₑ)/(1 − pₑ)</span>.
        </p>
        <p>
          <b>2 · The sentence is the shared unit.</b> Both coders highlight whole sentences (the
          restored transcript is one sentence per line), so you can&apos;t disagree on <i>edges</i> —
          only on <i>which</i> sentences and <i>which</i> code. <b>Overlap counts as agreement:</b>{' '}
          if you mark a sentence and the other coder marks the next, that is agreement (the{' '}
          <span className="font-mono">κ&nbsp;rlx</span> column, ±1-unit tolerance). Strict κ is the
          conservative read; relaxed is the honest one given how sentences split.
        </p>
        <p>
          <b>3 · The heat map finds codes to merge.</b> Each cell is how strongly two codes land on
          the <i>same</i> sentences (φ correlation, pooled across coders; diagonal = 1). Two codes
          that co-occur strongly <i>and</i> agree poorly are doing the same work under two names —{' '}
          <b>merge them</b> or sharpen a definition. Flagged pairs are listed under the map.
        </p>
      </div>
    </details>
  );
}

/** Code-subset selector — restricts BOTH the per-code table and the heat map. */
function CodeFilter({
  allCodes,
  origin,
  selected,
  onToggle,
  onSetAll,
}: {
  allCodes: string[];
  origin: Record<string, string>;
  selected: Set<string> | null;
  onToggle: (code: string) => void;
  onSetAll: (on: boolean) => void;
}) {
  const isOn = (c: string) => (selected ? selected.has(c) : true);
  const nOn = selected ? selected.size : allCodes.length;
  return (
    <details className="mt-6 border border-foreground/15 px-4 py-3 text-sm">
      <summary className="cursor-pointer font-medium text-foreground/80">
        Codes in analysis{' '}
        <span className="font-normal text-foreground/45">
          · {nOn}/{allCodes.length} selected
        </span>
      </summary>
      <div className="mt-3">
        <div className="mb-2 flex gap-3 text-xs">
          <button type="button" onClick={() => onSetAll(true)} className="underline hover:no-underline">
            all
          </button>
          <button type="button" onClick={() => onSetAll(false)} className="underline hover:no-underline">
            none
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {allCodes.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => onToggle(c)}
              className={`rounded-sm border px-1.5 py-0.5 font-mono text-[11px] transition ${
                isOn(c)
                  ? origin[c] === 'emergent'
                    ? 'border-lime-600/40 bg-lime-500/20'
                    : 'border-emerald-600/40 bg-emerald-500/15'
                  : 'border-foreground/15 text-foreground/40 line-through'
              }`}
              title={origin[c] ?? ''}
            >
              {c}
            </button>
          ))}
        </div>
      </div>
    </details>
  );
}

function PerCodeTable({ report }: { report: IrrReport }) {
  const { perCode, codeOrigin } = report;
  const [showEmergent, setShowEmergent] = useState(true);
  const rows = perCode.filter((p) => showEmergent || codeOrigin[p.code] !== 'emergent');
  return (
    <section className="mt-8">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-medium">Per-code agreement (sentence level)</h2>
        <label className="flex items-center gap-1.5 text-xs text-foreground/60">
          <input
            type="checkbox"
            checked={showEmergent}
            onChange={(e) => setShowEmergent(e.target.checked)}
          />
          show emergent (drift diagnostic)
        </label>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-foreground/45">
            <tr className="border-b border-foreground/15">
              <th className="py-1.5 pr-3 font-normal">code</th>
              <th className="py-1.5 pr-3 font-normal">origin</th>
              <th className="py-1.5 pr-3 text-right font-normal" title="chance-corrected agreement, strict per-sentence">
                κ
              </th>
              <th
                className="py-1.5 pr-3 text-right font-normal"
                title="overlap-relaxed κ: adjacent sentence (±1) counts as agreement"
              >
                κ&nbsp;rlx
              </th>
              <th className="py-1.5 pr-3 text-right font-normal">prev</th>
              <th className="py-1.5 pr-3 text-right font-normal" title="A / B / both — sentence-unit counts">
                A/B/✓
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr
                key={p.code}
                className={`border-b border-foreground/10 ${p.underpowered ? 'opacity-55' : ''}`}
              >
                <td className="py-1.5 pr-3 font-mono text-[13px]">
                  {p.code}
                  {p.underpowered && (
                    <span className="ml-1.5 text-[10px] uppercase text-amber-700" title="too few to trust">
                      low-n
                    </span>
                  )}
                </td>
                <td className="py-1.5 pr-3">
                  <span
                    className={`inline-block rounded-sm px-1 text-[11px] ${
                      codeOrigin[p.code] === 'emergent' ? 'bg-lime-500/20' : 'bg-emerald-500/15'
                    }`}
                  >
                    {codeOrigin[p.code] ?? '—'}
                  </span>
                </td>
                <td className="py-1.5 pr-3 text-right font-mono">{num(p.kappa)}</td>
                <td className="py-1.5 pr-3 text-right font-mono text-foreground/60">
                  {num(p.kappaRelaxed ?? null)}
                </td>
                <td className="py-1.5 pr-3 text-right font-mono text-foreground/60">{pct(p.prevalence)}</td>
                <td className="py-1.5 pr-3 text-right font-mono text-foreground/60">{p.counts}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-foreground/50">
        <span className="font-mono">κ</span> strict / <span className="font-mono">κ&nbsp;rlx</span>{' '}
        counts adjacent-sentence overlap as agreement (David&apos;s rule). <span className="uppercase">low-n</span>{' '}
        = below the min-units floor; not certifiable from this sample. Gate solo-coding per code
        (κ ≥ .80 licenses; .667–.80 keep double-coding).
      </p>
    </section>
  );
}

/** φ correlation → background color: warm for co-occurrence, cool for anti, pale at 0. */
function heatColor(v: number | null): string {
  if (v === null) return 'transparent';
  if (v >= 0) return `rgba(180, 83, 9, ${Math.min(1, v) * 0.85})`; // amber-700
  return `rgba(37, 99, 235, ${Math.min(1, -v) * 0.6})`; // blue-600
}

function CooccurrenceHeatmap({ co }: { co: CooccurrenceView }) {
  const { codes, matrix, counts, origin, mergeCandidates } = co;
  if (codes.length === 0) {
    return (
      <section className="mt-8 text-xs text-foreground/50">
        No codes to correlate in this selection.
      </section>
    );
  }
  return (
    <section className="mt-10">
      <h2 className="mb-1 text-sm font-medium">Code × code co-occurrence</h2>
      <p className="mb-3 max-w-2xl text-xs leading-relaxed text-foreground/55">
        Each cell is the φ correlation of two codes over sentence units (pooled across coders):
        warm = they land on the same sentences, cool = they avoid each other, diagonal = 1. Hover a
        cell for the shared-unit count. Strong warm cells among codes with weak agreement are merge
        candidates (below).
      </p>
      <div className="overflow-x-auto">
        <table className="border-collapse text-[11px]">
          <thead>
            <tr>
              <th className="p-1"></th>
              {codes.map((c, j) => (
                <th
                  key={j}
                  className="h-20 w-6 p-0 align-bottom font-mono font-normal text-foreground/55"
                  title={c}
                >
                  <div className="mx-auto w-4 origin-bottom-left -rotate-90 whitespace-nowrap text-left">
                    {c.length > 14 ? c.slice(0, 13) + '…' : c}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {codes.map((rc, i) => (
              <tr key={i}>
                <th
                  className="max-w-[9rem] truncate p-1 text-right font-mono font-normal text-foreground/60"
                  title={`${rc} (${origin[rc] ?? ''})`}
                >
                  {rc.length > 20 ? rc.slice(0, 19) + '…' : rc}
                </th>
                {codes.map((_, j) => {
                  const v = matrix[i][j];
                  const light = v !== null && v >= 0.5;
                  return (
                    <td
                      key={j}
                      style={{ backgroundColor: heatColor(v) }}
                      className={`h-6 w-6 border border-background text-center ${
                        light ? 'text-white' : 'text-foreground/70'
                      }`}
                      title={`${rc} × ${codes[j]} — φ=${v === null ? 'n/a' : v.toFixed(2)}, ${counts[i][j]} shared units`}
                    >
                      {i === j ? '' : v === null ? '' : Math.abs(v) >= 0.3 ? Math.round(v * 10) : ''}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-foreground/45">
        Cell numerals are φ×10 (shown only for |φ| ≥ 0.3) to keep the grid legible; hover for exact
        φ and the shared-unit count.
      </p>

      {mergeCandidates.length > 0 ? (
        <div className="mt-5">
          <h3 className="text-sm font-medium">Merge candidates</h3>
          <p className="mb-2 text-xs text-foreground/55">
            Highly correlated (φ ≥ 0.5) with weak agreement (min κ &lt; 0.6, or uncertifiable) — the
            same construct under two names, or a definition that needs sharpening.
          </p>
          <ul className="space-y-1 text-sm">
            {mergeCandidates.map((m, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-x-2 font-mono text-[13px]">
                <span className="rounded-sm bg-amber-500/15 px-1">{m.a}</span>
                <span className="text-foreground/40">↔</span>
                <span className="rounded-sm bg-amber-500/15 px-1">{m.b}</span>
                <span className="text-foreground/55">
                  φ={m.corr.toFixed(2)} · {m.jointUnits} shared ·{' '}
                  {m.weakKappa === null ? 'κ uncertifiable' : `min κ=${m.weakKappa.toFixed(2)}`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mt-4 text-xs text-foreground/45">
          No merge candidates in this selection (no strongly-correlated pair also has weak
          agreement).
        </p>
      )}
    </section>
  );
}
