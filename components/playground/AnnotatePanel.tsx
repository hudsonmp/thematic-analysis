'use client';

import { createContext, useContext, useState, useTransition } from 'react';
import {
  foldAnnotationsIntoVariant,
  saveAnnotation,
  type PromptVariant,
} from '@/app/actions/eval';
import type { VerdictRow } from '@/app/actions/runs';
import {
  contextLabel,
  parseAnnotationIds,
  type PendingAnnotation,
} from '@/lib/eval/playground/annotations';

// ---------------------------------------------------------------------------
// Annotate → fold-into-variant surface (Task B3-4).
//
// TWO pieces, one file (this task owns only AnnotatePanel.tsx):
//
//   • AnnotateBox — mounted INSIDE VerdictDetail's `annotate` seam. A textarea +
//     Save that calls saveAnnotation({ runId, verdictId, note }) from a handler
//     (useTransition, A's island rule). It carries the verdict/run/pid context
//     off the `verdict` prop VerdictDetail already holds — the action's REAL
//     input shape is { runId?, verdictId?, note } (NO pid field; PII stays out
//     of the annotation row), so the run + verdict ids ARE the context. The
//     pid/phase/scenario ride along only into the SESSION recall list below
//     (pid-only), never into the DB write.
//
//   • AnnotatePanel — mounted in Playground. Lists the notes saved THIS SESSION
//     (a recall aid; see the id note) and folds a chosen id set into a new
//     variant via foldAnnotationsIntoVariant(ids, baseVariantId, newName).
//
// THE ID SEAM (why this is wired the way it is): the committed saveAnnotation
// returns VOID (no .select()) and there is NO annotation read action — and B3
// may add none. So a session cannot learn the DB id of a note it just saved.
// foldAnnotationsIntoVariant, though, needs REAL ids and FAILS LOUD if any id
// doesn't resolve or the resolved count ≠ the requested Set size (partial-fold
// refusal). The honest wiring, adding no action: the recall list shows what was
// annotated this session (text + context, no id), and the researcher supplies
// the ids to fold (from Supabase / a prior list) in a paste field that is
// normalized by parseAnnotationIds EXACTLY as the action counts them. The loud
// refusal is surfaced verbatim, never swallowed.
//
// Playground bridges AnnotateBox → AnnotatePanel via AnnotateContext so the
// notes saved deep in the grid (VerdictGrid → VerdictDetail, files this task
// does NOT own) reach the panel's recall list WITHOUT editing that chain.
// ---------------------------------------------------------------------------

/** Playground provides `onNoteSaved`; AnnotateBox (rendered far down the grid)
 *  consumes it to push a just-saved note into the session recall list. Default
 *  no-op so the box still saves to the DB when used outside a provider. */
export const AnnotateContext = createContext<{ onNoteSaved: (a: PendingAnnotation) => void }>({
  onNoteSaved: () => {},
});

let localKeySeq = 0;

/**
 * The annotate box VerdictDetail mounts in its `annotate` seam. Self-contained:
 * derives the run/verdict/pid context from the verdict it inspects, saves the
 * note, and reports it up through AnnotateContext for the session recall list.
 */
export function AnnotateBox({ verdict }: { verdict: VerdictRow }) {
  const { onNoteSaved } = useContext(AnnotateContext);
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
        // REAL input shape: { runId?, verdictId?, note }. The run + verdict ids
        // ARE the context the action stores; no pid leaves this call.
        await saveAnnotation({ runId: verdict.runId, verdictId: verdict.id, note: trimmed });
        onNoteSaved({
          note: trimmed,
          runId: verdict.runId,
          verdictId: verdict.id,
          pid: verdict.pid,
          phaseOrdinal: verdict.phaseOrdinal,
          scenarioIdx: verdict.scenarioIdx,
          localKey: `ann-${localKeySeq++}`,
        });
        setNote('');
        setJustSaved(true);
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
            saved · fold it into a variant from the annotate panel
          </span>
        )}
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

/**
 * The fold panel (mounted in Playground). Shows the session recall list and
 * folds a supplied id set into a NEW child variant.
 */
export default function AnnotatePanel({
  pending,
  variants,
  onFolded,
}: {
  /** Notes saved this session (recall aid — no DB id; see the id-seam note). */
  pending: PendingAnnotation[];
  /** Current variant lineage — the fold's base is chosen from here. */
  variants: PromptVariant[];
  /** Lift the new variant so Playground can refresh the config/editor path. */
  onFolded: (variant: PromptVariant) => void;
}) {
  const [baseVariantId, setBaseVariantId] = useState<string>(variants[0]?.id ?? '');
  const [newName, setNewName] = useState('');
  const [idsRaw, setIdsRaw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [folded, setFolded] = useState<PromptVariant | null>(null);
  const [isFolding, startFolding] = useTransition();

  const ids = parseAnnotationIds(idsRaw);
  const base = variants.find((v) => v.id === baseVariantId) ?? variants[0] ?? null;

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
    if (ids.length === 0) {
      setError('Enter at least one annotation id to fold.');
      return;
    }
    setError(null);
    setFolded(null);
    startFolding(async () => {
      try {
        // Positional args (annotationIds, baseVariantId, newName). The action's
        // LOUD partial-fold refusal (a stale id throws) is surfaced verbatim
        // below — never swallowed.
        const variant = await foldAnnotationsIntoVariant(ids, base.id, name);
        setFolded(variant);
        onFolded(variant); // → Playground refreshes the variant list.
        setNewName('');
        setIdsRaw('');
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
          {pending.length} note{pending.length === 1 ? '' : 's'} this session
        </span>
      </div>

      {/* Session recall list — text + context, no DB id (saveAnnotation returns
          void; this is not the fold input). */}
      {pending.length === 0 ? (
        <p className="text-xs text-foreground/40">
          No notes yet. Inspect a verdict cell and add an annotation to build a set to fold.
        </p>
      ) : (
        <ul className="max-h-40 divide-y divide-foreground/10 overflow-auto border border-rule">
          {pending.map((a) => (
            <li key={a.localKey} className="px-2 py-1.5 text-xs">
              <span className="mr-1 font-mono text-foreground/40">{contextLabel(a)}</span>
              <span className="block truncate text-foreground/70">{a.note}</span>
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

        <label className="block space-y-1 text-sm">
          <span className="text-xs font-semibold uppercase tracking-wider text-foreground/50">
            Annotation ids to fold
          </span>
          <textarea
            value={idsRaw}
            onChange={(e) => setIdsRaw(e.target.value)}
            placeholder="paste annotation ids (comma/space/newline separated)…"
            aria-label="Annotation ids to fold"
            spellCheck={false}
            className="min-h-[3rem] w-full resize-y border border-rule bg-background px-3 py-2 font-mono text-[12px] leading-relaxed outline-none focus:border-foreground/40"
          />
          <span className="text-xs text-foreground/40">
            {ids.length} id{ids.length === 1 ? '' : 's'} · deduped as the action counts them
          </span>
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
            disabled={isFolding}
            className="border border-foreground/20 px-3 py-1 text-sm transition hover:bg-foreground/5 disabled:opacity-50"
          >
            {isFolding ? 'folding…' : 'Fold into new variant'}
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
