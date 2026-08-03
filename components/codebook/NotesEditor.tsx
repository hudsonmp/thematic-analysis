'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { parseNote } from './NoteText';
import { splitDefinition } from '@/lib/codebook/definition';
import { fuzzyRank } from '@/lib/transcript/fuzzy';

/**
 * Structured notes editor — the editor IS the rendered tree, so structure
 * shows LIVE while typing. Numbers and letters are derived CHROME, never
 * typed:
 *
 *   Enter in a step     → new step below (renumbers itself)
 *   Enter in a branch   → new sibling branch
 *   Tab in a step       → convert it to a branch of the step above
 *   Shift+Tab in branch → promote it back to a step
 *   ⑂ fork button       → add a branch (the no-keyboard path)
 *   Backspace on empty  → remove the row (caret to END of the previous)
 *   ⌘⏎ / blur outside   → save · Esc → cancel
 *
 * `@` opens the CODING SCREEN'S picker semantics in place: fuzzy search over
 * slug + applied definition + exemplars, rows expand their metadata on hover
 * (definition, exemplars, "not:", origin — the CodingPopup block). While the
 * picker is open, Enter/Tab PICK and Esc closes the picker, not the editor.
 *
 * Storage stays ONE plain string (`1. …` / `a. …` lines), so NoteText, the
 * popup hover and the printed sheet are untouched.
 */

export type MentionOption = {
  id: string;
  mnemonic: string;
  origin: string;
  definition: string | null;
  exemplars: string[];
  counterExample: string | null;
};

type Step = { text: string; subs: string[] };

function fromText(text: string): Step[] {
  const steps: Step[] = [];
  for (const b of parseNote(text)) {
    if (b.kind === 'p') {
      // Plain paragraphs normalize to steps on edit — the editor's model is
      // steps+forks, and a paragraph is a step you hadn't numbered yet.
      steps.push({ text: b.text, subs: [] });
    } else {
      for (const it of b.items) steps.push({ text: it.text, subs: it.subs.map((s) => s.text) });
    }
  }
  return steps.length ? steps : [{ text: '', subs: [] }];
}

function toText(steps: Step[]): string {
  const lines: string[] = [];
  steps
    .filter((s) => s.text.trim() !== '' || s.subs.some((x) => x.trim() !== ''))
    .forEach((s, i) => {
      // trimEnd: an empty label serializes as "1." (no trailing space) — the
      // exact form the parser round-trips as an item, keeping its fork intact.
      lines.push(`${i + 1}. ${s.text.trim()}`.trimEnd());
      s.subs
        .filter((x) => x.trim() !== '')
        .forEach((x, k) => lines.push(`${String.fromCharCode(97 + k)}. ${x.trim()}`.trimEnd()));
    });
  return lines.join('\n');
}

const stripStep = (v: string) => v.replace(/^\s*\d+[.)]\s+/, '');
const stripBranch = (v: string) => v.replace(/^\s*[a-z][.)]\s+/, '');

/** The active `@token` ending at the caret, if any. */
function mentionAt(value: string, caret: number): { start: number; query: string } | null {
  const before = value.slice(0, caret);
  const m = before.match(/@([a-z0-9-]*)$/i);
  if (!m) return null;
  return { start: caret - m[0].length, query: m[1].toLowerCase() };
}

/**
 * Auto-growing one-to-many-line text field. An <input> cannot wrap — long
 * step text was scrolling left out of view — so every field is a rows=1
 * textarea whose height tracks scrollHeight. Enter never inserts a newline
 * here (the editor's Enter means "next step/branch"), so wrapping is purely
 * visual.
 */
function GrowText({
  value,
  refCb,
  className,
  style,
  ...rest
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  value: string;
  refCb: (el: HTMLTextAreaElement | null) => void;
  className?: string;
}) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      {...rest}
      value={value}
      rows={1}
      ref={(el) => {
        innerRef.current = el;
        refCb(el);
      }}
      style={style}
      className={`resize-none overflow-hidden ${className ?? ''}`}
    />
  );
}

export default function NotesEditor({
  initial,
  codes = [],
  onCommit,
  onCancel,
}: {
  initial: string;
  /** Mentionable codes with the metadata the picker's hover expansion shows. */
  codes?: MentionOption[];
  onCommit: (next: string) => void;
  onCancel: () => void;
}) {
  const [steps, setSteps] = useState<Step[]>(() => fromText(initial));
  // Focus is an explicit REQUEST (key + nonce + optional caret), applied once
  // per gesture — never on plain typing. `caret` null = end of field.
  const [focusReq, setFocusReq] = useState<{ key: string; n: number; caret: number | null }>({
    key: 's0',
    n: 0,
    caret: null,
  });
  const focusOn = (key: string, caret: number | null = null) =>
    setFocusReq((p) => ({ key, n: p.n + 1, caret }));
  const rootRef = useRef<HTMLDivElement | null>(null);
  const cancelledRef = useRef(false);
  const inputRefs = useRef(new Map<string, HTMLTextAreaElement>());
  const reg = (key: string) => (el: HTMLTextAreaElement | null) => {
    if (el) inputRefs.current.set(key, el);
    else inputRefs.current.delete(key);
  };
  useEffect(() => {
    const el = inputRefs.current.get(focusReq.key);
    if (!el) return;
    el.focus();
    const pos = focusReq.caret ?? el.value.length;
    el.setSelectionRange(pos, pos);
  }, [focusReq]);

  // ---- @mention picker ------------------------------------------------------
  const [mention, setMention] = useState<{ fieldKey: string; start: number; query: string } | null>(
    null,
  );
  const [mCursor, setMCursor] = useState(0);
  const [mHover, setMHover] = useState<string | null>(null);
  const [mPos, setMPos] = useState<{ top: number; left: number } | null>(null);

  const ranked = useMemo(() => {
    if (!mention) return [];
    // The coding screen's search: slug + APPLIED definition + exemplars — the
    // code's meaning, not just its name.
    return fuzzyRank(
      mention.query,
      codes,
      (c) => `${c.mnemonic} ${splitDefinition(c.definition).applied} ${c.exemplars.join(' ')}`,
    )
      .map((m) => m.item)
      .slice(0, 8);
  }, [mention, codes]);
  const mSafe = Math.min(mCursor, Math.max(0, ranked.length - 1));

  // Anchor the dropdown under the active field, relative to the editor root.
  useLayoutEffect(() => {
    if (!mention || !rootRef.current) {
      setMPos(null);
      return;
    }
    const el = inputRefs.current.get(mention.fieldKey);
    if (!el) {
      setMPos(null);
      return;
    }
    const root = rootRef.current.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    setMPos({ top: r.bottom - root.top + 2, left: Math.max(0, r.left - root.left) });
  }, [mention]);

  /** Track the active @token for a field after any change. */
  const syncMention = (fieldKey: string, el: HTMLTextAreaElement) => {
    const hit = mentionAt(el.value, el.selectionStart ?? el.value.length);
    if (hit) {
      setMention({ fieldKey, start: hit.start, query: hit.query });
      setMCursor(0);
    } else {
      setMention(null);
    }
  };

  const mut = (fn: (next: Step[]) => void) => {
    setSteps((prev) => {
      const next = prev.map((s) => ({ text: s.text, subs: [...s.subs] }));
      fn(next);
      return next;
    });
  };

  /** Insert `@slug ` over the active token in the mention's field. */
  const pickMention = (slug: string) => {
    if (!mention) return;
    const el = inputRefs.current.get(mention.fieldKey);
    if (!el) return;
    const caret = el.selectionStart ?? el.value.length;
    const before = el.value.slice(0, mention.start);
    const after = el.value.slice(caret);
    const inserted = `@${slug} `;
    const nextValue = `${before}${inserted}${after}`;
    const key = mention.fieldKey;
    if (key.startsWith('s')) {
      const i = Number(key.slice(1));
      mut((n) => (n[i].text = nextValue));
    } else {
      const [i, k] = key.slice(1).split('.').map(Number);
      mut((n) => (n[i].subs[k] = nextValue));
    }
    setMention(null);
    focusOn(key, before.length + inserted.length);
  };

  const commit = () => onCommit(toText(steps));

  const addBranch = (i: number) => {
    mut((n) => n[i].subs.push(''));
    focusOn(`b${i}.${steps[i].subs.length}`);
  };

  /** Keys the mention picker OWNS while open. Returns true when handled. */
  const mentionKeys = (e: React.KeyboardEvent): boolean => {
    if (!mention || ranked.length === 0) return false;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setMCursor((c) => Math.min(c + 1, ranked.length - 1));
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setMCursor((c) => Math.max(c - 1, 0));
      return true;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      pickMention(ranked[mSafe].mnemonic);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // the editor's Esc means CANCEL — not while picking
      setMention(null);
      return true;
    }
    return false;
  };

  return (
    <div
      ref={rootRef}
      className="relative border border-foreground/30 bg-background px-1.5 py-1 text-[11px] leading-snug"
      // Save when focus leaves the WHOLE editor (clicking between inputs and
      // buttons inside must not commit mid-edit).
      onBlur={(e) => {
        if (cancelledRef.current) return;
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !mention) {
          cancelledRef.current = true;
          onCancel();
        } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
      }}
    >
      <ol className="space-y-0.5">
        {steps.map((st, i) => (
          <li key={i}>
            <div className="flex items-start gap-1">
              <span className="shrink-0 text-foreground/45">{i + 1}.</span>
              <GrowText
                refCb={reg(`s${i}`)}
                value={st.text}
                onChange={(e) => {
                  const v = stripStep(e.target.value);
                  mut((n) => (n[i].text = v));
                  syncMention(`s${i}`, e.target);
                }}
                onKeyDown={(e) => {
                  if (mentionKeys(e)) return;
                  if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
                    e.preventDefault();
                    mut((n) => n.splice(i + 1, 0, { text: '', subs: [] }));
                    focusOn(`s${i + 1}`);
                  } else if (e.key === 'Tab' && !e.shiftKey && i > 0) {
                    // Tab: this step becomes a fork branch of the step above.
                    e.preventDefault();
                    mut((n) => {
                      const [me] = n.splice(i, 1);
                      n[i - 1].subs.push(me.text, ...me.subs);
                    });
                    focusOn(`b${i - 1}.${steps[i - 1].subs.length}`);
                  } else if (
                    e.key === 'Backspace' &&
                    st.text === '' &&
                    st.subs.length === 0 &&
                    steps.length > 1
                  ) {
                    e.preventDefault();
                    mut((n) => n.splice(i, 1));
                    focusOn(i > 0 ? `s${i - 1}` : 's0');
                  }
                }}
                placeholder={i === 0 ? 'first step… (@ mentions a code)' : 'step…'}
                aria-label={`Step ${i + 1}`}
                className="min-w-0 flex-1 bg-transparent focus:outline-none"
              />
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault() /* keep focus inside */}
                onClick={() => addBranch(i)}
                title="Add a lettered branch under this step"
                className="shrink-0 border border-foreground/25 px-1 text-[10px] leading-4 text-foreground/60 transition hover:border-foreground hover:text-foreground"
              >
                ⑂ fork
              </button>
            </div>

            {st.subs.length > 0 && (
              // Live tree while editing — same elbows the reader shows.
              <div className="mt-0.5">
                <div className="mx-auto h-2 w-0 border-l border-foreground/50" />
                <div className="flex justify-center">
                  {st.subs.map((sub, k) => (
                    <div key={k} className="flex min-w-0 flex-col items-center">
                      <div className="flex w-full">
                        <div
                          className={`h-0 flex-1 border-t ${k === 0 ? 'border-transparent' : 'border-foreground/50'}`}
                        />
                        <div
                          className={`h-0 flex-1 border-t ${k === st.subs.length - 1 ? 'border-transparent' : 'border-foreground/50'}`}
                        />
                      </div>
                      <div className="h-2 w-0 border-l border-foreground/50" />
                      {/* COMPACT node: label + character-sized input as one
                          centered unit. */}
                      <div className="flex items-center gap-0.5 px-1.5">
                        <span className="shrink-0 text-foreground/45">
                          {String.fromCharCode(97 + k)}.
                        </span>
                        <GrowText
                          refCb={reg(`b${i}.${k}`)}
                          value={sub}
                          // grow by content up to a wrap ceiling — past ~24ch
                          // the node stops widening and the text WRAPS down.
                          style={{ width: `${Math.min(24, Math.max(8, sub.length + 2))}ch` }}
                          onChange={(e) => {
                            const v = stripBranch(e.target.value);
                            mut((n) => (n[i].subs[k] = v));
                            syncMention(`b${i}.${k}`, e.target);
                          }}
                          onKeyDown={(e) => {
                            if (mentionKeys(e)) return;
                            if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
                              e.preventDefault();
                              mut((n) => n[i].subs.splice(k + 1, 0, ''));
                              focusOn(`b${i}.${k + 1}`);
                            } else if (e.key === 'Tab' && e.shiftKey) {
                              // Shift+Tab: promote the branch back to a step.
                              e.preventDefault();
                              mut((n) => {
                                const [me] = n[i].subs.splice(k, 1);
                                n.splice(i + 1, 0, { text: me, subs: [] });
                              });
                              focusOn(`s${i + 1}`);
                            } else if (e.key === 'Backspace' && sub === '') {
                              e.preventDefault();
                              mut((n) => n[i].subs.splice(k, 1));
                              focusOn(k > 0 ? `b${i}.${k - 1}` : `s${i}`);
                            }
                          }}
                          placeholder="branch…"
                          aria-label={`Branch ${String.fromCharCode(97 + k)} of step ${i + 1}`}
                          className="min-w-0 bg-transparent focus:outline-none"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </li>
        ))}
      </ol>

      {/* The @mention picker — the coding screen's rows: slug line, metadata
          expands on hover / keyboard focus. mousedown picks before blur. */}
      {mention && ranked.length > 0 && mPos && (
        <div
          role="listbox"
          aria-label="Mention a code"
          style={{ top: mPos.top, left: Math.min(mPos.left, 40) }}
          className="absolute z-40 max-h-72 w-[340px] overflow-y-auto border border-foreground/25 bg-background py-1 shadow-2xl"
        >
          {ranked.map((c, idx) => {
            const focused = idx === mSafe;
            const expanded = mHover === c.id || (mHover === null && focused);
            return (
              <div
                key={c.id}
                onMouseEnter={() => {
                  setMHover(c.id);
                  setMCursor(idx);
                }}
                onMouseLeave={() => setMHover((h) => (h === c.id ? null : h))}
              >
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickMention(c.mnemonic);
                  }}
                  className={`block w-full px-3 py-1 text-left ${focused ? 'bg-foreground/[0.06]' : ''}`}
                >
                  <span className="font-mono text-[13px] font-medium text-foreground">
                    {c.mnemonic}
                  </span>
                </button>
                {expanded && (
                  <div className="mx-3 mb-1 border-l-2 border-foreground/15 py-0.5 pl-2 text-[12px] text-foreground/80">
                    <p>{splitDefinition(c.definition).applied || <em>No definition yet.</em>}</p>
                    {c.exemplars.length > 0 && (
                      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-foreground/70">
                        {c.exemplars.map((ex, j) => (
                          <li key={j} className="italic">
                            “{ex}”
                          </li>
                        ))}
                      </ul>
                    )}
                    {c.counterExample && (
                      <p className="mt-1 text-foreground/70">
                        <span className="text-[10px] uppercase tracking-wide text-red-700/60 dark:text-red-400/60">
                          not:{' '}
                        </span>
                        {c.counterExample}
                      </p>
                    )}
                    <p className="mt-0.5 text-[10px] uppercase tracking-wide text-foreground/35">
                      {c.origin.replace('_', ' ')}
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
