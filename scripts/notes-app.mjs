#!/usr/bin/env node
/**
 * notes-app — generate a SELF-CONTAINED offline notes editor.
 *
 *   node scripts/notes-app.mjs      →  notes/notes-app.html
 *
 * Open the file in Chrome (double-click). It embeds a snapshot of every live
 * code (slug, definition, note) styled like /codebook/view, and works with
 * ZERO network: every keystroke autosaves to localStorage (survives closing
 * the tab, rebooting, airplane mode). When back online, SYNC writes changed
 * notes to Supabase with the same 3-way safety as notes-sync: a code whose
 * cloud note moved since this snapshot is a CONFLICT, shown — never silently
 * clobbered. EXPORT downloads a notes.md compatible with
 * `node scripts/notes-sync.mjs push` as the fallback path.
 *
 * SECURITY: the generated file embeds the service credentials from
 * .env.local so sync works from file:// — it lives in the gitignored notes/
 * directory and must never be shared or committed.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outFile = join(root, 'notes', 'notes-app.html');

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

const { data: books, error: e1 } = await sb.from('cb_codebooks').select('id, name');
if (e1) throw e1;
const { data: codes, error: e2 } = await sb
  .from('cb_codes')
  .select('id, codebook_id, mnemonic, notes, retired_at, current_version_id')
  .is('retired_at', null)
  .order('mnemonic');
if (e2) throw e2;
const versionIds = codes.map((c) => c.current_version_id).filter(Boolean);
const { data: versions, error: e3 } = await sb
  .from('cb_code_versions')
  .select('id, definition')
  .in('id', versionIds);
if (e3) throw e3;
const defById = new Map((versions ?? []).map((v) => [v.id, v.definition]));
const bookById = new Map((books ?? []).map((b) => [b.id, b.name]));

const snapshot = codes.map((c) => ({
  id: c.id,
  slug: c.mnemonic,
  book: bookById.get(c.codebook_id) ?? '',
  def: defById.get(c.current_version_id) ?? '',
  notes: (c.notes ?? '').trim(),
}));

const generatedAt = new Date().toISOString();

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Codebook Notes — offline</title>
<style>
  /* Mirrors /codebook/view: warm paper, hairline grid, serif body, mono slugs. */
  :root { --fg: #1c1917; --line: rgba(28,25,23,.15); --dim: rgba(28,25,23,.45); }
  * { box-sizing: border-box; margin: 0; }
  body { background: #faf6ee; color: var(--fg); font: 14px/1.45 Georgia, 'Times New Roman', serif; padding: 24px; }
  header { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; margin-bottom: 6px; }
  h1 { font-size: 20px; font-weight: 600; letter-spacing: -0.01em; }
  .sub { color: var(--dim); font-size: 12px; }
  .bar { position: sticky; top: 0; background: #faf6eecc; backdrop-filter: blur(4px); padding: 8px 0; display: flex; gap: 8px; align-items: center; z-index: 5; border-bottom: 1px solid var(--line); margin-bottom: 12px; }
  button { font: 12px Georgia, serif; border: 1px solid var(--fg); background: var(--fg); color: #faf6ee; padding: 5px 12px; cursor: pointer; }
  button.ghost { background: transparent; color: var(--fg); border-color: rgba(28,25,23,.35); }
  button:disabled { opacity: .4; cursor: default; }
  #status { font-size: 12px; color: var(--dim); }
  #status.err { color: #b91c1c; }
  #status.ok { color: #047857; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 12px; }
  th { text-transform: uppercase; letter-spacing: .06em; font-size: 10px; color: var(--dim); text-align: left; font-weight: 600; }
  th, td { border: 1px solid var(--line); padding: 6px 8px; vertical-align: top; overflow-wrap: anywhere; hyphens: none; }
  .bookrow td { background: rgba(28,25,23,.05); font-weight: 600; font-size: 12px; }
  .slug { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; font-weight: 500; }
  .def { color: rgba(28,25,23,.8); font-size: 11.5px; }
  td.notes { padding: 4px; }
  textarea { width: 100%; min-height: 56px; border: 1px solid rgba(28,25,23,.25); background: #fffdf8; font: 12px/1.5 ui-monospace, Menlo, monospace; padding: 6px; resize: vertical; }
  textarea:focus { outline: none; border-color: var(--fg); }
  .dirty { border-left: 3px solid #b45309; }
  .preview { margin-top: 4px; font-size: 12px; }
  .preview ol { list-style: none; padding: 0; }
  .preview .n { color: var(--dim); }
  .mention { font-family: ui-monospace, Menlo, monospace; font-size: .92em; color: #047857; }
  /* fork tree: stub, rail, side-by-side branches — borders so it prints */
  .stub { width: 0; height: 8px; border-left: 1px solid rgba(28,25,23,.5); margin: 0 auto; }
  .branches { display: flex; justify-content: center; }
  .branch { display: flex; flex-direction: column; align-items: center; min-width: 0; }
  .rail { display: flex; width: 100%; } .rail div { height: 0; flex: 1; border-top: 1px solid rgba(28,25,23,.5); }
  .rail div.hide { border-top-color: transparent; }
  .tick { width: 0; height: 8px; border-left: 1px solid rgba(28,25,23,.5); }
  .bnode { padding: 0 6px; text-align: center; }
  .conflict { background: #fef3c7; border: 1px solid #b45309; padding: 4px 6px; font-size: 11px; margin-top: 4px; }
</style>
</head>
<body>
<header>
  <h1>Codebook Notes</h1>
  <span class="sub">offline editor · snapshot ${generatedAt.slice(0, 16).replace('T', ' ')} · autosaves locally as you type</span>
</header>
<div class="bar">
  <button id="sync">Sync to cloud</button>
  <button id="export" class="ghost">Export notes.md</button>
  <button id="revert" class="ghost" title="Discard local drafts, back to the snapshot">Discard drafts</button>
  <span id="status"></span>
</div>
<table id="tbl">
  <colgroup><col style="width:16%"><col style="width:42%"><col style="width:42%"></colgroup>
  <thead><tr><th>Code</th><th>Definition</th><th>Notes</th></tr></thead>
  <tbody></tbody>
</table>
<script>
const SUPA_URL = ${JSON.stringify(url)};
const SUPA_KEY = ${JSON.stringify(key)};
const SNAPSHOT = ${JSON.stringify(snapshot)};
const LS_KEY = 'ta-notes-drafts-v1';

// drafts: { [codeId]: text } — only codes the user touched. Baseline for the
// 3-way check is the embedded SNAPSHOT.
let drafts = {};
try { drafts = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch {}
const save = () => localStorage.setItem(LS_KEY, JSON.stringify(drafts));
const valueOf = (c) => (c.id in drafts ? drafts[c.id] : c.notes);
const isDirty = (c) => (c.id in drafts) && drafts[c.id].trim() !== c.notes.trim();

// ---- note rendering (port of NoteText: 1. steps, a. fork branches, @slug) --
function esc(s) { return s.replace(/[&<>"]/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch])); }
function inline(s) { return esc(s).replace(/@([a-z0-9][a-z0-9-]*)/gi, '<span class="mention">@$1</span>'); }
function renderNote(text) {
  const blocks = []; let list = null;
  for (const raw of text.split('\\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) { list = null; continue; }
    const num = line.match(/^\\s*(\\d+)[.)](?:\\s+(.*))?$/);
    const sub = line.match(/^\\s*([a-z])[.)](?:\\s+(.*))?$/);
    if (num) { if (!list) { list = { items: [] }; blocks.push(list); } list.items.push({ n: num[1], t: num[2] || '', subs: [] }); }
    else if (sub && list && list.items.length) list.items[list.items.length - 1].subs.push({ n: sub[1], t: sub[2] || '' });
    else { list = null; blocks.push({ p: line.trim() }); }
  }
  let h = '';
  for (const b of blocks) {
    if (b.p !== undefined) { h += '<p>' + inline(b.p) + '</p>'; continue; }
    h += '<ol>';
    for (const it of b.items) {
      h += '<li><span class="n">' + it.n + '.</span> ' + inline(it.t);
      if (it.subs.length) {
        h += '<div class="stub"></div><div class="branches">';
        it.subs.forEach((s2, k) => {
          h += '<div class="branch"><div class="rail"><div class="' + (k === 0 ? 'hide' : '') + '"></div><div class="' + (k === it.subs.length - 1 ? 'hide' : '') + '"></div></div><div class="tick"></div><div class="bnode"><span class="n">' + s2.n + '.</span> ' + inline(s2.t) + '</div></div>';
        });
        h += '</div>';
      }
      h += '</li>';
    }
    h += '</ol>';
  }
  return h;
}

// ---- table ----------------------------------------------------------------
const tbody = document.querySelector('#tbl tbody');
let lastBook = null;
for (const c of SNAPSHOT) {
  if (c.book !== lastBook) {
    lastBook = c.book;
    const tr = document.createElement('tr');
    tr.className = 'bookrow';
    tr.innerHTML = '<td colspan="3">' + esc(c.book) + '</td>';
    tbody.appendChild(tr);
  }
  const tr = document.createElement('tr');
  const defShown = (c.def || '').split('==').pop().trim();
  tr.innerHTML =
    '<td class="slug">' + esc(c.slug) + '</td>' +
    '<td class="def">' + esc(defShown) + '</td>' +
    '<td class="notes"><textarea data-id="' + c.id + '" placeholder="1. step\\na. fork branch\\n@slug links a code">' + esc(valueOf(c)) + '</textarea><div class="preview" data-prev="' + c.id + '">' + renderNote(valueOf(c)) + '</div><div data-conf="' + c.id + '"></div></td>';
  tbody.appendChild(tr);
}
const codeById = Object.fromEntries(SNAPSHOT.map((c) => [c.id, c]));
function refreshRow(id) {
  const c = codeById[id];
  const ta = document.querySelector('textarea[data-id="' + id + '"]');
  ta.classList.toggle('dirty', isDirty(c));
  document.querySelector('[data-prev="' + id + '"]').innerHTML = renderNote(valueOf(c));
}
document.addEventListener('input', (e) => {
  const id = e.target?.dataset?.id;
  if (!id) return;
  drafts[id] = e.target.value;
  save();
  refreshRow(id);
  setStatus(dirtyCount() + ' unsynced change(s) — saved locally', '');
});

// ---- status ---------------------------------------------------------------
const statusEl = document.getElementById('status');
function setStatus(msg, cls) { statusEl.textContent = msg; statusEl.className = cls || ''; }
function dirtyCount() { return SNAPSHOT.filter(isDirty).length; }
const n0 = dirtyCount();
setStatus(navigator.onLine ? (n0 ? n0 + ' unsynced change(s) from a previous session' : 'online · no local changes') : 'OFFLINE — edits save locally; sync when you land', '');
window.addEventListener('offline', () => setStatus('OFFLINE — edits save locally; sync when you land', ''));
window.addEventListener('online', () => setStatus('back online — ' + dirtyCount() + ' change(s) ready to sync', 'ok'));

// ---- sync (3-way, same semantics as notes-sync) ---------------------------
async function supa(path, opts = {}) {
  const r = await fetch(SUPA_URL + '/rest/v1/' + path, {
    ...opts,
    headers: { apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal', ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r;
}
document.getElementById('sync').onclick = async () => {
  const dirty = SNAPSHOT.filter(isDirty);
  if (!dirty.length) { setStatus('nothing to sync', 'ok'); return; }
  setStatus('syncing ' + dirty.length + ' change(s)…', '');
  try {
    // Fetch the cloud's CURRENT notes for the dirty codes (3-way anchor).
    const ids = dirty.map((c) => c.id).join(',');
    const res = await fetch(SUPA_URL + '/rest/v1/cb_codes?select=id,notes&id=in.(' + ids + ')', {
      headers: { apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const now = Object.fromEntries((await res.json()).map((r) => [r.id, (r.notes || '').trim()]));
    let wrote = 0, conflicts = 0;
    for (const c of dirty) {
      const mine = drafts[c.id].trim();
      const cloud = now[c.id] ?? '';
      const confEl = document.querySelector('[data-conf="' + c.id + '"]');
      confEl.innerHTML = '';
      if (cloud !== c.notes.trim() && cloud !== mine) {
        conflicts++;
        confEl.innerHTML = '<div class="conflict"><b>Conflict:</b> the cloud note changed while you were offline.<br>cloud: ' + esc(cloud.slice(0, 120)) + '<br>Your draft is kept locally — copy what you need, then edit &amp; sync again.</div>';
        continue;
      }
      await supa('cb_codes?id=eq.' + c.id, { method: 'PATCH', body: JSON.stringify({ notes: mine === '' ? null : mine }) });
      c.notes = mine;           // synced → new baseline for this code
      delete drafts[c.id];
      wrote++;
      refreshRow(c.id);
    }
    save();
    setStatus('synced ' + wrote + ' change(s)' + (conflicts ? ' · ' + conflicts + ' conflict(s) shown inline' : ''), conflicts ? 'err' : 'ok');
  } catch (err) {
    setStatus('sync failed (offline?): ' + err.message + ' — drafts are safe locally', 'err');
  }
};

// ---- export fallback (feeds scripts/notes-sync.mjs push) ------------------
document.getElementById('export').onclick = () => {
  let md = '';
  let book = null;
  for (const c of SNAPSHOT) {
    if (c.book !== book) { book = c.book; md += '# ' + c.book + '\\n\\n'; }
    md += '## ' + c.slug + '\\n';
    const v = valueOf(c).trim();
    if (v) md += v + '\\n';
    md += '\\n';
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
  a.download = 'notes.md';
  a.click();
};
document.getElementById('revert').onclick = () => {
  if (!confirm('Discard ALL local drafts and return to the snapshot?')) return;
  drafts = {};
  save();
  for (const c of SNAPSHOT) {
    const ta = document.querySelector('textarea[data-id="' + c.id + '"]');
    ta.value = c.notes;
    refreshRow(c.id);
  }
  setStatus('drafts discarded', '');
};
</script>
</body>
</html>
`;

mkdirSync(join(root, 'notes'), { recursive: true });
writeFileSync(outFile, html);
console.log(`generated ${outFile} (${snapshot.length} codes) — open it in Chrome; do NOT share the file (embeds service credentials)`);
