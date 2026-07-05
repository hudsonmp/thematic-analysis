'use client';

import type { ReactNode } from 'react';
import type { VerdictRow } from '@/app/actions/runs';

// ---------------------------------------------------------------------------
// VerdictDetail — the inspection surface for a single verdict cell (Task B3-3).
//
// Shows the grader's rationale, the pretty-printed evidence JSON, and — for the
// execution grader — a readable per-check list parsed out of evidence.perCheck
// (target · expected vs actual · ✓/✗). This is where B3-4's annotate affordance
// mounts: it is exposed as an optional `annotate` child SLOT, so this component
// stays a pure presenter and B3-4 wires the annotate box without editing the
// grid/detail render path.
//
// PII (spec L5): verdicts are pid-only. Evidence is grader JSON and SHOULD be
// pid-safe, but as a belt we scrub any name/email-shaped key before rendering
// the raw JSON, so a future evidence field can never surface a participant
// name/email through this panel.
// ---------------------------------------------------------------------------

/** A per-check row as the execution grader records it (lib/eval/graders/
 *  execution.ts → evidence.perCheck). Narrowed defensively from unknown. */
type PerCheck = { target: string; expected: unknown; actual: unknown; match: boolean };

/** Keys we refuse to render even if some future evidence shape carries them —
 *  the pid-only PII guard, applied before JSON.stringify. */
const PII_KEYS = new Set(['first_name', 'firstname', 'name', 'last_name', 'email', 'user_id']);

/** Deep-clone `value`, dropping any PII-shaped key at any depth. Non-plain
 *  values pass through untouched. */
function scrubPii(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubPii);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (PII_KEYS.has(k.toLowerCase())) continue;
      out[k] = scrubPii(v);
    }
    return out;
  }
  return value;
}

/** Pull evidence.perCheck if the shape matches the execution grader's contract;
 *  otherwise null (llm-judge, ungradable, or a foreign shape). */
function extractPerCheck(evidence: unknown): PerCheck[] | null {
  if (!evidence || typeof evidence !== 'object') return null;
  const raw = (evidence as Record<string, unknown>).perCheck;
  if (!Array.isArray(raw)) return null;
  const out: PerCheck[] = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const rec = c as Record<string, unknown>;
    if (typeof rec.target === 'string' && typeof rec.match === 'boolean') {
      out.push({ target: rec.target, expected: rec.expected, actual: rec.actual, match: rec.match });
    }
  }
  return out.length > 0 ? out : null;
}

function fmt(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return '—';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export default function VerdictDetail({
  verdict,
  annotate,
}: {
  verdict: VerdictRow;
  /** B3-4 mounts its annotate box here. Kept as a slot so this stays a pure
   *  presenter and B3-4 needs no edit to the grid/detail render path. */
  annotate?: ReactNode;
}) {
  const perCheck = extractPerCheck(verdict.evidence);

  return (
    <div className="space-y-4 border border-foreground/15 bg-background px-4 py-4 text-sm">
      <header className="flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground/50">
          {verdict.pid} · phase {verdict.phaseOrdinal}
          {verdict.scenarioIdx !== null ? ` · scenario ${verdict.scenarioIdx}` : ''}
        </h3>
        <span className="font-mono text-xs text-foreground/60">
          {verdict.pass === null ? '— ungradable' : verdict.pass ? '✓ pass' : '✗ fail'}
          {verdict.score !== null ? ` · ${verdict.score.toFixed(2)}` : ''}
        </span>
      </header>

      <div>
        <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-foreground/50">Rationale</p>
        <p className="whitespace-pre-wrap break-words text-foreground/80">{verdict.rationale || '—'}</p>
      </div>

      {perCheck && (
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-foreground/50">
            End-state checks
          </p>
          <ul className="divide-y divide-foreground/10 border border-foreground/15">
            {perCheck.map((c, i) => (
              <li
                key={`${c.target}-${i}`}
                className="flex items-center justify-between gap-3 px-2 py-1.5 font-mono text-xs"
              >
                <span className="text-foreground/70">{c.target}</span>
                <span className="flex items-center gap-2">
                  <span className="text-foreground/50">
                    exp {fmt(c.expected)} · act {fmt(c.actual)}
                  </span>
                  <span className={c.match ? 'text-emerald-700' : 'text-red-700'}>
                    {c.match ? '✓' : '✗'}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <details>
        <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-foreground/50">
          Evidence (raw)
        </summary>
        <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words border border-foreground/10 bg-foreground/5 p-2 font-mono text-[11px] leading-relaxed text-foreground/70">
          {JSON.stringify(scrubPii(verdict.evidence), null, 2)}
        </pre>
      </details>

      {/* B3-4 annotate seam. */}
      {annotate}
    </div>
  );
}
