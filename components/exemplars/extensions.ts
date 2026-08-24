import { Mark, mergeAttributes } from '@tiptap/core';
import Mention from '@tiptap/extension-mention';
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion';
import { COMMENT_MARK, CODE_MENTION_NODE } from '@/lib/exemplars/threads';
import type { MentionCode } from '@/components/codebook/MentionTextarea';

/**
 * The exemplar editor's two custom pieces on top of StarterKit:
 *
 *  - `CommentMark` — a `comment` mark carrying `threadId`. Rendered as
 *    `<span data-thread-id>` so the comment column can find each span's DOM
 *    position; `inclusive: false` so typing at the END of a highlighted span
 *    does not extend the highlight (Docs behaviour). The thread id is the anchor
 *    the comment rows point at (see lib/exemplars/threads.ts).
 *
 *  - `CodeMention` — the Mention node renamed `codeMention`, storing the code's
 *    id + mnemonic and rendered as an `@slug` chip. The dropdown itself is a
 *    React component in the workspace; the suggestion plugin only reports state
 *    through `MentionBridge` so this module stays free of React.
 */

export const CommentMark = Mark.create({
  name: COMMENT_MARK,
  inclusive: false,
  excludes: '',
  addAttributes() {
    return {
      threadId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-thread-id'),
        renderHTML: (attrs) => (attrs.threadId ? { 'data-thread-id': attrs.threadId } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-thread-id]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { class: 'ex-comment' }), 0];
  },
});

/** What the suggestion plugin reports to the React dropdown. */
export type MentionState = {
  items: MentionCode[];
  query: string;
  command: (item: MentionCode) => void;
  rect: DOMRect | null;
};

/**
 * The seam between the (non-React) suggestion plugin and the React dropdown.
 * The workspace fills `codes` and `onState`; the plugin's `render` handlers
 * call them. `onKeyDown` is set by the dropdown while it is open so ↑/↓/⏎/Esc
 * reach it.
 */
export type MentionBridge = {
  codes: () => MentionCode[];
  /** The workspace pushes the current code list here (from an effect). */
  setCodes: (codes: MentionCode[]) => void;
  onState: (s: MentionState | null) => void;
  /** Route a key event to the open dropdown; false when nothing handled it. */
  keyDown: (e: KeyboardEvent) => boolean;
  /** The dropdown installs its handler while open and clears it on close. */
  setKeyDown: (fn: ((e: KeyboardEvent) => boolean) | null) => void;
};

/** Build a bridge over closures so React never mutates a shared object in render. */
export function createMentionBridge(init: { onState: (s: MentionState | null) => void }): MentionBridge {
  let handler: ((e: KeyboardEvent) => boolean) | null = null;
  let codes: MentionCode[] = [];
  return {
    codes: () => codes,
    setCodes: (next) => {
      codes = next;
    },
    onState: init.onState,
    keyDown: (e) => handler?.(e) ?? false,
    setKeyDown: (fn) => {
      handler = fn;
    },
  };
}

/** Substring-rank the mnemonics: prefix hits first, then other hits, alphabetical. */
export function rankCodes(codes: MentionCode[], query: string): MentionCode[] {
  const q = query.trim().toLowerCase();
  const scored = codes
    .map((c) => {
      const m = c.mnemonic.toLowerCase();
      const rank = q === '' ? 1 : m.startsWith(q) ? 0 : m.includes(q) ? 1 : -1;
      return { c, rank };
    })
    .filter((x) => x.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.c.mnemonic.localeCompare(b.c.mnemonic));
  return scored.slice(0, 12).map((x) => x.c);
}

export function makeCodeMention(bridge: MentionBridge) {
  return Mention.extend({ name: CODE_MENTION_NODE }).configure({
    HTMLAttributes: { class: 'ex-mention' },
    renderText: ({ node }) => `@${node.attrs.label ?? node.attrs.id}`,
    renderHTML: ({ node, options }) => [
      'span',
      mergeAttributes(options.HTMLAttributes, {
        'data-type': CODE_MENTION_NODE,
        'data-id': node.attrs.id,
        'data-label': node.attrs.label,
      }),
      `@${node.attrs.label ?? node.attrs.id}`,
    ],
    suggestion: {
      char: '@',
      allowSpaces: false,
      items: ({ query }) => rankCodes(bridge.codes(), query),
      command: ({ editor, range, props }) => {
        const code = props as unknown as MentionCode;
        editor
          .chain()
          .focus()
          .insertContentAt(range, [
            {
              type: CODE_MENTION_NODE,
              attrs: { id: code.id, label: code.mnemonic },
            },
            { type: 'text', text: ' ' },
          ])
          .run();
      },
      render: () => {
        const push = (p: SuggestionProps<MentionCode, MentionCode>) =>
          bridge.onState({
            items: p.items,
            query: p.query,
            command: (item) => p.command(item),
            rect: p.clientRect?.() ?? null,
          });
        return {
          onStart: push,
          onUpdate: push,
          onKeyDown: (p: SuggestionKeyDownProps) => bridge.keyDown(p.event),
          onExit: () => bridge.onState(null),
        };
      },
    },
  });
}
