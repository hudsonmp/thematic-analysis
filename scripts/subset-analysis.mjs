#!/usr/bin/env node
/**
 * subset-analysis — is Moonwara's coding a SUBSET of Hudson's (omission only),
 * or does she COMMIT codes he doesn't have (disagreement)? David's fork:
 * subset-without-disagreement ≈ consolidation fixes it; commission = deeper
 * definition problem. READ-ONLY; windowed to matched effort per session.
 *
 * Unit = segment of the modal coded version. On each co-located unit
 * (both coders coded it), compare code SETS:
 *   exact       A == B
 *   subset      B ⊂ A (proper: she has some of his, none extra)
 *   commission  B \ A ≠ ∅ (she applied ≥1 code he did not — breaks subset)
 * Plus mark-level precision (of her (unit,code) marks, share he also has) and
 * her units-he-never-coded count (she exceeds him — also breaks strict subset).
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

async function main() {
  const sessions = await pageAll((a, b) => sb.from('cb_sessions').select('id, pid_label').range(a, b));
  const targets = ['548', '083', '353']
    .map((p) => sessions.find((s) => String(s.pid_label).includes(p)))
    .filter(Boolean);

  const annAll = await pageAll((a, b) =>
    sb.from('cb_annotations').select('coder_id, kind').eq('kind', 'code').range(a, b),
  );
  const byCoder = new Map();
  for (const r of annAll) byCoder.set(r.coder_id, (byCoder.get(r.coder_id) ?? 0) + 1);
  const [[A], [B]] = [...byCoder.entries()].sort((x, y) => y[1] - x[1]).slice(0, 2);

  const tot = { co: 0, exact: 0, subset: 0, commission: 0, superB: 0, bMarks: 0, bMarksHit: 0, bOnlyUnits: 0 };
  const commissionCodes = new Map(); // her committed code -> count of units

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
    const vc = new Map();
    for (const r of rows) vc.set(r.version_id, (vc.get(r.version_id) ?? 0) + 1);
    const versionId = [...vc.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
    const use = rows.filter((r) => r.version_id === versionId);
    const segs = await pageAll((a, b) =>
      sb.from('cb_segments').select('id, ordinal').eq('version_id', versionId).order('ordinal').range(a, b),
    );
    const idx = new Map(segs.map((x, i) => [x.id, i]));

    const maxOn = (cid) => Math.max(...use.filter((r) => r.coder_id === cid).map((r) => r.t_start_ms), -1);
    const win = Math.min(maxOn(A), maxOn(B));
    const inWin = use.filter((r) => r.t_start_ms <= win);

    const unitCodes = { [A]: new Map(), [B]: new Map() };
    for (const r of inWin) {
      const si = idx.get(r.segment_id);
      if (si === undefined) continue;
      const eiRaw = r.end_segment_id ? idx.get(r.end_segment_id) : si;
      const ei = eiRaw === undefined ? si : eiRaw;
      const codes = (r.cb_annotation_codes ?? []).map((x) => x.cb_codes?.mnemonic).filter(Boolean);
      for (let u = Math.min(si, ei); u <= Math.max(si, ei); u++) {
        let uc = unitCodes[r.coder_id].get(u);
        if (!uc) unitCodes[r.coder_id].set(u, (uc = new Set()));
        for (const c of codes) uc.add(c);
      }
    }

    const st = { co: 0, exact: 0, subset: 0, commission: 0, superB: 0, bMarks: 0, bMarksHit: 0, bOnlyUnits: 0 };
    for (const [u, bc] of unitCodes[B]) {
      const ac = unitCodes[A].get(u);
      for (const c of bc) {
        st.bMarks++;
        if (ac?.has(c)) st.bMarksHit++;
      }
      if (!ac) {
        st.bOnlyUnits++;
        continue;
      }
      st.co++;
      const bExtra = [...bc].filter((c) => !ac.has(c));
      const aExtra = [...ac].filter((c) => !bc.has(c));
      if (bExtra.length === 0 && aExtra.length === 0) st.exact++;
      else if (bExtra.length === 0) st.subset++;
      else {
        st.commission++;
        for (const c of bExtra) commissionCodes.set(c, (commissionCodes.get(c) ?? 0) + 1);
        if (aExtra.length === 0) st.superB++; // she is a strict SUPERSET of him here
      }
    }
    const pc = (x, n) => (n ? `${((x / n) * 100).toFixed(0)}%` : '—');
    console.log(
      `${s.pid_label}: co-located ${st.co} · exact ${st.exact} (${pc(st.exact, st.co)}) · she⊂you ${st.subset} (${pc(st.subset, st.co)}) · ` +
        `subset-or-exact ${pc(st.exact + st.subset, st.co)} · commission ${st.commission} (${pc(st.commission, st.co)}) · ` +
        `her mark-precision ${pc(st.bMarksHit, st.bMarks)} (${st.bMarksHit}/${st.bMarks}) · her-only units ${st.bOnlyUnits}`,
    );
    for (const k of Object.keys(tot)) tot[k] += st[k];
  }

  const pc = (x, n) => (n ? `${((x / n) * 100).toFixed(0)}%` : '—');
  console.log(
    `\nOVERALL: co-located ${tot.co} · exact ${tot.exact} (${pc(tot.exact, tot.co)}) · she⊂you ${tot.subset} (${pc(tot.subset, tot.co)}) · ` +
      `subset-or-exact ${pc(tot.exact + tot.subset, tot.co)} · commission ${tot.commission} (${pc(tot.commission, tot.co)}; strict-superset-of-you ${tot.superB}) · ` +
      `her mark-precision ${pc(tot.bMarksHit, tot.bMarks)} (${tot.bMarksHit}/${tot.bMarks}) · her-only units ${tot.bOnlyUnits}`,
  );
  console.log('\nher committed codes (on units where you had DIFFERENT codes):');
  for (const [c, n] of [...commissionCodes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${String(n).padStart(3)} × ${c}`);
  }
}

await main();
