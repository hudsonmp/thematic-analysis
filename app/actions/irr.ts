'use server';

import { createUserServerClient } from '@/lib/supabase/user-server';
import { pageAll } from '@/lib/supabase/pageAll';
import { requireAuthUser } from '@/lib/auth/supabase-auth';
import {
  sentenceGridKappa,
  poolSentenceGrids,
  type SentencePresence,
  type SentenceGridResult,
} from '@/lib/irr/sentencegrid';
import { codeCooccurrence, mergeCandidates, type UnitCode } from '@/lib/irr/cooccurrence';
import { IRR_TARGET_KAPPA } from '@/lib/irr/target';

/**
 * IRR + code co-occurrence — READ-ONLY. Computes two coders' agreement POOLED
 * over a set of sessions, per the Aug 4 method (Zihan/David/Moonwara meeting;
 * precedent map in 08-04-2026-irr-reconciliation-precedent.html):
 *
 *  1. SENTENCE-LEVEL κ, POOLED. The coding unit is the SEGMENT — one sentence
 *     per segment on the restored version. Per code: strict Cohen's κ AND an
 *     overlap-relaxed κ (±1 adjacent unit counts as agreement — David: "if
 *     someone highlights one sentence and someone the next, that is
 *     agreement"). κ is computed ONCE over all selected sessions by summing
 *     per-session contingency tables (poolSentenceGrids) — "compute IRR on
 *     those three" (plan A), not a mean of per-session κs. The preregistered
 *     target is κ ≥ 0.70 (meeting decision; McDonald et al. 2019 §5.3.5:
 *     state the target before the analysis).
 *  2. POOL DISCIPLINE. A session enters the pool only if BOTH coders have code
 *     annotations on its modal version — an uncoded session would score one
 *     coder's silence as disagreement. Which sessions are calibration
 *     (reconciled) vs independent is a METHODS disclosure the UI collects;
 *     the computation is identical (Zihan's pooled variant B).
 *  3. CODE × CODE CO-OCCURRENCE heat map over the pooled units: highly
 *     correlated codes with weak agreement are merge candidates.
 *
 * Never writes; never touches the coding surface.
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

/** One overall (headline) statistic. */
export type IrrHeadline = { label: string; value: string; sub: string };

/** One code's agreement row. Unit = segment (= sentence on the restored version). */
export type IrrPerCodeView = {
  code: string;
  origin: string;
  /** Strict per-unit Cohen's κ. */
  kappa: number | null;
  /** Overlap-relaxed κ (±1 adjacent unit = agreement) — David's overlap rule. */
  kappaRelaxed: number | null;
  prevalence: number;
  /** "A/B/both" unit counts. */
  counts: string;
  underpowered: boolean;
};

/** The code × code co-occurrence heat map payload. */
export type CooccurrenceView = {
  codes: string[];
  matrix: (number | null)[][];
  counts: number[][];
  unitCount: number[];
  nUnits: number;
  origin: Record<string, string>;
  mergeCandidates: { a: string; b: string; corr: number; jointUnits: number; weakKappa: number | null }[];
};

/** One session's status in the κ pool. */
export type IrrPoolSession = {
  sessionId: string;
  pidLabel: string;
  nUnits: number;
  included: boolean;
  /** Why an excluded session was excluded (null when included). */
  reason: string | null;
};

/** The decision read-out against the preregistered target. */
export type IrrDecision = {
  /** Mean strict per-code κ over powered codes — the decision statistic. */
  meanKappa: number | null;
  /** The preregistered target (κ ≥ this licenses solo-coding the remainder). */
  target: number;
  poweredAtTarget: number;
  poweredTotal: number;
};

export type IrrReport = {
  /** Every requested session, in request order, with inclusion status. */
  pool: IrrPoolSession[];
  decision: IrrDecision;
  coderA: { id: string; name: string };
  coderB: { id: string; name: string };
  /** origin per code mnemonic, so the UI can partition a-priori vs emergent. */
  codeOrigin: Record<string, string>;
  /** Every code mnemonic seen (for the code-subset selector). */
  allCodes: string[];
  headline: IrrHeadline[];
  perCode: IrrPerCodeView[];
  cooccurrence: CooccurrenceView;
  note: string;
};

type AnnRow = {
  id: string;
  coder_id: string;
  t_start_ms: number;
  t_end_ms: number;
  segment_id: string;
  end_segment_id: string | null;
  version_id: string;
  cb_annotation_codes: { cb_codes: { mnemonic: string; origin: string } | null }[] | null;
};

/**
 * Compute the pooled IRR + co-occurrence report for (sessions[], coderA, coderB).
 *
 * `codeFilter` (optional) restricts BOTH the per-code table and the heat map to the
 * given mnemonics — "let me select only certain codes for thematic analysis".
 * `windowStartMs/EndMs` restrict to annotations whose onset falls in the window,
 * applied per session (matched-effort: a coder who tapered off late did not
 * disagree in the tail).
 */
export async function computeIrr(input: {
  sessionIds: string[];
  coderAId: string;
  coderBId: string;
  minInstances?: number;
  windowStartMs?: number | null;
  windowEndMs?: number | null;
  codeFilter?: string[] | null;
}): Promise<IrrReport> {
  await requireAuthUser();
  const sb = await createUserServerClient();
  if (input.sessionIds.length === 0) throw new Error('computeIrr: no sessions selected');

  const lo = input.windowStartMs ?? null;
  const hi = input.windowEndMs ?? null;
  const allow = input.codeFilter && input.codeFilter.length ? new Set(input.codeFilter) : null;
  const minInstances = input.minInstances ?? 3;
  const codeOrigin: Record<string, string> = {};
  const allCodesSet = new Set<string>();

  const pool: IrrPoolSession[] = [];
  const grids: SentenceGridResult[] = [];
  const pooledUnits: UnitCode[] = [];
  let unitOffset = 0;
  let droppedOtherVersion = 0;

  const { data: sessRows } = await sb
    .from('cb_sessions')
    .select('id, pid_label')
    .in('id', input.sessionIds);
  const pidById = new Map((sessRows ?? []).map((s) => [s.id, s.pid_label]));

  for (const sessionId of input.sessionIds) {
    const pidLabel = pidById.get(sessionId) ?? sessionId.slice(0, 8);
    const { data, error } = await pageAll((from, to) =>
      sb
        .from('cb_annotations')
        .select(
          'id, coder_id, t_start_ms, t_end_ms, segment_id, end_segment_id, version_id, cb_annotation_codes(cb_codes(mnemonic, origin))',
        )
        .eq('session_id', sessionId)
        .eq('kind', 'code')
        .in('coder_id', [input.coderAId, input.coderBId])
        .order('id', { ascending: true })
        .range(from, to),
    );
    if (error) throw new Error(`computeIrr failed on ${pidLabel}: ${error.message}`);
    const allRows = (data ?? []) as AnnRow[];

    // Both coders must be scored on the SAME version so segment ordinals align.
    // Pick the modal version among the two coders' annotations; drop the rest.
    const verCount = new Map<string, number>();
    for (const r of allRows) verCount.set(r.version_id, (verCount.get(r.version_id) ?? 0) + 1);
    const versionId = [...verCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    droppedOtherVersion += allRows.filter((r) => r.version_id !== versionId).length;
    const rows = allRows.filter((r) => r.version_id === versionId);

    // POOL DISCIPLINE: both coders must have coded this session, else their
    // non-coding would be scored as disagreement with everything the other
    // coder marked. Excluded, disclosed — never silently absorbed.
    const aCoded = rows.some((r) => r.coder_id === input.coderAId);
    const bCoded = rows.some((r) => r.coder_id === input.coderBId);
    if (!aCoded || !bCoded) {
      pool.push({
        sessionId,
        pidLabel,
        nUnits: 0,
        included: false,
        reason: `${!aCoded ? 'coder A' : 'coder B'} has no code annotations here`,
      });
      continue;
    }

    const segRes = versionId
      ? await pageAll((from, to) =>
          sb
            .from('cb_segments')
            .select('id, ordinal')
            .eq('version_id', versionId)
            .order('ordinal', { ascending: true })
            .range(from, to),
        )
      : { data: [], error: null };
    if (segRes.error) throw new Error(`computeIrr (segments, ${pidLabel}) failed: ${segRes.error.message}`);
    const segs = (segRes.data ?? []) as { id: string; ordinal: number }[];
    const unitIndexById = new Map(segs.map((s, i) => [s.id, i]));
    const nUnits = segs.length;

    /** Units [start..end] an annotation covers (segment span in dense index space). */
    const unitsOf = (r: AnnRow): number[] => {
      const si = unitIndexById.get(r.segment_id);
      if (si === undefined) return [];
      const eiRaw = r.end_segment_id ? unitIndexById.get(r.end_segment_id) : si;
      const ei = eiRaw === undefined ? si : eiRaw;
      const a = Math.min(si, ei);
      const b = Math.max(si, ei);
      const out: number[] = [];
      for (let u = a; u <= b; u++) out.push(u);
      return out;
    };

    const presenceFor = (coderId: string): SentencePresence[] => {
      const out: SentencePresence[] = [];
      for (const r of rows) {
        if (r.coder_id !== coderId) continue;
        if (lo !== null && r.t_start_ms < lo) continue;
        if (hi !== null && r.t_start_ms > hi) continue;
        const units = unitsOf(r);
        if (!units.length) continue;
        const codes = (r.cb_annotation_codes ?? [])
          .map((ac) => ac.cb_codes)
          .filter((c): c is { mnemonic: string; origin: string } => c !== null);
        for (const c of codes) {
          codeOrigin[c.mnemonic] = c.origin;
          allCodesSet.add(c.mnemonic);
          if (allow && !allow.has(c.mnemonic)) continue;
          for (const u of units) out.push({ code: c.mnemonic, sentence: u });
        }
      }
      return out;
    };

    const presA = presenceFor(input.coderAId);
    const presB = presenceFor(input.coderBId);

    // Per-session grid (±1 dilation stays INSIDE the session); κ is computed
    // from the summed tables after the loop. minActiveSentences=0 here — the
    // powered/underpowered call belongs to the POOLED counts, not any one
    // session's.
    grids.push(sentenceGridKappa(nUnits, presA, presB, { minActiveSentences: 0 }));

    for (const p of [...presA, ...presB]) {
      pooledUnits.push({ unit: unitOffset + p.sentence, code: p.code });
    }
    pool.push({ sessionId, pidLabel, nUnits, included: true, reason: null });
    unitOffset += nUnits;
  }

  if (grids.length === 0) {
    throw new Error(
      'No selected session has code annotations from BOTH coders — nothing to pool.',
    );
  }

  const grid = poolSentenceGrids(grids, { minActiveSentences: minInstances });
  const nUnits = grid.nSentences;

  const co = codeCooccurrence(nUnits, pooledUnits, { codeFilter: input.codeFilter ?? null });
  const kappaByCode: Record<string, number | null> = {};
  for (const p of grid.perCode) kappaByCode[p.code] = p.kappa;
  const merges = mergeCandidates(co, kappaByCode, { corrThreshold: 0.5, kappaThreshold: 0.6 });

  const k2 = (x: number | null) => (x === null ? '—' : x.toFixed(2));
  const included = pool.filter((p) => p.included);
  const powered = grid.perCode.filter((p) => !p.underpowered && p.kappa !== null);
  const poweredAtTarget = powered.filter((p) => (p.kappa ?? 0) >= IRR_TARGET_KAPPA).length;

  const headline: IrrHeadline[] = [
    {
      label: 'Mean per-code κ',
      value: k2(grid.meanKappaPowered),
      sub: `target ≥ ${IRR_TARGET_KAPPA.toFixed(2)} (preregistered) · ${poweredAtTarget}/${powered.length} powered codes clear it`,
    },
    {
      label: 'Segmentation κ',
      value: k2(grid.segmentationKappa),
      sub: `agree which units are codeable · ${grid.segBothActive} shared`,
    },
    {
      label: 'Units',
      value: `${nUnits}`,
      sub: `sentence units pooled over ${included.length} session${included.length === 1 ? '' : 's'}`,
    },
  ];

  const perCode: IrrPerCodeView[] = grid.perCode.map((p) => ({
    code: p.code,
    origin: codeOrigin[p.code] ?? 'apriori',
    kappa: p.kappa,
    kappaRelaxed: p.kappaRelaxed,
    prevalence: p.prevalence,
    counts: `${p.bothActive + p.aOnly}/${p.bothActive + p.bOnly}/${p.bothActive}`,
    underpowered: p.underpowered,
  }));

  const { data: profRows } = await sb
    .from('cb_profiles')
    .select('user_id, display_name')
    .in('user_id', [input.coderAId, input.coderBId]);
  const nameById = new Map((profRows ?? []).map((p) => [p.user_id, p.display_name ?? 'coder']));

  const excluded = pool.filter((p) => !p.included);
  const note =
    `pool: ${included.map((p) => p.pidLabel).join(' + ') || 'none'} · ${nUnits} sentence units · ` +
    `one κ from summed contingency tables (not a mean of per-session κs) · strict κ decides, relaxed (±1) is a sensitivity check` +
    (excluded.length
      ? ` · excluded: ${excluded.map((p) => `${p.pidLabel} (${p.reason})`).join('; ')}`
      : '') +
    (droppedOtherVersion ? ` · ${droppedOtherVersion} annotation(s) on another version excluded` : '');

  return {
    pool,
    decision: {
      meanKappa: grid.meanKappaPowered,
      target: IRR_TARGET_KAPPA,
      poweredAtTarget,
      poweredTotal: powered.length,
    },
    coderA: { id: input.coderAId, name: nameById.get(input.coderAId) ?? 'coder A' },
    coderB: { id: input.coderBId, name: nameById.get(input.coderBId) ?? 'coder B' },
    codeOrigin,
    allCodes: [...allCodesSet].sort(),
    headline,
    perCode,
    cooccurrence: { ...co, origin: codeOrigin, mergeCandidates: merges },
    note,
  };
}
