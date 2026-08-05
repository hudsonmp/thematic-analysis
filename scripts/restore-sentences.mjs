#!/usr/bin/env node
/**
 * restore-sentences.mjs — LLM sentence-restoration pass over the study transcripts.
 *
 * WHY: the ASR corpus has no reliable sentence punctuation (≈65% of cues carry no
 * .!? at all), so punctuation-based sentence-level coding is impossible on the raw
 * text. This script produces, per session, a NEW transcript version whose segments
 * are WHOLE SENTENCES — the coding unit David Smith standardized on ("always
 * highlight at the sentence level; never a fragment"). Coding, IRR, and the
 * co-occurrence heat map then all compute over one-sentence-per-segment units.
 *
 * INPUT  : the deduped `cleaned` version (segments source='resegmented') — single
 *          clean track, original wording, dedup already applied.
 * OUTPUT : a new `cleaned` version, purpose='sentence_restored', segments
 *          source='restored', one sentence each, derived_from the input version.
 *          Originals + the resegmented version are untouched. Idempotent.
 *
 * HARD VALIDITY GATE: the model may add ONLY punctuation + capitalization and split
 * into sentences. It must not add/drop/alter a single word. Every restored turn is
 * checked token-for-token against its input (`wordSig`); on ANY mismatch the turn
 * FALLS BACK to its original segments unchanged. So the coded text can never be
 * model-fabricated — worst case it is the same raw cues you already have.
 *
 * Usage:
 *   node scripts/restore-sentences.mjs --dry-run [--session <pid|id>] [--limit-turns N] [--model <id>]
 *   node scripts/restore-sentences.mjs                 # full run, all 17 study sessions
 *   node scripts/restore-sentences.mjs --session 041   # one session
 *   node scripts/restore-sentences.mjs --force         # redo sessions already restored
 *
 * Env (read from .env.local): ANTHROPIC_API_KEY, NEXT_PUBLIC_SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ---- env -----------------------------------------------------------------
function loadEnvLocal() {
  const raw = readFileSync(join(ROOT, '.env.local'), 'utf8');
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}
loadEnvLocal();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) throw new Error('Missing Supabase env (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).');
if (!ANTHROPIC_KEY) throw new Error('Missing ANTHROPIC_API_KEY in .env.local.');

// ---- args ----------------------------------------------------------------
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d = null) => {
  const i = args.indexOf(f);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : d;
};
const DRY_RUN = has('--dry-run');
const FORCE = has('--force');
const ONLY = val('--session'); // pid_label or session uuid
const LIMIT_TURNS = val('--limit-turns') ? Number(val('--limit-turns')) : Infinity;
const MODEL = val('--model', 'claude-haiku-4-5-20251001');
const CONCURRENCY = Number(val('--concurrency', '8'));
const MAX_CHUNK_CHARS = 3500; // split long turns so restoration output stays bounded

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

// ---- word-preservation gate ---------------------------------------------
/** Token signature: lowercase, strip everything non-alphanumeric to spaces,
 *  collapse whitespace. Two strings share a signature iff they have the SAME
 *  ordered word/number tokens — punctuation and casing are ignored, but any
 *  added/dropped/expanded word (incl. "you'll"→"you will", "10"→"ten") differs. */
function wordSig(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ---- Anthropic restoration ----------------------------------------------
const SYSTEM = [
  'You restore sentence boundaries in a VERBATIM speech-to-text transcript.',
  'You may add ONLY punctuation (. ! ? , …) and fix capitalization.',
  'You MUST NOT add, delete, reorder, merge, or change ANY word — including fillers',
  "like 'um', 'uh', 'like', 'you know'. Do NOT expand contractions (keep \"you'll\",",
  'never "you will"). Do NOT change, spell out, or reformat numbers.',
  'Split the text into individual sentences at natural sentence boundaries.',
  'Output ONLY a JSON array of strings — each string exactly one sentence — and',
  'nothing else. No prose, no code fences.',
].join(' ');

async function restoreChunk(text) {
  const resp = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: SYSTEM,
    messages: [{ role: 'user', content: text }],
  });
  const out = (resp.content || []).map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
  // Tolerate accidental code fences / leading prose: extract the first JSON array.
  const start = out.indexOf('[');
  const end = out.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('no JSON array in model output');
  const arr = JSON.parse(out.slice(start, end + 1));
  if (!Array.isArray(arr) || arr.some((s) => typeof s !== 'string')) throw new Error('not a string array');
  return arr.map((s) => s.trim()).filter((s) => s.length > 0);
}

// ---- pacing --------------------------------------------------------------
async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---- turn model ----------------------------------------------------------
/** Group segments (already in reading order) into maximal same-speaker turns. */
function groupTurns(segs) {
  const turns = [];
  for (const s of segs) {
    const last = turns[turns.length - 1];
    if (last && last.speaker === s.speaker) last.segs.push(s);
    else turns.push({ speaker: s.speaker, segs: [s] });
  }
  return turns;
}

/** Split a turn's segments into chunks whose joined text stays under the char cap,
 *  cutting only at segment boundaries so the gate can run per chunk. */
function chunkTurn(segs) {
  const chunks = [];
  let cur = [];
  let len = 0;
  for (const s of segs) {
    const add = (s.text || '').length + 1;
    if (cur.length && len + add > MAX_CHUNK_CHARS) {
      chunks.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(s);
    len += add;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/** Distribute [t0,t1] across `parts` proportionally to their char length. */
function apportionTime(t0, t1, parts) {
  const total = parts.reduce((a, p) => a + Math.max(1, p.length), 0);
  const span = Math.max(0, (t1 ?? t0) - t0);
  let acc = 0;
  return parts.map((p) => {
    const w = Math.max(1, p.length);
    const start = t0 + Math.round((acc / total) * span);
    acc += w;
    const end = t0 + Math.round((acc / total) * span);
    return [start, Math.max(start, end)];
  });
}

// ---- per-session restoration --------------------------------------------
async function fetchSegments(versionId) {
  // Paged read (PostgREST caps at 1000). Reading order = temporal (t_start_ms).
  const all = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from('cb_segments')
      .select('id, speaker, t_start_ms, t_end_ms, text, ordinal')
      .eq('version_id', versionId)
      .order('t_start_ms', { ascending: true })
      .order('ordinal', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`fetchSegments: ${error.message}`);
    all.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return all;
}

async function restoreSession(row, stats) {
  const tag = `[${row.pid_label}]`;
  const segs = await fetchSegments(row.version_id);
  const turns = groupTurns(segs).slice(0, LIMIT_TURNS === Infinity ? undefined : LIMIT_TURNS);

  // Build the restored segment list (in reading order). Each entry:
  // { speaker, text, t0, t1, fromFallback }.
  const restoredSegs = [];
  let gateFails = 0;
  let gatePass = 0;

  // Flatten to chunks so restoration runs with bounded concurrency across the session.
  const jobs = [];
  turns.forEach((turn, ti) => {
    chunkTurn(turn.segs).forEach((chunk, ci) => {
      const t0 = chunk[0].t_start_ms ?? 0;
      const t1 = chunk[chunk.length - 1].t_end_ms ?? t0;
      const joined = chunk.map((s) => (s.text || '').trim()).filter(Boolean).join(' ');
      jobs.push({ ti, ci, speaker: turn.speaker, chunk, t0, t1, joined });
    });
  });

  const results = await mapLimited(jobs, CONCURRENCY, async (job) => {
    if (!job.joined) return { ...job, sentences: null };
    try {
      const sentences = await restoreChunk(job.joined);
      const ok = wordSig(sentences.join(' ')) === wordSig(job.joined);
      return { ...job, sentences: ok ? sentences : null };
    } catch {
      return { ...job, sentences: null };
    }
  });

  // Re-assemble in reading order (jobs were built in order; mapLimited preserves index).
  for (const job of results) {
    if (job.sentences && job.sentences.length) {
      gatePass++;
      const times = apportionTime(job.t0, job.t1, job.sentences);
      job.sentences.forEach((sen, k) => {
        restoredSegs.push({ speaker: job.speaker, text: sen, t0: times[k][0], t1: times[k][1], fallback: false });
      });
    } else {
      // FALLBACK: keep this chunk's original cues verbatim (word-preserving).
      gateFails++;
      for (const s of job.chunk) {
        restoredSegs.push({
          speaker: s.speaker,
          text: (s.text || '').trim(),
          t0: s.t_start_ms ?? job.t0,
          t1: s.t_end_ms ?? job.t1,
          fallback: true,
        });
      }
    }
  }

  stats.gatePass += gatePass;
  stats.gateFail += gateFails;

  if (DRY_RUN) {
    console.log(`\n${tag} ${segs.length} segs → ${restoredSegs.length} sentence-units  (chunks ok=${gatePass} fallback=${gateFails})`);
    for (let i = 0; i < Math.min(10, restoredSegs.length); i++) {
      const r = restoredSegs[i];
      console.log(`  ${String(i + 1).padStart(3)} ${r.fallback ? '·' : ' '} ${r.speaker}: ${r.text.slice(0, 90)}`);
    }
    return;
  }

  // ---- WRITE: new version + its segments ----------------------------------
  if (!FORCE && row.already_restored) {
    console.log(`${tag} already restored — skip`);
    return;
  }
  if (FORCE) {
    // Delete any prior restored version for this session (segments cascade or manual).
    const { data: prior } = await sb
      .from('cb_transcript_versions')
      .select('id')
      .eq('session_id', row.session_id)
      .eq('purpose', 'sentence_restored');
    for (const p of prior || []) {
      await sb.from('cb_segments').delete().eq('version_id', p.id);
      await sb.from('cb_transcript_versions').delete().eq('id', p.id);
    }
  }

  const { data: ver, error: verErr } = await sb
    .from('cb_transcript_versions')
    .insert({
      session_id: row.session_id,
      kind: 'restored',
      asr_engine: MODEL,
      is_verbatim: false,
      derived_from_version_id: row.version_id,
      purpose: 'sentence_restored',
    })
    .select('id')
    .single();
  if (verErr) throw new Error(`${tag} version insert: ${verErr.message}`);

  // ORDINALS FOLLOW TIME, not turn order. The resegmented sources contain
  // OVERLAPPING per-speaker mega-cues (echo-track residue): serializing whole
  // turns put e.g. a participant's 0–75s block before the interviewer's
  // overlapping 3–64s block, scrambling the conversation (the 041 bug —
  // 8–42 backward time-jumps on every session of the first batch, repaired
  // in-place 2026-08-05 by re-ordinaling on t_start_ms). Stable sort: ties
  // keep intra-turn sentence order.
  const timeOrdered = restoredSegs
    .map((r, i) => ({ ...r, turnIdx: i }))
    .sort((a, b) => a.t0 - b.t0 || a.turnIdx - b.turnIdx);
  const rows = timeOrdered.map((r, i) => ({
    session_id: row.session_id,
    version_id: ver.id,
    speaker: r.speaker,
    t_start_ms: r.t0,
    t_end_ms: r.t1,
    text: r.text,
    ordinal: i,
    source: 'restored',
  }));
  // Bulk insert in batches of 500.
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await sb.from('cb_segments').insert(rows.slice(i, i + 500));
    if (error) throw new Error(`${tag} segment insert: ${error.message}`);
  }
  console.log(`${tag} wrote ${rows.length} sentence-units  (ok=${gatePass} fallback=${gateFails})  version=${ver.id}`);
}

// ---- driver --------------------------------------------------------------
async function main() {
  // The 17 study sessions with a resegmented cleaned version.
  const { data: verRows, error: qErr } = await sb
    .from('cb_transcript_versions')
    .select('id, session_id, cb_sessions!inner(pid_label, collection)')
    .eq('kind', 'cleaned');
  if (qErr) throw new Error(`driver query: ${qErr.message}`);

  // Keep only versions whose segments are 'resegmented' (the dedup output), and
  // attach an already_restored flag.
  const candidates = [];
  for (const v of verRows || []) {
    const pid = v.cb_sessions?.pid_label;
    const collection = v.cb_sessions?.collection;
    if (collection !== 'study') continue;
    const { count: reseg } = await sb
      .from('cb_segments')
      .select('id', { count: 'exact', head: true })
      .eq('version_id', v.id)
      .eq('source', 'resegmented');
    if (!reseg) continue;
    const { count: already } = await sb
      .from('cb_transcript_versions')
      .select('id', { count: 'exact', head: true })
      .eq('session_id', v.session_id)
      .eq('purpose', 'sentence_restored');
    candidates.push({
      session_id: v.session_id,
      version_id: v.id,
      pid_label: pid,
      already_restored: (already || 0) > 0,
    });
  }

  let work = candidates;
  if (ONLY) work = candidates.filter((c) => c.pid_label === ONLY || c.session_id === ONLY);
  work.sort((a, b) => String(a.pid_label).localeCompare(String(b.pid_label)));

  console.log(`restore-sentences — model=${MODEL} dry=${DRY_RUN} force=${FORCE} sessions=${work.length}`);
  const stats = { gatePass: 0, gateFail: 0 };
  for (const row of work) {
    try {
      await restoreSession(row, stats);
    } catch (e) {
      console.error(`[${row.pid_label}] ERROR: ${e.message}`);
    }
  }
  const total = stats.gatePass + stats.gateFail;
  const pct = total ? Math.round((100 * stats.gatePass) / total) : 0;
  console.log(`\nDONE. chunks restored=${stats.gatePass} fallback=${stats.gateFail} (${pct}% clean-restored).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
