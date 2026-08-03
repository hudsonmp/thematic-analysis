'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { parseNote } from './NoteText';

/**
 * Structured notes editor — the editor IS the rendered tree, so structure
 * shows LIVE while typing (no type-syntax-then-see-it-on-blur). Numbers and
 * letters are derived CHROME, never typed:
 *
 *   Enter in a step     → new step below (renumbers itself)
 *   Enter in a branch   → new sibling branch
 *   Tab in a step       → convert it to a branch of the step above
 *   Shift+Tab in branch → promote it back to a step
 *   ⑂ button on a step  → add a fork branch (the no-keyboard path)
 *   Backspace on empty  → remove the row
 *   ⌘⏎ / blur outside   → save · Esc → cancel
 *
 * Storage stays the ONE plain string (`1. …` / `a. …` lines), so NoteText,
 * the popup hover and the printed sheet are untouched. Pasting/typing a
 * literal "1. " or "a. " prefix is stripped — the chrome already says it.
 */

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
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (next: string) => void;
  onCancel: () => void;
}) {
  const [steps, setSteps] = useState<Step[]>(() => fromText(initial));
  // Which input owns focus: 's<i>' for a step, 'b<i>.<k>' for a branch.
  // Focus is applied IMPERATIVELY after each render — autoFocus only fires at
  // mount, and moving focus to an already-mounted input (Backspace-delete)
  // would otherwise drop focus to <body>, blur the container and save early.
  const [focusKey, setFocusKey] = useState<string>('s0');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const cancelledRef = useRef(false);
  const inputRefs = useRef(new Map<string, HTMLTextAreaElement>());
  const reg = (key: string) => (el: HTMLTextAreaElement | null) => {
    if (el) inputRefs.current.set(key, el);
    else inputRefs.current.delete(key);
  };
  useEffect(() => {
    inputRefs.current.get(focusKey)?.focus();
  }, [focusKey, steps]);

  const mut = (fn: (next: Step[]) => void) => {
    setSteps((prev) => {
      const next = prev.map((s) => ({ text: s.text, subs: [...s.subs] }));
      fn(next);
      return next;
    });
  };

  const commit = () => onCommit(toText(steps));

  const addBranch = (i: number) => {
    mut((n) => n[i].subs.push(''));
    setFocusKey(`b${i}.${steps[i].subs.length}`);
  };

  return (
    <div
      ref={rootRef}
      className="border border-foreground/30 bg-background px-1.5 py-1 text-[11px] leading-snug"
      // Save when focus leaves the WHOLE editor (clicking between inputs and
      // buttons inside must not commit mid-edit).
      onBlur={(e) => {
        if (cancelledRef.current) return;
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
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
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
                    e.preventDefault();
                    mut((n) => n.splice(i + 1, 0, { text: '', subs: [] }));
                    setFocusKey(`s${i + 1}`);
                  } else if (e.key === 'Tab' && !e.shiftKey && i > 0) {
                    // Tab: this step becomes a fork branch of the step above.
                    e.preventDefault();
                    mut((n) => {
                      const [me] = n.splice(i, 1);
                      n[i - 1].subs.push(me.text, ...me.subs);
                    });
                    setFocusKey(`b${i - 1}.${steps[i - 1].subs.length}`);
                  } else if (e.key === 'Backspace' && st.text === '' && st.subs.length === 0 && steps.length > 1) {
                    e.preventDefault();
                    mut((n) => n.splice(i, 1));
                    setFocusKey(i > 0 ? `s${i - 1}` : 's0');
                  }
                }}
                placeholder={i === 0 ? 'first step…' : 'step…'}
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
                        <div className={`h-0 flex-1 border-t ${k === 0 ? 'border-transparent' : 'border-foreground/50'}`} />
                        <div className={`h-0 flex-1 border-t ${k === st.subs.length - 1 ? 'border-transparent' : 'border-foreground/50'}`} />
                      </div>
                      <div className="h-2 w-0 border-l border-foreground/50" />
                      {/* COMPACT node: label + character-sized input as one
                          centered unit — a full-width centered input floated
                          the caret to the middle of the cell, far from its
                          own "a." label. */}
                      <div className="flex items-center gap-0.5 px-1.5">
                        <span className="shrink-0 text-foreground/45">{String.fromCharCode(97 + k)}.</span>
                        <GrowText
                          refCb={reg(`b${i}.${k}`)}
                          value={sub}
                          // grow by content up to a wrap ceiling — past ~24ch
                          // the node stops widening and the text WRAPS down.
                          style={{ width: `${Math.min(24, Math.max(8, sub.length + 2))}ch` }}
                          onChange={(e) => {
                            const v = stripBranch(e.target.value);
                            mut((n) => (n[i].subs[k] = v));
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
                              e.preventDefault();
                              mut((n) => n[i].subs.splice(k + 1, 0, ''));
                              setFocusKey(`b${i}.${k + 1}`);
                            } else if (e.key === 'Tab' && e.shiftKey) {
                              // Shift+Tab: promote the branch back to a step.
                              e.preventDefault();
                              mut((n) => {
                                const [me] = n[i].subs.splice(k, 1);
                                n.splice(i + 1, 0, { text: me, subs: [] });
                              });
                              setFocusKey(`s${i + 1}`);
                            } else if (e.key === 'Backspace' && sub === '') {
                              e.preventDefault();
                              mut((n) => n[i].subs.splice(k, 1));
                              setFocusKey(k > 0 ? `b${i}.${k - 1}` : `s${i}`);
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
    </div>
  );
}
