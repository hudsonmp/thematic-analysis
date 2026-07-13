'use client';

import { createContext, useContext, useEffect, useState, useTransition } from 'react';
import {
  foldAnnotationsIntoVariant,
  listUnfoldedAnnotations,
  saveAnnotation,
  type PromptVariant,
} from '@/app/actions/eval';
import type { VerdictRow } from '@/app/actions/runs';
import {
  contextLabel,
  selectableCheckedIds,
  type AnnotationRow,
} from '@/lib/eval/playground/annotations';

// ---------------------------------------------------------------------------
// Annotate → fold-into-variant surface (Task B3-4, loop closed in B3-4b).
//
// TWO pieces, one file (this task owns only AnnotatePanel.tsx):
//
//   • AnnotateBox — mounted INSIDE VerdictDetail's `annotate` seam. A textarea +
//     Save that calls saveAnnotation({ runId, verdictId, note }) from a handler
//     (useTransition, A's island rule). It carries the verdict/run context off
//     the `verdict` prop VerdictDetail already holds — the action's input shape
//     is { runId?, verdictId?, note } (NO pid field; PII stays out of the row).
//     On save it fires AnnotateContext.onSaved so the panel below can re-pull
//     the unfolded list (the new note appears as a checkbox).
//
//   • AnnotatePanel — mounted in Playground. Fetches listUnfoldedAnnotations()
//     (on mount + on every onSaved bump via `refreshToken`) and renders it as a
//     CHECKBOX list. Folding uses the CHECKED, still-available ids
//     (selectableCheckedIds) → foldAnnotationsIntoVariant(ids, baseVariantId,
//     newName); the folded rows drop off the list and the new variant is lifted
//     to Playground for the config path. This is the closed loop B3-4 lacked:
//     no Supabase-console paste — saveAnnotation now returns the id and the read
//     action surfaces the real, unfolded rows.
//
// THE LOUD REFUSAL: foldAnnotationsIntoVariant throws if the resolved-count ≠
// the requested Set size (a stale id). selectableCheckedIds intersects the
// checked set with the live list so a stale check is dropped BEFORE the call;
// any refusal that still surfaces is shown verbatim, never swallowed.
//
// Playground bridges AnnotateBox → AnnotatePanel via AnnotateContext so a save
// deep in the grid (VerdictGrid → VerdictDetail, files this task does NOT own)
// triggers the panel's refresh WITHOUT editing that chain.
// ---------------------------------------------------------------------------

/** Playground provides `onSaved`; AnnotateBox (rendered far down the grid) calls
 *  it after a successful save so the panel re-pulls the unfolded list. Default
 *  no-op so the box still saves to the DB when used outside a provider. */
export const AnnotateContext = createContext<{ onSaved: () => void }>({
  onSaved: () => {},
});

/**
 * The annotate box VerdictDetail mounts in its `annotate` seam. Self-contained:
 * derives the run/verdict context from the verdict it inspects, saves the note
 * (getting back its DB id), and signals AnnotateContext.onSaved so the fold
 * panel refreshes its checkbox list.
 */
export function AnnotateBox({ verdict }: { verdict: VerdictRow }) {
  const { onSaved } = useContext(AnnotateContext);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [isSaving, startSaving] = useTransition();

  function save() {
    const trimmed = note.trim();
    if (!trimmed) {
      setError('Write a note before saving.');
      return;
    }
    setError(null);
    startSaving(async () => {
      try {
        // Input shape: { runId?, verdictId?, note }. The run + verdict ids ARE
        // the context the action stores; no pid leaves this call.
        await saveAnnotation({ runId: verdict.runId, verdictId: verdict.id, note: trimmed });
        setNote('');
        setJustSaved(true);
        onSaved(); // → Playground bumps the refresh token → panel re-pulls.
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save annotation.');
      }
    });
  }

  return (
    <div className="space-y-2 border-t border-foreground/10 pt-3">
      <p className="text-xs font-semibold uppercase tracking-wider text-foreground/50">Annotate</p>
      <textarea
        value={note}
        onChange={(e) => {
          setNote(e.target.value);
          setJustSaved(false);
        }}
        placeholder="observation about this verdict…"
        aria-label="Annotation note"
        spellCheck={false}
        className="min-h-[4rem] w-full resize-y border border-rule bg-background px-3 py-2 text-[13px] leading-relaxed outline-none focus:border-foreground/40"
      />
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={isSaving}
          className="border border-foreground/20 px-3 py-1 text-sm transition hover:bg-foreground/5 disabled:opacity-50"
        >
          {isSaving ? 'saving…' : 'Save note'}
        </button>
        {justSaved && !isSaving && (
          <span className="text-xs text-foreground/50">
            saved · check it in the annotate panel to fold it into a variant
          </span>
        )}
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

/** Row → the minimal PendingAnnotation shape contextLabel reads. Only the
 *  run/verdict ids ride along (pid-safe — the row has no pid/name/email), so the
 *  label degrades to `verdict <id>` / `run <id>` / `unscoped`. */
function labelForRow(row: AnnotationRow): string {
  return contextLabel({
    note: row.note,
    runId: row.runId ?? undefined,
    verdictId: row.verdictId ?? undefined,
    localKey: row.id,
  });
}

/**
 * The fold panel (mounted in Playground). Owns the unfolded-annotation list:
 * fetches it on mount and whenever `refreshToken` changes (a save deep in the
 * grid), renders it as checkboxes, and folds the checked/still-available set
 * into a NEW child variant.
 */
export default function AnnotatePanel({
  refreshToken,
  variants,
  onFolded,
}: {
  /** Bumped by Playground on every note-save so the list re-pulls. */
  refreshToken: number;
  /** Current variant lineage — the fold's base is chosen from here. */
  variants: PromptVariant[];
  /** Lift the new variant so Playground can refresh the config/editor path. */
  onFolded: (variant: PromptVariant) => void;
}) {
  const [rows, setRows] = useState<AnnotationRow[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, startLoading] = useTransition();

  const [baseVariantId, setBaseVariantId] = useState<string>(variants[0]?.id ?? '');
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [folded, setFolded] = useState<PromptVariant | null>(null);
  const [isFolding, startFolding] = useTransition();

  // Pull the unfolded list on mount + on every refreshToken bump. setState lives
  // INSIDE the transition callback (never bare in the effect) to avoid the
  // set-state-in-effect lint; the transition also gives `isLoading` for free.
  useEffect(() => {
    startLoading(async () => {
      try {
        const next = await listUnfoldedAnnotations();
        setRows(next);
        // Prune checks whose rows are gone (folded elsewhere / refreshed away).
        setChecked((prev) => {
          const live = new Set(next.map((r) => r.id));
          const kept = new Set<string>();
          for (const id of prev) if (live.has(id)) kept.add(id);
          return kept;
        });
        setLoadError(null);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'Failed to load annotations.');
      }
    });
    // refreshToken is the trigger; startLoading is a stable useTransition dispatcher.
  }, [refreshToken]);

  const base = variants.find((v) => v.id === baseVariantId) ?? variants[0] ?? null;
  const foldIds = selectableCheckedIds(checked, rows.map((r) => r.id));

  function toggle(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function fold() {
    const name = newName.trim();
    if (!base) {
      setError('No base variant to fold into.');
      return;
    }
    if (!name) {
      setError('Name the new variant before folding.');
      return;
    }
    if (foldIds.length === 0) {
      setError('Check at least one annotation to fold.');
      return;
    }
    setError(null);
    setFolded(null);
    startFolding(async () => {
      try {
        // Positional args (annotationIds, baseVariantId, newName). The action's
        // LOUD partial-fold refusal (a stale id throws) is surfaced verbatim
        // below — never swallowed. selectableCheckedIds already dropped stale
        // checks, so this only fires on a genuine mid-flight change.
        const variant = await foldAnnotationsIntoVariant(foldIds, base.id, name);
        setFolded(variant);
        onFolded(variant); // → Playground prepends it to the variant list.
        setNewName('');
        // Refresh the unfolded list: the just-folded rows drop off.
        const next = await listUnfoldedAnnotations();
        setRows(next);
        setChecked(new Set());
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Fold failed.');
      }
    });
  }

  return (
    <section className="space-y-3 border border-foreground/15 bg-panel px-4 py-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground/50">
          Annotations → fold into variant
        </h3>
        <span className="text-xs text-foreground/40">
          {isLoading ? 'loading…' : `${rows.length} unfolded · ${foldIds.length} checked`}
        </span>
      </div>

      {/* Unfolded annotations — real DB rows, checkbox-selectable. No paste. */}
      {loadError ? (
        <p className="border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-700">
          {loadError}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-foreground/40">
          No unfolded annotations. Inspect a verdict cell and add a note to build a set to fold.
        </p>
      ) : (
        <ul className="max-h-48 divide-y divide-foreground/10 overflow-auto border border-rule">
          {rows.map((r) => (
            <li key={r.id} className="px-2 py-1.5 text-xs">
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={checked.has(r.id)}
                  onChange={() => toggle(r.id)}
                  aria-label={`Fold annotation ${labelForRow(r)}`}
                  className="mt-0.5"
                />
                <span className="min-w-0 flex-1">
                  <span className="mr-1 font-mono text-foreground/40">{labelForRow(r)}</span>
                  <span className="block truncate text-foreground/70">{r.note}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-2 border-t border-foreground/10 pt-3">
        <label className="block space-y-1 text-sm">
          <span className="text-xs font-semibold uppercase tracking-wider text-foreground/50">
            Base variant
          </span>
          <select
            value={base?.id ?? ''}
            onChange={(e) => setBaseVariantId(e.target.value)}
            aria-label="Base variant to fold into"
            className="w-full border border-rule bg-background px-2 py-1.5 text-sm outline-none focus:border-foreground/40"
          >
            {variants.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </label>

        <div className="flex items-center gap-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="new variant name…"
            aria-label="New variant name"
            className="min-w-0 flex-1 border border-rule bg-background px-2 py-1 text-sm outline-none focus:border-foreground/40"
          />
          <button
            type="button"
            onClick={fold}
            disabled={isFolding || foldIds.length === 0}
            className="border border-foreground/20 px-3 py-1 text-sm transition hover:bg-foreground/5 disabled:opacity-50"
          >
            {isFolding ? 'folding…' : `Fold ${foldIds.length} into new variant`}
          </button>
        </div>
      </div>

      {/* Provenance surface: base → folded child + the dated section the action
          appended, now selectable for the next run. */}
      {folded && (
        <div className="space-y-1 border-t border-foreground/10 pt-3 text-xs">
          <p className="text-foreground/70">
            Folded into <span className="font-mono text-foreground">{folded.name}</span>
          </p>
          <p className="text-foreground/50">
            provenance: {base?.name ?? 'base'} → {folded.name}
            {folded.parentId ? ` · parent ${folded.parentId}` : ''}
          </p>
          <details>
            <summary className="cursor-pointer text-foreground/50">
              new system prompt (with ## Researcher annotations section)
            </summary>
            <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words border border-foreground/10 bg-foreground/5 p-2 font-mono text-[11px] leading-relaxed text-foreground/70">
              {folded.systemPrompt}
            </pre>
          </details>
          <p className="text-foreground/40">Selectable as a prompt variant for the next run.</p>
        </div>
      )}

      {error && (
        <p className="border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-700">{error}</p>
      )}
    </section>
  );
}
