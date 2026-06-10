'use client';

import { useState } from 'react';
import type { ReliabilityScope } from '@/app/actions/reliability';
import type { FacetWithValues, CodeWithRefs } from '@/app/actions/codebook';
import type { Tables } from '@/lib/types/cb-db';

type CodebookVersion = Tables<'cb_codebook_versions'>;

export type ComputeArgs = {
  scope: ReliabilityScope;
  scopeFacetValueId?: string;
  scopeCodeId?: string;
  labelTableText: string;
  codebookVersionId?: string;
  note?: string;
};

/**
 * The "compute a run" sub-form: a two-coder label-table textarea + a format
 * hint, a scope selector (overall / per facet-value / per code), and an optional
 * frozen-version tag. Owns its own draft state and validates the scope→id
 * dependency locally before handing assembled args to `onCompute`. It never
 * calls the server action itself — the parent runs it inside a transition and
 * refreshes, matching the server-loads / client-edits pattern.
 */
export default function LabelTableInput({
  facets,
  codes,
  frozenVersions,
  isPending,
  onCompute,
}: {
  facets: FacetWithValues[];
  codes: CodeWithRefs[];
  frozenVersions: CodebookVersion[];
  isPending: boolean;
  onCompute: (args: ComputeArgs) => void;
}) {
  const [labelTableText, setLabelTableText] = useState('');
  const [scope, setScope] = useState<ReliabilityScope>('overall');
  const [scopeFacetValueId, setScopeFacetValueId] = useState('');
  const [scopeCodeId, setScopeCodeId] = useState('');
  const [codebookVersionId, setCodebookVersionId] = useState('');
  const [note, setNote] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  function submit() {
    if (labelTableText.trim() === '') {
      setLocalError('Paste a two-coder label table first.');
      return;
    }
    if (scope === 'facet_value' && !scopeFacetValueId) {
      setLocalError('Pick a facet-value for the facet-value scope.');
      return;
    }
    if (scope === 'code' && !scopeCodeId) {
      setLocalError('Pick a code for the code scope.');
      return;
    }
    setLocalError(null);
    onCompute({
      scope,
      scopeFacetValueId: scope === 'facet_value' ? scopeFacetValueId : undefined,
      scopeCodeId: scope === 'code' ? scopeCodeId : undefined,
      labelTableText,
      codebookVersionId: codebookVersionId || undefined,
      note: note.trim() || undefined,
    });
    // Clear the pasted table on submit; keep scope/version so a researcher can
    // run several tables under the same scope without re-selecting.
    setLabelTableText('');
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <label htmlFor="label-table" className="block text-sm text-foreground/70">
          Two-coder label table
        </label>
        <textarea
          id="label-table"
          value={labelTableText}
          onChange={(e) => {
            setLabelTableText(e.target.value);
            if (localError) setLocalError(null);
          }}
          disabled={isPending}
          rows={6}
          placeholder={'u1,yes,yes\nu2,yes,no\nu3,no,no'}
          className="w-full border border-foreground/15 px-3 py-2 text-sm font-mono bg-background resize-y disabled:opacity-50"
        />
        <p className="text-xs text-foreground/50 leading-relaxed">
          One row per unit:{' '}
          <code className="font-mono text-foreground/70">unit,coderA,coderB</code> (CSV or
          TSV). A header row is optional. Avoid using the literal words{' '}
          <code className="font-mono">unit</code>/<code className="font-mono">coder</code>/
          <code className="font-mono">a</code>/<code className="font-mono">b</code> as code
          labels — they&apos;re treated as header tokens.
        </p>
      </div>

      {/* Scope selector */}
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="scope" className="text-sm text-foreground/70">
          Scope
        </label>
        <select
          id="scope"
          value={scope}
          onChange={(e) => {
            setScope(e.target.value as ReliabilityScope);
            setLocalError(null);
          }}
          disabled={isPending}
          className="border border-foreground/15 px-2 py-1 text-sm bg-background disabled:opacity-50"
        >
          <option value="overall">overall</option>
          <option value="facet_value">per facet-value</option>
          <option value="code">per code</option>
        </select>

        {scope === 'facet_value' && (
          <select
            value={scopeFacetValueId}
            onChange={(e) => setScopeFacetValueId(e.target.value)}
            disabled={isPending}
            aria-label="Facet value"
            className="border border-foreground/15 px-2 py-1 text-sm bg-background disabled:opacity-50"
          >
            <option value="">— pick a facet-value —</option>
            {facets.map((f) => (
              <optgroup key={f.id} label={f.label}>
                {f.values.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        )}

        {scope === 'code' && (
          <select
            value={scopeCodeId}
            onChange={(e) => setScopeCodeId(e.target.value)}
            disabled={isPending}
            aria-label="Code"
            className="border border-foreground/15 px-2 py-1 text-sm bg-background disabled:opacity-50"
          >
            <option value="">— pick a code —</option>
            {codes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.mnemonic} — {c.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Optional frozen-version tag */}
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="frozen-version" className="text-sm text-foreground/70">
          Frozen version
        </label>
        <select
          id="frozen-version"
          value={codebookVersionId}
          onChange={(e) => setCodebookVersionId(e.target.value)}
          disabled={isPending}
          className="border border-foreground/15 px-2 py-1 text-sm bg-background disabled:opacity-50"
        >
          <option value="">— none (untagged) —</option>
          {frozenVersions.map((v) => (
            <option key={v.id} value={v.id}>
              {v.label}
              {v.calibration_round != null ? ` (round ${v.calibration_round})` : ''}
            </option>
          ))}
        </select>
      </div>

      {/* Optional note */}
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        disabled={isPending}
        placeholder="note (optional)"
        aria-label="Run note"
        className="w-full border border-foreground/15 px-2 py-1 text-sm bg-background disabled:opacity-50"
      />

      {localError && <p className="text-sm text-red-600">{localError}</p>}

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={isPending}
          onClick={submit}
          className="border border-foreground px-3 py-1 text-sm hover:bg-foreground hover:text-background transition disabled:opacity-50"
        >
          Compute
        </button>
        {isPending && <span className="text-xs text-foreground/40">working…</span>}
      </div>
    </div>
  );
}
