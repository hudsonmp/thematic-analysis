'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import {
  addExemplarComment,
  deleteExemplarComment,
  getExemplarDoc,
  saveExemplarDoc,
  type ExemplarComment,
  type ExemplarDoc,
  type ExemplarTab,
} from '@/app/actions/exemplars';
import { threadIdsInDoc, mentionedSlugs, COMMENT_MARK, type PmNode } from '@/lib/exemplars/threads';
import MentionTextarea, { type MentionCode } from '@/components/codebook/MentionTextarea';
import { CommentMark, createMentionBridge, makeCodeMention, type MentionBridge, type MentionState } from './extensions';

/**
 * ExemplarsWorkspace — the Google-Docs-shaped worked-example editor.
 *
 *   ┌ tabs (one per code) ┬────────── page ──────────┬─ comments ─┐
 *
 * ONE mode: write/paste the excerpt, ⌘B/⌘I/bullets like Docs, `@` to link a
 * code inline, select text → 💬 to highlight it and explain the coding in a
 * comment (whose `@slug` mentions ARE the codes the span is coded as). Coders
 * get the same view with the editor and comment controls read-only.
 *
 * Persistence: the body autosaves (debounced 800ms, flushed on tab switch /
 * unmount) via `saveExemplarDoc`; comments post immediately. Threads are
 * anchored by the `comment` mark's threadId inside the body, so the comment
 * column derives its list from the LIVE document — a highlight deleted from
 * the text drops its card without any DB write.
 */

type Props = {
  codebookId: string;
  tabs: ExemplarTab[];
  initialCodeId: string | null;
  initialDoc: ExemplarDoc | null;
  canEdit: boolean;
};

const AUTOSAVE_MS = 800;

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Remove every `comment` mark carrying `threadId` from the doc (cancelled compose / last comment deleted). */
function removeThreadMark(editor: Editor, threadId: string) {
  const { state } = editor;
  const markType = state.schema.marks[COMMENT_MARK];
  if (!markType) return;
  let tr = state.tr;
  state.doc.descendants((node, pos) => {
    if (!node.isText) return;
    for (const m of node.marks) {
      if (m.type === markType && m.attrs.threadId === threadId) {
        tr = tr.removeMark(pos, pos + node.nodeSize, m);
      }
    }
  });
  if (tr.docChanged) editor.view.dispatch(tr);
}

export default function ExemplarsWorkspace({ codebookId, tabs, initialCodeId, initialDoc, canEdit }: Props) {
  const router = useRouter();
  const params = useSearchParams();
  const [activeId, setActiveId] = useState<string | null>(initialCodeId);
  const [doc, setDoc] = useState<ExemplarDoc | null>(initialDoc);
  const [loading, setLoading] = useState(false);
  const [comments, setComments] = useState<ExemplarComment[]>(initialDoc?.comments ?? []);
  const [threadIds, setThreadIds] = useState<string[]>(threadIdsInDoc(initialDoc?.body));
  const [activeThread, setActiveThread] = useState<string | null>(null);
  /** A thread being composed (mark applied, no comment yet). */
  const [composing, setComposing] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(initialDoc?.updatedAt ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selRect, setSelRect] = useState<DOMRect | null>(null);
  const [mention, setMention] = useState<MentionState | null>(null);
  const [tabFilter, setTabFilter] = useState('');

  const pageRef = useRef<HTMLDivElement | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSaved = useRef<string | null>(initialDoc ? JSON.stringify(initialDoc.body) : null);
  // Refs mirrored from state for event-time reads (assigned in effects, never in render).
  const activeIdRef = useRef(activeId);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  const codes: MentionCode[] = useMemo(() => tabs.map((t) => ({ id: t.codeId, mnemonic: t.mnemonic })), [tabs]);
  // The suggestion-plugin ↔ dropdown seam. Created once (lazy state initializer);
  // the code list is pushed in from an effect so the plugin reads it at event time.
  const [bridge] = useState<MentionBridge>(() => createMentionBridge({ onState: (s) => setMention(s) }));
  useEffect(() => {
    bridge.setCodes(codes);
  }, [bridge, codes]);

  // ── Persistence ──────────────────────────────────────────────────────────
  const persist = useCallback(
    async (codeId: string, body: PmNode) => {
      const key = JSON.stringify(body);
      if (key === lastSaved.current) return;
      lastSaved.current = key;
      setSaving(true);
      setError(null);
      try {
        const { updated_at } = await saveExemplarDoc(codeId, codebookId, body);
        setSavedAt(updated_at);
      } catch (err) {
        lastSaved.current = null;
        setError(err instanceof Error ? err.message : 'Save failed.');
      } finally {
        setSaving(false);
      }
    },
    [codebookId],
  );

  const editor = useEditor({
    immediatelyRender: false,
    editable: canEdit,
    extensions: [
      StarterKit.configure({ link: false, underline: false }),
      Placeholder.configure({ placeholder: 'Paste or write the excerpt — then select text and comment on it.' }),
      CommentMark,
      makeCodeMention(bridge),
    ],
    content: initialDoc?.body ?? { type: 'doc', content: [] },
    editorProps: {
      attributes: { class: 'ex-editor', spellcheck: 'true' },
      handleClick: (_view, _pos, event) => {
        const el = (event.target as HTMLElement | null)?.closest?.('[data-thread-id]');
        const id = el?.getAttribute('data-thread-id') ?? null;
        setActiveThread(id);
        return false;
      },
    },
    onUpdate: ({ editor }) => {
      const json = editor.getJSON() as PmNode;
      setThreadIds(threadIdsInDoc(json));
      if (!canEdit) return;
      const codeId = activeIdRef.current;
      if (!codeId) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void persist(codeId, json), AUTOSAVE_MS);
    },
    onSelectionUpdate: ({ editor }) => {
      if (!canEdit) return;
      const { from, to } = editor.state.selection;
      if (from === to) {
        setSelRect(null);
        return;
      }
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      setSelRect(sel.getRangeAt(0).getBoundingClientRect());
    },
    onBlur: () => {
      // Keep the bar if focus moved into it; otherwise hide after a tick.
      setTimeout(() => {
        const a = document.activeElement;
        if (!a?.closest?.('[data-ex-toolbar]')) setSelRect(null);
      }, 0);
    },
  });

  /** Flush a pending autosave synchronously-ish (awaited by callers that need the row). */
  const flush = useCallback(async () => {
    if (!editor || !canEdit) return;
    const codeId = activeIdRef.current;
    if (!codeId) return;
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    await persist(codeId, editor.getJSON() as PmNode);
  }, [editor, canEdit, persist]);

  // Flush on unmount (best effort).
  useEffect(() => {
    return () => {
      if (saveTimer.current && editor && canEdit && activeIdRef.current) {
        clearTimeout(saveTimer.current);
        const body = editor.getJSON() as PmNode;
        if (JSON.stringify(body) !== lastSaved.current) {
          void saveExemplarDoc(activeIdRef.current, codebookId, body).catch(() => {});
        }
      }
    };
  }, [editor, canEdit, codebookId]);

  // ── Tab switching ────────────────────────────────────────────────────────
  const openTab = useCallback(
    async (codeId: string) => {
      if (codeId === activeId) return;
      await flush();
      setLoading(true);
      setActiveThread(null);
      setComposing(null);
      setSelRect(null);
      try {
        const next = await getExemplarDoc(codeId);
        setActiveId(codeId);
        setDoc(next);
        setComments(next.comments);
        setThreadIds(threadIdsInDoc(next.body));
        setSavedAt(next.updatedAt);
        lastSaved.current = JSON.stringify(next.body);
        editor?.commands.setContent(next.body as never, { emitUpdate: false });
        const sp = new URLSearchParams(params.toString());
        sp.set('code', codeId);
        router.replace(`/exemplars?${sp.toString()}`, { scroll: false });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load tab.');
      } finally {
        setLoading(false);
      }
    },
    [activeId, editor, flush, params, router],
  );

  // ── Comments ─────────────────────────────────────────────────────────────
  const startComment = useCallback(() => {
    if (!editor || !canEdit) return;
    const { from, to } = editor.state.selection;
    if (from === to) return;
    const threadId = crypto.randomUUID();
    editor.chain().focus().setMark(COMMENT_MARK, { threadId }).run();
    setComposing(threadId);
    setActiveThread(threadId);
    setSelRect(null);
  }, [editor, canEdit]);

  const cancelCompose = useCallback(() => {
    if (!editor || !composing) return;
    // Only strip the mark if the thread has no comments (a fresh compose).
    if (!comments.some((c) => c.threadId === composing)) removeThreadMark(editor, composing);
    setComposing(null);
  }, [editor, composing, comments]);

  const submitComment = useCallback(
    async (threadId: string, body: string) => {
      if (!activeId) return;
      await flush();
      try {
        const created = await addExemplarComment({ codeId: activeId, codebookId, threadId, body });
        setComments((prev) => [...prev, created]);
        setComposing((c) => (c === threadId ? null : c));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Comment failed.');
      }
    },
    [activeId, codebookId, flush],
  );

  const removeComment = useCallback(
    async (comment: ExemplarComment) => {
      try {
        await deleteExemplarComment(comment.id);
        const rest = comments.filter((c) => c.id !== comment.id);
        setComments(rest);
        if (editor && !rest.some((c) => c.threadId === comment.threadId)) {
          removeThreadMark(editor, comment.threadId);
          await flush();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Delete failed.');
      }
    },
    [comments, editor, flush],
  );

  // Highlight the active thread's spans.
  useEffect(() => {
    const root = pageRef.current;
    if (!root) return;
    root.querySelectorAll<HTMLElement>('[data-thread-id]').forEach((el) => {
      el.classList.toggle('ex-active', el.getAttribute('data-thread-id') === activeThread);
    });
  }, [activeThread, threadIds, doc]);

  // ── Comment column layout: each card sits level with its span, no overlaps ─
  const [cardTops, setCardTops] = useState<Map<string, number>>(new Map());
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const visibleThreads = useMemo(() => {
    const ids = [...threadIds];
    if (composing && !ids.includes(composing)) ids.push(composing);
    return ids;
  }, [threadIds, composing]);

  const layoutCards = useCallback(() => {
    const root = pageRef.current;
    if (!root) return;
    const rootTop = root.getBoundingClientRect().top;
    const anchors: { id: string; top: number }[] = [];
    for (const id of visibleThreads) {
      const el = root.querySelector<HTMLElement>(`[data-thread-id="${id}"]`);
      if (!el) continue;
      anchors.push({ id, top: el.getBoundingClientRect().top - rootTop });
    }
    anchors.sort((a, b) => a.top - b.top);
    // The active thread stays level with its span; others yield around it.
    const next = new Map<string, number>();
    let cursor = 0;
    const activeIdx = anchors.findIndex((a) => a.id === activeThread);
    if (activeIdx >= 0) {
      // Place from the active one downwards, then fill upwards.
      cursor = anchors[activeIdx].top;
      for (let i = activeIdx; i < anchors.length; i++) {
        const top = Math.max(anchors[i].top, cursor);
        next.set(anchors[i].id, top);
        cursor = top + (cardRefs.current.get(anchors[i].id)?.offsetHeight ?? 80) + 8;
      }
      let bottom = anchors[activeIdx].top;
      for (let i = activeIdx - 1; i >= 0; i--) {
        const h = cardRefs.current.get(anchors[i].id)?.offsetHeight ?? 80;
        const top = Math.min(anchors[i].top, bottom - h - 8);
        next.set(anchors[i].id, Math.max(0, top));
        bottom = top;
      }
    } else {
      for (const a of anchors) {
        const top = Math.max(a.top, cursor);
        next.set(a.id, top);
        cursor = top + (cardRefs.current.get(a.id)?.offsetHeight ?? 80) + 8;
      }
    }
    setCardTops((prev) => {
      if (prev.size === next.size && [...next].every(([k, v]) => prev.get(k) === v)) return prev;
      return next;
    });
  }, [visibleThreads, activeThread]);

  useLayoutEffect(() => {
    layoutCards();
  }, [layoutCards, comments, doc, threadIds]);
  useEffect(() => {
    if (!editor) return;
    const onUpd = () => requestAnimationFrame(layoutCards);
    editor.on('update', onUpd);
    window.addEventListener('resize', onUpd);
    return () => {
      editor.off('update', onUpd);
      window.removeEventListener('resize', onUpd);
    };
  }, [editor, layoutCards]);

  // ── Derived ──────────────────────────────────────────────────────────────
  const activeTab = tabs.find((t) => t.codeId === activeId) ?? null;
  const filteredTabs = useMemo(() => {
    const q = tabFilter.trim().toLowerCase();
    return q === '' ? tabs : tabs.filter((t) => t.mnemonic.toLowerCase().includes(q));
  }, [tabs, tabFilter]);
  const byMnemonic = useMemo(() => new Map(tabs.map((t) => [t.mnemonic, t])), [tabs]);
  const status = error ? error : saving ? 'saving…' : savedAt ? `saved ${formatTime(savedAt)}` : canEdit ? 'autosaves as you type' : 'read only';

  return (
    <div className="flex min-h-[calc(100vh-3.5rem)] bg-[#f8f9fa]">
      {/* ── Tabs ─────────────────────────────────────────────────────────── */}
      <aside className="w-64 shrink-0 border-r border-rule-soft px-3 py-4 overflow-y-auto">
        <div className="mb-2 flex items-center justify-between px-1">
          <span className="text-sm font-medium text-foreground/80">Code tabs</span>
          <span className="text-xs text-foreground/40">{tabs.length}</span>
        </div>
        <input
          value={tabFilter}
          onChange={(e) => setTabFilter(e.target.value)}
          placeholder="Filter codes…"
          className="mb-2 w-full rounded border border-rule px-2 py-1 text-xs bg-white"
        />
        {tabs.length === 0 && (
          <p className="px-1 text-xs italic text-foreground/50">No codes yet — tabs appear as codes are added to the codebook.</p>
        )}
        <ul className="space-y-0.5">
          {filteredTabs.map((t) => {
            const active = t.codeId === activeId;
            return (
              <li key={t.codeId}>
                <button
                  type="button"
                  onClick={() => void openTab(t.codeId)}
                  className={`group flex w-full items-center gap-2 rounded-full px-3 py-1.5 text-left text-sm ${
                    active ? 'bg-[#d3e3fd] text-[#001d35]' : 'hover:bg-black/5 text-foreground/80'
                  }`}
                >
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${t.hasContent ? 'bg-emerald-500' : 'bg-transparent border border-foreground/25'}`} />
                  <span className="truncate font-mono text-[12px]">{t.mnemonic}</span>
                  {t.threadCount > 0 && (
                    <span className="ml-auto rounded-full bg-white px-1.5 text-[10px] text-foreground/60 border border-rule-soft">
                      {t.threadCount}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      {/* ── Page ─────────────────────────────────────────────────────────── */}
      <main className="flex-1 overflow-y-auto px-8 py-6">
        <div className="mx-auto flex max-w-[1180px] gap-6">
          <div className="min-w-0 flex-1">
            <div className="mb-2 flex items-baseline justify-between text-xs text-foreground/50">
              <span>
                {activeTab ? (
                  <>
                    <span className="font-mono text-foreground/80">{activeTab.mnemonic}</span>
                  </>
                ) : (
                  'No code selected'
                )}
              </span>
              <span className={error ? 'text-danger' : ''}>{loading ? 'loading…' : status}</span>
            </div>
            <div
              ref={pageRef}
              className="ex-page relative rounded-sm border border-rule-soft bg-white px-24 py-16 shadow-sm"
              style={{ minHeight: '80vh' }}
            >
              {!canEdit && (
                <p className="mb-6 -mt-8 text-xs italic text-foreground/45" style={{ fontFamily: 'var(--font-sans)' }}>
                  Worked example by the study admin — read only. Click a highlight to see why it was coded that way.
                </p>
              )}
              <EditorContent editor={editor} />
            </div>
          </div>

          {/* ── Comments ───────────────────────────────────────────────── */}
          <div className="relative w-[320px] shrink-0" style={{ paddingTop: '1.75rem' }}>
            <div className="relative" style={{ minHeight: '80vh' }}>
              {visibleThreads.length === 0 && (
                <p className="mt-16 px-3 text-xs italic text-foreground/40">
                  {canEdit ? 'Select text and press 💬 to explain how it would be coded.' : 'No comments on this tab yet.'}
                </p>
              )}
              {visibleThreads.map((tid) => {
                const thread = comments.filter((c) => c.threadId === tid);
                const isActive = activeThread === tid;
                const isComposing = composing === tid;
                if (thread.length === 0 && !isComposing) return null;
                return (
                  <div
                    key={tid}
                    ref={(el) => {
                      if (el) cardRefs.current.set(tid, el);
                      else cardRefs.current.delete(tid);
                    }}
                    onClick={() => setActiveThread(tid)}
                    className={`absolute left-0 right-0 rounded-lg border bg-white p-3 text-sm shadow-sm transition-[top,box-shadow] duration-150 ${
                      isActive ? 'border-[#c2c9d6] shadow-md z-10 -translate-x-3' : 'border-rule-soft'
                    }`}
                    style={{ top: cardTops.get(tid) ?? 0, fontFamily: 'var(--font-sans)' }}
                  >
                    {thread.map((c) => (
                      <CommentItem
                        key={c.id}
                        comment={c}
                        canEdit={canEdit}
                        byMnemonic={byMnemonic}
                        onDelete={() => void removeComment(c)}
                        onOpenCode={(id) => void openTab(id)}
                      />
                    ))}
                    {isComposing && canEdit && (
                      <Compose
                        codes={codes}
                        onSubmit={(body) => void submitComment(tid, body)}
                        onCancel={cancelCompose}
                        autoFocus
                      />
                    )}
                    {!isComposing && isActive && canEdit && (
                      <button
                        type="button"
                        onClick={() => setComposing(tid)}
                        className="mt-2 text-xs text-[#0b57d0] hover:underline"
                      >
                        Reply
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </main>

      {/* ── Floating selection toolbar ───────────────────────────────────── */}
      {canEdit && editor && selRect && (
        <div
          data-ex-toolbar
          className="fixed z-30 flex items-center gap-0.5 rounded-md border border-rule bg-white p-1 shadow-lg"
          style={{ top: Math.max(8, selRect.top - 44), left: Math.max(8, selRect.left + selRect.width / 2 - 90) }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <ToolbarButton
            active={editor.isActive('bold')}
            label="Bold (⌘B)"
            onClick={() => editor.chain().focus().toggleBold().run()}
          >
            <b>B</b>
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive('italic')}
            label="Italic (⌘I)"
            onClick={() => editor.chain().focus().toggleItalic().run()}
          >
            <i>I</i>
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive('bulletList')}
            label="Bulleted list"
            onClick={() => editor.chain().focus().toggleBulletList().run()}
          >
            •
          </ToolbarButton>
          <span className="mx-1 h-4 w-px bg-rule" />
          <ToolbarButton label="Comment (link a code with @)" onClick={startComment}>
            💬
          </ToolbarButton>
        </div>
      )}

      {/* ── @ mention dropdown ───────────────────────────────────────────── */}
      {mention && <MentionMenu key={mention.query} state={mention} bridge={bridge} />}
    </div>
  );
}

function ToolbarButton({
  active,
  label,
  onClick,
  children,
}: {
  active?: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={`h-7 min-w-7 rounded px-1.5 text-sm ${active ? 'bg-[#d3e3fd] text-[#001d35]' : 'hover:bg-black/5'}`}
    >
      {children}
    </button>
  );
}

/** One comment: author, time, body with `@slug` chips, delete for admins. */
function CommentItem({
  comment,
  canEdit,
  byMnemonic,
  onDelete,
  onOpenCode,
}: {
  comment: ExemplarComment;
  canEdit: boolean;
  byMnemonic: Map<string, ExemplarTab>;
  onDelete: () => void;
  onOpenCode: (codeId: string) => void;
}) {
  const parts = useMemo(() => {
    // Split the body into text + mention runs for rendering.
    const out: { t: 'text' | 'mention'; v: string }[] = [];
    const re = /(^|[\s(\[])@([^\s@]+)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(comment.body)) !== null) {
      const lead = m[1];
      const raw = m[2];
      const slug = raw.replace(/[.,;:!?)\]]+$/, '');
      const trail = raw.slice(slug.length);
      const start = m.index + lead.length;
      if (start > last) out.push({ t: 'text', v: comment.body.slice(last, start) });
      out.push({ t: 'mention', v: slug });
      last = start + 1 + slug.length;
      if (trail) {
        out.push({ t: 'text', v: trail });
        last += trail.length;
      }
    }
    if (last < comment.body.length) out.push({ t: 'text', v: comment.body.slice(last) });
    return out;
  }, [comment.body]);
  const slugs = mentionedSlugs(comment.body);

  return (
    <div className="mb-2 last:mb-0">
      <div className="flex items-baseline justify-between">
        <span className="font-medium text-[13px]">{comment.authorName}</span>
        <span className="text-[11px] text-foreground/45">{formatTime(comment.createdAt)}</span>
      </div>
      <p className="mt-1 whitespace-pre-wrap text-[13px] leading-snug text-foreground/85">
        {parts.map((p, i) =>
          p.t === 'text' ? (
            <span key={i}>{p.v}</span>
          ) : (
            <span key={i} className="ex-mention" style={{ cursor: byMnemonic.has(p.v) ? 'pointer' : 'default' }}
              onClick={(e) => {
                const t = byMnemonic.get(p.v);
                if (!t) return;
                e.stopPropagation();
                onOpenCode(t.codeId);
              }}
            >
              @{p.v}
            </span>
          ),
        )}
      </p>
      {slugs.length > 0 && (
        <p className="mt-1 text-[10px] uppercase tracking-wider text-foreground/40">
          coded as {slugs.map((s) => (byMnemonic.has(s) ? s : `${s}?`)).join(', ')}
        </p>
      )}
      {canEdit && (
        <button type="button" onClick={(e) => { e.stopPropagation(); onDelete(); }} className="mt-1 text-[11px] text-foreground/40 hover:text-danger">
          delete
        </button>
      )}
    </div>
  );
}

function Compose({
  codes,
  onSubmit,
  onCancel,
  autoFocus,
}: {
  codes: MentionCode[];
  onSubmit: (body: string) => void;
  onCancel: () => void;
  autoFocus?: boolean;
}) {
  const [body, setBody] = useState('');
  const wrap = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (autoFocus) wrap.current?.querySelector('textarea')?.focus();
  }, [autoFocus]);
  return (
    <div ref={wrap} className="mt-2" onClick={(e) => e.stopPropagation()}>
      <MentionTextarea
        value={body}
        onChange={setBody}
        codes={codes}
        rows={3}
        placeholder="Why is this coded this way? Use @ to link the code."
        className="w-full rounded border border-rule px-2 py-1 text-[13px]"
        aria-label="Comment"
      />
      <div className="mt-1.5 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-full px-3 py-1 text-xs text-foreground/60 hover:bg-black/5">
          Cancel
        </button>
        <button
          type="button"
          disabled={body.trim() === ''}
          onClick={() => onSubmit(body)}
          className="rounded-full bg-[#0b57d0] px-3 py-1 text-xs text-white disabled:opacity-40"
        >
          Comment
        </button>
      </div>
    </div>
  );
}

/** The `@` dropdown inside the editor body, driven by the suggestion plugin via the bridge. */
function MentionMenu({ state, bridge }: { state: MentionState; bridge: MentionBridge }) {
  // Keyed on `state.query` by the parent, so a new query remounts with cursor 0.
  const [cursor, setCursor] = useState(0);
  const items = state.items;
  useEffect(() => {
    bridge.setKeyDown((e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        setCursor((c) => (items.length ? (c + 1) % items.length : 0));
        return true;
      }
      if (e.key === 'ArrowUp') {
        setCursor((c) => (items.length ? (c - 1 + items.length) % items.length : 0));
        return true;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (items[cursor]) state.command(items[cursor]);
        return true;
      }
      if (e.key === 'Escape') {
        bridge.onState(null);
        return true;
      }
      return false;
    });
    return () => bridge.setKeyDown(null);
  }, [bridge, items, cursor, state]);

  const rect = state.rect;
  if (!rect) return null;
  return (
    <div
      className="fixed z-40 max-h-64 w-64 overflow-y-auto rounded-md border border-rule bg-white py-1 shadow-lg"
      style={{ top: rect.bottom + 4, left: rect.left }}
      role="listbox"
    >
      {items.length === 0 ? (
        <div className="px-3 py-1.5 text-xs text-foreground/50">No code matches “{state.query}”</div>
      ) : (
        items.map((c, i) => (
          <button
            key={c.id}
            type="button"
            role="option"
            aria-selected={i === cursor}
            onMouseDown={(e) => {
              e.preventDefault();
              state.command(c);
            }}
            onMouseEnter={() => setCursor(i)}
            className={`block w-full px-3 py-1.5 text-left font-mono text-xs ${i === cursor ? 'bg-[#d3e3fd]' : ''}`}
          >
            @{c.mnemonic}
          </button>
        ))
      )}
    </div>
  );
}
