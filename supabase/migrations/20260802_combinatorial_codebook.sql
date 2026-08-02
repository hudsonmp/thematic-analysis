-- Combinatorial codebook v2 (spec: docs/superpowers/specs/2026-08-02-composite-codes-design.md)
-- ADDITIVE ONLY. Existing rows are untouched; existing assignments default to
-- status='attested' (they were plain assertions, which is exactly what attested means).

-- 1 · Modular buckets: the running, shared list. A bucket = a general action
--     (e.g. Review) housing member codes.
create table if not exists cb_buckets (
  id          uuid primary key default gen_random_uuid(),
  codebook_id uuid not null references cb_codebooks(id) on delete cascade,
  name        text not null,
  caption     text,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  unique (codebook_id, name)
);

-- 2 · Bucket membership. `mandatory` marks the infrequent must-assign members.
create table if not exists cb_bucket_codes (
  bucket_id uuid not null references cb_buckets(id) on delete cascade,
  code_id   uuid not null references cb_codes(id) on delete cascade,
  mandatory boolean not null default false,
  position  int not null default 0,
  primary key (bucket_id, code_id)
);

-- 3 · Forks: per-coder overlay, fork = modular + Δ. Δ is jsonb:
--     { addedCodes: [{codeId, mandatory}], mandatoryOverrides: {codeId: bool},
--       caption?: string, removedCodeIds: [codeId] }   (deletions never auto-pull → flagged)
create table if not exists cb_bucket_forks (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  uuid not null references cb_buckets(id) on delete cascade,
  owner_id   uuid not null,
  delta      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  unique (bucket_id, owner_id)
);

-- 4 · Combinatorial definitions: ordered AND items. Each item is EITHER a bucket
--     reference OR a mandatory singleton code (stands in place of a one-code bucket).
--     `interchange_group`: contiguous positions sharing a non-null group are
--     interchangeable (series-parallel order).
create table if not exists cb_code_bucket_items (
  id                uuid primary key default gen_random_uuid(),
  code_id           uuid not null references cb_codes(id) on delete cascade,
  bucket_id         uuid references cb_buckets(id) on delete restrict,
  singleton_code_id uuid references cb_codes(id) on delete restrict,
  position          int not null,
  interchange_group int,
  check ((bucket_id is null) <> (singleton_code_id is null)),
  unique (code_id, position)
);
create index if not exists cb_code_bucket_items_code_idx on cb_code_bucket_items(code_id);

-- 5 · Assignment status + provenance on the existing junction.
--     attested   — asserted, no/partial documented evidence (all pre-existing rows)
--     decomposed — children linked with sub-spans
--     pending    — NOT yet asserted; blocks IRR until resolved
alter table cb_annotation_codes
  add column if not exists status text not null default 'attested',
  add column if not exists snapshot_id uuid,
  add column if not exists order_violated boolean not null default false;
do $$ begin
  alter table cb_annotation_codes
    add constraint cb_annotation_codes_status_chk
    check (status in ('attested','decomposed','pending'));
exception when duplicate_object then null; end $$;

-- 6 · Decomposition / promotion links. Promotion LINKS existing assignments —
--     never copies. `item_id` = which AND-item the child fulfills (a child may
--     double-serve: one row per item). `via_code_id` = subsumption provenance.
create table if not exists cb_assignment_children (
  id                   uuid primary key default gen_random_uuid(),
  parent_annotation_id uuid not null references cb_annotations(id) on delete cascade,
  parent_code_id       uuid not null references cb_codes(id) on delete cascade,
  child_annotation_id  uuid not null references cb_annotations(id) on delete cascade,
  child_code_id        uuid not null references cb_codes(id) on delete cascade,
  item_id              uuid references cb_code_bucket_items(id) on delete set null,
  via_code_id          uuid references cb_codes(id) on delete set null,
  created_at           timestamptz not null default now(),
  unique (parent_annotation_id, parent_code_id, child_annotation_id, child_code_id, item_id)
);
create index if not exists cb_assignment_children_parent_idx
  on cb_assignment_children(parent_annotation_id, parent_code_id);

-- 7 · Codebook snapshots: immutable full-state JSON, monotonic seq, append-only.
--     Cut mandatorily before: IRR session, batch pull, push to modular.
create table if not exists cb_codebook_snapshots (
  id          uuid primary key default gen_random_uuid(),
  codebook_id uuid not null references cb_codebooks(id) on delete cascade,
  seq         int not null,
  reason      text not null check (reason in ('irr','pull','push','manual')),
  payload     jsonb not null,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  unique (codebook_id, seq)
);
do $$ begin
  alter table cb_annotation_codes
    add constraint cb_annotation_codes_snapshot_fk
    foreign key (snapshot_id) references cb_codebook_snapshots(id) on delete set null;
exception when duplicate_object then null; end $$;

-- 8 · Append-only event log: assignment lifecycle + bucket push/pull events.
create table if not exists cb_assignment_events (
  id       uuid primary key default gen_random_uuid(),
  at       timestamptz not null default now(),
  actor_id uuid,
  kind     text not null,
  payload  jsonb not null default '{}'::jsonb
);
create index if not exists cb_assignment_events_kind_idx on cb_assignment_events(kind, at);

-- RLS: house pattern — read for all authenticated, writes for editors.
-- Snapshots + events get NO update/delete policies: append-only is enforced by
-- policy absence under RLS.
alter table cb_buckets enable row level security;
alter table cb_bucket_codes enable row level security;
alter table cb_bucket_forks enable row level security;
alter table cb_code_bucket_items enable row level security;
alter table cb_assignment_children enable row level security;
alter table cb_codebook_snapshots enable row level security;
alter table cb_assignment_events enable row level security;

do $$
declare t text;
begin
  foreach t in array array['cb_buckets','cb_bucket_codes',
                           'cb_code_bucket_items','cb_assignment_children'] loop
    execute format('create policy %I on %I for select using (true)', t || '_read', t);
    execute format('create policy %I on %I for insert with check (cb_is_editor())', t || '_ins', t);
    execute format('create policy %I on %I for update using (cb_is_editor()) with check (cb_is_editor())', t || '_upd', t);
    execute format('create policy %I on %I for delete using (cb_is_editor())', t || '_del', t);
  end loop;
  -- append-only pair: select + insert only
  foreach t in array array['cb_codebook_snapshots','cb_assignment_events'] loop
    execute format('create policy %I on %I for select using (true)', t || '_read', t);
    execute format('create policy %I on %I for insert with check (cb_is_editor())', t || '_ins', t);
  end loop;
end $$;

-- Forks are PER-CODER: anyone can read, only the owner writes their own Δ.
create policy cb_bucket_forks_read on cb_bucket_forks for select using (true);
create policy cb_bucket_forks_ins on cb_bucket_forks
  for insert with check (cb_is_editor() and owner_id = auth.uid());
create policy cb_bucket_forks_upd on cb_bucket_forks
  for update using (cb_is_editor() and owner_id = auth.uid())
  with check (cb_is_editor() and owner_id = auth.uid());
create policy cb_bucket_forks_del on cb_bucket_forks
  for delete using (cb_is_editor() and owner_id = auth.uid());
