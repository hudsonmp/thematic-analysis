'use server';

import { createUserServerClient } from '@/lib/supabase/user-server';
import { pageAll } from '@/lib/supabase/pageAll';
import { requireAuthUser } from '@/lib/auth/supabase-auth';
import { easyDiag, type Annotation, type EasyDiagResult } from '@/lib/irr/easydiag';

/**
 * IRR (EasyDIAg) — READ-ONLY. Loads two coders' TIME-anchored code annotations
 * for a session and computes inter-rater reliability via lib/irr/easydiag.
 *
 * This never writes and never touches the coding surface. The interval for each
 * annotation is the row's own [t_start_ms, t_end_ms] — the coded span's
 * enclosing-segment time extent, already materialized at ingest — so both the
 * mic track and the un-named echo track land on the SAME recording clock and a
 * duplicate-track split collapses by temporal overlap (see easydiag.ts header).
 *
 * A multi-code annotation is expanded to one event per code, because EasyDIAg's
 * category axis is single-valued; two codes on one span are two co-located
 * events, which is the correct model (both compete for a partner independently).
 */

export type CoderOption = { id: string; name: string; nCode: number };

export type IrrSessionOption = {
  sessionId: string;
  pidLabel: string;
  coders: CoderOption[];
};

/** Sessions with ≥2 coders who have code-kind annotations — the only sessions
 *  IRR can be computed on. */
export async function listIrrSessions(): Promise<IrrSessionOption[]> {
  await requireAuthUser();
  const sb = await createUserServerClient();

  const { data, error } = await pageAll((from, to) =>
    sb
      .from('cb_annotations')
      .select('session_id, coder_id, kind')
      .eq('kind', 'code')
      .order('id', { ascending: true })
      .range(from, to),
  );
  if (error) throw new Error(`listIrrSessions failed: ${error.message}`);
  const rows = data ?? [];

  // session -> coder -> count
  const bySession = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (!r.session_id || !r.coder_id) continue;
    let m = bySession.get(r.session_id);
    if (!m) {
      m = new Map();
      bySession.set(r.session_id, m);
    }
    m.set(r.coder_id, (m.get(r.coder_id) ?? 0) + 1);
  }

  const multi = [...bySession.entries()].filter(([, m]) => m.size >= 2);
  if (multi.length === 0) return [];

  // Resolve pid labels and coder names.
  const sessionIds = multi.map(([s]) => s);
  const coderIds = [...new Set(multi.flatMap(([, m]) => [...m.keys()]))];

  const [{ data: sessRows }, { data: profRows }] = await Promise.all([
    sb.from('cb_sessions').select('id, pid_label').in('id', sessionIds),
    sb.from('cb_profiles').select('user_id, display_name').in('user_id', coderIds),
  ]);
  const pidById = new Map((sessRows ?? []).map((s) => [s.id, s.pid_label]));
  const nameById = new Map((profRows ?? []).map((p) => [p.user_id, p.display_name ?? 'coder']));

  return multi
    .map(([sessionId, m]) => ({
      sessionId,
      pidLabel: pidById.get(sessionId) ?? sessionId.slice(0, 8),
      coders: [...m.entries()]
        .map(([id, nCode]) => ({ id, name: nameById.get(id) ?? id.slice(0, 8), nCode }))
        .sort((a, b) => b.nCode - a.nCode),
    }))
    .sort((a, b) => a.pidLabel.localeCompare(b.pidLabel));
}

export type CodeMeta = { mnemonic: string; origin: string };

export type IrrReport = {
  sessionId: string;
  pidLabel: string;
  coderA: { id: string; name: string };
  coderB: { id: string; name: string };
  result: EasyDiagResult;
  /** origin per code mnemonic, so the UI can partition a-priori vs emergent. */
  codeOrigin: Record<string, string>;
};

/**
 * Compute the EasyDIAg report for one (session, coderA, coderB) at a given
 * overlap threshold. `minInstances` sets the underpowered flag.
 */
export async function computeIrr(input: {
  sessionId: string;
  coderAId: string;
  coderBId: string;
  threshold?: number;
  minInstances?: number;
  /** Restrict to annotations whose ONSET falls in [windowStartMs, windowEndMs].
   *  Null bounds = open. Purpose: a coder who tapered off late did not DISAGREE
   *  in the tail, they left it uncoded; scoring the region where both coded at
   *  comparable density is the honest estimate (the "matched-effort window"). */
  windowStartMs?: number | null;
  windowEndMs?: number | null;
}): Promise<IrrReport> {
  await requireAuthUser();
  const sb = await createUserServerClient();

  // Code annotations for the two coders, with their codes and each code's origin.
  const { data, error } = await pageAll((from, to) =>
    sb
      .from('cb_annotations')
      .select(
        'id, coder_id, t_start_ms, t_end_ms, cb_annotation_codes(cb_codes(mnemonic, origin))',
      )
      .eq('session_id', input.sessionId)
      .eq('kind', 'code')
      .in('coder_id', [input.coderAId, input.coderBId])
      .order('id', { ascending: true })
      .range(from, to),
  );
  if (error) throw new Error(`computeIrr failed: ${error.message}`);

  type Row = {
    id: string;
    coder_id: string;
    t_start_ms: number;
    t_end_ms: number;
    cb_annotation_codes: { cb_codes: { mnemonic: string; origin: string } | null }[] | null;
  };

  const lo = input.windowStartMs ?? null;
  const hi = input.windowEndMs ?? null;
  const codeOrigin: Record<string, string> = {};
  const expand = (coderId: string): Annotation[] => {
    const out: Annotation[] = [];
    for (const r of (data ?? []) as Row[]) {
      if (r.coder_id !== coderId) continue;
      if (lo !== null && r.t_start_ms < lo) continue;
      if (hi !== null && r.t_start_ms > hi) continue;
      const codes = (r.cb_annotation_codes ?? [])
        .map((ac) => ac.cb_codes)
        .filter((c): c is { mnemonic: string; origin: string } => c !== null);
      for (const c of codes) {
        codeOrigin[c.mnemonic] = c.origin;
        out.push({
          id: `${r.id}:${c.mnemonic}`,
          onset: r.t_start_ms,
          offset: r.t_end_ms,
          code: c.mnemonic,
        });
      }
    }
    return out;
  };

  const result = easyDiag(expand(input.coderAId), expand(input.coderBId), {
    threshold: input.threshold ?? 0.6,
    minInstances: input.minInstances ?? 10,
  });

  const [{ data: sessRow }, { data: profRows }] = await Promise.all([
    sb.from('cb_sessions').select('pid_label').eq('id', input.sessionId).maybeSingle(),
    sb
      .from('cb_profiles')
      .select('user_id, display_name')
      .in('user_id', [input.coderAId, input.coderBId]),
  ]);
  const nameById = new Map((profRows ?? []).map((p) => [p.user_id, p.display_name ?? 'coder']));

  return {
    sessionId: input.sessionId,
    pidLabel: sessRow?.pid_label ?? input.sessionId.slice(0, 8),
    coderA: { id: input.coderAId, name: nameById.get(input.coderAId) ?? 'coder A' },
    coderB: { id: input.coderBId, name: nameById.get(input.coderBId) ?? 'coder B' },
    result,
    codeOrigin,
  };
}
