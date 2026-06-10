create table cb_memos (
  id uuid primary key default gen_random_uuid(),
  codebook_id uuid not null references cb_codebooks(id) on delete cascade,
  pid text not null,
  span jsonb,                 -- optional [startMs,endMs]
  author text,
  body text not null,
  created_at timestamptz not null default now()
);
create index on cb_memos(codebook_id);
create index on cb_memos(pid);
