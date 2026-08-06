'use client';

import { useMemo, useState } from 'react';
import {
  computeIrr,
  type IrrReport,
  type IrrSessionOption,
  type CooccurrenceView,
} from '@/app/actions/irr';
import { IRR_TARGET_KAPPA } from '@/lib/irr/target';

/**
 * The reliability + code co-occurrence surface, per the Aug 4 method
 * (Zihan/David/Moonwara; precedent map in the 08-04 reading guide):
 *
 * POOLED κ over a SELECTED SET of sessions — "compute IRR on those three" —
 * one statistic from summed per-session contingency tables, judged against the
 * PREREGISTERED target κ ≥ 0.70 (McDonald et al. 2019 §5.3.5: state the
 * target before the analysis). Sessions the coders reconciled in meetings
 * (calibration) can be marked as such: including them is Zihan's pooled
 * variant (B) and must be disclosed in methods; excluding them is plan A.
 *
 * Per-code strict κ stays the diagnostic for systematic disagreement; the
 * heat map flags merge candidates. Read-only; never changes coding.
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
  // Pool selection: which sessions enter the κ pool, and which of those the
  // coders CALIBRATED on (reconciliation meetings) — a methods disclosure, not
  // a computation change.
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(sessions.map((s) => s.sessionId)),
  );
  const [calib, setCalib] = useState<Set<string>>(() => new Set());

  // Coder options = union across the selected sessions (same user ids appear
  // in every session they coded; counts summed for display).
  const coderOptions = useMemo(() => {
    const m = new Map<string, { id: string; name: string; nCode: number }>();
    for (const s of sessions) {
      if (!selected.has(s.sessionId)) continue;
      for (const c of s.coders) {
        const cur = m.get(c.id);
        if (cur) cur.nCode += c.nCode;
        else m.set(c.id, { ...c });
      }
    }
    return [...m.values()].sort((a, b) => b.nCode - a.nCode);
  }, [sessions, selected]);

  const [coderAId, setCoderAId] = useState(sessions[0]?.coders[0]?.id ?? '');
  const [coderBId, setCoderBId] = useState(sessions[0]?.coders[1]?.id ?? '');
  // Toggling sessions can shrink the coder union; fall back to valid options so
  // a stale id never reaches the action (where it would empty the whole pool).
  const aId = coderOptions.some((c) => c.id === coderAId)
    ? coderAId
    : (coderOptions[0]?.id ?? '');
  const bId = coderOptions.some((c) => c.id === coderBId && c.id !== aId)
    ? coderBId
    : (coderOptions.find((c) => c.id !== aId)?.id ?? '');
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
    if (selected.size === 0 || !aId || !bId || aId === bId) {
      setError('Pick at least one session and two different coders.');
      return;
    }
    setBusy(true);
    setError(null);
    const toMs = (v: string) => (v.trim() === '' ? null : Math.round(Number(v) * 60000));
    computeIrr({
      sessionIds: sessions.filter((s) => selected.has(s.sessionId)).map((s) => s.sessionId),
      coderAId: aId,
      coderBId: bId,
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

  const toggleSession = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
    setReport(null);
    setSelectedCodes(null);
  };
  const toggleCalib = (id: string) => {
    const next = new Set(calib);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCalib(next);
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

  // Pool-composition disclosure: which INCLUDED sessions were marked calibration.
  const includedCalib = report
    ? report.pool.filter((p) => p.included && calib.has(p.sessionId)).map((p) => p.pidLabel)
    : [];

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <header>
        <h1 className="text-lg font-medium tracking-tight">Reliability &amp; code co-occurrence</h1>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-foreground/60">
          κ is computed <b>pooled over the selected sessions</b> at the sentence level — one
          statistic from summed contingency tables, judged against the preregistered target. Per-code
          rows stay the <i>diagnostic for systematic disagreement</i>; the heat map flags merge
          candidates. Reads the coding; never changes it.
        </p>
      </header>

      <TargetPanel />
      <ConceptPanel />

      {/* Controls */}
      <section className="mt-5 border border-foreground/15 p-4">
        {/* Session pool picker */}
        <div className="mb-3">
          <div className="mb-1.5 text-xs text-foreground/60">
            κ pool — sessions to compute over{' '}
            <span className="text-foreground/40">
              · mark <b>calib</b> on sessions you reconciled in a meeting (548, 083): including them
              is the pooled variant (B) and must be disclosed; deselect them for plan A
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {sessions.map((s) => {
              const on = selected.has(s.sessionId);
              const isCal = calib.has(s.sessionId);
              return (
                <span
                  key={s.sessionId}
                  className={`flex items-center gap-1.5 border px-2 py-1 text-sm ${
                    on ? 'border-foreground/40' : 'border-foreground/15 text-foreground/40'
                  }`}
                >
                  <label className="flex cursor-pointer items-center gap-1.5">
                    <input type="checkbox" checked={on} onChange={() => toggleSession(s.sessionId)} />
                    <span className="font-mono">{s.pidLabel}</span>
                    <span className="text-xs text-foreground/40">({s.coders.length} coders)</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => toggleCalib(s.sessionId)}
                    title="Mark as a calibration session (coded with reconciliation meetings) — a methods disclosure, not a computation change"
                    className={`rounded-sm px-1 text-[10px] uppercase tracking-wide transition ${
                      isCal
                        ? 'bg-amber-500/20 text-amber-800'
                        : 'text-foreground/30 hover:text-foreground/60'
                    }`}
                  >
                    calib
                  </button>
                </span>
              );
            })}
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-1 text-xs text-foreground/60">
            Coder A
            <select
              value={aId}
              onChange={(e) => setCoderAId(e.target.value)}
              className="border border-foreground/25 bg-background px-2 py-1 text-sm text-foreground"
            >
              {coderOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.nCode})
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-foreground/60">
            Coder B
            <select
              value={bId}
              onChange={(e) => setCoderBId(e.target.value)}
              className="border border-foreground/25 bg-background px-2 py-1 text-sm text-foreground"
            >
              {coderOptions.map((c) => (
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
        </div>
      </section>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      {report && (
        <>
          {/* Decision vs the preregistered target */}
          <DecisionBanner report={report} includedCalib={includedCalib} />

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
        </>
      )}
    </main>
  );
}

/**
 * WHAT THE STATS NEED TO BE — the preregistered decision procedure, stated
 * before any number renders (McDonald et al. 2019 §5.3.5: a target set after
 * seeing the data is not a target). Always visible, not collapsed.
 */
function TargetPanel() {
  return (
    <section className="mt-5 border border-foreground/25 bg-foreground/[0.03] px-4 py-3 text-sm leading-relaxed">
      <h2 className="text-xs font-medium uppercase tracking-wide text-foreground/55">
        What the stats need to be — preregistered (Aug 4 meeting)
      </h2>
      <ul className="mt-2 space-y-1 text-foreground/75">
        <li>
          <b>Decision statistic:</b> mean strict per-code κ over powered codes, computed{' '}
          <i>pooled</i> across the measurement sessions (one κ from summed tables — not a mean of
          per-session κs).
        </li>
        <li>
          <b>Target:</b>{' '}
          <span className="font-mono">κ ≥ {IRR_TARGET_KAPPA.toFixed(2)}</span> (set in advance —
          McDonald et al. 2019 §5.3.5). Reached → the codebook is certified; solo-code the remainder
          (Kazemitabaar et al. 2023). Not reached → revise the codebook and run another independent
          round; do not lower the target.
        </li>
        <li>
          <b>Pool (plan A):</b> only sessions coded <i>independently</i> — no reconciliation
          meetings between the coders on them; calibration sessions (548, 083) stay out. Including
          them is the pooled variant (B, Zihan) and must be disclosed in methods.
        </li>
        <li>
          <b>Reading the table:</b> strict κ decides; <span className="font-mono">κ rlx</span> (±1
          sentence) is a sensitivity check only. <span className="uppercase">low-n</span> codes give
          direction, not verdicts.
        </li>
      </ul>
    </section>
  );
}

/** The verdict against the preregistered target, plus the pool-composition disclosure. */
function DecisionBanner({
  report,
  includedCalib,
}: {
  report: IrrReport;
  includedCalib: string[];
}) {
  const d = report.decision;
  const reached = d.meanKappa !== null && d.meanKappa >= d.target;
  return (
    <section className="mt-6 space-y-2">
      {d.meanKappa === null ? (
        <div className="border border-foreground/20 bg-foreground/[0.03] px-4 py-3 text-sm text-foreground/70">
          No powered code yields a computable κ on this pool — nothing to judge against the target
          yet. Pool more sessions or lower the min-units floor knowingly.
        </div>
      ) : reached ? (
        <div className="border border-emerald-700/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-900">
          <b>
            κ = {d.meanKappa.toFixed(2)} ≥ {d.target.toFixed(2)} — target reached.
          </b>{' '}
          The codebook is certified on this pool; solo-coding the remainder is licensed
          (Kazemitabaar et al. 2023 precedent). {d.poweredAtTarget}/{d.poweredTotal} powered codes
          individually clear the target — codes below it still deserve a definition pass.
        </div>
      ) : (
        <div className="border border-amber-700/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-900">
          <b>
            κ = {d.meanKappa.toFixed(2)} &lt; {d.target.toFixed(2)} — target not reached.
          </b>{' '}
          Revise the codebook where per-code κ is weak, then run another independent round (David:
          choosing IRR obligates acting on a bad κ — do not lower the target). {d.poweredAtTarget}/
          {d.poweredTotal} powered codes clear it individually.
        </div>
      )}
      {includedCalib.length > 0 ? (
        <div className="border border-amber-700/30 bg-amber-500/5 px-4 py-2 text-xs leading-relaxed text-amber-900/90">
          <b>Pooled variant (B):</b> the pool includes calibration session
          {includedCalib.length === 1 ? '' : 's'} {includedCalib.join(', ')} — coded with
          reconciliation meetings. Legitimate (Zihan: syncing polishes the codebook without forcing
          code-level agreement) but it must be <b>disclosed in methods</b>. Deselect{' '}
          {includedCalib.length === 1 ? 'it' : 'them'} for plan A.
        </div>
      ) : (
        <div className="border border-foreground/15 px-4 py-2 text-xs leading-relaxed text-foreground/60">
          <b>Independent pool (plan A):</b> no session in the pool is marked as calibration — κ is
          measured on independently coded sessions only.
        </div>
      )}
    </section>
  );
}

/**
 * The conceptual frame — collapsible. The method in three ideas: agreement is a
 * process check, sentences are the shared unit, and the heat map finds redundant
 * codes. Kept dense and specific to this study.
 */
function ConceptPanel() {
  return (
    <details className="mt-3 border border-foreground/15 bg-foreground/[0.02] px-4 py-3 text-sm">
      <summary className="cursor-pointer text-sm font-medium text-foreground/80">
        How to read this — three ideas
      </summary>
      <div className="mt-3 space-y-3 leading-relaxed text-foreground/70">
        <p>
          <b>1 · IRR is a process check with a preregistered stake.</b> The per-code table finds{' '}
          <i>systematic</i> disagreement (a code you consistently split on) so you can fix the
          definition. The pooled mean is different: it is judged against the target you set in
          advance, and the outcome is binding — reached licenses solo-coding, missed obligates
          another round. κ = agreement minus luck:{' '}
          <span className="font-mono">κ = (p₀ − pₑ)/(1 − pₑ)</span>.
        </p>
        <p>
          <b>2 · The sentence is the shared unit, pooled across sessions.</b> Both coders highlight
          whole sentences (the restored transcript is one sentence per line), so you can&apos;t
          disagree on <i>edges</i> — only on <i>which</i> sentences and <i>which</i> code. Pooling
          sums each code&apos;s 2×2 table over the selected sessions and computes κ once — small
          sessions don&apos;t get outsized weight, and a code rare in every single session can
          still be estimated. <b>Overlap counts as agreement</b> in the{' '}
          <span className="font-mono">κ&nbsp;rlx</span> column (±1-unit tolerance, never across a
          session boundary); strict κ is what the decision reads.
        </p>
        <p>
          <b>3 · The heat map finds codes to merge.</b> Each cell is how strongly two codes land on
          the <i>same</i> sentences (φ correlation, pooled across coders and sessions; diagonal =
          1). Two codes that co-occur strongly <i>and</i> agree poorly are doing the same work under
          two names — <b>merge them</b> or sharpen a definition. Flagged pairs are listed under the
          map.
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
  const target = report.decision.target;
  return (
    <section className="mt-8">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-medium">Per-code agreement (sentence level, pooled)</h2>
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
                <td
                  className={`py-1.5 pr-3 text-right font-mono ${
                    p.underpowered || p.kappa === null
                      ? ''
                      : p.kappa >= target
                        ? 'text-emerald-700'
                        : 'text-amber-700'
                  }`}
                >
                  {num(p.kappa)}
                </td>
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
        counts adjacent-sentence overlap as agreement (David&apos;s rule; never across a session
        boundary). <span className="uppercase">low-n</span> = below the min-units floor pooled; not
        certifiable from this sample. Green/amber κ = at/below the preregistered target of{' '}
        {IRR_TARGET_KAPPA.toFixed(2)}.
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
        Each cell is the φ correlation of two codes over sentence units (pooled across coders and
        sessions): warm = they land on the same sentences, cool = they avoid each other, diagonal =
        1. Hover a cell for the shared-unit count. Strong warm cells among codes with weak agreement
        are merge candidates (below).
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
