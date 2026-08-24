-- 45_action_schema — (Applied 2026-08-20.) ACTIONS = MOVE(s) × OBJECT(s), the
-- low-level, objective coding layer that sits UNDER the existing codebook.
--
-- The existing codebook is a taxonomy of epistemic actions whose codes are
-- "loaded" (observable act + inferred cognition + outcome bundled together),
-- which is what makes κ hard to reach. An ACTION is a deliberately thin unit:
-- one or more MOVES (create / revise / review / trace / recall …) performed on
-- one or more OBJECTS (goal / entity / element / specification / scenario …).
-- Codes are later assigned to actions post hoc; this migration only defines
-- the vocabulary and the action catalog — nothing here touches cb_annotations.
--
-- Shape (all codebook-scoped):
--   * cb_action_moves    — the move vocabulary. `min_objects` (default 1) is the
--                          fewest objects an action using this move must name.
--   * cb_action_objects  — the object vocabulary.
--   * cb_action_questions — extra questions the researcher attaches to every
--                          action ("Did external factors play a role?"). `kind`
--                          is free_text or multiple_choice; `required` marks a
--                          question mandatory when an action is authored.
--   * cb_action_question_options — the choices of a multiple_choice question.
--                          Each option may declare WHAT HAPPENS when chosen:
--                          `trigger_action_id` (this choice implies a subsequent
--                          action) and/or `follow_up_question_id` (ask another
--                          question next). Both nullable, both `set null` on
--                          delete so removing a target never deletes the option.
--   * cb_actions         — the catalog entry: name + description, composed of
--                          moves (cb_action_moves_link) and objects
--                          (cb_action_objects_link), with the questions answered
--                          in cb_action_answers (one row per question per action;
--                          `option_id` for multiple_choice, `free_text` otherwise).
--
-- RLS: read-all to `authenticated`; NO write policies — every write goes through
-- the service-role client behind requireEditor() in app/actions/action-schema.ts
-- (the same gate as codes/facets/labels/flag-types).
--
-- Additive cb_ only. Does NOT touch study/onboarding/users tables.

create table if not exists cb_action_moves (
  id uuid primary key default gen_random_uuid(),
  codebook_id uuid not null references cb_codebooks(id) on delete cascade,
  name text not null,
  description text,
  min_objects integer not null default 1 check (min_objects >= 1),
  position integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists cb_action_moves_codebook_idx on cb_action_moves (codebook_id, position);

create table if not exists cb_action_objects (
  id uuid primary key default gen_random_uuid(),
  codebook_id uuid not null references cb_codebooks(id) on delete cascade,
  name text not null,
  description text,
  position integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists cb_action_objects_codebook_idx on cb_action_objects (codebook_id, position);

create table if not exists cb_action_questions (
  id uuid primary key default gen_random_uuid(),
  codebook_id uuid not null references cb_codebooks(id) on delete cascade,
  prompt text not null,
  description text,
  kind text not null default 'free_text' check (kind in ('free_text', 'multiple_choice')),
  required boolean not null default false,
  position integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists cb_action_questions_codebook_idx on cb_action_questions (codebook_id, position);

create table if not exists cb_actions (
  id uuid primary key default gen_random_uuid(),
  codebook_id uuid not null references cb_codebooks(id) on delete cascade,
  name text not null,
  description text,
  position integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists cb_actions_codebook_idx on cb_actions (codebook_id, position);

create table if not exists cb_action_question_options (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references cb_action_questions(id) on delete cascade,
  label text not null,
  position integer not null default 0,
  trigger_action_id uuid references cb_actions(id) on delete set null,
  follow_up_question_id uuid references cb_action_questions(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists cb_action_question_options_question_idx on cb_action_question_options (question_id, position);

create table if not exists cb_action_moves_link (
  action_id uuid not null references cb_actions(id) on delete cascade,
  move_id uuid not null references cb_action_moves(id) on delete cascade,
  primary key (action_id, move_id)
);

create table if not exists cb_action_objects_link (
  action_id uuid not null references cb_actions(id) on delete cascade,
  object_id uuid not null references cb_action_objects(id) on delete cascade,
  primary key (action_id, object_id)
);

create table if not exists cb_action_answers (
  action_id uuid not null references cb_actions(id) on delete cascade,
  question_id uuid not null references cb_action_questions(id) on delete cascade,
  option_id uuid references cb_action_question_options(id) on delete set null,
  free_text text,
  primary key (action_id, question_id)
);

alter table cb_action_moves enable row level security;
alter table cb_action_objects enable row level security;
alter table cb_action_questions enable row level security;
alter table cb_actions enable row level security;
alter table cb_action_question_options enable row level security;
alter table cb_action_moves_link enable row level security;
alter table cb_action_objects_link enable row level security;
alter table cb_action_answers enable row level security;

drop policy if exists cb_action_moves_read on cb_action_moves;
create policy cb_action_moves_read on cb_action_moves for select to authenticated using (true);
drop policy if exists cb_action_objects_read on cb_action_objects;
create policy cb_action_objects_read on cb_action_objects for select to authenticated using (true);
drop policy if exists cb_action_questions_read on cb_action_questions;
create policy cb_action_questions_read on cb_action_questions for select to authenticated using (true);
drop policy if exists cb_actions_read on cb_actions;
create policy cb_actions_read on cb_actions for select to authenticated using (true);
drop policy if exists cb_action_question_options_read on cb_action_question_options;
create policy cb_action_question_options_read on cb_action_question_options for select to authenticated using (true);
drop policy if exists cb_action_moves_link_read on cb_action_moves_link;
create policy cb_action_moves_link_read on cb_action_moves_link for select to authenticated using (true);
drop policy if exists cb_action_objects_link_read on cb_action_objects_link;
create policy cb_action_objects_link_read on cb_action_objects_link for select to authenticated using (true);
drop policy if exists cb_action_answers_read on cb_action_answers;
create policy cb_action_answers_read on cb_action_answers for select to authenticated using (true);
