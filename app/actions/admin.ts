'use server';

import { cbFrom } from '@/lib/supabase/guard';
import { createUserServerClient } from '@/lib/supabase/user-server';
import { requireAuthUser } from '@/lib/auth/supabase-auth';
import { requireAdmin } from '@/lib/auth/roles';

/**
 * Admin actions: single-use invites + the data-familiarization list. Every action
 * here starts with requireAdmin() — the `/?admin` view gates rendering, but pages are
 * not security boundaries; the actions are.
 *
 * Invites go through cbFrom (service role) because cb_invites deliberately has NO
 * RLS policies: a token in a URL is the whole credential, so the table must be
 * unreadable to every JWT. The familiarization writes also use cbFrom (no write
 * policies exist; reads are policy-open to authenticated).
 */

export type InviteRow = {
  id: string;
  token: string;
  role: string;
  createdAt: string;
  usedAt: string | null;
  usedByName: string | null;
};

export async function createInvite(role: 'full' | 'viewer'): Promise<InviteRow> {
  await requireAdmin();
  const user = await requireAuthUser();
  const { data, error } = await cbFrom('cb_invites')
    .insert({ role, created_by: user.id })
    .select('*')
    .single();
  if (error || !data) {
    throw new Error(`createInvite failed: ${error?.message ?? 'no row returned'}`);
  }
  return {
    id: data.id,
    token: data.token,
    role: data.role,
    createdAt: data.created_at,
    usedAt: data.used_at,
    usedByName: null,
  };
}

export async function listInvites(): Promise<InviteRow[]> {
  await requireAdmin();
  const { data, error } = await cbFrom('cb_invites')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw new Error(`listInvites failed: ${error.message}`);

  // Resolve consumer display names via cb_profiles (used_by FKs auth.users).
  const ids = [...new Set((data ?? []).map((r) => r.used_by).filter((x): x is string => !!x))];
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const sb = await createUserServerClient();
    const profs = await sb.from('cb_profiles').select('user_id, display_name').in('user_id', ids);
    for (const p of profs.data ?? []) names.set(p.user_id, p.display_name ?? p.user_id);
  }

  return (data ?? []).map((r) => ({
    id: r.id,
    token: r.token,
    role: r.role,
    createdAt: r.created_at,
    usedAt: r.used_at,
    usedByName: r.used_by ? (names.get(r.used_by) ?? r.used_by) : null,
  }));
}

/** Revoke an UNUSED invite (a used one is history, not a credential — keep it). */
export async function revokeInvite(id: string): Promise<void> {
  await requireAdmin();
  const { error } = await cbFrom('cb_invites').delete().eq('id', id).is('used_at', null);
  if (error) throw new Error(`revokeInvite failed: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Data familiarization (Track F): the sessions a new coder should watch first.
// ---------------------------------------------------------------------------

export type FamiliarizationRow = { sessionId: string; position: number };

/** Replace the familiarization list with `sessionIds`, in the given order. A
 *  replace (not add/remove pairs) because the list IS the curriculum — its order
 *  and extent are one editorial decision. */
export async function setFamiliarization(sessionIds: string[]): Promise<void> {
  await requireAdmin();
  const user = await requireAuthUser();

  const del = await cbFrom('cb_familiarization').delete().gte('position', 0);
  if (del.error) throw new Error(`setFamiliarization (clear) failed: ${del.error.message}`);

  if (sessionIds.length === 0) return;
  const ins = await cbFrom('cb_familiarization').insert(
    sessionIds.map((session_id, i) => ({ session_id, position: i, added_by: user.id })),
  );
  if (ins.error) throw new Error(`setFamiliarization failed: ${ins.error.message}`);
}

/** The ordered familiarization list — readable by ANY coder (the guide ends with
 *  it), so this one reads through the user client + the read-all policy. */
export async function listFamiliarization(): Promise<
  { sessionId: string; position: number; pidLabel: string; collection: string }[]
> {
  await requireAuthUser();
  const sb = await createUserServerClient();
  const { data, error } = await sb
    .from('cb_familiarization')
    .select('session_id, position, cb_sessions(pid_label, collection)')
    .order('position', { ascending: true });
  if (error) throw new Error(`listFamiliarization failed: ${error.message}`);
  return (data ?? []).map((r) => {
    const sess = r.cb_sessions as unknown as { pid_label: string; collection: string } | null;
    return {
      sessionId: r.session_id,
      position: r.position,
      pidLabel: sess?.pid_label ?? '—',
      collection: sess?.collection ?? '—',
    };
  });
}
