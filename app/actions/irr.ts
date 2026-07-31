'use server';

import { createUserServerClient } from '@/lib/supabase/user-server';
import { pageAll } from '@/lib/supabase/pageAll';
import { requireAuthUser } from '@/lib/auth/supabase-auth';
import { easyDiag, type Annotation } from '@/lib/irr/easydiag';
import { timeGridKappa } from '@/lib/irr/timegrid';
import {
  sentenceGridKappa,
  enumerateSentences,
  sentencesForRange,
  type SentencePresence,
} from '@/lib/irr/sentencegrid';

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
export type IrrMethod = 'easydiag' | 'timegrid' | 'sentencegrid';

/** One overall (headline) statistic, method-agnostic for the UI. */
export type IrrHeadline = { label: string; value: string; sub: string };

/** One code's row, normalized across methods so the UI renders ONE table. */
export type IrrPerCodeView = {
  code: string;
  kappa: number | null;
  ac1: number | null;
  prevalence: number;
  /** Method-specific count summary, e.g. "12/7/1" (A/B/both) or "44 bins ✓". */
  counts: string;
  underpowered: boolean;
  /** Low κ despite high agreement + low prevalence — flag as a base-rate artifact. */
  paradox: boolean;
  /** Time-grid / sentence-grid only: the 2×2 unit cells for the worked example
   *  (n11 both-active, n10 A-only, n01 B-only, n00 both-inactive). */
  cells?: { n11: number; n10: number; n01: number; n00: number };
  /** Sentence-grid only: the overlap-relaxed κ (±1-sentence tolerance),
   *  reported beside the strict κ as a sensitivity check. */
  kappaRelaxed?: number | null;
};

export type IrrReport = {
  method: IrrMethod;
  sessionId: string;
  pidLabel: string;
  coderA: { id: string; name: string };
  coderB: { id: string; name: string };
  /** origin per code mnemonic, so the UI can partition a-priori vs emergent. */
  codeOrigin: Record<string, string>;
  headline: IrrHeadline[];
  perCode: IrrPerCodeView[];
  /** One-line note on events/bins + params. */
  note: string;
  /** EasyDIAg-only: the confusion matrix for the detail view. */
  confusion?: { categories: string[]; matrix: number[][] };
};

/**
 * Compute the IRR report for one (session, coderA, coderB).
 *
 * `method` selects the statistic:
 *  - 'easydiag' — event matching by temporal overlap, then IPF-κ (Holle & Rein);
 *    penalizes boundary jitter, so it answers "do the coders mark the same
 *    EVENTS". Controlled by `threshold`.
 *  - 'timegrid' — fixed time bins, Cohen's κ per code (Bakeman); inherits the
 *    same units for both coders, so boundary jitter is not penalized. Answers
 *    "do the coders agree bin-by-bin". Controlled by `binMs`.
 */
export async function computeIrr(input: {
  sessionId: string;
  coderAId: string;
  coderBId: string;
  method?: IrrMethod;
  threshold?: number;
  binMs?: number;
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
  // segment_id / char offsets are needed by the sentence-grid method to map an
  // annotation onto the sentence units it covers.
  const { data, error } = await pageAll((from, to) =>
    sb
      .from('cb_annotations')
      .select(
        'id, coder_id, t_start_ms, t_end_ms, segment_id, end_segment_id, char_start, char_end, version_id, cb_annotation_codes(cb_codes(mnemonic, origin))',
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
    char_start: number;
    char_end: number;
    version_id: string;
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

  const method: IrrMethod = input.method ?? 'easydiag';
  const evA = expand(input.coderAId);
  const evB = expand(input.coderBId);

  const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);
  const k2 = (x: number | null) => (x === null ? '—' : x.toFixed(2));

  let headline: IrrHeadline[];
  let perCode: IrrPerCodeView[];
  let note: string;
  let confusion: { categories: string[]; matrix: number[][] } | undefined;

  if (method === 'sentencegrid') {
    // Enumerate sentence units from the coded VERSION's segments, then map each
    // annotation to the sentences it covers. Version = the one the annotations
    // are on (both coders share it); fall back to the session's active version.
    const rows = (data ?? []) as Row[];
    const versionId = rows[0]?.version_id ?? null;
    const segRes = versionId
      ? await pageAll((from, to) =>
          sb
            .from('cb_segments')
            .select('id, ordinal, text')
            .eq('version_id', versionId)
            .order('ordinal', { ascending: true })
            .range(from, to),
        )
      : { data: [], error: null };
    if (segRes.error) throw new Error(`computeIrr (segments) failed: ${segRes.error.message}`);
    const segs = (segRes.data ?? []) as { id: string; ordinal: number; text: string }[];
    const ordinalById = new Map(segs.map((s) => [s.id, s.ordinal]));
    const { units, byOrdinal } = enumerateSentences(segs);

    const presenceFor = (coderId: string): SentencePresence[] => {
      const out: SentencePresence[] = [];
      for (const r of rows) {
        if (r.coder_id !== coderId) continue;
        const startOrd = ordinalById.get(r.segment_id);
        if (startOrd === undefined) continue;
        const endOrd = r.end_segment_id ? ordinalById.get(r.end_segment_id) ?? startOrd : startOrd;
        const sentenceIdxs = sentencesForRange(byOrdinal, startOrd, r.char_start, endOrd, r.char_end);
        const codes = (r.cb_annotation_codes ?? [])
          .map((ac) => ac.cb_codes)
          .filter((c): c is { mnemonic: string; origin: string } => c !== null);
        for (const c of codes) {
          codeOrigin[c.mnemonic] = c.origin;
          for (const sIdx of sentenceIdxs) out.push({ code: c.mnemonic, sentence: sIdx });
        }
      }
      return out;
    };

    const r = sentenceGridKappa(units.length, presenceFor(input.coderAId), presenceFor(input.coderBId), {
      minActiveSentences: input.minInstances ?? 5,
    });
    headline = [
      {
        label: 'Segmentation κ',
        value: k2(r.segmentationKappa),
        sub: `same sentences codeable · ${r.segBothActive} shared`,
      },
      { label: 'Mean per-code κ', value: k2(r.meanKappaPowered), sub: 'strict, powered codes' },
      { label: 'Sentences', value: `${units.length}`, sub: 'coding units' },
    ];
    perCode = r.perCode.map((p) => ({
      code: p.code,
      kappa: p.kappa,
      kappaRelaxed: p.kappaRelaxed,
      ac1: p.ac1,
      prevalence: p.prevalence,
      counts: `${p.bothActive + p.aOnly}/${p.bothActive + p.bOnly}/${p.bothActive}`,
      underpowered: p.underpowered,
      paradox:
        p.kappa !== null && p.ac1 !== null && p.kappa < 0.4 && p.ac1 > 0.85 && p.prevalence < 0.15,
      cells: { n11: p.bothActive, n10: p.aOnly, n01: p.bOnly, n00: p.inactive },
    }));
    note = `${units.length} sentence units · ${presenceFor(input.coderAId).length} A / ${presenceFor(input.coderBId).length} B sentence-code marks · strict primary, relaxed (±1) secondary`;
  } else if (method === 'timegrid') {
    const binMs = input.binMs ?? 2000;
    const r = timeGridKappa(evA, evB, { binMs, minActiveBins: input.minInstances ?? 5 });
    headline = [
      {
        label: 'Segmentation κ',
        value: k2(r.segmentationKappa),
        sub: `any-code-active · ${r.segBothActive} shared bins`,
      },
      {
        label: 'Mean per-code κ',
        value: k2(r.meanKappaPowered),
        sub: 'powered codes only',
      },
      {
        label: 'Grid',
        value: `${r.nBins}`,
        sub: `bins of ${binMs / 1000}s`,
      },
    ];
    perCode = r.perCode.map((p) => ({
      code: p.code,
      kappa: p.kappa,
      ac1: p.ac1,
      prevalence: p.prevalence,
      counts: `${p.bothActive + p.aOnly}/${p.bothActive + p.bOnly}/${p.bothActive}`,
      underpowered: p.underpowered,
      paradox:
        p.kappa !== null && p.ac1 !== null && p.kappa < 0.4 && p.ac1 > 0.85 && p.prevalence < 0.15,
      cells: { n11: p.bothActive, n10: p.aOnly, n01: p.bOnly, n00: p.inactive },
    }));
    note = `${evA.length} events / ${evB.length} events · ${r.nBins} bins of ${binMs / 1000}s · one-sided time A ${r.segAOnly} vs B ${r.segBOnly} bins`;
  } else {
    const r = easyDiag(evA, evB, {
      threshold: input.threshold ?? 0.6,
      minInstances: input.minInstances ?? 10,
    });
    headline = [
      { label: 'Overall κ', value: k2(r.overallKappa), sub: 'IPF-corrected, incl. Void' },
      {
        label: 'Segmentation agreement',
        value: pct(r.segmentationAgreement),
        sub: `${r.nLinked} linked · ${r.nUnmatchedA}+${r.nUnmatchedB} unmatched`,
      },
      {
        label: 'Categorization agreement',
        value: pct(r.categorizationAgreement),
        sub: 'of linked pairs, same code',
      },
    ];
    perCode = r.perCode.map((p) => ({
      code: p.code,
      kappa: p.kappa,
      ac1: p.ac1,
      prevalence: p.prevalence,
      counts: `${p.byCoderA}/${p.byCoderB}/${p.linkedBoth}`,
      underpowered: p.underpowered,
      paradox:
        p.kappa !== null && p.rawAgreement !== null && p.kappa < 0.4 && p.rawAgreement > 0.8,
    }));
    note = `overlap link ≥ ${Math.round(r.threshold * 100)}% · ${r.nEventsA} events / ${r.nEventsB} events · ${r.nLinked} linked`;
    // Only show categories that appear, so the matrix is readable.
    const seen = r.categories
      .map((c, i) => ({ c, i }))
      .filter(({ i }) => r.confusion[i].some((v) => v > 0) || r.confusion.some((row) => row[i] > 0));
    confusion = {
      categories: seen.map(({ c }) => c),
      matrix: seen.map(({ i }) => seen.map(({ i: j }) => r.confusion[i][j])),
    };
  }

  const [{ data: sessRow }, { data: profRows }] = await Promise.all([
    sb.from('cb_sessions').select('pid_label').eq('id', input.sessionId).maybeSingle(),
    sb
      .from('cb_profiles')
      .select('user_id, display_name')
      .in('user_id', [input.coderAId, input.coderBId]),
  ]);
  const nameById = new Map((profRows ?? []).map((p) => [p.user_id, p.display_name ?? 'coder']));

  return {
    method,
    sessionId: input.sessionId,
    pidLabel: sessRow?.pid_label ?? input.sessionId.slice(0, 8),
    coderA: { id: input.coderAId, name: nameById.get(input.coderAId) ?? 'coder A' },
    coderB: { id: input.coderBId, name: nameById.get(input.coderBId) ?? 'coder B' },
    codeOrigin,
    headline,
    perCode,
    note,
    confusion,
  };
}
