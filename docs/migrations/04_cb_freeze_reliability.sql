create table cb_codebook_versions (
  id uuid primary key default gen_random_uuid(),
  codebook_id uuid not null references cb_codebooks(id) on delete cascade,
  label text not null, snapshot jsonb not null,
  frozen_at timestamptz not null default now(), frozen_by text, note text,
  calibration_round int
);
create table cb_coder_comments (
  id uuid primary key default gen_random_uuid(),
  code_id uuid not null references cb_codes(id) on delete cascade,
  -- code_version is a plain int (no composite FK): a (code_id, code_version) FK with
  -- ON DELETE SET NULL conflicts with code_id NOT NULL. See migration 05. Versions are
  -- append-only, so referential enforcement on the version int is unnecessary here.
  code_version int, author text not null, body text not null,
  resolved boolean not null default false,
  created_at timestamptz not null default now()
);
create table cb_reliability_runs (
  id uuid primary key default gen_random_uuid(),
  codebook_id uuid not null references cb_codebooks(id) on delete cascade,
  codebook_version_id uuid references cb_codebook_versions(id),
  scope text not null check (scope in ('overall','facet_value','code')),
  scope_facet_value_id uuid references cb_facet_values(id) on delete cascade,
  scope_code_id uuid references cb_codes(id) on delete cascade,
  n_units int, n_coders int default 2,
  percent_agreement numeric, cohen_kappa numeric, pabak numeric,
  krippendorff_alpha numeric, prevalence_index numeric, bias_index numeric,
  raw_labels jsonb, dismissed_note text,
  computed_at timestamptz not null default now(), note text,
  check (
    (scope='overall' and scope_facet_value_id is null and scope_code_id is null) or
    (scope='facet_value' and scope_facet_value_id is not null and scope_code_id is null) or
    (scope='code' and scope_code_id is not null and scope_facet_value_id is null))
);
create table cb_codings (
  id uuid primary key default gen_random_uuid(),
  code_id uuid not null references cb_codes(id),
  code_version int, codebook_version_id uuid references cb_codebook_versions(id),
  coder text, episode_ref jsonb,
  created_at timestamptz not null default now(),
  foreign key (code_id, code_version) references cb_code_versions(code_id, version) on delete restrict
);
create index on cb_codebook_versions(codebook_id);
create index on cb_coder_comments(code_id);
create index on cb_reliability_runs(codebook_id);
create index on cb_reliability_runs(codebook_version_id);
create index on cb_codings(code_id);
create index on cb_codings(codebook_version_id);
