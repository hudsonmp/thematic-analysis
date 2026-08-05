#!/usr/bin/env node
/**
 * realign-times — replace INTERPOLATED sentence times on restored versions
 * with times derived from the SOURCE cues' real ASR timestamps.
 *
 *   node scripts/realign-times.mjs [--session <pid>] [--dry-run]
 *
 * WHY: restoration apportioned a turn's [t0,t1] across its sentences by
 * character share — systematically late/early wherever speech is uneven,
 * which the player shows as the follow-along highlight LAGGING the voice.
 *
 * HOW: per speaker, the restored sentences' word stream is IDENTICAL to the
 * source cues' word stream (the restoration word gate guarantees it). Walk
 * both together: each source word gets a timestamp interpolated within its
 * OWN cue (cue-level accuracy, seconds not minutes); each restored sentence
 * then takes [t of its first word, t of its last word]. Self-verifying: if a
 * speaker's word streams don't match exactly, the whole SESSION is skipped
 * and reported — no partial guesses. Finishes with the standard per-version
 * re-ordinal by (t_start_ms, ordinal).
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

async function realignSession(v, pid) {
  const restored = await fetchSegs(v.id);
  const source = await fetchSegs(v.sourceVersionId ?? v.derived_from_version_id);
  const speakers = [...new Set(restored.map((s) => s.speaker))];

  // Per-speaker timed word streams from the SOURCE cues (true ASR times;
  // within a cue, words spread linearly across the cue's own span).
  const streams = new Map();
  for (const sp of speakers) {
    const cues = source
      .filter((s) => s.speaker === sp)
      .sort((a, b) => a.t_start_ms - b.t_start_ms || a.ordinal - b.ordinal);
    const stream = [];
    for (const c of cues) {
      const ws = words(c.text);
      const span = Math.max(0, (c.t_end_ms ?? c.t_start_ms) - c.t_start_ms);
      ws.forEach((w, i) => {
        stream.push({
          w,
          t0: c.t_start_ms + Math.round((i / Math.max(1, ws.length)) * span),
          t1: c.t_start_ms + Math.round(((i + 1) / Math.max(1, ws.length)) * span),
        });
      });
    }
    streams.set(sp, { stream, pos: 0 });
  }

  // Walk restored sentences per speaker IN ORDINAL ORDER, consuming the
  // speaker's word stream. Any mismatch aborts the session (report, no write).
  const updates = [];
  for (const seg of restored) {
    const st = streams.get(seg.speaker);
    if (!st) return { ok: false, reason: `speaker ${seg.speaker} missing in source` };
    const ws = words(seg.text);
    if (ws.length === 0) continue;
    const start = st.pos;
    for (let i = 0; i < ws.length; i++) {
      const src = st.stream[st.pos];
      if (!src || src.w !== ws[i]) {
        return {
          ok: false,
          reason: `word mismatch for ${seg.speaker} at stream pos ${st.pos} (` +
            `want "${ws[i]}", have "${src?.w ?? '(end)'}") — ord ${seg.ordinal}`,
        };
      }
      st.pos++;
    }
    const t0 = st.stream[start].t0;
    const t1 = st.stream[st.pos - 1].t1;
    if (t0 !== seg.t_start_ms || t1 !== seg.t_end_ms) {
      updates.push({ id: seg.id, t_start_ms: t0, t_end_ms: Math.max(t0, t1) });
    }
  }
  // Every source word must be consumed (coverage both directions).
  for (const [sp, st] of streams) {
    if (st.pos !== st.stream.length) {
      return { ok: false, reason: `${st.stream.length - st.pos} source words unconsumed for ${sp}` };
    }
  }

  if (DRY) return { ok: true, updated: updates.length, dry: true };
  for (const u of updates) {
    const { error } = await sb
      .from('cb_segments')
      .update({ t_start_ms: u.t_start_ms, t_end_ms: u.t_end_ms })
      .eq('id', u.id);
    if (error) throw new Error(`[${pid}] update: ${error.message}`);
  }
  return { ok: true, updated: updates.length };
}

const USE_ORIGINAL = args.includes('--source-original');

async function main() {
  let q = sb
    .from('cb_transcript_versions')
    .select('id, session_id, derived_from_version_id, cb_sessions!inner(pid_label)')
    .eq('kind', 'restored');
  if (ONLY) q = q.eq('cb_sessions.pid_label', ONLY);
  const { data: vers, error } = await q;
  if (error) throw new Error(error.message);
  if (USE_ORIGINAL) {
    // Fine-grained ground truth: the ORIGINAL (verbatim ASR) version's cues
    // are seconds-long, so per-word times are accurate even where the
    // resegmented source had multi-minute mega-cues (the residual-drift
    // stretches). Restored speakers only — echo tracks are ignored by
    // construction (their speaker labels never appear in restored).
    for (const v of vers) {
      const { data: orig } = await sb
        .from('cb_transcript_versions')
        .select('id')
        .eq('session_id', v.session_id)
        .eq('kind', 'original')
        .limit(1);
      v.sourceVersionId = orig?.[0]?.id ?? null;
    }
  }

  const touched = [];
  for (const v of vers) {
    const pid = v.cb_sessions.pid_label;
    try {
      console.log(`[${pid}] source = ${v.sourceVersionId ?? v.derived_from_version_id}${v.sourceVersionId ? ' (original)' : ' (derived)'}`);
      const r = await realignSession(v, pid);
      if (r.ok) {
        console.log(`[${pid}] realigned ${r.updated} segment time(s)${r.dry ? ' [dry]' : ''}`);
        if (!r.dry && r.updated > 0) touched.push(v.id);
      } else {
        console.log(`[${pid}] SKIPPED: ${r.reason}`);
      }
    } catch (e) {
      console.log(`[${pid}] ERROR: ${e.message}`);
    }
  }
  console.log(`\ntouched versions needing re-ordinal: ${touched.length}`);
  for (const id of touched) console.log(id);
}

await main();
