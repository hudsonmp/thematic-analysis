'use client';

import { useState, useTransition } from 'react';
import { saveArtifact, type EvalArtifact } from '@/app/actions/eval';

// ---------------------------------------------------------------------------
// Artifact editor island — rendered TWICE (oracle_spec, metric). Lists the
// append-only version history (newest first), shows the latest content in a
// textarea WITH its [UNDECIDED] markers visible (they are load-bearing: an
// unresolved decision the researcher must see before running), and Save appends
// a NEW VERSION (saveArtifact(kind, name, content) — never mutates a row, so
// every past verdict's config_hash still resolves its exact artifact). The
// selected version's id is lifted via onSelect so a run references it by id.
// ---------------------------------------------------------------------------

const UNDECIDED = '[UNDECIDED]';

export default function ArtifactEditor({
  kind,
  label,
  artifacts,
  selectedId,
  onSelect,
}: {
  kind: 'oracle_spec' | 'metric';
  label: string;
  artifacts: EvalArtifact[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const [list, setList] = useState(artifacts);
  const initial = artifacts.find((a) => a.id === selectedId) ?? artifacts[0] ?? null;
  const [name, setName] = useState(initial?.name ?? '');
  const [content, setContent] = useState(initial?.content ?? '');
  const [error, setError] = useState<string | null>(null);
  const [isSaving, startSaving] = useTransition();

  const selected = list.find((a) => a.id === selectedId) ?? list[0] ?? null;
  const undecidedCount = (content.match(new RegExp(escapeRegExp(UNDECIDED), 'g')) ?? []).length;

  function pick(id: string) {
    const a = list.find((x) => x.id === id);
    if (!a) return;
    onSelect(id);
    setName(a.name);
    setContent(a.content);
    setError(null);
  }

  function save() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Name this version before saving.');
      return;
    }
    if (!content.trim()) {
      setError('Content must be non-empty.');
      return;
    }
    setError(null);
    startSaving(async () => {
      try {
        const created = await saveArtifact(kind, trimmedName, content);
        setList((prev) => [created, ...prev]);
        onSelect(created.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save artifact.');
      }
    });
  }

  return (
    <div className="space-y-2 border border-foreground/15 bg-panel px-3 py-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-foreground/50">
          {label}
        </span>
        <span className="text-xs text-foreground/40">
          {list.length} version{list.length === 1 ? '' : 's'}
          {undecidedCount > 0 && (
            <span className="ml-2 text-amber-700">
              · {undecidedCount} {UNDECIDED}
            </span>
          )}
        </span>
      </div>

      <select
        value={selected?.id ?? ''}
        onChange={(e) => pick(e.target.value)}
        aria-label={`${label} version`}
        className="w-full border border-rule bg-background px-2 py-1.5 text-sm outline-none focus:border-foreground/40"
      >
        {list.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name} · {a.createdAt.slice(0, 10)}
          </option>
        ))}
      </select>

      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="version name…"
        aria-label={`${label} version name`}
        className="w-full border border-rule bg-background px-2 py-1 text-sm outline-none focus:border-foreground/40"
      />

      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        aria-label={`${label} content`}
        spellCheck={false}
        className="min-h-[9rem] w-full resize-y border border-rule bg-background px-3 py-2 font-mono text-[13px] leading-relaxed outline-none focus:border-foreground/40"
      />

      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={save}
          disabled={isSaving}
          className="border border-foreground/20 px-3 py-1 text-sm transition hover:bg-foreground/5 disabled:opacity-50"
        >
          {isSaving ? 'saving…' : 'Save new version'}
        </button>
        {error && <p className="text-xs text-danger">{error}</p>}
      </div>
    </div>
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
