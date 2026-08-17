-- 44_exemplar_docs — (Applied 2026-08-17.) The admin-authored WORKED-EXAMPLE document, one tab per code.
--
-- /exemplars is a Google-Docs-shaped instruction surface: the researcher writes
-- (or pastes) a transcript / dialogue excerpt, highlights spans, and leaves
-- comments explaining WHY a span would be coded a certain way. Coders read it;
-- only the admin writes it. It is NOT data — nothing here touches cb_annotations,
-- cb_sessions, or the κ pool.
--
-- Shape:
--   * A TAB is a code. Tabs are DERIVED from cb_codes (non-retired), so a new
--     code gets a tab and a renamed code's tab follows the mnemonic with no sync
--     logic; a merged/retired code's tab disappears from the list but its row is
--     kept (audit provenance, and it reappears if the code is un-retired).
--   * cb_exemplar_docs is that tab's body: ONE row per code, created lazily on
--     first save. `body` is the editor's document JSON (ProseMirror doc). Spans
--     carry a `comment` mark whose `threadId` is the anchor for comment rows.
--   * cb_exemplar_comments are the comments on a thread (thread_id = the mark id
--     inside the doc). Anchoring lives in the doc JSON, not in a char range, so
--     it survives later edits. A thread whose mark was deleted from the doc is
--     orphaned and simply not rendered.
--
-- RLS: read-all to `authenticated` (coders review it); NO write policies — every
-- write goes through the service-role client behind requireAdmin() in
-- app/actions/exemplars.ts. A non-admin JWT cannot write these rows however the
-- client is driven.
--
-- Additive cb_ only. Does NOT touch study/onboarding/users tables.

create table if not exists cb_exemplar_docs (
  code_id uuid primary key references cb_codes(id) on delete cascade,
  codebook_id uuid not null references cb_codebooks(id) on delete cascade,
  body jsonb not null default '{"type":"doc","content":[]}'::jsonb,
  updated_at timestamptz not null default now()
);
create index if not exists cb_exemplar_docs_codebook_idx on cb_exemplar_docs (codebook_id);

create table if not exists cb_exemplar_comments (
  id uuid primary key default gen_random_uuid(),
  code_id uuid not null references cb_exemplar_docs(code_id) on delete cascade,
  thread_id uuid not null,
  author_id uuid not null references auth.users(id),
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists cb_exemplar_comments_code_idx on cb_exemplar_comments (code_id, thread_id, created_at);

alter table cb_exemplar_docs enable row level security;
alter table cb_exemplar_comments enable row level security;

drop policy if exists cb_exemplar_docs_read on cb_exemplar_docs;
create policy cb_exemplar_docs_read on cb_exemplar_docs
  for select to authenticated using (true);

drop policy if exists cb_exemplar_comments_read on cb_exemplar_comments;
create policy cb_exemplar_comments_read on cb_exemplar_comments
  for select to authenticated using (true);
