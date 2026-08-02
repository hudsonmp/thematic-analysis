-- Re-key bucket forks from PER-CODER to PER-SLOT (Hudson's correction):
-- a fork is an overlay on ONE parent code's step slot (cb_code_bucket_items
-- row), not a coder-private view. The slot belongs to the shared instrument,
-- so any editor may edit it; owner_id becomes provenance-only.

-- No rows exist yet (verified: the per-coder model shipped today and was
-- never used), so the re-key is a clean column addition.
delete from cb_bucket_forks;

alter table cb_bucket_forks add column if not exists item_id uuid;
alter table cb_bucket_forks alter column item_id set not null;
do $$ begin
  alter table cb_bucket_forks
    add constraint cb_bucket_forks_item_fk
    foreign key (item_id) references cb_code_bucket_items(id) on delete cascade;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table cb_bucket_forks add constraint cb_bucket_forks_item_uniq unique (item_id);
exception when duplicate_object then null; end $$;

-- The per-coder key would BLOCK the same editor forking two slots of one
-- bucket — drop it.
alter table cb_bucket_forks drop constraint if exists cb_bucket_forks_bucket_id_owner_id_key;

-- RLS: owner-scoped → editor-scoped (house pattern). Read stays open.
drop policy if exists cb_bucket_forks_ins on cb_bucket_forks;
drop policy if exists cb_bucket_forks_upd on cb_bucket_forks;
drop policy if exists cb_bucket_forks_del on cb_bucket_forks;
create policy cb_bucket_forks_ins on cb_bucket_forks
  for insert with check (cb_is_editor());
create policy cb_bucket_forks_upd on cb_bucket_forks
  for update using (cb_is_editor()) with check (cb_is_editor());
create policy cb_bucket_forks_del on cb_bucket_forks
  for delete using (cb_is_editor());
