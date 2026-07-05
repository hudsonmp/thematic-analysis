'use client';

import { useState, useTransition } from 'react';
import { savePromptVariant, type PromptVariant } from '@/app/actions/eval';

// ---------------------------------------------------------------------------
// Prompt-variant editor island. Lists the prompt-variant lineage (newest first,
// as the server returns it), lets the researcher pick one, edit its system
// prompt in a textarea, and Save — which appends a NEW child variant
// (savePromptVariant, parent = the selected variant) rather than mutating the
// picked one (the lineage is append-only provenance). A's island rule: the
// server action is called from a HANDLER inside useTransition, the result is
// held in state, and errors surface to the panel.
//
// The selected variant's id is lifted via onSelect so ConfigPanel/buildRunRequest
// can reference it — a run always targets a concrete variant id.
// ---------------------------------------------------------------------------

export default function VariantEditor({
  variants,
  selectedId,
  onSelect,
}: {
  variants: PromptVariant[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const [list, setList] = useState(variants);
  const [name, setName] = useState('');
  const [systemPrompt, setSystemPrompt] = useState(
    () => variants.find((v) => v.id === selectedId)?.systemPrompt ?? variants[0]?.systemPrompt ?? '',
  );
  const [dirtyFor, setDirtyFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, startSaving] = useTransition();

  const selected = list.find((v) => v.id === selectedId) ?? list[0] ?? null;

  function pick(id: string) {
    const v = list.find((x) => x.id === id);
    if (!v) return;
    onSelect(id);
    setSystemPrompt(v.systemPrompt);
    setDirtyFor(null);
    setError(null);
  }

  function save() {
    const parentId = selected?.id ?? null;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Name the new variant before saving.');
      return;
    }
    setError(null);
    startSaving(async () => {
      try {
        const created = await savePromptVariant(trimmedName, systemPrompt, parentId);
        setList((prev) => [created, ...prev]);
        onSelect(created.id);
        setName('');
        setDirtyFor(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save variant.');
      }
    });
  }

  return (
    <div className="space-y-2 border border-foreground/15 bg-panel px-3 py-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-foreground/50">
          Prompt variant
        </span>
        <span className="text-xs text-foreground/40">{list.length} in lineage</span>
      </div>

      <select
        value={selected?.id ?? ''}
        onChange={(e) => pick(e.target.value)}
        aria-label="Prompt variant"
        className="w-full border border-rule bg-background px-2 py-1.5 text-sm outline-none focus:border-foreground/40"
      >
        {list.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
          </option>
        ))}
      </select>

      <textarea
        value={systemPrompt}
        onChange={(e) => {
          setSystemPrompt(e.target.value);
          setDirtyFor(selected?.id ?? null);
        }}
        aria-label="System prompt"
        spellCheck={false}
        className="min-h-[8rem] w-full resize-y border border-rule bg-background px-3 py-2 font-mono text-[13px] leading-relaxed outline-none focus:border-foreground/40"
      />

      <div className="flex items-center gap-2">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="new variant name…"
          aria-label="New variant name"
          className="min-w-0 flex-1 border border-rule bg-background px-2 py-1 text-sm outline-none focus:border-foreground/40"
        />
        <button
          type="button"
          onClick={save}
          disabled={isSaving}
          className="border border-foreground/20 px-3 py-1 text-sm transition hover:bg-foreground/5 disabled:opacity-50"
        >
          {isSaving ? 'saving…' : 'Save as child'}
        </button>
      </div>

      {dirtyFor === selected?.id && dirtyFor !== null && (
        <p className="text-xs text-foreground/40">
          Editing forks a new child of “{selected?.name}” — the original is unchanged.
        </p>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
