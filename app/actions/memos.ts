'use server';

import { createServiceRoleClient } from '@/lib/supabase/service';
import { cbFrom } from '@/lib/supabase/guard';
import type { Json, Tables } from '@/lib/types/cb-db';

type Memo = Tables<'cb_memos'>;

/**
 * The memo as the player consumes it: the raw `cb_memos` row with `span`
 * narrowed from jsonb to an optional `[startMs, endMs]` tuple.
 */
export type MemoView = {
  id: string;
  body: string;
  author: string | null;
  span: [number, number] | null;
  created_at: string;
};

function spanView(span: Json | null): [number, number] | null {
  if (Array.isArray(span) && span.length === 2) {
    return [Number(span[0]) || 0, Number(span[1]) || 0];
  }
  return null;
}

/**
 * Add an analytic memo on a session. `span` is an optional `[startMs, endMs]`
 * the researcher had selected when writing the memo (null = a memo about the
 * session as a whole). `author` is supplied by the UI (the researcher session
 * carries no per-user identity); it is optional here — an unattributed memo is
 * still useful as a running analytic note, unlike a coder comment. Returns the
 * inserted row.
 */
export async function addMemo({
  codebookId,
  pid,
  body,
  author,
  span,
}: {
  codebookId: string;
  pid: string;
  body: string;
  author?: string | null;
  span?: [number, number] | null;
}): Promise<Memo> {
  if (typeof body !== 'string' || body.trim() === '') {
    throw new Error('addMemo: body must be a non-empty string.');
  }

  const res = await cbFrom('cb_memos')
    .insert({
      codebook_id: codebookId,
      pid,
      body: body.trim(),
      author: author?.trim() ? author.trim() : null,
      span: span ? (span as unknown as Json) : null,
    })
    .select('*')
    .single();
  if (res.error || !res.data) {
    throw new Error(`addMemo failed: ${res.error?.message ?? 'no row returned'}`);
  }
  return res.data;
}

/**
 * List a session's memos (`pid` match), oldest first (running-note order).
 * Read-only — service-role client directly; only writes route through `cbFrom`.
 */
export async function listMemos(pid: string): Promise<MemoView[]> {
  const supabase = createServiceRoleClient();
  const res = await supabase
    .from('cb_memos')
    .select('id, body, author, span, created_at')
    .eq('pid', pid)
    .order('created_at', { ascending: true });
  if (res.error) {
    throw new Error(`listMemos failed: ${res.error.message}`);
  }
  return (res.data ?? []).map((m) => ({
    id: m.id,
    body: m.body,
    author: m.author,
    span: spanView(m.span),
    created_at: m.created_at,
  }));
}

/** Delete a memo by id. */
export async function deleteMemo(id: string): Promise<void> {
  const { error } = await cbFrom('cb_memos').delete().eq('id', id);
  if (error) throw new Error(`deleteMemo failed: ${error.message}`);
}
