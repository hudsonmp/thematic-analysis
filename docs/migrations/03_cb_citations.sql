create table cb_citations (
  id uuid primary key default gen_random_uuid(),
  codebook_id uuid not null references cb_codebooks(id) on delete cascade,
  bibtex_key text, bibtex_raw text not null,
  title text, authors text, year int, doi text, url text, parsed jsonb,
  created_at timestamptz not null default now(),
  unique (codebook_id, bibtex_key)
);
create table cb_code_citations (
  code_id uuid not null references cb_codes(id) on delete cascade,
  citation_id uuid not null references cb_citations(id) on delete cascade,
  role text default 'derived_from' check (role in ('derived_from','near_miss')),
  primary key (code_id, citation_id)
);
create index on cb_citations(codebook_id);
create index on cb_code_citations(code_id);
create index on cb_code_citations(citation_id);
