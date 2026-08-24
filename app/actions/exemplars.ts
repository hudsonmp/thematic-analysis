'use server';

import { cbFrom } from '@/lib/supabase/guard';
import { requireAuthUser } from '@/lib/auth/supabase-auth';
import { requireAdmin } from '@/lib/auth/roles';
import type { Json } from '@/lib/types/cb-db';
import { EMPTY_DOC, docHasContent, threadIdsInDoc, type PmNode } from '@/lib/exemplars/threads';

// ---------------------------------------------------------------------------
// Exemplars — the admin-authored worked-example document (migration 44).
//
// A TAB is a code: `listExemplarTabs` derives the tab list from cb_codes (the
// same non-retired spine every code surface reads), decorated with whether an
// exemplar body exists yet. `getExemplarDoc` returns one tab's body + comment
// threads. Writes (`saveExemplarDoc`, `addExemplarComment`,
// `deleteExemplarComment`) are ADMIN-ONLY: the tables carry no write policies,
// so the service-role path behind requireAdmin() is the only way in.
// ---------------------------------------------------------------------------

export type ExemplarTab = {
  codeId: string;
  mnemonic: string;
  /** True when a saved body with visible text exists for this code. */
  hasContent: boolean;
  /** Comment threads whose highlight still exists in the body. */
  threadCount: number;
};

export type ExemplarComment = {
  id: string;
  threadId: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
};

export type ExemplarDoc = {
  codeId: string;
  body: PmNode;
  updatedAt: string | null;
  comments: ExemplarComment[];
};

/** The tab list for a codebook: every non-retired code, ordered by mnemonic. */
export async function listExemplarTabs(codebookId: string): Promise<ExemplarTab[]> {
  await requireAuthUser();
  const [codesRes, docsRes] = await Promise.all([
    cbFrom('cb_codes')
      .select('id, mnemonic')
      .eq('codebook_id', codebookId)
      .is('retired_at', null)
      .order('mnemonic', { ascending: true }),
    cbFrom('cb_exemplar_docs').select('code_id, body').eq('codebook_id', codebookId),
  ]);
  if (codesRes.error) throw new Error(`listExemplarTabs (codes) failed: ${codesRes.error.message}`);
  if (docsRes.error) throw new Error(`listExemplarTabs (docs) failed: ${docsRes.error.message}`);
  const docs = docsRes.data ?? [];
  const withContent = new Set(
    docs.filter((d) => docHasContent(d.body as PmNode)).map((d) => d.code_id),
  );
  // Live thread count per tab: comments whose thread mark still exists in the doc.
  const counts = new Map<string, number>();
  if (docs.length > 0) {
    const { data: comments, error } = await cbFrom('cb_exemplar_comments')
      .select('code_id, thread_id')
      .in('code_id', docs.map((d) => d.code_id));
    if (error) throw new Error(`listExemplarTabs (comments) failed: ${error.message}`);
    const live = new Map(docs.map((d) => [d.code_id, new Set(threadIdsInDoc(d.body as PmNode))]));
    const seen = new Set<string>();
    for (const c of comments ?? []) {
      const key = `${c.code_id}:${c.thread_id}`;
      if (seen.has(key) || !live.get(c.code_id)?.has(c.thread_id)) continue;
      seen.add(key);
      counts.set(c.code_id, (counts.get(c.code_id) ?? 0) + 1);
    }
  }
  return (codesRes.data ?? []).map((c) => ({
    codeId: c.id,
    mnemonic: c.mnemonic,
    hasContent: withContent.has(c.id),
    threadCount: counts.get(c.id) ?? 0,
  }));
}

/** One tab's body + its comments (author names resolved from cb_profiles). */
export async function getExemplarDoc(codeId: string): Promise<ExemplarDoc> {
  await requireAuthUser();
  const [docRes, commentsRes] = await Promise.all([
    cbFrom('cb_exemplar_docs').select('body, updated_at').eq('code_id', codeId).maybeSingle(),
    cbFrom('cb_exemplar_comments')
      .select('id, thread_id, author_id, body, created_at')
      .eq('code_id', codeId)
      .order('created_at', { ascending: true }),
  ]);
  if (docRes.error) throw new Error(`getExemplarDoc failed: ${docRes.error.message}`);
  if (commentsRes.error) throw new Error(`getExemplarDoc (comments) failed: ${commentsRes.error.message}`);

  const rows = commentsRes.data ?? [];
  const authorIds = [...new Set(rows.map((r) => r.author_id))];
  const names = new Map<string, string>();
  if (authorIds.length > 0) {
    const { data: profiles } = await cbFrom('cb_profiles')
      .select('user_id, display_name, initials')
      .in('user_id', authorIds);
    for (const p of profiles ?? []) {
      names.set(p.user_id, p.display_name?.trim() || p.initials?.trim() || 'Researcher');
    }
  }

  return {
    codeId,
    body: (docRes.data?.body as PmNode | null) ?? EMPTY_DOC,
    updatedAt: docRes.data?.updated_at ?? null,
    comments: rows.map((r) => ({
      id: r.id,
      threadId: r.thread_id,
      authorId: r.author_id,
      authorName: names.get(r.author_id) ?? 'Researcher',
      body: r.body,
      createdAt: r.created_at,
    })),
  };
}

/** Autosave a tab's body (admin). Upserts the 1:1 row; returns `updated_at`. */
export async function saveExemplarDoc(
  codeId: string,
  codebookId: string,
  body: PmNode,
): Promise<{ updated_at: string }> {
  await requireAdmin();
  const { data, error } = await cbFrom('cb_exemplar_docs')
    .upsert(
      {
        code_id: codeId,
        codebook_id: codebookId,
        body: body as unknown as Json,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'code_id' },
    )
    .select('updated_at')
    .single();
  if (error || !data) {
    throw new Error(`saveExemplarDoc failed: ${error?.message ?? 'no row returned'}`);
  }
  return { updated_at: data.updated_at };
}

/**
 * Add a comment to a thread (admin). The doc row must exist first — the client
 * flushes its autosave (which upserts the row) before calling this, so the FK
 * on code_id holds; we upsert an empty row defensively anyway.
 */
export async function addExemplarComment(input: {
  codeId: string;
  codebookId: string;
  threadId: string;
  body: string;
}): Promise<ExemplarComment> {
  await requireAdmin();
  const user = await requireAuthUser();
  const body = input.body.trim();
  if (body === '') throw new Error('addExemplarComment: body must be non-empty.');

  const ensure = await cbFrom('cb_exemplar_docs')
    .upsert(
      { code_id: input.codeId, codebook_id: input.codebookId },
      { onConflict: 'code_id', ignoreDuplicates: true },
    );
  if (ensure.error) throw new Error(`addExemplarComment (doc) failed: ${ensure.error.message}`);

  const { data, error } = await cbFrom('cb_exemplar_comments')
    .insert({ code_id: input.codeId, thread_id: input.threadId, author_id: user.id, body })
    .select('id, thread_id, author_id, body, created_at')
    .single();
  if (error || !data) {
    throw new Error(`addExemplarComment failed: ${error?.message ?? 'no row returned'}`);
  }

  const { data: profile } = await cbFrom('cb_profiles')
    .select('display_name, initials')
    .eq('user_id', user.id)
    .maybeSingle();

  return {
    id: data.id,
    threadId: data.thread_id,
    authorId: data.author_id,
    authorName: profile?.display_name?.trim() || profile?.initials?.trim() || 'Researcher',
    body: data.body,
    createdAt: data.created_at,
  };
}

/** Delete one comment (admin). */
export async function deleteExemplarComment(id: string): Promise<void> {
  await requireAdmin();
  const { error } = await cbFrom('cb_exemplar_comments').delete().eq('id', id);
  if (error) throw new Error(`deleteExemplarComment failed: ${error.message}`);
}
