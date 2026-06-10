create table cb_codes (
  id uuid primary key default gen_random_uuid(),
  codebook_id uuid not null references cb_codebooks(id) on delete cascade,
  mnemonic text not null, name text not null,
  origin text not null check (origin in ('a_priori','pilot','emergent')),
  status text not null default 'proposed' check (status in ('proposed','active','merged','retired')),
  parent_code_id uuid references cb_codes(id),
  current_version_id uuid,
  created_at timestamptz not null default now(),
  retired_at timestamptz,
  unique (codebook_id, mnemonic)
);
create table cb_code_versions (
  id uuid primary key default gen_random_uuid(),
  code_id uuid not null references cb_codes(id) on delete cascade,
  version int not null,
  definition text not null,
  include_if jsonb not null default '[]',
  exclude_if jsonb not null default '[]',
  exemplars jsonb not null default '[]',
  disconfirming_pattern text,
  prediction text, prediction_falsifier text,
  change_note text,
  created_at timestamptz not null default now(),
  created_by text,
  unique (code_id, version)
);
alter table cb_codes add constraint cb_codes_current_version_fk
  foreign key (current_version_id) references cb_code_versions(id);
create table cb_code_facet_values (
  code_id uuid not null references cb_codes(id) on delete cascade,
  facet_value_id uuid not null references cb_facet_values(id) on delete cascade,
  primary key (code_id, facet_value_id)
);
create index on cb_codes(codebook_id);
create index on cb_code_versions(code_id);
create index on cb_code_facet_values(code_id);
create index on cb_code_facet_values(facet_value_id);
