#!/usr/bin/env node
/**
 * notes-sync — edit code NOTES offline / programmatically.
 *
 *   node scripts/notes-sync.mjs pull            # DB → notes/notes.md
 *   node scripts/notes-sync.mjs push            # notes/notes.md → DB
 *   node scripts/notes-sync.mjs push --dry-run  # show what would change
 *
 * FILE FORMAT (notes/notes.md, gitignored):
 *
 *   # <Codebook name>
 *   ## <code-slug>
 *   1. first step
 *   a. fork branch        ← same syntax the app renders (NoteText)
 *   @other-code links a code
 *
 * Every code appears on pull (empty body = no notes) so offline editing can
 * ADD notes, not just amend. Push updates only codes whose note text changed,
 * prints a summary, and refuses unknown slugs rather than guessing. Uses the
 * same .env.local credentials as restore-sentences.mjs (service role — this
 * writes cb_codes.notes ONLY).
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const notesDir = join(root, 'notes');
const notesFile = join(notesDir, 'notes.md');
const baselineFile = join(notesDir, '.baseline.md');

// ---- env (.env.local, same loader pattern as restore-sentences.mjs) --------
function loadEnv() {
  const p = join(root, '.env.local');
  if (!existsSync(p)) throw new Error('.env.local not found');
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
loadEnv();
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
const sb = createClient(url, key, { auth: { persistSession: false } });

async function fetchCodes() {
  const { data: books, error: e1 } = await sb.from('cb_codebooks').select('id, name');
  if (e1) throw e1;
  const { data: codes, error: e2 } = await sb
    .from('cb_codes')
    .select('id, codebook_id, mnemonic, notes, retired_at')
    .is('retired_at', null)
    .order('mnemonic');
  if (e2) throw e2;
  return { books: books ?? [], codes: codes ?? [] };
}

async function pull() {
  const { books, codes } = await fetchCodes();
  const byBook = new Map(books.map((b) => [b.id, b.name]));
  const lines = [
    '<!-- notes-sync file — edit freely, then: node scripts/notes-sync.mjs push -->',
    '<!-- ## <slug> headers are the keys; the body below each is the note.    -->',
    '<!-- Syntax: "1." numbered steps · "a." fork branches · @slug code links -->',
    '',
  ];
  // Group by codebook, stable order.
  for (const b of books) {
    const mine = codes.filter((c) => c.codebook_id === b.id);
    if (mine.length === 0) continue;
    lines.push(`# ${byBook.get(b.id)}`, '');
    for (const c of mine) {
      lines.push(`## ${c.mnemonic}`);
      if (c.notes?.trim()) lines.push(c.notes.trim());
      lines.push('');
    }
  }
  mkdirSync(notesDir, { recursive: true });
  writeFileSync(notesFile, lines.join('\n'));
  // Baseline = what the DB looked like at pull time — push's 3-way anchor.
  writeFileSync(baselineFile, lines.join('\n'));
  const n = codes.filter((c) => c.notes?.trim()).length;
  console.log(`pulled ${codes.length} codes (${n} with notes) → ${notesFile}`);
}

function parseFile(text) {
  // ## slug headers key the sections; # codebook headers are ignored (grouping
  // is cosmetic — slugs are globally unique per instrument in practice, and
  // push matches by slug).
  const out = new Map();
  let slug = null;
  let buf = [];
  const flush = () => {
    if (slug !== null) out.set(slug, buf.join('\n').trim());
  };
  for (const line of text.split('\n')) {
    const h = line.match(/^##\s+(\S+)\s*$/);
    if (h) {
      flush();
      slug = h[1];
      buf = [];
    } else if (slug !== null && !line.startsWith('# ') && !line.startsWith('<!--')) {
      buf.push(line);
    }
  }
  flush();
  return out;
}

async function push(dryRun, force) {
  if (!existsSync(notesFile)) throw new Error(`${notesFile} not found — run pull first`);
  const wanted = parseFile(readFileSync(notesFile, 'utf8'));
  const baseline = existsSync(baselineFile)
    ? parseFile(readFileSync(baselineFile, 'utf8'))
    : new Map();
  const { books, codes } = await fetchCodes();
  const byslug = new Map(codes.map((c) => [c.mnemonic, c]));

  const unknown = [...wanted.keys()].filter((s) => !byslug.has(s));
  if (unknown.length) {
    throw new Error(`unknown slugs (fix or remove them): ${unknown.join(', ')}`);
  }

  // SAFETY BACKUP: the DB's current notes, before any write — every push is
  // reversible by hand from this file.
  if (!dryRun) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = codes
      .filter((c) => c.notes?.trim())
      .map((c) => `## ${c.mnemonic}\n${c.notes.trim()}\n`)
      .join('\n');
    writeFileSync(join(notesDir, `backup-${stamp}.md`), backup);
  }

  let changed = 0;
  let conflicts = 0;
  for (const [slug, text] of wanted) {
    const code = byslug.get(slug);
    const current = (code.notes ?? '').trim();
    if (current === text) continue; // already what we want
    // 3-WAY CHECK: if the DB moved since pull (someone edited in the app),
    // do NOT clobber it silently — report the conflict and skip.
    const base = (baseline.get(slug) ?? '').trim();
    if (current !== base && !force) {
      conflicts++;
      console.log(`CONFLICT ${slug}: DB changed since your pull — skipped.`);
      console.log(`  db now : ${JSON.stringify(current.slice(0, 80))}`);
      console.log(`  yours  : ${JSON.stringify(text.slice(0, 80))}`);
      console.log(`  (re-run pull to take the DB version, or push --force to overwrite)`);
      continue;
    }
    changed++;
    console.log(`${dryRun ? '[dry-run] ' : ''}${slug}: ${current.length} → ${text.length} chars`);
    if (!dryRun) {
      const { error } = await sb
        .from('cb_codes')
        .update({ notes: text === '' ? null : text })
        .eq('id', code.id);
      if (error) throw new Error(`update ${slug} failed: ${error.message}`);
    }
  }
  // A successful full push makes the file the new baseline.
  if (!dryRun && conflicts === 0) writeFileSync(baselineFile, readFileSync(notesFile, 'utf8'));
  console.log(
    `${dryRun ? 'would update' : 'updated'} ${changed} code(s)` +
      (conflicts ? ` · ${conflicts} conflict(s) skipped` : ''),
  );
  void books;
}

const cmd = process.argv[2];
const dry = process.argv.includes('--dry-run');
const force = process.argv.includes('--force');
if (cmd === 'pull') await pull();
else if (cmd === 'push') await push(dry, force);
else {
  console.log('usage: node scripts/notes-sync.mjs <pull|push> [--dry-run] [--force]');
  process.exit(1);
}
