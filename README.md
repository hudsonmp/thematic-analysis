# thematic-analysis

A **directed-content-analysis** (Hsieh & Shannon, 2005) codebook authoring tool for
the `spec-study-app` rideshare think-aloud requirement-engineering study. The codebook
is treated as a **versioned instrument with a freeze gate** — not a flat list of codes —
plus a §2.9 inter-rater **reliability** workbench. Codes carry full anatomy and
falsifiable predictions, are organized by a user-defined facet scheme, cite their source
theory via BibTeX, and accrue coder comments during the review period. Reliability is
recorded against a *frozen* codebook version so the κ audit has a fixed source of truth.

(Section references — §2.6, §2.9, etc. — point into the companion methods guide,
`~/Desktop/Readings - Claude/06-09-2026-methods-guide.pdf`, "Mapping Novice Impasses in
Specification Design.")

## Stack

- **Next.js 16** (16.2.6, App Router). Dev runs on Webpack: `next dev --webpack -p 3200`.
  Note: Next 16 APIs differ from older versions — read `node_modules/next/dist/docs/`
  before writing framework-specific code (see `AGENTS.md`).
- **Supabase** — the **same VT project** as `spec-study-app`
  (`wuvtffnomynoafbilzxw`). All tool tables are **`cb_`-prefixed**; study data is
  accessed **read-only** (see Architecture).
- **React 19**, **TypeScript 5**, **Tailwind 4**, `@supabase/ssr` + `@supabase/supabase-js`,
  `iron-session` + `zod`.
- **Vitest** for unit tests (pure reliability math, BibTeX parsing, export, Zod contracts).

## Setup

```bash
cp .env.local.example .env.local      # then fill the 5 keys (see below)
npm install
npm run dev                           # → http://localhost:3200
```

Then sign in at the researcher gate: **`/create/login`**.

`.env.local` keys (all 5 required):

| Key | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | VT Supabase project URL (`https://wuvtffnomynoafbilzxw.supabase.co`) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Anon key (read-only client) |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key — used ONLY through `cbFrom()` for `cb_*` writes |
| `RESEARCHER_PASSWORD` | Single shared password for the researcher gate |
| `COOKIE_SECRET` | iron-session cookie secret |

`.env.local` is gitignored; never commit secrets.

## Architecture

**Option A connection (shared VT project).** This tool lives in the *same* Supabase
project as the study app rather than a separate DB. Isolation is by convention +
enforcement, not by project boundary:

- All tool tables are **`cb_`-prefixed**. The tool **NEVER writes study tables**
  (`users`, `studies`, `study_events`, `study_snapshots`, `study_responses`,
  `study_scripts`, `onboarding_fields`, `onboarding_responses`).
- Enforcement is layered:
  1. **`cbFrom()`** (`lib/supabase/guard.ts`) — the only sanctioned write path. A
     compile-time `CbTable` bound restricts the table arg to `cb_*` names, and the
     runtime `assertCbTable()` guard re-checks the `cb_` prefix (the service-role key
     bypasses RLS, so this app-level guard *is* the read-only-against-study-data line).
  2. **No-study-writes lint** (`scripts/check-no-study-writes.sh`, run in `npm run lint`)
     — fails the build if a study-table `.from(...)` is chained to a write verb.
  3. **Post-test DB verification** — a sweep confirms no recent rows were written to
     study tables by the tooling (see "Verification" below).
- The study protocol is **vendored**, not imported across repos: `lib/study/study.ts`
  and `lib/study/screens.ts` are a **keep-in-sync mirror** of `spec-study-app`
  (currently sha **`6b32007`**). Each file carries a `MIRRORED FROM spec-study-app @ <sha>`
  header; update the sha when re-syncing and do not edit semantics locally.
- The **freeze snapshot** is the κ-audit source of truth: reliability runs are tagged to
  a frozen `cb_codebook_versions` row so the instrument the coders used is immutable.

### Write-guard limitation

`cbFrom()` / `assertCbTable()` cover **`.from()` writes only** (the `cb_` prefix is
asserted at compile time and runtime). They do **NOT** intercept:

- `.rpc()` calls to study stored procedures, or
- dynamic/computed table names that bypass `cbFrom`.

Those paths are caught only by **code review** plus the **`check-no-study-writes.sh`**
lint and the post-test DB verification — not by the guard function. Keep all codebook
writes flowing through `cbFrom` so the prefix check actually runs. (See the comments in
`lib/supabase/guard.ts` and `lib/supabase/guard-core.ts`.)

## Features

- **Modular facet scheme** — classification dimensions (Stage, Locus, …) and their values
  are editable data, not hard-coded enums. Ships empty; the researcher defines the scheme.
- **Code anatomy** — name, mnemonic, definition, include-if, exclude-if, exemplars,
  disconfirming pattern, and a falsifiable prediction (+ prediction falsifier).
- **Origin tagging** — `a_priori` (theory-derived spine), `pilot` (residue from pilot
  coding), `emergent` (added during main coding).
- **BibTeX citations** — paste one or many entries into a library, then link codes to
  entries; codes cite their source theory.
- **Coder comments** — per-code threads captured during the calibration/review period.
- **Freeze + reliability (§2.9)** — explicit freeze event snapshots the whole codebook;
  reliability is computed from a pasted two-coder label table:
  percent agreement (Pₒ), Cohen's κ, PABAK, Krippendorff's α (nominal), prevalence/bias
  indices, and Landis–Koch bands. Degenerate-input and mis-carved (low-κ) flags surface
  pathological tables.
- **Export** — **LaTeX** (methods-section table) and **JSON** (machine backup / re-import).
  Markdown intentionally dropped; LaTeX is the publication format.

## Method honesty

This tool implements **coding-reliability / codebook thematic analysis** (a positivist
stance for which κ is a coherent validity warrant) — it is **NOT reflexive TA**. The
`cb_codebooks.method` field defaults to `directed_content_analysis`, and exports name
**directed content analysis** and cite the coding-reliability strand (Boyatzis 1998;
MacQueen et al. 1998; Hsieh & Shannon 2005) as the κ warrant — never reflexive
Braun–Clarke. This avoids the method incoherence reviewers actively catch.

## Deferred (schema-ready, not built)

These have DB/FK seams in place but no UI in the MVP:

- **Session playback** by researcher number (PID).
- **Applying codes to live sessions** — the `cb_codings` table exists and is FK-ready,
  but there is no coding UI.
- **Auto-κ from applied codings** — the MVP computes κ from a *pasted* label table; auto
  derivation from `cb_codings` is deferred.

## Pointers

- Design spec: `docs/specs/2026-06-10-thematic-analysis-codebook-design.md`
- Implementation plan: `docs/plans/2026-06-10-thematic-analysis-codebook-implementation.md`
- SQL migrations: `docs/migrations/` (`01_cb_core.sql` … `07_reliability_degenerate.sql`)

## Verification

```bash
npx tsc --noEmit     # types
npm test             # Vitest (reliability math, bibtex, export, contracts)
npm run lint         # eslint + check-no-study-writes.sh
npm run build        # production build
```
