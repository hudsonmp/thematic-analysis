'use client';

import { Fragment, useState } from 'react';
import {
  computeIrr,
  type IrrMethod,
  type IrrReport,
  type IrrSessionOption,
} from '@/app/actions/irr';

/**
 * The IRR surface. Pick a session with two coders, pick the STATISTIC —
 *  • EasyDIAg (event matching, IPF-κ): answers "same events?", penalizes
 *    boundary jitter (Holle & Rein 2014).
 *  • Time-grid κ (fixed bins, Cohen's κ): answers "agree bin-by-bin?", robust to
 *    boundary jitter because both coders inherit the same units (Bakeman 2009).
 * Both render one overall row + one per-code table. Read-only; never changes the
 * coding. Method rationale + the 548 diagnosis in docs/irr-design.md.
 */

function pct(x: number | null): string {
  return x === null ? '—' : `${Math.round(x * 100)}%`;
}
function num(x: number | null): string {
  return x === null ? '—' : x.toFixed(2);
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
  const [method, setMethod] = useState<IrrMethod>('timegrid');
  const [thresholdPct, setThresholdPct] = useState(60);
  const [binSec, setBinSec] = useState(2);
  const [minInstances, setMinInstances] = useState(5);
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
      method,
      threshold: thresholdPct / 100,
      binMs: binSec * 1000,
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

  const aprioriUnderpowered = report
    ? report.perCode.filter((p) => report.codeOrigin[p.code] === 'a_priori' && p.underpowered).length
    : 0;

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <header>
        <h1 className="text-lg font-medium tracking-tight">Inter-rater reliability</h1>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-foreground/60">
          Agreement on the code annotations, in time. Choose the statistic; both give an overall
          figure and a code-by-code table. This reads the coding; it never changes it. Method &amp;
          the 548 diagnosis in <code>docs/irr-design.md</code>.
        </p>
      </header>

      <ConceptPanel />

      {/* Method selector */}
      <section className="mt-6 flex gap-2">
        {(
          [
            ['timegrid', 'Time-grid κ', 'Cohen κ on fixed bins · robust to boundary jitter (Bakeman)'],
            ['easydiag', 'EasyDIAg', 'Event matching by overlap · IPF-κ (Holle & Rein)'],
          ] as [IrrMethod, string, string][]
        ).map(([m, label, sub]) => (
          <button
            key={m}
            type="button"
            onClick={() => {
              setMethod(m);
              setReport(null);
            }}
            className={`flex-1 border px-3 py-2 text-left transition ${
              method === m
                ? 'border-foreground bg-foreground/5'
                : 'border-foreground/15 hover:bg-foreground/5'
            }`}
          >
            <div className="text-sm font-medium">{label}</div>
            <div className="text-xs text-foreground/55">{sub}</div>
          </button>
        ))}
      </section>

      {/* Controls */}
      <section className="mt-4 flex flex-wrap items-end gap-4 border border-foreground/15 p-4">
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
        {method === 'easydiag' ? (
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
        ) : (
          <label className="flex flex-col gap-1 text-xs text-foreground/60">
            Bin width {binSec}s
            <input
              type="range"
              min={1}
              max={10}
              step={1}
              value={binSec}
              onChange={(e) => setBinSec(Number(e.target.value))}
              className="w-32"
            />
          </label>
        )}
        <label className="flex flex-col gap-1 text-xs text-foreground/60">
          Min {method === 'timegrid' ? 'bins' : 'instances'}
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

      {report && (
        <>
          {/* Headline (overall) */}
          <section className="mt-8 grid gap-3 sm:grid-cols-3">
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
                  underpowered here — too few {method === 'timegrid' ? 'active bins' : 'instances'}{' '}
                  to certify.
                </span>
              </>
            )}
          </p>

          <PerCodeTable report={report} method={method} />

          {report.method === 'easydiag' && report.confusion && (
            <ConfusionMatrix report={report} />
          )}
        </>
      )}
    </main>
  );
}

/**
 * The conceptual frame — collapsible, so it scaffolds on first read and gets out
 * of the way once the ideas are yours (expertise-reversal: scaffolding that
 * can't be dismissed becomes noise for the expert). Kept dense and specific to
 * this study; it teaches the mental model, not a textbook.
 */
function ConceptPanel() {
  return (
    <details className="mt-5 border border-foreground/15 bg-foreground/[0.02] px-4 py-3 text-sm">
      <summary className="cursor-pointer text-sm font-medium text-foreground/80">
        How to read this — the four ideas
      </summary>
      <div className="mt-3 space-y-3 leading-relaxed text-foreground/70">
        <p>
          <b>1 · Two questions, not one.</b> Reliability decomposes into{' '}
          <i>segmentation</i> (do you and the other coder mark the <i>same moments</i>?) and{' '}
          <i>categorization</i> (given you both marked a moment, do you assign the <i>same
          code</i>?). A single number hides which one is failing. Yours fails on segmentation
          first — fix that before the codes.
        </p>
        <p>
          <b>2 · κ is agreement minus luck.</b> Raw agreement counts how often you match; κ
          subtracts the matches you&apos;d expect by chance and rescales:{' '}
          <span className="font-mono">κ = (p₀ − pₑ)/(1 − pₑ)</span>, where p₀ is observed
          agreement and pₑ is chance agreement. κ = 0 means &ldquo;no better than luck&rdquo;;
          κ = 1 is perfect. Expand any code&apos;s row below to see this computed on its real
          bins.
        </p>
        <p>
          <b>3 · The base-rate paradox.</b> When a code is rare, you agree on its <i>absence</i>{' '}
          almost every bin — so chance agreement pₑ is nearly 1, and κ collapses toward 0 even at
          96% raw agreement. That low κ is an <span className="text-amber-700">artifact</span> (we
          flag it amber), not real disagreement. Gwet&apos;s <b>AC1</b> is the guard: it estimates
          chance differently and doesn&apos;t collapse. But AC1 <i>over</i>-credits absence, so
          trust it per-prevalent-code, never as a headline.
        </p>
        <p>
          <b>4 · The two instruments measure different failures.</b>{' '}
          <b>Time-grid κ</b> slices the session into fixed bins both coders share, so it forgives
          different <i>edges</i> around the same moment. <b>EasyDIAg</b> matches your free-drawn
          spans and penalizes edge differences. Flip between them on a well-sampled code: κ near 0
          under EasyDIAg but ~0.6 under time-grid means your disagreement is boundary-drawing, not
          perception. Full rationale in <code>docs/irr-design.md</code>.
        </p>
      </div>
    </details>
  );
}

/** A transparent worked κ for one code (time-grid), computed on its real bins —
 *  the worked-example device that makes the formula concrete on the user's data. */
function WorkedKappa({ cells }: { cells: { n11: number; n10: number; n01: number; n00: number } }) {
  const { n11, n10, n01, n00 } = cells;
  const N = n11 + n10 + n01 + n00;
  if (N === 0) return null;
  const po = (n11 + n00) / N;
  const pa = (n11 + n10) / N; // this coder active-rate
  const pb = (n11 + n01) / N; // other coder active-rate
  const pe = pa * pb + (1 - pa) * (1 - pb);
  const kappa = 1 - pe === 0 ? null : (po - pe) / (1 - pe);
  const f = (x: number) => x.toFixed(3);
  return (
    <div className="bg-foreground/[0.02] px-4 py-3 text-xs leading-relaxed text-foreground/70">
      <div className="mb-2 grid max-w-xs grid-cols-3 gap-x-3 gap-y-0.5 font-mono">
        <span></span>
        <span className="text-foreground/45">B active</span>
        <span className="text-foreground/45">B not</span>
        <span className="text-foreground/45">A active</span>
        <span className="font-semibold text-emerald-700">{n11}</span>
        <span>{n10}</span>
        <span className="text-foreground/45">A not</span>
        <span>{n01}</span>
        <span className="font-semibold text-emerald-700">{n00}</span>
      </div>
      <p>
        Of <b>{N}</b> bins, you agree on <b>{n11 + n00}</b> (both active {n11} + both empty {n00}),
        so observed agreement <span className="font-mono">p₀ = {n11 + n00}/{N} = {f(po)}</span>.
      </p>
      <p className="mt-1">
        You mark this code in <span className="font-mono">{f(pa)}</span> of bins, the other coder{' '}
        <span className="font-mono">{f(pb)}</span>; so by chance you&apos;d both-agree{' '}
        <span className="font-mono">
          pₑ = {f(pa)}·{f(pb)} + {f(1 - pa)}·{f(1 - pb)} = {f(pe)}
        </span>
        .
      </p>
      <p className="mt-1">
        <span className="font-mono">
          κ = (p₀ − pₑ)/(1 − pₑ) = ({f(po)} − {f(pe)})/(1 − {f(pe)}) ={' '}
          <b>{kappa === null ? '—' : f(kappa)}</b>
        </span>
        {pe > 0.9 && (
          <span className="text-amber-700">
            {' '}
            — note pₑ ≈ {f(pe)}: almost all agreement here is agreement-on-absence, so κ is
            base-rate-suppressed (idea 3).
          </span>
        )}
      </p>
    </div>
  );
}

function PerCodeTable({ report, method }: { report: IrrReport; method: IrrMethod }) {
  const { perCode, codeOrigin } = report;
  const [showEmergent, setShowEmergent] = useState(true);
  const [openCode, setOpenCode] = useState<string | null>(null);
  const rows = perCode.filter((p) => showEmergent || codeOrigin[p.code] !== 'emergent');
  const countsHead = method === 'timegrid' ? 'A/B/✓ bins' : 'A/B/✓';
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
              <th className="py-1.5 pr-3 text-right font-normal" title="chance-corrected agreement">κ</th>
              <th className="py-1.5 pr-3 text-right font-normal" title="Gwet's AC1 — paradox-robust">AC1</th>
              <th className="py-1.5 pr-3 text-right font-normal">prev</th>
              <th className="py-1.5 pr-3 text-right font-normal" title={countsHead}>{countsHead}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const canExpand = p.cells !== undefined;
              const open = openCode === p.code;
              return (
                <Fragment key={p.code}>
                  <tr
                    onClick={() => canExpand && setOpenCode(open ? null : p.code)}
                    className={`border-b border-foreground/10 ${p.underpowered ? 'opacity-55' : ''} ${
                      canExpand ? 'cursor-pointer hover:bg-foreground/[0.03]' : ''
                    }`}
                    title={canExpand ? 'Click to see the κ computed on this code’s bins' : undefined}
                  >
                    <td className="py-1.5 pr-3 font-mono text-[13px]">
                      {canExpand && (
                        <span className="mr-1 inline-block text-foreground/40">{open ? '▾' : '▸'}</span>
                      )}
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
                    <td className={`py-1.5 pr-3 text-right font-mono ${p.paradox ? 'text-amber-700' : ''}`}>
                      {num(p.kappa)}
                    </td>
                    <td className="py-1.5 pr-3 text-right font-mono">{num(p.ac1)}</td>
                    <td className="py-1.5 pr-3 text-right font-mono text-foreground/60">
                      {pct(p.prevalence)}
                    </td>
                    <td className="py-1.5 pr-3 text-right font-mono text-foreground/60">{p.counts}</td>
                  </tr>
                  {open && p.cells && (
                    <tr>
                      <td colSpan={6} className="border-b border-foreground/10 p-0">
                        <WorkedKappa cells={p.cells} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-foreground/50">
        <span className="text-amber-700">Amber κ</span> = base-rate paradox (low κ despite high
        agreement and low prevalence — read AC1). <span className="uppercase">low-n</span> = below
        the min floor; not certifiable from this sample. Gate solo-coding per code (κ ≥ .80
        licenses; .667–.80 keep double-coding).
      </p>
    </section>
  );
}

function ConfusionMatrix({ report }: { report: IrrReport }) {
  const conf = report.confusion!;
  const cats = conf.categories;
  return (
    <section className="mt-8">
      <h2 className="mb-2 text-sm font-medium">
        Confusion matrix{' '}
        <span className="font-normal text-foreground/45">
          · rows {report.coderA.name} · cols {report.coderB.name}
        </span>
      </h2>
      <div className="overflow-x-auto">
        <table className="text-right text-[11px]">
          <thead>
            <tr className="text-foreground/45">
              <th className="p-1"></th>
              {cats.map((c, j) => (
                <th key={j} className="max-w-[3rem] truncate p-1 font-mono font-normal" title={c}>
                  {c === 'Void' ? '∅' : c.slice(0, 6)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="font-mono">
            {cats.map((rc, i) => (
              <tr key={i}>
                <th className="max-w-[7rem] truncate p-1 text-left font-normal text-foreground/60" title={rc}>
                  {rc === 'Void' ? '∅ Void' : rc}
                </th>
                {cats.map((_, j) => {
                  const v = conf.matrix[i][j];
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
        Diagonal = agreements. ∅ (Void) rows/cols are events one coder marked and the other did not;
        ∅×∅ is a structural zero, which is why κ is IPF-corrected.
      </p>
    </section>
  );
}
