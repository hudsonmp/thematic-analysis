/**
 * threads — PURE helpers over an exemplar document (ProseMirror JSON) and its
 * comment bodies. No editor, no DOM, no DB, so the anchoring rules are unit-
 * testable on plain objects.
 *
 * Anchoring model: a commented span carries a `comment` mark with a `threadId`
 * attr; comment rows (cb_exemplar_comments) point at that id. The doc JSON is
 * therefore the source of truth for WHICH threads still exist — a mark deleted
 * by a later edit orphans its rows, and the UI must not render orphans.
 *
 * Code linking: the codes a span "is coded as" are the codes `@`-mentioned in
 * its thread's comment bodies (plain `@slug` tokens, the same convention as
 * MentionTextarea / NoteText). Nothing is stored twice.
 */

/** The minimal ProseMirror JSON shape we walk. */
export type PmNode = {
  type?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: PmNode[];
  text?: string;
};

export const COMMENT_MARK = 'comment';
export const CODE_MENTION_NODE = 'codeMention';

/** The empty document — what a tab with no row yet renders. */
export const EMPTY_DOC: PmNode = { type: 'doc', content: [] };

/** Every thread id present in `doc`, in document order, de-duplicated. */
export function threadIdsInDoc(doc: PmNode | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (n: PmNode | undefined) => {
    if (!n) return;
    for (const m of n.marks ?? []) {
      if (m.type !== COMMENT_MARK) continue;
      const id = m.attrs?.threadId;
      if (typeof id === 'string' && id !== '' && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
    for (const c of n.content ?? []) walk(c);
  };
  walk(doc ?? undefined);
  return out;
}

/** The concatenated text of every span carrying `threadId` (the quoted excerpt). */
export function threadExcerpt(doc: PmNode | null | undefined, threadId: string): string {
  let out = '';
  const walk = (n: PmNode | undefined) => {
    if (!n) return;
    if (
      typeof n.text === 'string' &&
      (n.marks ?? []).some((m) => m.type === COMMENT_MARK && m.attrs?.threadId === threadId)
    ) {
      out += n.text;
    }
    for (const c of n.content ?? []) walk(c);
  };
  walk(doc ?? undefined);
  return out;
}

/** Every code id mentioned inline in the body (codeMention nodes), de-duplicated. */
export function codeIdsInDoc(doc: PmNode | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (n: PmNode | undefined) => {
    if (!n) return;
    if (n.type === CODE_MENTION_NODE) {
      const id = n.attrs?.id;
      if (typeof id === 'string' && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
    for (const c of n.content ?? []) walk(c);
  };
  walk(doc ?? undefined);
  return out;
}

/**
 * The `@slug` tokens in a comment body. A mention starts at an '@' that begins
 * the text or follows whitespace/punctuation-open (so "a@b" is not one) and runs
 * to the next whitespace; trailing sentence punctuation is stripped so
 * "coded as @foo." yields "foo".
 */
export function mentionedSlugs(body: string): string[] {
  const out: string[] = [];
  const re = /(^|[\s(\[])@([^\s@]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const slug = m[2].replace(/[.,;:!?)\]]+$/, '');
    if (slug !== '' && !out.includes(slug)) out.push(slug);
  }
  return out;
}

/** Whether `doc` has any visible text (so the tab list can mark "has example"). */
export function docHasContent(doc: PmNode | null | undefined): boolean {
  let found = false;
  const walk = (n: PmNode | undefined) => {
    if (!n || found) return;
    if (typeof n.text === 'string' && n.text.trim() !== '') found = true;
    if (n.type === CODE_MENTION_NODE) found = true;
    for (const c of n.content ?? []) walk(c);
  };
  walk(doc ?? undefined);
  return found;
}
