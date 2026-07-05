'use client';

import { useState, useTransition } from 'react';
import {
  listAssistantTurnsForFewShot,
  saveFewShotSet,
  type AssistantTurn,
  type FewShotExample,
  type FewShotSet,
} from '@/app/actions/eval';

// ---------------------------------------------------------------------------
// Few-shot picker island. Two affordances:
//   1. PICK an existing set (lifts its id via onSelect; null = "none", a valid
//      run state — fewShotSetId is nullable).
//   2. BUILD a set from the real study corpus: lazily load
//      listAssistantTurnsForFewShot() (pid-only, read-only study access inside
//      the action), check the turns to include, name it, and Save →
//      saveFewShotSet(name, examples). Each checked turn becomes a FewShotExample
//      carrying its sourceMessageId (provenance) + role + content.
// Turns load ONLY when the researcher opens the builder — no cost on mount. A's
// island rule: actions from handlers via useTransition, results in state.
// ---------------------------------------------------------------------------

export default function FewShotPicker({
  sets,
  selectedId,
  onSelect,
}: {
  sets: FewShotSet[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const [list, setList] = useState(sets);
  const [building, setBuilding] = useState(false);
  const [turns, setTurns] = useState<AssistantTurn[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, startLoading] = useTransition();
  const [isSaving, startSaving] = useTransition();

  function openBuilder() {
    setBuilding(true);
    setError(null);
    if (turns !== null) return; // already loaded once
    startLoading(async () => {
      try {
        const t = await listAssistantTurnsForFewShot();
        setTurns(t);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load turns.');
      }
    });
  }

  function toggleTurn(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function save() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Name the few-shot set before saving.');
      return;
    }
    const chosen = (turns ?? []).filter((t) => checked.has(t.id));
    if (chosen.length === 0) {
      setError('Check at least one turn to include.');
      return;
    }
    const examples: FewShotExample[] = chosen.map((t) => ({
      sourceMessageId: t.id,
      role: t.role,
      content: t.content,
    }));
    setError(null);
    startSaving(async () => {
      try {
        const created = await saveFewShotSet(trimmedName, examples);
        setList((prev) => [created, ...prev]);
        onSelect(created.id);
        setBuilding(false);
        setChecked(new Set());
        setName('');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save set.');
      }
    });
  }

  return (
    <div className="space-y-2 border border-foreground/15 bg-panel px-3 py-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-foreground/50">
          Few-shot set
        </span>
        <button
          type="button"
          onClick={() => (building ? setBuilding(false) : openBuilder())}
          className="text-xs text-foreground/60 underline underline-offset-2 transition hover:text-foreground"
        >
          {building ? 'cancel' : 'build from corpus'}
        </button>
      </div>

      <select
        value={selectedId ?? ''}
        onChange={(e) => onSelect(e.target.value === '' ? null : e.target.value)}
        aria-label="Few-shot set"
        className="w-full border border-rule bg-background px-2 py-1.5 text-sm outline-none focus:border-foreground/40"
      >
        <option value="">(none)</option>
        {list.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name} · {s.examples.length} example{s.examples.length === 1 ? '' : 's'}
          </option>
        ))}
      </select>

      {building && (
        <div className="space-y-2 border-t border-foreground/10 pt-2">
          {isLoading && <p className="text-xs text-foreground/40">Loading corpus turns…</p>}
          {turns && turns.length === 0 && (
            <p className="text-xs text-foreground/40">No assistant turns in the corpus.</p>
          )}
          {turns && turns.length > 0 && (
            <ul className="max-h-52 divide-y divide-foreground/10 overflow-auto border border-rule">
              {turns.map((t) => (
                <li key={t.id}>
                  <label className="flex cursor-pointer items-start gap-2 px-2 py-1.5 text-xs transition hover:bg-foreground/5">
                    <input
                      type="checkbox"
                      checked={checked.has(t.id)}
                      onChange={() => toggleTurn(t.id)}
                      className="mt-0.5 h-3.5 w-3.5 accent-foreground"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="mr-1 font-mono text-foreground/40">
                        {t.pid} · {t.role}
                        {t.scenarioIdx !== null ? ` · s${t.scenarioIdx}` : ''}
                      </span>
                      <span className="block truncate text-foreground/70">{t.content}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="set name…"
              aria-label="Few-shot set name"
              className="min-w-0 flex-1 border border-rule bg-background px-2 py-1 text-sm outline-none focus:border-foreground/40"
            />
            <span className="text-xs text-foreground/40">{checked.size} chosen</span>
            <button
              type="button"
              onClick={save}
              disabled={isSaving}
              className="border border-foreground/20 px-3 py-1 text-sm transition hover:bg-foreground/5 disabled:opacity-50"
            >
              {isSaving ? 'saving…' : 'Save set'}
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
