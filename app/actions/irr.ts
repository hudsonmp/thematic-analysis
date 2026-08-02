'use server';

import { createUserServerClient } from '@/lib/supabase/user-server';
import { pageAll } from '@/lib/supabase/pageAll';
import { requireAuthUser } from '@/lib/auth/supabase-auth';
import { sentenceGridKappa, type SentencePresence } from '@/lib/irr/sentencegrid';
import { codeCooccurrence, mergeCandidates, type UnitCode } from '@/lib/irr/cooccurrence';

/**
 * IRR + code co-occurrence — READ-ONLY. Loads two coders' code annotations for a
 * session and computes, per David Smith's Tuesday method:
 *
 *  1. SENTENCE-LEVEL AGREEMENT. The coding unit is the SEGMENT — on the
 *     sentence-restored version each segment is exactly one sentence, so this is
 *     agreement "at the sentence level", which David standardized on. Per code we
 *     report strict Cohen's κ AND an overlap-relaxed κ (±1 adjacent unit counts as
 *     agreement — David: "if someone highlights one sentence and someone the next,
 *     that is agreement"). IRR here is a DIAGNOSTIC for systematic disagreement, not
 *     a headline number to report.
 *  2. CODE × CODE CO-OCCURRENCE heat map (codeCooccurrence): highly correlated codes
 *     with weak agreement are merge candidates.
 *
 * There is ONE method now (the EasyDIAg / time-grid apparatus was removed — David
 * asked for sentence-level agreement + the heat map, nothing more). Never writes;
 * never touches the coding surface.
 */

export type CoderOption = { id: string; name: string; nCode: number };

export type IrrSessionOption = {
  sessionId: string;
  pidLabel: string;
  coders: CoderOption[];
};

/** Mnemonics of combinatorial codes (codes owning ≥1 AND item) — used for the
 *  decomposition-rate descriptives and the audit sample. */
async function combinatorialMnemonics(
  sb: Awaited<ReturnType<typeof createUserServerClient>>,
): Promise<Set<string>> {
  const res = await sb.from('cb_code_bucket_items').select('cb_codes!cb_code_bucket_items_code_id_fkey(mnemonic)');
  if (res.error) return new Set(); // descriptive only — never fail the report on it
  const out = new Set<string>();
  for (const r of (res.data ?? []) as unknown as { cb_codes: { mnemonic: string } | null }[]) {
    if (r.cb_codes?.mnemonic) out.add(r.cb_codes.mnemonic);
  }
  return out;
}

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

export type IrrReport = {
  sessionId: string;
  pidLabel: string;
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
  /** v2: >0 blocks IRR — pendings must resolve before cross-coder contact. */
  pendingCount: number;
  /** v2: the single snapshot the assignments share, else null. */
  snapshotId: string | null;
  /** v2: why snapshotId is null (straddling / pre-snapshot data). */
  snapshotNote: string | null;
  /** v2 descriptive: decomposition rate per (coder, code). */
  decomposition: { coder: string; code: string; decomposed: number; total: number }[];
  /** v2: deterministic ~15% audit sample to fully decompose. */
  auditSample: { annotationId: string; code: string; coder: string }[];
};

/**
 * Compute the IRR + co-occurrence report for one (session, coderA, coderB).
 *
 * `codeFilter` (optional) restricts BOTH the per-code table and the heat map to the
 * given mnemonics — "let me select only certain codes for thematic analysis".
 * `windowStartMs/EndMs` restrict to annotations whose onset falls in the window
 * (matched-effort: a coder who tapered off late did not disagree in the tail).
 */
export async function computeIrr(input: {
  sessionId: string;
  coderAId: string;
  coderBId: string;
  minInstances?: number;
  windowStartMs?: number | null;
  windowEndMs?: number | null;
  codeFilter?: string[] | null;
}): Promise<IrrReport> {
  await requireAuthUser();
  const sb = await createUserServerClient();

  const { data, error } = await pageAll((from, to) =>
    sb
      .from('cb_annotations')
      .select(
        'id, coder_id, t_start_ms, t_end_ms, segment_id, end_segment_id, version_id, cb_annotation_codes(status, snapshot_id, cb_codes(mnemonic, origin))',
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
    segment_id: string;
    end_segment_id: string | null;
    version_id: string;
    cb_annotation_codes:
      | {
          status: string | null;
          snapshot_id: string | null;
          cb_codes: { mnemonic: string; origin: string } | null;
        }[]
      | null;
  };
  const allRows = (data ?? []) as Row[];

  // v2 GATE: pending assignments are NOT assignments — the coder has not yet
  // asserted. IRR is blocked until every pending on this session resolves
  // (all pendings resolve before any cross-coder contact).
  const pendingCount = allRows.reduce(
    (n, r) => n + (r.cb_annotation_codes ?? []).filter((ac) => ac.status === 'pending').length,
    0,
  );

  // v2 SNAPSHOT SCOPE: IRR is computed within a single snapshot and reported
  // with its ID. Mixed/absent snapshot ids ⇒ calibration, not IRR.
  const snapshotIds = new Set<string>();
  let unsnapshotted = 0;
  for (const r of allRows) {
    for (const ac of r.cb_annotation_codes ?? []) {
      if (ac.status === 'pending') continue;
      if (ac.snapshot_id) snapshotIds.add(ac.snapshot_id);
      else unsnapshotted++;
    }
  }
  const snapshotId = snapshotIds.size === 1 && unsnapshotted === 0 ? [...snapshotIds][0] : null;
  const snapshotNote =
    snapshotIds.size > 1
      ? 'assignments straddle snapshots — calibration, not IRR'
      : unsnapshotted > 0
        ? 'assignments predate snapshotting — calibration reading'
        : null;

  // Both coders must be scored on the SAME version so their segment ordinals align.
  // Pick the modal version among the two coders' annotations; drop rows on others.
  const verCount = new Map<string, number>();
  for (const r of allRows) verCount.set(r.version_id, (verCount.get(r.version_id) ?? 0) + 1);
  const versionId = [...verCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const droppedOtherVersion = allRows.filter((r) => r.version_id !== versionId).length;
  const rows = allRows.filter((r) => r.version_id === versionId);

  // Segments of the coded version → dense unit indices in reading (ordinal) order.
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
  if (segRes.error) throw new Error(`computeIrr (segments) failed: ${segRes.error.message}`);
  const segs = (segRes.data ?? []) as { id: string; ordinal: number }[];
  const unitIndexById = new Map(segs.map((s, i) => [s.id, i]));
  const nUnits = segs.length;

  const lo = input.windowStartMs ?? null;
  const hi = input.windowEndMs ?? null;
  const allow = input.codeFilter && input.codeFilter.length ? new Set(input.codeFilter) : null;
  const codeOrigin: Record<string, string> = {};
  const allCodesSet = new Set<string>();

  /** Units [start..end] an annotation covers (segment span in dense index space). */
  const unitsOf = (r: Row): number[] => {
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
      // v2: agreement = same parent code on same segment, REGARDLESS of
      // decomposition path or attested/decomposed status — but a pending row
      // is not an assignment and is excluded.
      const codes = (r.cb_annotation_codes ?? [])
        .filter((ac) => ac.status !== 'pending')
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

  // v2 DESCRIPTIVES: decomposition rate per code per coder + the ~15% audit
  // sample of combinatorial assignments to fully decompose (deterministic:
  // sorted by annotation id, every 7th — reproducible without a stored seed).
  const comboCodes = await combinatorialMnemonics(sb);
  const decompCount = new Map<string, { decomposed: number; total: number }>();
  const auditPool: { annotationId: string; code: string; coder: string }[] = [];
  for (const r of rows) {
    for (const ac of r.cb_annotation_codes ?? []) {
      if (ac.status === 'pending' || !ac.cb_codes) continue;
      const key = `${r.coder_id}|${ac.cb_codes.mnemonic}`;
      const cur = decompCount.get(key) ?? { decomposed: 0, total: 0 };
      cur.total++;
      if (ac.status === 'decomposed') cur.decomposed++;
      decompCount.set(key, cur);
      if (comboCodes.has(ac.cb_codes.mnemonic) && ac.status !== 'decomposed') {
        auditPool.push({ annotationId: r.id, code: ac.cb_codes.mnemonic, coder: r.coder_id });
      }
    }
  }
  auditPool.sort((a, b) => a.annotationId.localeCompare(b.annotationId));
  const auditSample = auditPool.filter((_, i) => i % 7 === 0);

  const presA = presenceFor(input.coderAId);
  const presB = presenceFor(input.coderBId);

  const grid = sentenceGridKappa(nUnits, presA, presB, {
    minActiveSentences: input.minInstances ?? 3,
  });

  // Pooled per-unit code presence (union across coders) for co-occurrence.
  const pooled: UnitCode[] = [...presA, ...presB].map((p) => ({ unit: p.sentence, code: p.code }));
  const co = codeCooccurrence(nUnits, pooled, { codeFilter: input.codeFilter ?? null });
  const kappaByCode: Record<string, number | null> = {};
  for (const p of grid.perCode) kappaByCode[p.code] = p.kappa;
  const merges = mergeCandidates(co, kappaByCode, { corrThreshold: 0.5, kappaThreshold: 0.6 });

  const k2 = (x: number | null) => (x === null ? '—' : x.toFixed(2));

  const headline: IrrHeadline[] = [
    {
      label: 'Segmentation κ',
      value: k2(grid.segmentationKappa),
      sub: `agree which units are codeable · ${grid.segBothActive} shared`,
    },
    { label: 'Mean per-code κ', value: k2(grid.meanKappaPowered), sub: 'strict, powered codes (diagnostic)' },
    { label: 'Units', value: `${nUnits}`, sub: 'sentence-level coding units' },
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

  const [{ data: sessRow }, { data: profRows }] = await Promise.all([
    sb.from('cb_sessions').select('pid_label').eq('id', input.sessionId).maybeSingle(),
    sb
      .from('cb_profiles')
      .select('user_id, display_name')
      .in('user_id', [input.coderAId, input.coderBId]),
  ]);
  const nameById = new Map((profRows ?? []).map((p) => [p.user_id, p.display_name ?? 'coder']));

  const note =
    `${nUnits} sentence units · ${presA.length} A / ${presB.length} B unit-code marks · ` +
    `strict κ primary, overlap-relaxed (±1) secondary` +
    (droppedOtherVersion ? ` · ${droppedOtherVersion} annotation(s) on another version excluded` : '');

  const decomposition = [...decompCount.entries()].map(([key, v]) => {
    const [coder, code] = key.split('|');
    return { coder: nameById.get(coder) ?? coder.slice(0, 8), code, ...v };
  });

  return {
    sessionId: input.sessionId,
    pidLabel: sessRow?.pid_label ?? input.sessionId.slice(0, 8),
    coderA: { id: input.coderAId, name: nameById.get(input.coderAId) ?? 'coder A' },
    coderB: { id: input.coderBId, name: nameById.get(input.coderBId) ?? 'coder B' },
    codeOrigin,
    allCodes: [...allCodesSet].sort(),
    headline,
    perCode,
    cooccurrence: { ...co, origin: codeOrigin, mergeCandidates: merges },
    note,
    pendingCount,
    snapshotId,
    snapshotNote,
    decomposition,
    auditSample: auditSample.map((a) => ({
      ...a,
      coder: nameById.get(a.coder) ?? a.coder.slice(0, 8),
    })),
  };
}
