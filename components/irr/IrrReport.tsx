'use client';

import { useState } from 'react';
import {
  computeIrr,
  type IrrReport,
  type IrrSessionOption,
} from '@/app/actions/irr';

/**
 * The IRR (EasyDIAg) surface. READ-ONLY: pick a session with two coders, pick
 * the overlap threshold, and read the reliability. Every number is per code
 * (never a single pooled κ), reported beside prevalence, raw agreement, and
 * Gwet's AC1 so a base-rate artifact is legible as such. Underpowered codes —
 * too few instances to trust — are flagged, not hidden.
 *
 * The method and every design decision are documented in
 * lib/irr/easydiag.ts and docs/irr-design.md.
 */

function pct(x: number | null): string {
  return x === null ? '—' : `${Math.round(x * 100)}%`;
}
function num(x: number | null): string {
  return x === null ? '—' : x.toFixed(2);
}
/** Landis & Koch band, shown only as a reference — the cutoffs are, per the
 *  authors, arbitrary (see docs). */
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
  const [thresholdPct, setThresholdPct] = useState(60);
  const [minInstances, setMinInstances] = useState(10);
  // Matched-effort window (minutes). A coder who stopped early left the tail
  // uncoded — that is not disagreement, so restrict the estimate to where both
  // coded at comparable density (see docs/irr-design.md §8).
  const [winStartMin, setWinStartMin] = useState('');
  const [winEndMin, setWinEndMin] = useState('');
  const [report, setReport] = useState<IrrReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (sessions.length === 0) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-12 text-sm text-foreground/60">
        No session has two coders with code annotations yet. IRR needs one
        session independently double-coded.
      </main>
    );
  }

  const run = () => {
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
      threshold: thresholdPct / 100,
      minInstances,
      windowStartMs: toMs(winStartMin),
      windowEndMs: toMs(winEndMin),
    })
      .then((r) => setReport(r))
      .catch((e) => setError(String(e?.message ?? e)))
      .finally(() => setBusy(false));
  };

  const onSession = (id: string) => {
    setSessionId(id);
    const s = sessions.find((x) => x.sessionId === id);
    setCoderAId(s?.coders[0]?.id ?? '');
    setCoderBId(s?.coders[1]?.id ?? '');
    setReport(null);
  };

  const r = report?.result;
  const aprioriUnderpowered = r
    ? r.perCode.filter((p) => report!.codeOrigin[p.code] === 'a_priori' && p.underpowered).length
    : 0;

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <header>
        <h1 className="text-lg font-medium tracking-tight">Inter-rater reliability · EasyDIAg</h1>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-foreground/60">
          Time-domain agreement on the code annotations (Holle &amp; Rein 2014). Two coders&apos;
          codes are linked by temporal overlap, then chance-corrected per code. This reads the
          coding; it never changes it. Method &amp; rationale in <code>docs/irr-design.md</code>.
        </p>
      </header>

      {/* Controls */}
      <section className="mt-6 flex flex-wrap items-end gap-4 border border-foreground/15 p-4">
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
          Overlap link ≥ {thresholdPct}%
          <input
            type="range"
            min={10}
            max={100}
            step={5}
            value={thresholdPct}
            onChange={(e) => setThresholdPct(Number(e.target.value))}
            className="w-32"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-foreground/60">
          Min instances
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

      {r && report && (
        <>
          {/* Headline */}
          <section className="mt-8 grid gap-3 sm:grid-cols-3">
            <Stat
              label="Overall κ"
              value={num(r.overallKappa)}
              sub={`${band(r.overallKappa)} · IPF-corrected`}
            />
            <Stat
              label="Segmentation agreement"
              value={pct(r.segmentationAgreement)}
              sub={`${r.nLinked} linked · ${r.nUnmatchedA}+${r.nUnmatchedB} unmatched`}
            />
            <Stat
              label="Categorization agreement"
              value={pct(r.categorizationAgreement)}
              sub="of linked pairs, same code"
            />
          </section>
          <p className="mt-3 text-xs leading-relaxed text-foreground/55">
            Overlap threshold {Math.round(r.threshold * 100)}% · {report.coderA.name} coded{' '}
            {r.nEventsA} events, {report.coderB.name} coded {r.nEventsB}. Overall κ is the joint
            segmentation+categorization coefficient over the full table incl. the unmatched
            (&ldquo;Void&rdquo;) margin; read it as context, and gate on the PER-CODE numbers below.
            {aprioriUnderpowered > 0 && (
              <>
                {' '}
                <span className="text-amber-700">
                  {aprioriUnderpowered} a-priori code
                  {aprioriUnderpowered === 1 ? '' : 's'} are underpowered in this session — too few
                  instances to certify (add sessions or keep double-coding those).
                </span>
              </>
            )}
          </p>

          {/* Per-code table */}
          <PerCodeTable report={report} />

          {/* Confusion matrix */}
          <ConfusionMatrix report={report} />
        </>
      )}
    </main>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="border border-foreground/15 p-4">
      <div className="text-xs uppercase tracking-wide text-foreground/45">{label}</div>
      <div className="mt-1 font-mono text-2xl">{value}</div>
      <div className="mt-1 text-xs text-foreground/50">{sub}</div>
    </div>
  );
}

function PerCodeTable({ report }: { report: IrrReport }) {
  const { result, codeOrigin } = report;
  const [showEmergent, setShowEmergent] = useState(true);
  const rows = result.perCode.filter(
    (p) => showEmergent || codeOrigin[p.code] !== 'emergent',
  );
  return (
    <section className="mt-8">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-medium">Per code</h2>
        <label className="flex items-center gap-1.5 text-xs text-foreground/60">
          <input
            type="checkbox"
            checked={showEmergent}
            onChange={(e) => setShowEmergent(e.target.checked)}
          />
          show emergent (drift diagnostic, not a reliability claim)
        </label>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-foreground/45">
            <tr className="border-b border-foreground/15">
              <th className="py-1.5 pr-3 font-normal">code</th>
              <th className="py-1.5 pr-3 font-normal">origin</th>
              <th className="py-1.5 pr-3 text-right font-normal" title="chance-corrected agreement (IPF-κ)">κ</th>
              <th className="py-1.5 pr-3 text-right font-normal" title="Gwet's AC1 — paradox-robust">AC1</th>
              <th className="py-1.5 pr-3 text-right font-normal" title="raw agreement over linked pairs">raw</th>
              <th className="py-1.5 pr-3 text-right font-normal">prev</th>
              <th className="py-1.5 pr-3 text-right font-normal" title="events by A / by B / linked-both">A/B/✓</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const paradox =
                p.kappa !== null && p.rawAgreement !== null && p.kappa < 0.4 && p.rawAgreement > 0.8;
              return (
                <tr
                  key={p.code}
                  className={`border-b border-foreground/10 ${p.underpowered ? 'opacity-55' : ''}`}
                >
                  <td className="py-1.5 pr-3 font-mono text-[13px]">
                    {p.code}
                    {p.underpowered && (
                      <span className="ml-1.5 text-[10px] uppercase text-amber-700" title="too few instances to trust">
                        low-n
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3">
                    <span
                      className={`inline-block rounded-sm px-1 text-[11px] ${
                        codeOrigin[p.code] === 'emergent'
                          ? 'bg-lime-500/20'
                          : 'bg-emerald-500/15'
                      }`}
                    >
                      {codeOrigin[p.code] ?? '—'}
                    </span>
                  </td>
                  <td className={`py-1.5 pr-3 text-right font-mono ${paradox ? 'text-amber-700' : ''}`}>
                    {num(p.kappa)}
                  </td>
                  <td className="py-1.5 pr-3 text-right font-mono">{num(p.ac1)}</td>
                  <td className="py-1.5 pr-3 text-right font-mono text-foreground/60">{pct(p.rawAgreement)}</td>
                  <td className="py-1.5 pr-3 text-right font-mono text-foreground/60">{pct(p.prevalence)}</td>
                  <td className="py-1.5 pr-3 text-right font-mono text-foreground/60">
                    {p.byCoderA}/{p.byCoderB}/{p.linkedBoth}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-foreground/50">
        <span className="text-amber-700">Amber κ</span> = base-rate paradox (low κ despite high raw
        agreement and low prevalence — read AC1 instead). <span className="uppercase">low-n</span> =
        below the min-instance floor; not certifiable from this sample regardless of the point
        estimate. Gate solo-coding per code (κ ≥ .80 licenses; .667–.80 keep double-coding).
      </p>
    </section>
  );
}

function ConfusionMatrix({ report }: { report: IrrReport }) {
  const { result } = report;
  const cats = result.categories;
  // Only show categories that appear (a full 38-wide matrix is unreadable).
  const active = cats
    .map((c, i) => ({ c, i }))
    .filter(({ i }) =>
      result.confusion[i].some((v) => v > 0) || result.confusion.some((row) => row[i] > 0),
    );
  return (
    <section className="mt-8">
      <h2 className="mb-2 text-sm font-medium">
        Confusion matrix <span className="font-normal text-foreground/45">· rows {report.coderA.name} · cols {report.coderB.name}</span>
      </h2>
      <div className="overflow-x-auto">
        <table className="text-right text-[11px]">
          <thead>
            <tr className="text-foreground/45">
              <th className="p-1"></th>
              {active.map(({ c, i }) => (
                <th key={i} className="max-w-[3rem] truncate p-1 font-mono font-normal" title={c}>
                  {c === 'Void' ? '∅' : c.slice(0, 6)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="font-mono">
            {active.map(({ c: rc, i }) => (
              <tr key={i}>
                <th className="max-w-[7rem] truncate p-1 text-left font-normal text-foreground/60" title={rc}>
                  {rc === 'Void' ? '∅ Void' : rc}
                </th>
                {active.map(({ i: j }) => {
                  const v = result.confusion[i][j];
                  const diag = i === j;
                  return (
                    <td
                      key={j}
                      className={`p-1 ${v === 0 ? 'text-foreground/20' : diag ? 'bg-emerald-500/15 font-semibold' : 'text-foreground/70'}`}
                    >
                      {v}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-foreground/50">
        Diagonal = agreements. The ∅ (Void) row/col are events one coder marked and the other did
        not; ∅×∅ is a structural zero (an event neither coder saw cannot exist), which is why κ is
        IPF-corrected rather than plain Cohen&apos;s.
      </p>
    </section>
  );
}
