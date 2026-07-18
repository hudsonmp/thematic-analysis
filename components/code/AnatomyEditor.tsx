'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { saveNewVersion } from '@/app/actions/codes';
import type { ProtocolEpisode } from '@/app/actions/protocol';
import MentionTextarea, { type MentionCode } from '@/components/codebook/MentionTextarea';
import type { CodeVersionInputT, EpisodeRefT, ExemplarT } from '@/lib/types/contracts';
import type { Tables } from '@/lib/types/cb-db';
import BulletListEditor from './BulletListEditor';
import EpisodePicker from './EpisodePicker';

type CodeVersion = Tables<'cb_code_versions'>;

// Local draft exemplar — same shape as ExemplarT but always carries the fields
// (no optional erasure) so the form's controlled inputs have stable values.
type DraftExemplar = {
  text: string;
  source_pid: string;
  episode_ref: EpisodeRefT | undefined;
};

/** Coerce the stored Json columns back into typed arrays (they round-trip as Json). */
function asStringArray(j: unknown): string[] {
  return Array.isArray(j) ? j.filter((x): x is string => typeof x === 'string') : [];
}
function asExemplars(j: unknown): DraftExemplar[] {
  if (!Array.isArray(j)) return [];
  return j.map((raw) => {
    const e = (raw ?? {}) as Partial<ExemplarT>;
    return {
      text: typeof e.text === 'string' ? e.text : '',
      source_pid: typeof e.source_pid === 'string' ? e.source_pid : '',
      episode_ref: e.episode_ref,
    };
  });
}

/**
 * Edits the CURRENT version's anatomy and saves it as a NEW version (codebook
 * versions are append-only — see saveNewVersion). Pre-fills every field from
 * the current version row. "Save as new version" validates client-side
 * (definition must be non-empty — mirrors the server's CodeVersionInput zod
 * `.min(1)`), builds a CodeVersionInput, calls the action, then router.refresh()
 * so the server component re-reads the new current version + version history.
 *
 * The change_note is intentionally NOT pre-filled (it describes THIS edit, not
 * the prior one) and is cleared after a successful save.
 */
export default function AnatomyEditor({
  codeId,
  current,
  episodes,
  allCodes,
}: {
  codeId: string;
  current: CodeVersion | null;
  episodes: ProtocolEpisode[];
  /** Every code in the codebook — for @-mentioning in the definition and
   *  counter-example. Threaded from the code page via CodeCard, never fetched. */
  allCodes: MentionCode[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // @-mention candidates: every code but this one — a code citing itself in
  // its own definition says nothing.
  const mentionables = allCodes.filter((c) => c.id !== codeId);

  const [definition, setDefinition] = useState(current?.definition ?? '');
  const [includeIf, setIncludeIf] = useState<string[]>(asStringArray(current?.include_if));
  const [excludeIf, setExcludeIf] = useState<string[]>(asStringArray(current?.exclude_if));
  const [exemplars, setExemplars] = useState<DraftExemplar[]>(asExemplars(current?.exemplars));
  const [disconfirming, setDisconfirming] = useState(current?.disconfirming_pattern ?? '');
  const [changeNote, setChangeNote] = useState('');

  function addExemplar() {
    setExemplars((xs) => [...xs, { text: '', source_pid: '', episode_ref: undefined }]);
  }
  function editExemplar(idx: number, patch: Partial<DraftExemplar>) {
    setExemplars((xs) => xs.map((x, i) => (i === idx ? { ...x, ...patch } : x)));
  }
  function removeExemplar(idx: number) {
    setExemplars((xs) => xs.filter((_, i) => i !== idx));
  }

  function save() {
    setError(null);
    setSaved(false);
    if (!definition.trim()) {
      setError('Definition is required.');
      return;
    }
    // Drop exemplars with empty text (a blank row the coder added but never
    // filled); the schema requires text.min(1) so an empty one would 400.
    const cleanedExemplars: ExemplarT[] = exemplars
      .filter((x) => x.text.trim() !== '')
      .map((x) => ({
        text: x.text.trim(),
        ...(x.source_pid.trim() ? { source_pid: x.source_pid.trim() } : {}),
        ...(x.episode_ref ? { episode_ref: x.episode_ref } : {}),
      }));

    const input: CodeVersionInputT = {
      definition: definition.trim(),
      include_if: includeIf.map((s) => s.trim()).filter(Boolean),
      exclude_if: excludeIf.map((s) => s.trim()).filter(Boolean),
      exemplars: cleanedExemplars,
      ...(disconfirming.trim() ? { disconfirming_pattern: disconfirming.trim() } : {}),
      // Prediction/falsifier no longer have inputs, but the columns and any
      // stored values survive: carry the PREVIOUS version's values forward
      // VERBATIM so saving an edit never clobbers them.
      ...(current?.prediction != null ? { prediction: current.prediction } : {}),
      ...(current?.prediction_falsifier != null
        ? { prediction_falsifier: current.prediction_falsifier }
        : {}),
      ...(changeNote.trim() ? { change_note: changeNote.trim() } : {}),
    };

    startTransition(async () => {
      try {
        await saveNewVersion(codeId, input);
        setChangeNote('');
        setSaved(true);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Save failed.');
      }
    });
  }

  return (
    <div className="space-y-6">
      {/* Definition */}
      <div className="space-y-1">
        <label className="text-xs uppercase tracking-wider text-foreground/50">
          Definition <span className="text-red-600">*</span>
        </label>
        <MentionTextarea
          value={definition}
          disabled={isPending}
          onChange={setDefinition}
          codes={mentionables}
          rows={3}
          placeholder="What this code captures — the rule a coder applies. @ mentions another code."
          className="w-full border border-foreground/15 px-2 py-1.5 text-sm bg-background"
          aria-label="Definition"
        />
      </div>

      {/* Include / exclude */}
      <div className="grid gap-6 md:grid-cols-2">
        <BulletListEditor
          label="Include if"
          items={includeIf}
          onChange={setIncludeIf}
          disabled={isPending}
          placeholder="Apply this code when…"
        />
        <BulletListEditor
          label="Exclude if"
          items={excludeIf}
          onChange={setExcludeIf}
          disabled={isPending}
          placeholder="Do NOT apply this code when…"
        />
      </div>

      {/* Exemplars */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-xs uppercase tracking-wider text-foreground/50">Exemplars</p>
          <button
            type="button"
            disabled={isPending}
            onClick={addExemplar}
            className="border border-foreground/30 px-2 py-0.5 text-xs hover:bg-foreground hover:text-background transition disabled:opacity-50"
          >
            Add exemplar
          </button>
        </div>
        {exemplars.length === 0 && (
          <p className="text-xs text-foreground/30">
            No exemplars yet — anchor representative quotes to a protocol episode.
          </p>
        )}
        <ul className="space-y-3">
          {exemplars.map((x, idx) => (
            <li key={idx} className="border border-foreground/10 p-2 space-y-1.5">
              <div className="flex items-start gap-1.5">
                <textarea
                  value={x.text}
                  disabled={isPending}
                  onChange={(e) => editExemplar(idx, { text: e.target.value })}
                  rows={2}
                  placeholder="Verbatim quote / observation…"
                  className="flex-1 border border-foreground/15 px-2 py-1 text-sm bg-background"
                  aria-label={`Exemplar ${idx + 1} text`}
                />
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => removeExemplar(idx)}
                  className="px-1 text-xs text-red-600 hover:underline disabled:opacity-50"
                  aria-label="Remove exemplar"
                  title="Remove exemplar"
                >
                  ×
                </button>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <input
                  value={x.source_pid}
                  disabled={isPending}
                  onChange={(e) => editExemplar(idx, { source_pid: e.target.value })}
                  placeholder="source pid (optional)"
                  className="border border-foreground/15 px-1.5 py-0.5 text-xs bg-background font-mono w-44"
                  aria-label={`Exemplar ${idx + 1} source pid`}
                />
                <EpisodePicker
                  episodes={episodes}
                  value={x.episode_ref}
                  onChange={(ep) => editExemplar(idx, { episode_ref: ep })}
                  disabled={isPending}
                />
              </div>
            </li>
          ))}
        </ul>
      </div>

      {/* Counter-example (the falsification anatomy the editor still authors;
          prediction/prediction_falsifier are display-only legacy columns now) */}
      <div className="space-y-3">
        <div className="space-y-1">
          <label className="text-xs uppercase tracking-wider text-foreground/50">
            Disconfirming pattern
          </label>
          <MentionTextarea
            value={disconfirming}
            disabled={isPending}
            onChange={setDisconfirming}
            codes={mentionables}
            rows={2}
            placeholder="What evidence would count AGAINST this code applying. @ mentions the code it belongs to instead."
            className="w-full border border-foreground/15 px-2 py-1.5 text-sm bg-background"
            aria-label="Disconfirming pattern"
          />
        </div>
      </div>

      {/* Change note + save */}
      <div className="space-y-2 border-t border-foreground/15 pt-4">
        <div className="space-y-1">
          <label className="text-xs uppercase tracking-wider text-foreground/50">
            Change note
          </label>
          <input
            value={changeNote}
            disabled={isPending}
            onChange={(e) => setChangeNote(e.target.value)}
            placeholder="Why this revision? (recorded on the new version)"
            className="w-full border border-foreground/15 px-2 py-1 text-sm bg-background"
          />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        {saved && !error && (
          <p className="text-sm text-green-700">Saved as a new version.</p>
        )}
        <button
          type="button"
          disabled={isPending}
          onClick={save}
          className="border border-foreground px-3 py-1.5 text-sm hover:bg-foreground hover:text-background transition disabled:opacity-50"
        >
          {isPending ? 'Saving…' : 'Save as new version'}
        </button>
      </div>
    </div>
  );
}
