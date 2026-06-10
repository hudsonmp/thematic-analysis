create table cb_codebooks (
  id uuid primary key default gen_random_uuid(),
  study_id uuid references studies(id),
  name text not null,
  method text not null default 'directed_content_analysis',
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table cb_facets (
  id uuid primary key default gen_random_uuid(),
  codebook_id uuid not null references cb_codebooks(id) on delete cascade,
  key text not null, label text not null, description text,
  cardinality text not null default 'single' check (cardinality in ('single','multi')),
  position int not null default 0,
  created_at timestamptz not null default now(),
  unique (codebook_id, key)
);
create table cb_facet_values (
  id uuid primary key default gen_random_uuid(),
  facet_id uuid not null references cb_facets(id) on delete cascade,
  key text not null, label text not null, description text, color text,
  position int not null default 0,
  created_at timestamptz not null default now(),
  unique (facet_id, key)
);
create index on cb_facets(codebook_id);
create index on cb_facet_values(facet_id);
