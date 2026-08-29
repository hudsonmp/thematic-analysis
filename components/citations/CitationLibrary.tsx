'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  addCitations,
  updateCitation,
  deleteCitation,
} from '@/app/actions/citations';
import type { Tables } from '@/lib/types/cb-db';

type Citation = Tables<'cb_citations'>;

/**
 * The codebook's reference library. A paste area (BibTeX blob -> addCitations)
 * sits above the list of existing citations; each row supports inline metadata
 * edits (updateCitation) and delete (deleteCitation). Mutations run from event
 * handlers inside a transition and `router.refresh()` after success so the
 * parent Server Component re-fetches — a Client Component never calls the
 * actions during render.
 *
 * Per-code linking is intentionally NOT here; that lives on the code card.
 */
export default function CitationLibrary({
  codebookId,
  citations,
}: {
  codebookId: string;
  citations: Citation[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Paste area state.
  const [blob, setBlob] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);

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

  function add() {
    const text = blob.trim();
    if (!text) {
      setError('Paste a BibTeX entry first.');
      return;
    }
    setError(null);
    setFeedback(null);
    startTransition(async () => {
      try {
        const { inserted } = await addCitations(codebookId, text);
        if (inserted === 0) {
          setFeedback('No valid BibTeX entries found in that paste.');
        } else {
          setBlob('');
          setFeedback(
            `Parsed ${inserted} ${inserted === 1 ? 'entry' : 'entries'} · added to library.`,
          );
        }
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Add citations failed.');
      }
    });
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-8 space-y-8">
      <header className="space-y-1">
        <h1 className="text-lg font-medium tracking-tight">Citations</h1>
      </header>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {/* Paste area */}
      <section className="space-y-2">
        <label htmlFor="bibtex-blob" className="block text-sm text-foreground/70">
          Paste BibTeX
        </label>
        <textarea
          id="bibtex-blob"
          value={blob}
          onChange={(e) => {
            setBlob(e.target.value);
            if (feedback) setFeedback(null);
          }}
          disabled={isPending}
          rows={6}
          placeholder={'@article{smith2024, title={...}, author={...}, year={2024}}'}
          className="w-full border border-foreground/15 px-3 py-2 text-sm font-mono bg-background resize-y disabled:opacity-50"
        />
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={isPending}
            onClick={add}
            className="border border-foreground px-3 py-1 text-sm hover:bg-foreground hover:text-background transition disabled:opacity-50"
          >
            Add citations
          </button>
          {isPending && <span className="text-xs text-foreground/40">working…</span>}
          {feedback && !isPending && (
            <span className="text-xs text-foreground/60">{feedback}</span>
          )}
        </div>
      </section>

      {/* List */}
      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-wider text-foreground/50">
          Library {citations.length > 0 && `(${citations.length})`}
        </h2>

        {citations.length === 0 ? (
          <p className="text-sm text-foreground/50">
            Paste BibTeX to start your reference library.
          </p>
        ) : (
          <ul className="divide-y divide-foreground/10 border border-foreground/15">
            {citations.map((c) => (
              <CitationRow
                key={c.id}
                citation={c}
                isPending={isPending}
                onSave={(patch) => run(() => updateCitation(c.id, patch))}
                onDelete={() => {
                  if (confirm(`Delete citation "${c.bibtex_key ?? c.id}"?`)) {
                    run(() => deleteCitation(c.id));
                  }
                }}
              />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

type EditPatch = {
  title?: string;
  authors?: string;
  year?: number;
  doi?: string;
  url?: string;
};

/**
 * One citation row. Read view shows key/title/authors/year/doi/url; an inline
 * "Edit" toggle swaps to a small form. The form holds local draft state and
 * commits via onSave with only the changed fields (so bibtex_key/raw/parsed are
 * never disturbed). Year is sent as a number or omitted when blank.
 */
function CitationRow({
  citation: c,
  isPending,
  onSave,
  onDelete,
}: {
  citation: Citation;
  isPending: boolean;
  onSave: (patch: EditPatch) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(c.title ?? '');
  const [authors, setAuthors] = useState(c.authors ?? '');
  const [year, setYear] = useState(c.year != null ? String(c.year) : '');
  const [doi, setDoi] = useState(c.doi ?? '');
  const [url, setUrl] = useState(c.url ?? '');

  function reset() {
    setTitle(c.title ?? '');
    setAuthors(c.authors ?? '');
    setYear(c.year != null ? String(c.year) : '');
    setDoi(c.doi ?? '');
    setUrl(c.url ?? '');
  }

  function save() {
    const trimmedYear = year.trim();
    const parsedYear = trimmedYear === '' ? undefined : Number(trimmedYear);
    onSave({
      title: title.trim(),
      authors: authors.trim(),
      year: Number.isFinite(parsedYear) ? parsedYear : undefined,
      doi: doi.trim(),
      url: url.trim(),
    });
    setEditing(false);
  }

  if (editing) {
    return (
      <li className="px-3 py-3 space-y-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-foreground/60">{c.bibtex_key}</span>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={isPending}
            placeholder="title"
            className="border border-foreground/15 px-2 py-1 text-sm bg-background sm:col-span-2"
            aria-label="Title"
          />
          <input
            value={authors}
            onChange={(e) => setAuthors(e.target.value)}
            disabled={isPending}
            placeholder="authors"
            className="border border-foreground/15 px-2 py-1 text-sm bg-background"
            aria-label="Authors"
          />
          <input
            value={year}
            onChange={(e) => setYear(e.target.value)}
            disabled={isPending}
            inputMode="numeric"
            placeholder="year"
            className="border border-foreground/15 px-2 py-1 text-sm bg-background"
            aria-label="Year"
          />
          <input
            value={doi}
            onChange={(e) => setDoi(e.target.value)}
            disabled={isPending}
            placeholder="doi"
            className="border border-foreground/15 px-2 py-1 text-sm bg-background"
            aria-label="DOI"
          />
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={isPending}
            placeholder="url"
            className="border border-foreground/15 px-2 py-1 text-sm bg-background"
            aria-label="URL"
          />
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={isPending}
            onClick={save}
            className="border border-foreground px-2 py-0.5 text-xs hover:bg-foreground hover:text-background transition disabled:opacity-50"
          >
            Save
          </button>
          <button
            type="button"
            disabled={isPending}
            onClick={() => {
              reset();
              setEditing(false);
            }}
            className="border border-foreground/30 px-2 py-0.5 text-xs hover:bg-foreground/10 transition disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className="flex items-start gap-3 px-3 py-2.5">
      <div className="flex-1 min-w-0 space-y-0.5">
        <p className="text-sm">
          <span className="font-mono text-foreground/60">{c.bibtex_key ?? '(no key)'}</span>
          {c.title ? ` — ${c.title}` : ''}
        </p>
        {(c.authors || c.year != null) && (
          <p className="text-xs text-foreground/50">
            {[c.authors, c.year != null ? String(c.year) : null]
              .filter(Boolean)
              .join(' · ')}
          </p>
        )}
        {(c.doi || c.url) && (
          <p className="text-xs text-foreground/40 break-all">
            {c.doi && <span>doi:{c.doi}</span>}
            {c.doi && c.url && <span> · </span>}
            {c.url && (
              <a
                href={c.url}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-foreground hover:underline"
              >
                {c.url}
              </a>
            )}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {/* Deductive coding: jump to the matrix new-code form bound to THIS
            paper, so every code created there auto-links (derived_from) and
            defaults origin=a_priori. The binding persists across creates until
            the researcher exits. */}
        <Link
          href={`/?fromCitation=${c.id}`}
          title={`Derive a priori codes from "${c.bibtex_key ?? c.id}"`}
          className="border border-foreground/30 px-2 py-0.5 text-xs hover:bg-foreground hover:text-background transition whitespace-nowrap"
        >
          Add codes →
        </Link>
        <button
          type="button"
          disabled={isPending}
          onClick={() => setEditing(true)}
          className="border border-foreground/30 px-2 py-0.5 text-xs hover:bg-foreground hover:text-background transition disabled:opacity-50"
        >
          Edit
        </button>
        <button
          type="button"
          disabled={isPending}
          onClick={onDelete}
          className="border border-foreground/30 px-2 py-0.5 text-xs text-red-600 hover:bg-red-600 hover:text-background transition disabled:opacity-50"
        >
          Delete
        </button>
      </div>
    </li>
  );
}
