create table cb_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text, initials text,
  created_at timestamptz not null default now()
);
alter table cb_profiles enable row level security;
create policy cb_profiles_self_rw on cb_profiles
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy cb_profiles_read_all on cb_profiles
  for select to authenticated using (true);

do $$ declare t text; begin
  foreach t in array array['cb_codebooks','cb_facets','cb_facet_values','cb_codes',
    'cb_code_versions','cb_code_facet_values','cb_citations','cb_code_citations',
    'cb_codebook_versions','cb_coder_comments','cb_reliability_runs','cb_memos']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I_auth_all on %I', t, t);
    execute format('create policy %I_auth_all on %I for all to authenticated using (true) with check (true)', t, t);
  end loop;
end $$;
