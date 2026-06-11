'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { saveCodebookNotes } from '@/app/actions/notes';

/**
 * Instructions editor (client). One free-form notes document per codebook — the
 * researcher's OWN running notes ("how to do stuff": coding conventions,
 * reminders, decisions). Plain text / markdown in a single <textarea>, AUTOSAVED
 * as they type.
 *
 *  - DEBOUNCED AUTOSAVE (~800ms), mirroring the spec editors (FacetTagger's
 *    OpenTextField): a debounce timer + a `lastSaved` ref so we only persist when
 *    the body actually changed; a flush-on-blur so leaving the field saves
 *    immediately. A small status hint shows idle / "saving…" / "saved <time>".
 *  - OPTIONAL MARKDOWN PREVIEW side-by-side, toggled off by default. The render
 *    is a tiny dependency-free pass (headings / bold / italic / inline code /
 *    bullet + numbered lists / links / paragraphs) — no new dependency is added
 *    (package.json has no markdown lib). It is intentionally minimal; the body is
 *    the source of truth and is saved verbatim regardless of the preview.
 *
 * The codebook is resolved server-side and passed as `codebookId`; the initial
 * body is loaded server-side (`getCodebookNotes`) and seeded here.
 */
export default function InstructionsEditor({
  codebookId,
  initialBody,
}: {
  codebookId: string;
  initialBody: string;
}) {
  const [body, setBody] = useState(initialBody);
  const [isSaving, startSaving] = useTransition();
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The last body we successfully persisted. `null` is a "nothing reliably
  // saved" sentinel (a real body is always a string), so after a failed save we
  // set it to null to force the next attempt to re-persist whatever is current.
  const lastSaved = useRef<string | null>(initialBody);

  // Persist `next` (only if it differs from what we last saved). Runs inside a
  // transition so the "saving…" hint reflects the in-flight Server Action.
  function persist(next: string) {
    if (next === lastSaved.current) return;
    lastSaved.current = next;
    setError(null);
    startSaving(async () => {
      try {
        const { updated_at } = await saveCodebookNotes(codebookId, next);
        setSavedAt(updated_at);
      } catch (err) {
        // Roll back the "last saved" marker so a retry (next keystroke / blur)
        // re-attempts this body instead of silently treating it as persisted.
        lastSaved.current = null;
        setError(err instanceof Error ? err.message : 'Save failed.');
      }
    });
  }

  function scheduleSave(next: string) {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => persist(next), 800);
  }

  function flush(next: string) {
    if (timer.current) clearTimeout(timer.current);
    persist(next);
  }

  // Flush any pending debounce on unmount so a fast navigation doesn't drop the
  // last edit.
  useEffect(() => {
    const t = timer;
    const get = () => body;
    return () => {
      if (t.current) {
        clearTimeout(t.current);
        // Fire-and-forget the final save (best effort; the transition won't run
        // after unmount, so call the action directly).
        const pending = get();
        if (pending !== lastSaved.current) {
          lastSaved.current = pending;
          void saveCodebookNotes(codebookId, pending).catch(() => {});
        }
      }
    };
    // Intentionally only on unmount: `body` is read lazily via `get()`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codebookId]);

  const status = error
    ? error
    : isSaving
      ? 'saving…'
      : savedAt
        ? `saved ${formatTime(savedAt)}`
        : 'autosaves as you type';

  const previewHtml = useMemo(
    () => (showPreview ? renderMarkdown(body) : ''),
    [showPreview, body],
  );

  return (
    <main className="px-6 py-6">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-medium tracking-tight">
            Instructions{' '}
            <span
              className={`text-sm font-normal ${
                error ? 'text-danger' : 'text-foreground/40'
              }`}
            >
              · {status}
            </span>
          </h1>
          <p className="max-w-2xl text-sm text-foreground/60">
            Your own running notes for this codebook — conventions, reminders, and
            decisions about how to code. Plain text or markdown; it autosaves as
            you type.
          </p>
        </div>
        <label className="flex items-center gap-1.5 text-sm text-foreground/70">
          <input
            type="checkbox"
            checked={showPreview}
            onChange={(e) => setShowPreview(e.target.checked)}
          />
          markdown preview
        </label>
      </header>

      <div
        className={`grid gap-4 ${showPreview ? 'md:grid-cols-2' : 'grid-cols-1'}`}
      >
        <textarea
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            scheduleSave(e.target.value);
          }}
          onBlur={(e) => flush(e.target.value)}
          placeholder="Write your coding notes here…"
          aria-label="Codebook instructions"
          spellCheck
          className="min-h-[60vh] w-full resize-y border border-rule bg-panel px-4 py-3 text-[15px] leading-relaxed outline-none focus:border-foreground/40"
        />
        {showPreview && (
          <div
            className="prose-notes min-h-[60vh] w-full overflow-auto border border-rule-soft bg-panel px-4 py-3 text-[15px] leading-relaxed"
            // Safe: previewHtml is built by `renderMarkdown` (below), which
            // escapes all input text before inserting any markup.
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
        )}
      </div>
    </main>
  );
}

/** Render a timestamp as a short local time (e.g. "3:42 PM"); falls back to the
 *  raw string if it isn't parseable. */
function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// ---------------------------------------------------------------------------
// Minimal, dependency-free markdown → HTML. NOT a full implementation — just
// enough to make the preview useful (headings, bold/italic/code, links, bullet
// and numbered lists, paragraphs). ALL text is HTML-escaped before any markup is
// emitted, so the output is safe to inject (no raw HTML passes through).
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Inline spans applied to already-escaped text: `code`, **bold**, *italic*,
 *  [text](url). URLs are escaped and constrained to http(s)/mailto to avoid
 *  javascript: schemes. */
function renderInline(escaped: string): string {
  let out = escaped;
  // `inline code` first so its contents are not further transformed.
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  // [text](url)
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, url: string) => {
    const safe = /^(https?:|mailto:)/i.test(url) ? url : '#';
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });
  // **bold**
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // *italic*
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  return out;
}

function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const html: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) {
      html.push(`<p>${renderInline(escapeHtml(para.join(' ')))}</p>`);
      para = [];
    }
  };
  const closeList = () => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+\.\s+(.*)$/.exec(line);

    if (heading) {
      flushPara();
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(escapeHtml(heading[2]))}</h${level}>`);
    } else if (bullet) {
      flushPara();
      if (listType !== 'ul') {
        closeList();
        listType = 'ul';
        html.push('<ul>');
      }
      html.push(`<li>${renderInline(escapeHtml(bullet[1]))}</li>`);
    } else if (ordered) {
      flushPara();
      if (listType !== 'ol') {
        closeList();
        listType = 'ol';
        html.push('<ol>');
      }
      html.push(`<li>${renderInline(escapeHtml(ordered[1]))}</li>`);
    } else if (line.trim() === '') {
      flushPara();
      closeList();
    } else {
      closeList();
      para.push(line.trim());
    }
  }
  flushPara();
  closeList();
  return html.join('\n');
}
