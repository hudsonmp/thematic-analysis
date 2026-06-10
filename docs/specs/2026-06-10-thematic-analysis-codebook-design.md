# Thematic-Analysis Codebook — Design Spec (MVP)

**Date:** 2026-06-10
**Author:** Hudson Mitchell-Pullman (with Claude Code)
**Status:** Approved design → spec reviewed (adversarial pass applied) → pending user review → implementation plan
**Companion document:** `~/Desktop/Readings - Claude/06-09-2026-methods-guide.pdf`
("Mapping Novice Impasses in Specification Design"). Section references (§) below
point into that guide.

---

## 0. One-paragraph summary

A separate Next.js + Supabase tool (repo `thematic-analysis`) for authoring the
**directed-content-analysis codebook** (Hsieh & Shannon, 2005) used to code the
think-aloud requirement-engineering ("rideshare") study run on the `spec-study-app`
platform. The codebook is a **versioned instrument with a freeze gate**, not a flat
list: codes carry full anatomy + falsifiable predictions, are organized by a
**modular, user-defined facet scheme** (Stage, Locus, … — editable at runtime, not
hard-coded), cite their source theory via pasted BibTeX, accrue coder comments during
the review period, and support inter-rater reliability recording (§2.9: percent
agreement, Cohen's κ, PABAK, Krippendorff's α) tagged to a frozen codebook version.
It binds to the live study protocol read-only and leaves a schema-ready seam for the
**deferred** session-playback / apply-codes-to-sessions feature.

---

## 1. Goals, non-goals, and the epistemic frame

### 1.1 Goals (MVP)
1. Author codes with the full anatomy (§2.6) and a falsifiable prediction (§3.2/§4.2).
2. Organize codes in a **modular** classification scheme — dimensions ("facets") and
   their values are data the user edits, *not* hard-coded enums. Ships empty.
3. Distinguish code **origin**: `a_priori` (theory-derived spine, §2.8), `pilot`
   (residue from pilot coding, §3.1), `emergent` (added during main coding).
4. Attach source citations to codes by pasting BibTeX (one or many) into a library,
   then linking codes to entries.
5. Record reliability per **frozen codebook version** (§2.9): the full
   {percent agreement, Cohen's κ, PABAK, Krippendorff's α, prevalence/bias index}
   stack, computed from a pasted two-coder label table.
6. Capture **coder comments** per code during the calibration/review period.
7. **Version** every code-definition edit with a dated change note; support an explicit
   **freeze** event that snapshots the whole codebook (§11 #9, §2.9).
8. **Connect to the study protocol**: read the rideshare study's structure
   (`enumerateScreens`) read-only so episodes/screens are referenceable and the
   apply-to-sessions seam is foreign-key-ready.
9. Export the codebook to **LaTeX** (methods-section table) and **JSON** (machine
   backup / re-import). Markdown intentionally dropped (LaTeX is the publication
   format per the author's standing convention).

### 1.2 Non-goals (deferred; schema-ready, no UI in MVP)
- Session **playback** by researcher number (PID).
- Applying codes to live transcripts/events/snapshots (the `cb_codings` table is
  defined but unused by UI in MVP).
- **Auto**-computing κ from applied codings — MVP computes κ from a *pasted* label
  table, which needs no session-coding UI.
- Any generalization beyond the single rideshare protocol.
- Deploy to VT Vercel (MVP runs locally; deploy gated like `spec-study-app`).

### 1.3 Epistemic frame (a hard requirement, not commentary)
The tool implements **directed content analysis / coding-reliability (codebook) TA** —
a (post)positivist stance for which κ is a coherent validity warrant. It must **name
its method honestly** (`cb_codebooks.method` defaults to `directed_content_analysis`)
and must **not** present itself as *reflexive* thematic analysis. Reviewers (per
Padiyath & Nelson-Fromm, 2025) actively catch codebooks that cite reflexive
Braun–Clarke as the warrant for a κ workflow; the tool's copy and exports avoid that
incoherence. Satisfied by: (a) the `method` field; (b) export templates that cite the
coding-reliability/codebook strand (Boyatzis 1998; MacQueen et al. 1998; Hsieh &
Shannon 2005), never reflexive TA, as the κ warrant.

---

## 2. Architecture

### 2.1 Repo & stack
- New GitHub repo **`thematic-analysis`** (owner `hudsonmp`), independent of
  `spec-study-app`.
- **Next.js App Router + TypeScript + Tailwind**, `@supabase/ssr` +
  service-role client, `iron-session` + `zod` — mirroring `spec-study-app`'s stack.
  AGENTS.md caveat from that repo applies: Next.js 16 APIs differ from training data;
  read `node_modules/next/dist/docs/` before writing framework-specific code.
- Researcher-only auth: single `RESEARCHER_PASSWORD` gate + iron-session cookie,
  pattern copied from `spec-study-app/lib/auth/researcher.ts` (confirmed copyable;
  depends only on `iron-session` config + `RESEARCHER_PASSWORD`, `COOKIE_SECRET`,
  `NODE_ENV`). `created_by`/comment-author identity = the researcher label from this
  session.
- Env: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY` (VT project `wuvtffnomynoafbilzxw`),
  `RESEARCHER_PASSWORD`, `COOKIE_SECRET`. `.env.local` gitignored.
- tsconfig must set `baseUrl: "."` + `paths: { "@/*": ["./"] }` so the vendored
  platform files (which import `@/lib/types/study`) resolve.

### 2.2 Connection model (Option A — same project, read-only against study data)
- All codebook tables live in the **same** VT Supabase project
  (`wuvtffnomynoafbilzxw`) with a **`cb_` prefix**.
- **The read-only-against-study-data guarantee is code-enforced + contractual, NOT
  RLS-enforced** — the service-role key bypasses RLS, so nothing at the DB layer stops
  a write. Enforcement mechanism (must be implemented):
  1. All mutations route through a `cbWrite(table)` helper that throws unless
     `table` matches `^cb_`.
  2. Study-table access goes through a `readStudy*()` helper that only issues
     `select`.
  3. An ESLint rule / CI grep forbids `.from('study` / `.from('users` / `.from(
     'onboarding` followed by `.insert|.update|.delete|.upsert` anywhere in the repo.
  4. Verification (§6): after the test suite, query the study tables for any row with
     `created_at`/`updated_at` newer than the run start → must be zero.
- Rationale for sharing the project: the eventual apply-to-sessions / playback join is
  a foreign key away, with zero migration and reuse of the existing service-role
  client. Blast-radius mitigations are items 1–4 above + the security-advisor pass.

### 2.3 Protocol binding (what "connects to the study protocol" means)
- `cb_codebooks.study_id` FK → `studies.id`. The rideshare study is located by the
  same query the platform uses to serve it: `select id, name, authored_data from
  studies where visibility = 'shown'` (the `studies` table uses a `visibility` enum
  `'shown'|'hidden'|'archived'`, **not** an `active` boolean — verified in
  `spec-study-app/app/study/page.tsx`). A codebook may bind to any study row
  regardless of visibility; the picker defaults to the `shown` one.
- The tool **vendors a read-only mirror** of `spec-study-app`'s `lib/types/study.ts`
  (zero imports) and `lib/study/screens.ts` (`enumerateScreens`; its only import is
  `@/lib/types/study`). Both copied into `lib/study/` of this repo with a header:
  `// MIRRORED FROM spec-study-app @ <git-sha> — keep in sync; do not edit semantics`.
  The `<git-sha>` is the source commit, enabling drift detection.
- **Episode-reference picker** (downscoped from a full protocol renderer): the tool
  runs `enumerateScreens(authored_data.content)` to derive the participant flow and
  offers a compact, read-only **Module → Scenario → Phase** picker so exemplars can
  cite a specific episode `(module_id, scenario_idx, phase)` (the Episode unit, §2.4),
  plus a small read-only summary of the bound study. No full interactive renderer.

---

## 3. Data model

All tables `cb_`-prefixed. PostgreSQL. `id uuid default gen_random_uuid()`,
`created_at timestamptz default now()` on every table unless noted. Applied via
`mcp__vt-supabase__apply_migration`, one migration per logical group; types
regenerated with `mcp__vt-supabase__generate_typescript_types` → `lib/types/cb-db.ts`;
`mcp__vt-supabase__get_advisors type=security` run after, FK indexes resolved.

### 3.1 Codebook root
```
cb_codebooks
  id
  study_id        uuid null references studies(id)   -- the bound study (read-only use)
  name            text not null
  method          text not null default 'directed_content_analysis'
  description     text
  created_at
  updated_at      timestamptz default now()          -- set app-side on child writes
```

### 3.2 Modular scheme — facets & values (the editable dimensions)
```
cb_facets
  id
  codebook_id     uuid not null references cb_codebooks(id) on delete cascade
  key             text not null            -- machine key, e.g. 'stage'
  label           text not null            -- display, e.g. 'Stage'
  description     text
  cardinality     text not null default 'single'  -- 'single' | 'multi'
  position        int  not null default 0
  unique (codebook_id, key)

cb_facet_values
  id
  facet_id        uuid not null references cb_facets(id) on delete cascade
  key             text not null            -- e.g. 'monitor'
  label           text not null
  description     text
  color           text
  position        int  not null default 0
  unique (facet_id, key)
```
Ships **empty** (no seeded facets or values). κ reporting and the matrix pivot group
by any facet. `cardinality='single'` → at most one value per code on that facet;
`'multi'` → several.

### 3.3 Codes — stable identity vs. versioned anatomy
```
cb_codes                              -- stable across versions
  id
  codebook_id        uuid not null references cb_codebooks(id) on delete cascade
  mnemonic           text not null            -- stable handle, e.g. 'MON-ABSENT'
  name               text not null
  origin             text not null            -- 'a_priori' | 'pilot' | 'emergent'
  status             text not null default 'proposed'
                                              -- 'proposed'|'active'|'merged'|'retired'
  parent_code_id     uuid null references cb_codes(id)   -- sub-codes / merge target
  current_version_id uuid null references cb_code_versions(id) deferrable
                                              -- atomically updated on each new version;
                                              -- avoids a max(version) lookup + edit race
  created_at
  retired_at         timestamptz
  unique (codebook_id, mnemonic)

cb_code_versions                      -- the §2.6 anatomy, one row per edit (immutable)
  id
  code_id              uuid not null references cb_codes(id) on delete cascade
  version              int  not null
  definition           text not null   -- one sentence, mechanism-level, names its stage
  include_if           jsonb not null default '[]'  -- string[] (bulleted criteria)
  exclude_if           jsonb not null default '[]'  -- string[]; each NAMES the rival code
  exemplars            jsonb not null default '[]'  -- Exemplar[] (shape below)
  disconfirming_pattern text          -- what in the data would show the code is
                                       -- MIS-CARVED entirely (stronger than exclude_if,
                                       -- which only names the adjacent rival code) — §2.6
  prediction           text           -- "novices will…" (§3.2/§4.2)
  prediction_falsifier text           -- "I'd know it's wrong if…"
  change_note          text           -- dated revision rationale (DeCuir-Gunby)
  created_at
  created_by           text           -- researcher label from iron-session
  unique (code_id, version)

cb_code_facet_values                  -- code ↔ facet-value tags (live; identity-level)
  code_id          uuid not null references cb_codes(id) on delete cascade
  facet_value_id   uuid not null references cb_facet_values(id) on delete cascade
  primary key (code_id, facet_value_id)
```
**JSONB shapes (validated with Zod at the app layer on read/write; documented here as
the contract):**
- `include_if`, `exclude_if`: `string[]`.
- `Exemplar` (in `exemplars`): `{ text: string, source_pid?: string,
  episode_ref?: EpisodeRef }`.
- `EpisodeRef`: `{ module_id: string, scenario_idx: number,
  phase: 'initial'|'read'|'ponder'|'revise'|'retro'|'final', span?: [number, number] }`
  — `span` is an optional transcript offset (ms or char range), forward-compat for the
  deferred audio/transcript coding (guide §7); the platform has **no** span column, so
  it is never populated from study data in MVP.

**Facet-versioning resolution (adversarial-review item):** facet tags are kept
identity-level (live join) to preserve FK integrity and a clean matrix pivot. The
audit concern — re-classifying a code mid-study would retroactively change
κ-per-facet — is resolved by the **freeze snapshot** (§3.5) being the source of truth
for κ: every reliability run references a frozen `cb_codebook_versions` row whose
snapshot records each code's facet assignments at freeze time. Pre-freeze re-tagging
is expected (that is what calibration is for); post-freeze the codebook is immutable.

### 3.4 Citations (BibTeX library)
```
cb_citations
  id
  codebook_id     uuid not null references cb_codebooks(id) on delete cascade
  bibtex_key      text
  bibtex_raw      text not null          -- pasted entry, verbatim
  title           text
  authors         text
  year            int
  doi             text
  url             text
  parsed          jsonb
  created_at
  unique (codebook_id, bibtex_key)

cb_code_citations
  code_id          uuid not null references cb_codes(id) on delete cascade
  citation_id      uuid not null references cb_citations(id) on delete cascade
  role             text default 'derived_from'  -- 'derived_from' | 'near_miss'
  primary key (code_id, citation_id)
```
Paste one entry or a whole `.bib` blob → parse `@type{key, title, author, year, doi,
url}` into columns, keep `bibtex_raw`. Linking a code to a citation is the "check the
citation for the coding scheme" action (§2.8 Source column).

### 3.5 Freeze gate & versioning
```
cb_codebook_versions
  id
  codebook_id       uuid not null references cb_codebooks(id) on delete cascade
  label             text not null      -- e.g. 'v1-frozen-2026-08-01'
  snapshot          jsonb not null     -- full state at freeze (schema below)
  frozen_at         timestamptz default now()
  frozen_by         text
  note              text
  calibration_round int                -- which round this freeze concludes
```
`snapshot` JSON schema (built server-side in a single read at freeze; no DB trigger):
```
{ frozen_at, codes: [ { id, mnemonic, name, origin, status,
    current_version: { version, definition, include_if, exclude_if, exemplars,
                       disconfirming_pattern, prediction, prediction_falsifier },
    facet_values: [ { facet_key, value_key } ],
    citations: [ bibtex_key ] } ],
  facets: [ { key, label, cardinality, values: [ { key, label } ] } ],
  citations: [ { bibtex_key, title, authors, year, doi } ] }
```
Discipline (§2.9 / §11 #9): codebook seeded on pilots, extended with a dated change
log, **frozen after pilot calibration reaches κ ≥ .70 and before main independent
coding begins**. Post-freeze, code definitions are immutable for that version;
emergent codes are added as new codes (origin `emergent`) and require a new freeze.
Every reliability run references the frozen version it was computed under.

### 3.6 Coder comments (review period)
```
cb_coder_comments
  id
  code_id          uuid not null references cb_codes(id) on delete cascade
  code_version     int                    -- nullable: null = about the code generally
  author           text not null
  body             text not null
  resolved         boolean not null default false
  created_at
  foreign key (code_id, code_version)
    references cb_code_versions(code_id, version) on delete set null
```

### 3.7 Reliability (§2.9)
```
cb_reliability_runs
  id
  codebook_id           uuid not null references cb_codebooks(id) on delete cascade
  codebook_version_id   uuid references cb_codebook_versions(id)   -- the frozen version
  scope                 text not null      -- 'overall' | 'facet_value' | 'code'
  scope_facet_value_id  uuid references cb_facet_values(id) on delete cascade
  scope_code_id         uuid references cb_codes(id) on delete cascade
  n_units               int
  n_coders              int default 2
  percent_agreement     numeric
  cohen_kappa           numeric
  pabak                 numeric            -- null unless scope is binary (see §4)
  krippendorff_alpha    numeric
  prevalence_index      numeric
  bias_index            numeric
  raw_labels            jsonb              -- the pasted two-coder table, for audit
  dismissed_note        text               -- rationale if a mis-carved flag is dismissed
  computed_at           timestamptz default now()
  note                  text
  check (
    (scope = 'overall'      and scope_facet_value_id is null and scope_code_id is null) or
    (scope = 'facet_value'  and scope_facet_value_id is not null and scope_code_id is null) or
    (scope = 'code'         and scope_code_id is not null and scope_facet_value_id is null)
  )
```
Two typed nullable FKs + CHECK replace the original untyped `scope_ref` (gives FK
integrity without a junction table).

### 3.8 Deferred seam (defined, no MVP UI)
```
cb_codings
  id
  code_id              uuid not null references cb_codes(id)
  code_version         int
  codebook_version_id  uuid references cb_codebook_versions(id)
  coder                text
  episode_ref          jsonb   -- one of two documented variants (Zod-validated):
                               --  snapshot-keyed: { kind:'snapshot', user_id, study_id,
                               --     module_id, scenario_idx, phase, span? }
                               --  event-keyed:    { kind:'event', user_id, study_id,
                               --     event_id }
  created_at
  foreign key (code_id, code_version)
    references cb_code_versions(code_id, version) on delete restrict
```
`episode_ref` keys are aligned to the real platform columns in `study_snapshots`
(`user_id, study_id, module_id, scenario_idx, phase`) and `study_events`
(`user_id, study_id, id, event_type, payload`) — verified in
`spec-study-app/lib/types/db.ts`.

### 3.9 Indexes
```
create index on cb_facets(codebook_id);
create index on cb_facet_values(facet_id);
create index on cb_codes(codebook_id);
create index on cb_code_versions(code_id);
create index on cb_code_facet_values(code_id);
create index on cb_code_facet_values(facet_value_id);
create index on cb_citations(codebook_id);
create index on cb_code_citations(code_id);
create index on cb_code_citations(citation_id);
create index on cb_codebook_versions(codebook_id);
create index on cb_coder_comments(code_id);
create index on cb_reliability_runs(codebook_id);
create index on cb_reliability_runs(codebook_version_id);
create index on cb_codings(code_id);
create index on cb_codings(codebook_version_id);
```

---

## 4. Reliability math (must be implemented correctly; §2.9 + kappa-paradox literature)

Given a two-coder label table over N units (one categorical label per coder per unit):

- **Percent agreement** `P_o = (#units where A = B) / N`. Reported, never alone.
- **Cohen's κ** `= (P_o − P_e) / (1 − P_e)`, `P_e = Σ_k (p_Ak · p_Bk)` over categories
  k, with `p_Ak`, `p_Bk` the marginal proportions for coders A, B.
- **PABAK** (Byrt, Bishop & Carlin, 1993) `= 2·P_o − 1`. **Computed only for a *binary
  scope*** — defined precisely as: a `code` or `facet_value` scope whose two-coder
  contingency table has exactly two distinct labels (present/absent). For
  multi-category scopes, `pabak` is null and the tool reports an explicit
  **prevalence index** and **bias index** instead.
- **Krippendorff's α** `= 1 − D_o / D_e` (disagreement-based). MVP: **nominal level,
  two coders, complete data**, using the coincidence-matrix (pairable-values)
  formulation of Hayes & Krippendorff (2007). If >2 coders or missing/uncodable values
  are supplied, the tool **flags and refuses to silently degrade** (records a note;
  ordinal/interval α and n-coder α are out of MVP scope).
- **Prevalence index** and **bias index** computed per scope (the κ-paradox diagnostics).
- **Landis & Koch (1977)** bands for κ display: `<0` poor; `.01–.20` slight;
  `.21–.40` fair; `.41–.60` moderate; `.61–.80` substantial; `.81–1` almost perfect —
  labelled conventional, not principled.
- **Mis-carved flag (advisory, not blocking):** any `code`/`facet_value` scope with
  `κ < 0.5` is surfaced as an *advisory* flag (not an error state) shown beside its
  prevalence/bias indices, with the §2.9 guidance "split / merge / sharpen near-miss."
  Flags fire on κ compute and can be dismissed with a rationale stored in
  `dismissed_note`. Sparse-cell κ depression (high `P_o`, low κ) is expected, not a
  coding failure — the prevalence/bias display makes this legible.

All statistics are pure functions in `lib/reliability/` with unit tests against
hand-computed fixtures — including a deliberate kappa-paradox case (high `P_o`, low κ)
and a binary-scope PABAK case, pinned to a published worked example, not self-generated
numbers.

---

## 5. UI surfaces (MVP)

1. **Scheme / matrix view** (`/`) — pivot codes by any two facets (user picks rows &
   columns); add/rename/reorder/delete facets and values inline; empty state when no
   facets. Cells show code chips (mnemonic + status color); untagged codes sit in an
   "unassigned" lane.
2. **Code card** (`/codes/[id]`) — the §2.6 anatomy editor: name, mnemonic, definition,
   include-if (bulleted), exclude-if (bulleted), exemplars (bulleted, each with an
   optional episode reference via the picker below), disconfirming pattern, prediction
   + falsifier, origin, status, facet tags, linked citations (multi-select from
   library), **version history** (read prior versions + change notes; "save as new
   version" bumps `version` and updates `cb_codes.current_version_id` atomically),
   **coder-comments thread**. The episode picker is an optional **Module → Scenario →
   Phase** breadcrumb sourced from `enumerateScreens`; selection is stored in the
   `episode_ref` JSONB (no hard FK); on save it is validated against the current
   `enumerateScreens` output and warns if stale.
3. **Citation library** (`/citations`) — paste BibTeX (single or whole-file blob) →
   parsed entries; edit/delete; link to codes.
4. **Reliability panel** (`/reliability`) — calibration-round tracker; **Freeze** action
   (snapshots codebook → `cb_codebook_versions`); per-frozen-version κ runs: paste a
   two-coder label table (CSV/TSV) → compute {P_o, κ, PABAK (binary only), α,
   prevalence, bias} per facet-value + overall; Landis–Koch band; advisory mis-carved
   flags with dismiss-with-rationale.
5. **Export** (`/export`) — codebook → **LaTeX** table (methods section; cites the
   coding-reliability strand for the κ warrant, never reflexive TA) and **JSON**.

---

## 6. Verification plan

1. `mcp__vt-supabase__list_tables` → all `cb_*` tables present; existing study tables
   untouched (same count + schema as before).
2. `mcp__vt-supabase__get_advisors type=security` → resolve warnings (FK indexes per §3.9).
3. **Read-only guard:** run the test suite, then query `studies`, `study_events`,
   `study_snapshots`, `users`, `onboarding_*` for any row mutated since run start →
   must be zero. ESLint/CI grep finds no write call against study tables.
4. Create a codebook → it binds to the `visibility='shown'` study; episode picker
   lists its Module→Scenario→Phase options from `enumerateScreens` (parity with the
   platform preview).
5. Create facets (Stage, Locus) + values → matrix pivots correctly; a code tagged
   `Stage=repair, Locus=participant` lands in the right cell.
6. Author a code with full anatomy + prediction; edit it → a new `cb_code_versions`
   row appears, `cb_codes.current_version_id` updates atomically, prior version
   readable.
7. Paste a multi-entry BibTeX blob → entries parsed; link two to a code; unlink one.
8. Add coder comments; mark one resolved.
9. Freeze → `cb_codebook_versions` row with a complete snapshot matching §3.5 schema.
10. Reliability: paste fixture tables → P_o, κ, PABAK, α match hand-computed values
    (unit-tested); kappa-paradox fixture shows high P_o + low κ + advisory flag;
    binary-scope fixture produces a PABAK, multi-category produces null PABAK +
    prevalence/bias.
11. Export → LaTeX compiles to a methods-section table; method named directed content
    analysis (never reflexive TA). JSON round-trips.
12. Confirm `cb_codings` exists but no UI references it (deferred seam intact).

---

## 7. Open risks / things to watch
- **Mirror drift:** vendored `enumerateScreens`/`study.ts` carry the source `<git-sha>`
  in a header; surface a warning in the bound-study summary if `authored_data.content`
  fails to parse (a drift signal). Future: extract to a shared package (out of MVP).
- **Krippendorff's α correctness** is the highest-bug-risk math; pin it with fixtures
  from a published worked example.
- **Same-project blast radius:** mitigated by the §2.2 code-level write-guard + lint +
  verification, not RLS (service-role bypasses RLS — stated, not hidden).
- **`method` honesty is load-bearing:** export templates cite the coding-reliability /
  codebook strand for the κ warrant, never reflexive Braun–Clarke.
- **No seeding:** ships empty by explicit decision; the §2.8 spine / §3.1 residue are
  entered by the user. (A manual "import starter spine" action is a possible future
  nicety, not MVP.)

---

## 8. Appendix — adversarial spec-review resolutions (2026-06-10)

Four independent critics (data-model, methods-validity, platform-integration,
scope-fit) reviewed the prior draft. **Accepted & applied:** wrong study identifier
(`visibility='shown'`, not `active`); `scope_ref` → two typed FKs + CHECK;
`current_version_id` pointer; code-level read-only write-guard (service-role bypasses
RLS); PABAK binary-only definition; Krippendorff α pinned to Hayes & Krippendorff
(2007) nominal pairable-values + refuse-to-degrade on >2 coders/missing; freeze gated
at pilot κ≥.70; advisory (non-blocking) mis-carved flag with dismiss-rationale;
`episode_ref` `span` clarified as forward-compat transcript offset; FK indexes; coder-
comment & codings version FKs; exclude_if vs disconfirming_pattern distinction;
exemplar/episode_ref JSONB shapes + Zod validation; `created_by` = iron-session
researcher; downscoped Protocol panel → episode-reference picker.
**Rejected (over-engineering or contrary to author constraints):** dropping LaTeX
export (inverted — LaTeX is the publication format; dropped Markdown instead); plpgsql
freeze functions + `updated_at`/validation DB triggers (app-level for a single-user
tool); denormalizing facet tags into JSONB (kept live join; freeze snapshot is the
κ-audit truth); separate `cb_reliability_scopes` junction table (two typed FKs +
CHECK suffice).
