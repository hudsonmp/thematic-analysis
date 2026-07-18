'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { freezeCodebook } from '@/app/actions/freeze';
import { computeReliability, dismissMisCarved } from '@/app/actions/reliability';
import type { FacetWithValues, CodeWithRefs } from '@/app/actions/codebook';
import type { Tables } from '@/lib/types/cb-db';
import LabelTableInput, { type ComputeArgs } from './LabelTableInput';
import KappaResult from './KappaResult';

type CodebookVersion = Tables<'cb_codebook_versions'>;
type ReliabilityRun = Tables<'cb_reliability_runs'>;

/**
 * The §2.9 reliability surface. Three sections, all on the server-loads /
 * client-edits pattern: every mutation runs from an event handler inside a
 * transition, then `router.refresh()` re-runs the page loader so the lists
 * re-fetch. No Server Action is ever called during render.
 *
 *   1. Freeze gate — snapshot the codebook into an immutable version; list of
 *      frozen versions; the §2.9 discipline (calibrate to κ≥.70, then freeze).
 *   2. Compute a run — paste a two-coder table, pick a scope (+ optional frozen
 *      version), compute the κ stack.
 *   3. Runs list — each rendered by KappaResult, which carries the degenerate
 *      and mis-carved marking.
 */
export default function ReliabilityPanel({
  codebookId,
  frozenVersions,
  runs,
  facets,
  codes,
}: {
  codebookId: string;
  frozenVersions: CodebookVersion[];
  runs: ReliabilityRun[];
  facets: FacetWithValues[];
  codes: CodeWithRefs[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(fn: () => Promise<unknown>) {
    setError(null);
    startTransition(async () => {
      try {
        await fn();
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Mutation failed.');
      }
    });
  }

  // Resolve a run's scope_*_id to a human label for its KappaResult header. The
  // run rows store only ids; the tree (loaded server-side) carries the names.
  const facetValueName = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of facets) for (const v of f.values) m.set(v.id, `${f.label} · ${v.label}`);
    return m;
  }, [facets]);
  const codeName = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of codes) m.set(c.id, c.mnemonic);
    return m;
  }, [codes]);

  function scopeNameFor(r: ReliabilityRun): string | null {
    if (r.scope === 'facet_value' && r.scope_facet_value_id) {
      return facetValueName.get(r.scope_facet_value_id) ?? null;
    }
    if (r.scope === 'code' && r.scope_code_id) {
      return codeName.get(r.scope_code_id) ?? null;
    }
    return null;
  }

  function onCompute(args: ComputeArgs) {
    run(() =>
      computeReliability({
        codebookId,
        codebookVersionId: args.codebookVersionId,
        scope: args.scope,
        scopeFacetValueId: args.scopeFacetValueId,
        scopeCodeId: args.scopeCodeId,
        labelTableText: args.labelTableText,
        note: args.note,
      }),
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-8 space-y-10">
      <header className="space-y-1">
        <h1 className="text-lg font-medium tracking-tight">Reliability</h1>
        <p className="text-sm text-foreground/60">
          Inter-rater reliability for this codebook (§2.9): freeze a calibrated
          codebook, then record κ runs against it.
        </p>
      </header>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {/* 1. Freeze gate */}
      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-xs uppercase tracking-wider text-foreground/50">
            Freeze codebook
          </h2>
          <p className="text-xs text-foreground/50 leading-relaxed">
            §2.9 discipline: calibrate on pilots until κ ≥ .70, then{' '}
            <strong className="font-medium text-foreground/70">freeze</strong> the codebook
            before main independent coding begins. Each reliability run references the
            frozen version it was computed under; emergent codes require a new freeze.
          </p>
        </div>

        <FreezeForm
          isPending={isPending}
          onFreeze={(args) => run(() => freezeCodebook({ codebookId, ...args }))}
        />

        <FrozenVersionList versions={frozenVersions} />
      </section>

      {/* 2. Compute a run */}
      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-wider text-foreground/50">Compute a run</h2>
        <LabelTableInput
          facets={facets}
          codes={codes}
          frozenVersions={frozenVersions}
          isPending={isPending}
          onCompute={onCompute}
        />
      </section>

      {/* 3. Runs list */}
      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-wider text-foreground/50">
          Runs {runs.length > 0 && `(${runs.length})`}
        </h2>
        {runs.length === 0 ? (
          <p className="text-sm text-foreground/50">
            No reliability runs yet. Paste a two-coder label table above to compute one.
          </p>
        ) : (
          <div className="space-y-3">
            {runs.map((r) => (
              <KappaResult
                key={r.id}
                run={r}
                scopeName={scopeNameFor(r)}
                isPending={isPending}
                onDismiss={(rationale) => run(() => dismissMisCarved(r.id, rationale))}
              />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

type FreezeArgs = { label: string; calibrationRound?: number; note?: string };

/**
 * The freeze control: a label (required), an optional calibration-round number,
 * and an optional note. Local draft state; hands assembled args to `onFreeze`.
 */
function FreezeForm({
  isPending,
  onFreeze,
}: {
  isPending: boolean;
  onFreeze: (args: FreezeArgs) => void;
}) {
  const [label, setLabel] = useState('');
  const [round, setRound] = useState('');
  const [note, setNote] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  function submit() {
    const trimmedLabel = label.trim();
    if (trimmedLabel === '') {
      setLocalError('A version label is required (e.g. "v1 post-calibration").');
      return;
    }
    const trimmedRound = round.trim();
    const parsedRound = trimmedRound === '' ? undefined : Number(trimmedRound);
    if (parsedRound !== undefined && !Number.isInteger(parsedRound)) {
      setLocalError('Calibration round must be a whole number.');
      return;
    }
    setLocalError(null);
    onFreeze({
      label: trimmedLabel,
      calibrationRound: parsedRound,
      note: note.trim() || undefined,
    });
    setLabel('');
    setRound('');
    setNote('');
  }

  return (
    <div className="border border-foreground/20 p-3 space-y-2 max-w-xl">
      <div className="flex flex-wrap gap-2">
        <input
          value={label}
          onChange={(e) => {
            setLabel(e.target.value);
            if (localError) setLocalError(null);
          }}
          disabled={isPending}
          placeholder="label (e.g. v1 post-calibration)"
          aria-label="Version label"
          className="border border-foreground/15 px-2 py-1 text-sm bg-background flex-1 min-w-48"
        />
        <input
          value={round}
          onChange={(e) => setRound(e.target.value)}
          disabled={isPending}
          inputMode="numeric"
          placeholder="round"
          aria-label="Calibration round"
          className="border border-foreground/15 px-2 py-1 text-sm bg-background w-24"
        />
      </div>
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        disabled={isPending}
        placeholder="note (optional)"
        aria-label="Freeze note"
        className="w-full border border-foreground/15 px-2 py-1 text-sm bg-background"
      />
      {localError && <p className="text-sm text-red-600">{localError}</p>}
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={isPending}
          onClick={submit}
          className="border border-foreground px-3 py-1 text-sm hover:bg-foreground hover:text-background transition disabled:opacity-50"
        >
          Freeze codebook
        </button>
        {isPending && <span className="text-xs text-foreground/40">working…</span>}
      </div>
    </div>
  );
}

/** The list of frozen versions: label, frozen_at, calibration round. */
function FrozenVersionList({ versions }: { versions: CodebookVersion[] }) {
  if (versions.length === 0) {
    return (
      <p className="text-sm text-foreground/50">
        No frozen versions yet. Freeze the codebook once calibration reaches κ ≥ .70.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-foreground/10 border border-foreground/15">
      {versions.map((v) => (
        <li key={v.id} className="flex items-baseline justify-between gap-3 px-3 py-2 text-sm">
          <span className="font-medium">{v.label}</span>
          <span className="text-xs text-foreground/50">
            {v.calibration_round != null && (
              <span className="mr-3">round {v.calibration_round}</span>
            )}
            {v.frozen_at ? new Date(v.frozen_at).toLocaleString() : ''}
          </span>
        </li>
      ))}
    </ul>
  );
}
