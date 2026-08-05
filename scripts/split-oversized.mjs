#!/usr/bin/env node
/**
 * split-oversized — find restored segments whose text is a giant unsplit blob
 * and split them into gate-verified sentences, in place.
 *
 *   node scripts/split-oversized.mjs [--session <pid>] [--threshold 600] [--dry-run]
 *
 * WHY these exist: chunking in restore-sentences cuts only at CUE boundaries,
 * so a single multi-minute ASR cue (3k+ chars) went to the model whole,
 * overflowed, failed the word gate three times, and was kept raw. This sweep
 * splits such a cue's TEXT at word boundaries into ~900-char pieces, restores
 * each with the same retry+feedback protocol, verifies the CONCATENATION
 * preserves every word, then replaces the one row with N sentence rows
 * (times apportioned by char length). Other segments keep their ids —
 * annotations never dangle. Finishes with a per-version re-ordinal by
 * (t_start_ms, ordinal), the same normalization as the 08-05 repair.
 */

import Anthropic from '@anthropic-ai/sdk';
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
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-haiku-4-5-20251001';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
const DRY = has('--dry-run');
const ONLY = val('--session');
const THRESHOLD = Number(val('--threshold') ?? 600);

// ---- same restoration contract as restore-sentences ------------------------
const SYSTEM = [
  'You restore punctuation and capitalization to raw speech-to-text transcript text.',
  'You MUST preserve every word exactly as given, in order — do not add, remove,',
  'merge, or correct any word, filler ("um", "uh"), stutter, or repetition. Do NOT',
  'expand or contract contractions (keep "I\'ll" as "I\'ll", keep "you will"',
  'never "you will"). Do NOT change, spell out, or reformat numbers.',
  'Split the text into individual sentences at natural sentence boundaries.',
  'Output ONLY a JSON array of strings — each string exactly one sentence — and',
  'nothing else. No prose, no code fences.',
].join(' ');

const wordSig = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');

async function restoreChunk(text, feedback = null, model = MODEL) {
  const content = feedback
    ? `${feedback}\n\nRestore this text again, reproducing EVERY word verbatim:\n${text}`
    : text;
  const resp = await anthropic.messages.create({
    model,
    max_tokens: 4096,
    system: SYSTEM,
    messages: [{ role: 'user', content }],
  });
  const out = (resp.content || []).map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
  const start = out.indexOf('[');
  const end = out.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('no JSON array in model output');
  const arr = JSON.parse(out.slice(start, end + 1));
  if (!Array.isArray(arr) || arr.some((s) => typeof s !== 'string')) throw new Error('not a string array');
  return arr.map((s) => s.trim()).filter((s) => s.length > 0);
}

function firstDivergence(wantSig, gotSig) {
  const a = wantSig.split(' ');
  const b = gotSig.split(' ');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return { i, want: a[i] ?? '(end)', got: b[i] ?? '(end)' };
  }
  return null;
}

const MAX_SENTENCE_CHARS = 300;
const ESCALATION = [MODEL, MODEL, 'claude-sonnet-5'];

/**
 * Acceptance = BOTH invariants:
 *   1. every word preserved (the original gate), AND
 *   2. actually SPLIT — no returned "sentence" over MAX_SENTENCE_CHARS. The
 *      word gate alone let the model echo a whole chunk back as one string
 *      and "pass" (353's 897-char pseudo-sentences).
 * Retry ladder: Haiku ×2 with targeted feedback, then Sonnet for the text
 * Haiku won't split.
 */
async function restoreVerified(text) {
  let feedback = null;
  for (let attempt = 0; attempt < ESCALATION.length; attempt++) {
    try {
      const sentences = await restoreChunk(text, feedback, ESCALATION[attempt]);
      const want = wordSig(text);
      const got = wordSig(sentences.join(' '));
      if (want !== got) {
        const d = firstDivergence(want, got);
        feedback =
          `Your previous output changed the words (word ${d.i}: expected ` +
          `"${d.want}", got "${d.got}"). Add ONLY punctuation and capitalization; ` +
          `keep every word, filler, and stutter exactly as given.`;
        continue;
      }
      const longest = Math.max(...sentences.map((x) => x.length));
      if (longest > MAX_SENTENCE_CHARS) {
        feedback =
          `You returned text that is not split into sentences (one item was ` +
          `${longest} characters). Split into SHORT sentences — at most ~35 words ` +
          `each. In rambling speech, break at discourse markers like "so", "okay", ` +
          `"um", "and then", "I think". Keep every word exactly as given.`;
        continue;
      }
      return sentences;
    } catch (e) {
      feedback = `Your previous output was invalid (${String(e.message).slice(0, 80)}). Output ONLY a JSON array of sentence strings.`;
    }
  }
  return null;
}

/** Split text into ≤cap-char pieces on word boundaries. */
function wordChunks(text, cap = 500) {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks = [];
  let cur = [];
  let len = 0;
  for (const w of words) {
    if (cur.length && len + w.length + 1 > cap) {
      chunks.push(cur.join(' '));
      cur = [];
      len = 0;
    }
    cur.push(w);
    len += w.length + 1;
  }
  if (cur.length) chunks.push(cur.join(' '));
  return chunks;
}

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

async function main() {
  // Oversized segments on restored versions (optionally one session).
  let q = sb
    .from('cb_segments')
    .select('id, version_id, session_id, speaker, t_start_ms, t_end_ms, text, ordinal, cb_transcript_versions!inner(kind), cb_sessions!inner(pid_label)')
    .eq('cb_transcript_versions.kind', 'restored');
  if (ONLY) q = q.eq('cb_sessions.pid_label', ONLY);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const targets = (data || [])
    .filter((r) => (r.text || '').length > THRESHOLD)
    .sort((a, b) => b.text.length - a.text.length);
  console.log(`${targets.length} oversized segment(s) > ${THRESHOLD} chars${ONLY ? ` in ${ONLY}` : ''}`);

  const touchedVersions = new Set();
  let split = 0;
  let failed = 0;

  for (const seg of targets) {
    const pid = seg.cb_sessions.pid_label;
    const chunks = wordChunks(seg.text);
    const all = [];
    let ok = true;
    for (const ch of chunks) {
      const sentences = await restoreVerified(ch);
      if (!sentences) {
        ok = false;
        break;
      }
      all.push(...sentences);
    }
    // FULL-SEGMENT gate: the concatenation must preserve every word.
    if (!ok || wordSig(all.join(' ')) !== wordSig(seg.text)) {
      failed++;
      console.log(`[${pid}] ord ${seg.ordinal} (${seg.text.length} ch): FAILED gate — left as is`);
      continue;
    }
    console.log(`[${pid}] ord ${seg.ordinal} (${seg.text.length} ch) → ${all.length} sentences${DRY ? ' [dry]' : ''}`);
    if (DRY) continue;

    // Splice: insert the sentences at out-of-the-way ordinals, delete the blob.
    const times = apportionTime(seg.t_start_ms ?? 0, seg.t_end_ms ?? seg.t_start_ms ?? 0, all);
    const rows = all.map((text, i) => ({
      session_id: seg.session_id,
      version_id: seg.version_id,
      speaker: seg.speaker,
      t_start_ms: times[i][0],
      t_end_ms: times[i][1],
      text,
      ordinal: 500000 + split * 1000 + i, // unique, far above any real ordinal
      source: 'restored',
    }));
    const ins = await sb.from('cb_segments').insert(rows);
    if (ins.error) throw new Error(`[${pid}] insert: ${ins.error.message}`);
    const del = await sb.from('cb_segments').delete().eq('id', seg.id);
    if (del.error) throw new Error(`[${pid}] delete: ${del.error.message}`);
    touchedVersions.add(seg.version_id);
    split++;
  }

  console.log(`split=${split} failed=${failed}; touched versions: ${touchedVersions.size}`);
  if (touchedVersions.size) {
    console.log('NOW RUN the re-ordinal SQL (printed below) via the Supabase MCP:');
    console.log(`-- versions: ${[...touchedVersions].join(', ')}`);
  }
}

await main();
