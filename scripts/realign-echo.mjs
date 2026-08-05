#!/usr/bin/env node
/**
 * realign-echo — align restored sentences to the FINE-GRAINED room-audio
 * track ('speaker') of the ORIGINAL version, fixing mid-cue highlight drift.
 *
 *   node scripts/realign-echo.mjs [--session <pid>] [--dry-run]
 *
 * WHY: named-speaker cue tracks are COARSE (10–300s cues); per-word times
 * inside such a cue are linear guesses, so the follow-along highlight starts
 * right at each cue boundary and then falls behind mid-cue ("starts correct
 * but then lags"). The echo track transcribes the SAME speech in ~4s cues —
 * a dense, accurate timeline — but with slightly different ASR text, so
 * exact word-stream equality is impossible. Instead: banded monotone
 * alignment (DP, LCS-style) between the restored word stream (reading order)
 * and the echo word stream (time order); matched words become time ANCHORS;
 * each sentence takes its first/last word's time, interpolated between
 * anchors for unmatched words.
 *
 * GUARDRAILS: a session applies only if ≥60% of restored words anchor and
 * the echo track has ≥3× the cue density of the named tracks; per-sentence
 * starts are clamped monotone afterwards. Otherwise: skip + report.
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

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const ONLY = args.includes('--session') ? args[args.indexOf('--session') + 1] : null;

const words = (s) =>
  (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

async function fetchSegs(versionId) {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from('cb_segments')
      .select('id, speaker, t_start_ms, t_end_ms, text, ordinal')
      .eq('version_id', versionId)
      .order('ordinal')
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    all.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return all;
}

/**
 * Banded monotone alignment of word arrays A→B. Returns anchorB[i] = index in
 * B matched to A[i], or -1. Classic LCS DP over a diagonal band; band width
 * scales with the length difference plus slack for local ASR divergence.
 */
function alignWords(A, B) {
  const n = A.length;
  const m = B.length;
  const band = Math.min(m, Math.abs(n - m) + 600);
  // dp rows only within the band around the scaled diagonal.
  const lo = new Array(n + 1);
  const hi = new Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const center = Math.round((i * m) / Math.max(1, n));
    lo[i] = Math.max(0, center - band);
    hi[i] = Math.min(m, center + band);
  }
  // score + backpointers, stored per row (band width ≤ 2*band+1).
  const rows = new Array(n + 1);
  for (let i = 0; i <= n; i++) rows[i] = new Int32Array(hi[i] - lo[i] + 1);
  const bp = new Array(n + 1);
  for (let i = 0; i <= n; i++) bp[i] = new Int8Array(hi[i] - lo[i] + 1); // 0 none, 1 diagMatch, 2 up(A skip), 3 left(B skip)
  const get = (i, j) => (j < lo[i] || j > hi[i] ? -1e9 : rows[i][j - lo[i]]);
  for (let i = 1; i <= n; i++) {
    for (let j = Math.max(1, lo[i]); j <= hi[i]; j++) {
      const match = A[i - 1] === B[j - 1] ? get(i - 1, j - 1) + 1 : -1e9;
      const up = get(i - 1, j);
      const left = get(i, j - 1);
      let best = match;
      let dir = 1;
      if (up > best) {
        best = up;
        dir = 2;
      }
      if (left > best) {
        best = left;
        dir = 3;
      }
      if (best < -1e8) {
        best = 0;
        dir = 0;
      }
      rows[i][j - lo[i]] = best;
      bp[i][j - lo[i]] = dir;
    }
  }
  const anchor = new Int32Array(n).fill(-1);
  let i = n;
  let j = hi[n];
  // start from the best cell in the last row
  for (let jj = lo[n]; jj <= hi[n]; jj++) if (get(n, jj) > get(n, j)) j = jj;
  while (i > 0 && j > 0) {
    const dir = bp[i][j - lo[i]];
    if (dir === 1) {
      anchor[i - 1] = j - 1;
      i--;
      j--;
    } else if (dir === 2) i--;
    else if (dir === 3) j--;
    else break;
  }
  return anchor;
}

async function realignSession(sessionId, pid) {
  const { data: vers } = await sb
    .from('cb_transcript_versions')
    .select('id, kind')
    .eq('session_id', sessionId);
  const restoredV = vers.find((v) => v.kind === 'restored');
  const originalV = vers.find((v) => v.kind === 'original');
  if (!restoredV || !originalV) return { ok: false, reason: 'missing version' };

  const restored = await fetchSegs(restoredV.id);
  const orig = await fetchSegs(originalV.id);

  // The fine timeline: the track with the SHORTEST average cue span that also
  // has enough cues (the room-audio echo track where present).
  const bySpeaker = new Map();
  for (const c of orig) {
    const arr = bySpeaker.get(c.speaker) ?? [];
    arr.push(c);
    bySpeaker.set(c.speaker, arr);
  }
  const namedSpeakers = new Set(restored.map((s) => s.speaker));
  let fine = null;
  for (const [sp, cues] of bySpeaker) {
    if (namedSpeakers.has(sp)) continue; // named tracks are the coarse ones
    const avg = cues.reduce((a, c) => a + (c.t_end_ms - c.t_start_ms), 0) / cues.length;
    if (!fine || avg < fine.avg) fine = { sp, cues, avg };
  }
  if (!fine || fine.cues.length < 50) return { ok: false, reason: 'no fine echo track' };
  const namedAvg =
    orig
      .filter((c) => namedSpeakers.has(c.speaker))
      .reduce((a, c) => a + (c.t_end_ms - c.t_start_ms), 0) /
    Math.max(1, orig.filter((c) => namedSpeakers.has(c.speaker)).length);
  if (!(namedAvg / fine.avg >= 2)) {
    return { ok: false, reason: `echo not finer (named avg ${(namedAvg / 1000).toFixed(1)}s vs echo ${(fine.avg / 1000).toFixed(1)}s)` };
  }

  // Echo word timeline (per-word linear WITHIN each short cue).
  const echo = [];
  for (const c of fine.cues.sort((a, b) => a.t_start_ms - b.t_start_ms || a.ordinal - b.ordinal)) {
    const ws = words(c.text);
    const span = Math.max(0, (c.t_end_ms ?? c.t_start_ms) - c.t_start_ms);
    ws.forEach((w, k) => {
      echo.push({
        w,
        t0: c.t_start_ms + Math.round((k / Math.max(1, ws.length)) * span),
        t1: c.t_start_ms + Math.round(((k + 1) / Math.max(1, ws.length)) * span),
      });
    });
  }

  // Restored word stream in reading order, remembering sentence boundaries.
  const flat = [];
  const sentSpans = []; // per restored seg: [firstWordIdx, lastWordIdx]
  for (const seg of restored) {
    const ws = words(seg.text);
    if (ws.length === 0) {
      sentSpans.push(null);
      continue;
    }
    sentSpans.push([flat.length, flat.length + ws.length - 1]);
    for (const w of ws) flat.push(w);
  }

  const anchor = alignWords(flat.map((x) => x), echo.map((e) => e.w));
  const matched = anchor.reduce((a, x) => a + (x >= 0 ? 1 : 0), 0);
  const rate = matched / Math.max(1, flat.length);
  if (rate < 0.6) return { ok: false, reason: `anchor rate ${(rate * 100).toFixed(0)}% < 60%` };

  // Word time lookup: matched words take echo time; unmatched interpolate
  // between the nearest matched neighbors.
  const wordT0 = new Array(flat.length).fill(null);
  const wordT1 = new Array(flat.length).fill(null);
  for (let k = 0; k < flat.length; k++) {
    if (anchor[k] >= 0) {
      wordT0[k] = echo[anchor[k]].t0;
      wordT1[k] = echo[anchor[k]].t1;
    }
  }
  let prev = null;
  const nextIdx = new Array(flat.length).fill(null);
  let nxt = null;
  for (let k = flat.length - 1; k >= 0; k--) {
    if (wordT0[k] !== null) nxt = k;
    nextIdx[k] = nxt;
  }
  for (let k = 0; k < flat.length; k++) {
    if (wordT0[k] !== null) {
      prev = k;
      continue;
    }
    const nk = nextIdx[k];
    if (prev !== null && nk !== null) {
      const f = (k - prev) / (nk - prev);
      wordT0[k] = Math.round(wordT0[prev] + f * (wordT0[nk] - wordT0[prev]));
      wordT1[k] = wordT0[k];
    } else if (prev !== null) {
      wordT0[k] = wordT1[prev];
      wordT1[k] = wordT1[prev];
    } else if (nk !== null) {
      wordT0[k] = wordT0[nk];
      wordT1[k] = wordT0[nk];
    }
  }

  // Sentence times, clamped monotone on starts.
  const updates = [];
  let lastStart = -1;
  restored.forEach((seg, si) => {
    const span = sentSpans[si];
    if (!span) return;
    let t0 = wordT0[span[0]];
    let t1 = Math.max(t0, wordT1[span[1]]);
    if (t0 < lastStart) t0 = lastStart; // monotone clamp (reading order)
    lastStart = t0;
    if (t0 !== seg.t_start_ms || t1 !== seg.t_end_ms) {
      updates.push({ id: seg.id, t_start_ms: t0, t_end_ms: Math.max(t0, t1) });
    }
  });

  if (DRY) {
    const deltas = updates.map((u, i) => u.t_start_ms - restored.find((r) => r.id === u.id).t_start_ms);
    const maxAbs = deltas.length ? Math.max(...deltas.map((d) => Math.abs(d))) : 0;
    return { ok: true, updated: updates.length, rate, maxAbs, dry: true };
  }
  for (const u of updates) {
    const { error } = await sb
      .from('cb_segments')
      .update({ t_start_ms: u.t_start_ms, t_end_ms: u.t_end_ms })
      .eq('id', u.id);
    if (error) throw new Error(`[${pid}] update: ${error.message}`);
  }
  return { ok: true, updated: updates.length, rate, restoredVersionId: restoredV.id };
}

async function main() {
  let q = sb.from('cb_sessions').select('id, pid_label');
  if (ONLY) q = q.eq('pid_label', ONLY);
  const { data: sessions, error } = await q;
  if (error) throw new Error(error.message);

  const touched = [];
  for (const s of sessions) {
    try {
      const r = await realignSession(s.id, s.pid_label);
      if (r.ok) {
        console.log(
          `[${s.pid_label}] anchors ${(r.rate * 100).toFixed(0)}% · updated ${r.updated}` +
            (r.maxAbs !== undefined ? ` · max shift ${(r.maxAbs / 1000).toFixed(1)}s` : '') +
            (r.dry ? ' [dry]' : ''),
        );
        if (!r.dry && r.updated > 0) touched.push(r.restoredVersionId);
      } else {
        console.log(`[${s.pid_label}] SKIPPED: ${r.reason}`);
      }
    } catch (e) {
      console.log(`[${s.pid_label}] ERROR: ${e.message}`);
    }
  }
  console.log(`\ntouched versions needing re-ordinal: ${touched.length}`);
  for (const id of touched) console.log(id);
}

await main();
