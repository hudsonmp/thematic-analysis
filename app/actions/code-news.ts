'use server';

import { createUserServerClient } from '@/lib/supabase/user-server';
import { requireAuthUser } from '@/lib/auth/supabase-auth';

/**
 * NEW-CODE notifications for asynchronous co-coding.
 *
 * During the emergent phase each coder mints codes the other cannot see
 * arriving — and a code you have never read is a code you cannot apply, so
 * the instrument silently forks. The mechanism is a WATERMARK, not an inbox:
 * `cb_profiles.codes_seen_at` marks the last time THIS coder acknowledged
 * the code list; anything created after it by SOMEONE ELSE is "news".
 * Dismissing the banner advances the watermark — one write, no per-code ack
 * rows, and it works identically for N coders.
 */

export type NewCode = {
  id: string;
  mnemonic: string;
  origin: string;
  codebookName: string;
  creatorName: string;
  createdAt: string;
};

export async function listNewCodes(): Promise<NewCode[]> {
  const user = await requireAuthUser();
  const sb = await createUserServerClient();

  const { data: prof } = await sb
    .from('cb_profiles')
    .select('codes_seen_at')
    .eq('user_id', user.id)
    .maybeSingle();
  // No profile row → show nothing rather than the whole history.
  if (!prof) return [];

  const { data, error } = await sb
    .from('cb_codes')
    .select('id, mnemonic, origin, created_at, created_by, cb_codebooks(name)')
    .gt('created_at', prof.codes_seen_at)
    .neq('created_by', user.id)
    .not('created_by', 'is', null)
    .is('retired_at', null)
    .order('created_at', { ascending: true })
    .limit(50);
  if (error) throw new Error(`listNewCodes failed: ${error.message}`);
  const rows = data ?? [];
  if (rows.length === 0) return [];

  const creatorIds = [...new Set(rows.map((r) => r.created_by).filter((v): v is string => !!v))];
  const nameById = new Map<string, string>();
  if (creatorIds.length > 0) {
    const { data: profs } = await sb
      .from('cb_profiles')
      .select('user_id, display_name')
      .in('user_id', creatorIds);
    for (const p of profs ?? []) nameById.set(p.user_id, p.display_name ?? 'a co-coder');
  }

  return rows.map((r) => ({
    id: r.id,
    mnemonic: r.mnemonic,
    origin: r.origin,
    codebookName:
      (r.cb_codebooks as unknown as { name: string } | null)?.name ?? 'codebook',
    creatorName: nameById.get(r.created_by ?? '') ?? 'a co-coder',
    createdAt: r.created_at,
  }));
}

/** Advance MY watermark to now — the banner's dismiss. */
export async function markCodesSeen(): Promise<void> {
  const user = await requireAuthUser();
  const sb = await createUserServerClient();
  const { error } = await sb
    .from('cb_profiles')
    .update({ codes_seen_at: new Date().toISOString() })
    .eq('user_id', user.id);
  if (error) throw new Error(`markCodesSeen failed: ${error.message}`);
}
