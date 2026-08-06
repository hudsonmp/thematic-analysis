#!/usr/bin/env node
/**
 * irr-independent — κ computed FROM SCRATCH, deliberately importing NOTHING
 * from lib/irr, as an independent cross-check of the app's engine.
 *
 * Unit = segment of the modal coded version (one sentence per segment on
 * restored versions). Per code: binary presence per coder per unit; Cohen's κ
 * from the 2×2 by the textbook formula. Also: segmentation κ (any-code),
 * relaxed κ (±1 unit, dilation within session only), matched-effort window
 * (min over coders of their max annotation onset), pooled κ by summing cells
 * across sessions, and the confusion-pair table (co-located units where the
 * coders applied different codes).
 *
 * READ-ONLY. Prints a report; writes nothing.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
function loadEnv() {
  const p = join(root, '.env.local');
  if (!existsSync(p)) throw new Error('.env.local not found');
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
loadEnv();
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function pageAll(build) {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(error.message);
    all.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return all;
}

// ---------- κ from first principles ----------
function kappa2x2(n11, n10, n01, n00) {
  const n = n11 + n10 + n01 + n00;
  if (n === 0) return null;
  const po = (n11 + n00) / n;
  const pA = (n11 + n10) / n; // coder A marks
  const pB = (n11 + n01) / n; // coder B marks
  const pe = pA * pB + (1 - pA) * (1 - pB);
  if (Math.abs(1 - pe) < 1e-12) return null; // no variance → undefined
  return (po - pe) / (1 - pe);
}

function cells(aSet, bSet, N) {
  let n11 = 0, n10 = 0, n01 = 0, n00 = 0;
  for (let u = 0; u < N; u++) {
    const a = aSet.has(u);
    const b = bSet.has(u);
    if (a && b) n11++;
    else if (a) n10++;
    else if (b) n01++;
    else n00++;
  }
  return { n11, n10, n01, n00 };
}

function dilate(set, N) {
  const out = new Set();
  for (const s of set) {
    if (s > 0) out.add(s - 1);
    out.add(s);
    if (s + 1 < N) out.add(s + 1);
  }
  return out;
}

// relaxed cells: one-sided cell upgraded iff other coder has the code within ±1
function relaxedCells(aSet, bSet, N) {
  const aD = dilate(aSet, N);
  const bD = dilate(bSet, N);
  let n11 = 0, n10 = 0, n01 = 0, n00 = 0;
  for (let u = 0; u < N; u++) {
    const a = aSet.has(u);
    const b = bSet.has(u);
    if (a && b) n11++;
    else if (a) (bD.has(u) ? n11++ : n10++);
    else if (b) (aD.has(u) ? n11++ : n01++);
    else n00++;
  }
  return { n11, n10, n01, n00 };
}

const f2 = (x) => (x === null ? '  — ' : x.toFixed(2));

// ---------- data ----------
async function main() {
  const sessions = await pageAll((a, b) =>
    sb.from('cb_sessions').select('id, pid_label').range(a, b),
  );
  const targets = ['548', '083', '353']
    .map((p) => sessions.find((s) => String(s.pid_label).includes(p)))
    .filter(Boolean);
  console.log('sessions:', targets.map((t) => t.pid_label).join(', '));

  // Two most prolific code-annotators overall.
  const annAll = await pageAll((a, b) =>
    sb.from('cb_annotations').select('coder_id, kind').eq('kind', 'code').range(a, b),
  );
  const byCoder = new Map();
  for (const r of annAll) byCoder.set(r.coder_id, (byCoder.get(r.coder_id) ?? 0) + 1);
  const [cA, cB] = [...byCoder.entries()].sort((x, y) => y[1] - x[1]).slice(0, 2);
  const { data: profs } = await sb
    .from('cb_profiles')
    .select('user_id, display_name')
    .in('user_id', [cA[0], cB[0]]);
  const nameOf = (id) => profs?.find((p) => p.user_id === id)?.display_name ?? id.slice(0, 8);
  const A = cA[0], B = cB[0];
  console.log(`coder A = ${nameOf(A)} (${cA[1]} anns) · coder B = ${nameOf(B)} (${cB[1]} anns)\n`);

  const perSession = []; // {pid, N, byCodeCells:{code:{strict,relaxed}}, seg cells, meta}
  const confusions = new Map(); // "x ↔ y" -> count
  let exactUnits = 0, partialUnits = 0, coUnits = 0;

  for (const s of targets) {
    const rows = await pageAll((a, b) =>
      sb
        .from('cb_annotations')
        .select('coder_id, t_start_ms, segment_id, end_segment_id, version_id, cb_annotation_codes(cb_codes(mnemonic))')
        .eq('session_id', s.id)
        .eq('kind', 'code')
        .in('coder_id', [A, B])
        .range(a, b),
    );
    // modal version
    const vc = new Map();
    for (const r of rows) vc.set(r.version_id, (vc.get(r.version_id) ?? 0) + 1);
    const versionId = [...vc.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
    const offVersion = rows.filter((r) => r.version_id !== versionId).length;
    const use = rows.filter((r) => r.version_id === versionId);

    const segs = await pageAll((a, b) =>
      sb
        .from('cb_segments')
        .select('id, ordinal')
        .eq('version_id', versionId)
        .order('ordinal', { ascending: true })
        .range(a, b),
    );
    const idx = new Map(segs.map((x, i) => [x.id, i]));
    const N = segs.length;

    // matched-effort window: min over coders of their max onset
    const maxOn = (cid) => Math.max(...use.filter((r) => r.coder_id === cid).map((r) => r.t_start_ms), -1);
    const win = Math.min(maxOn(A), maxOn(B));
    const inWin = use.filter((r) => r.t_start_ms <= win);
    const cut = { [A]: 0, [B]: 0 };
    for (const r of use) if (r.t_start_ms > win) cut[r.coder_id]++;

    // presence: code -> Set(units), per coder; and per-unit code sets for confusions
    const build = (rowsIn) => {
      const pres = { [A]: new Map(), [B]: new Map() };
      const unitCodes = { [A]: new Map(), [B]: new Map() };
      for (const r of rowsIn) {
        const si = idx.get(r.segment_id);
        if (si === undefined) continue;
        const eiRaw = r.end_segment_id ? idx.get(r.end_segment_id) : si;
        const ei = eiRaw === undefined ? si : eiRaw;
        const codes = (r.cb_annotation_codes ?? []).map((x) => x.cb_codes?.mnemonic).filter(Boolean);
        for (let u = Math.min(si, ei); u <= Math.max(si, ei); u++) {
          for (const c of codes) {
            let set = pres[r.coder_id].get(c);
            if (!set) pres[r.coder_id].set(c, (set = new Set()));
            set.add(u);
            let uc = unitCodes[r.coder_id].get(u);
            if (!uc) unitCodes[r.coder_id].set(u, (uc = new Set()));
            uc.add(c);
          }
        }
      }
      return { pres, unitCodes };
    };

    const W = build(inWin);
    const F = build(use);

    // per-code cells (windowed = the honest read)
    const codes = [...new Set([...W.pres[A].keys(), ...W.pres[B].keys()])];
    const byCode = new Map();
    for (const c of codes) {
      const a = W.pres[A].get(c) ?? new Set();
      const b = W.pres[B].get(c) ?? new Set();
      byCode.set(c, { strict: cells(a, b, N), relaxed: relaxedCells(a, b, N) });
    }
    // segmentation (any-code)
    const anySet = (m) => {
      const out = new Set();
      for (const s2 of m.values()) for (const u of s2) out.add(u);
      return out;
    };
    const segCellsW = cells(anySet(W.pres[A]), anySet(W.pres[B]), N);
    const segCellsF = cells(anySet(F.pres[A]), anySet(F.pres[B]), N);

    // confusions + co-location categorization (windowed)
    let ex = 0, pa = 0, co = 0;
    for (const [u, ac] of W.unitCodes[A]) {
      const bc = W.unitCodes[B].get(u);
      if (!bc) continue;
      co++;
      const same = ac.size === bc.size && [...ac].every((c) => bc.has(c));
      if (same) ex++;
      else {
        pa++;
        for (const x of ac) if (!bc.has(x))
          for (const y of bc) if (!ac.has(y)) {
            const key = [x, y].sort().join(' ↔ ');
            confusions.set(key, (confusions.get(key) ?? 0) + 1);
          }
      }
    }
    exactUnits += ex; partialUnits += pa; coUnits += co;

    perSession.push({
      pid: s.pid_label, N, byCode, segCellsW, segCellsF,
      win, cutA: cut[A], cutB: cut[B], offVersion,
      nA: use.filter((r) => r.coder_id === A).length,
      nB: use.filter((r) => r.coder_id === B).length,
      coUnits: co, exactUnits: ex,
    });
  }

  // ---------- report ----------
  for (const s of perSession) {
    console.log(`── ${s.pid} ─ ${s.N} units · A ${s.nA} anns / B ${s.nB} anns · window ≤ ${(s.win / 60000).toFixed(1)} min (cut A ${s.cutA} / B ${s.cutB})${s.offVersion ? ` · ${s.offVersion} off-version` : ''}`);
    console.log(`   segmentation κ  windowed ${f2(kappa2x2(s.segCellsW.n11, s.segCellsW.n10, s.segCellsW.n01, s.segCellsW.n00))}   full ${f2(kappa2x2(s.segCellsF.n11, s.segCellsF.n10, s.segCellsF.n01, s.segCellsF.n00))}`);
    const rowsK = [...s.byCode.entries()]
      .map(([c, x]) => ({
        c,
        act: x.strict.n11 + x.strict.n10 + x.strict.n01,
        k: kappa2x2(x.strict.n11, x.strict.n10, x.strict.n01, x.strict.n00),
        kr: kappa2x2(x.relaxed.n11, x.relaxed.n10, x.relaxed.n01, x.relaxed.n00),
        both: x.strict.n11, aO: x.strict.n10, bO: x.strict.n01,
      }))
      .sort((p, q) => q.act - p.act);
    const powered = rowsK.filter((r) => r.act >= 3 && r.k !== null);
    const mean = powered.length ? powered.reduce((t, r) => t + r.k, 0) / powered.length : null;
    console.log(`   mean per-code κ (powered, strict) ${f2(mean)} over ${powered.length} codes · categorization|co-located ${s.coUnits ? ((s.exactUnits / s.coUnits) * 100).toFixed(0) : '—'}% exact of ${s.coUnits}`);
    for (const r of rowsK.slice(0, 12)) {
      console.log(`     ${r.c.padEnd(28)} κ ${f2(r.k)}  rlx ${f2(r.kr)}  A/B/✓ ${r.aO + r.both}/${r.bO + r.both}/${r.both}${r.act < 3 ? '  low-n' : ''}`);
    }
    console.log('');
  }

  // pooled (sum cells) — calibration pool (548+083) and all three
  const pools = [
    ['548+083 (calibration, variant B)', perSession.filter((s) => s.pid.includes('548') || s.pid.includes('083'))],
    ['all three (548+083+353)', perSession],
  ];
  for (const [label, set] of pools) {
    if (set.length < 2) continue;
    const codes = [...new Set(set.flatMap((s) => [...s.byCode.keys()]))];
    const per = codes.map((c) => {
      let n11 = 0, n10 = 0, n01 = 0, n00 = 0;
      for (const s of set) {
        const x = s.byCode.get(c);
        if (x) { n11 += x.strict.n11; n10 += x.strict.n10; n01 += x.strict.n01; n00 += x.strict.n00; }
        else n00 += s.N;
      }
      return { c, act: n11 + n10 + n01, k: kappa2x2(n11, n10, n01, n00) };
    });
    const powered = per.filter((r) => r.act >= 3 && r.k !== null);
    const mean = powered.length ? powered.reduce((t, r) => t + r.k, 0) / powered.length : null;
    let m11 = 0, m10 = 0, m01 = 0, m00 = 0;
    for (const s of set) { m11 += s.segCellsW.n11; m10 += s.segCellsW.n10; m01 += s.segCellsW.n01; m00 += s.segCellsW.n00; }
    console.log(`POOLED ${label}: mean per-code κ ${f2(mean)} (${powered.length} powered) · segmentation κ ${f2(kappa2x2(m11, m10, m01, m00))} · ${powered.filter((r) => r.k >= 0.7).length}/${powered.length} codes ≥ .70`);
  }

  console.log(`\nco-located units (windowed, all sessions): ${coUnits} · exact code-set match ${exactUnits} (${((exactUnits / Math.max(1, coUnits)) * 100).toFixed(0)}%)`);
  console.log('top confusion pairs (co-located, different codes):');
  for (const [pair, n] of [...confusions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`  ${String(n).padStart(3)} × ${pair}`);
  }
}

await main();
