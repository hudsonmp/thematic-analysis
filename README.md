# thematic-analysis

A focused **directed-content-analysis** (Hsieh & Shannon, 2005) workspace for the
`spec-study-app` rideshare think-aloud requirement-engineering study. It combines
codebook authoring, recorded-session coding, comparison, and admin-authored training
exemplars without a separate evaluation workbench.

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
  and `zod`.
- **Vitest** for unit tests across codebook, transcript, session, upload, and data guards.

## Setup

```bash
cp .env.local.example .env.local      # fill the Supabase keys + services you use
npm install
npm run dev                           # → http://localhost:3200
```

Then sign in at the researcher gate: **`/create/login`**.

Required `.env.local` keys:

| Key | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | VT Supabase project URL (`https://wuvtffnomynoafbilzxw.supabase.co`) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Anon key (read-only client) |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only access to the app's `cb_*` tables |

Optional services:

| Key | Purpose |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN` | Google Drive video storage |
| `GDRIVE_CLIENT_ID`, `GDRIVE_CLIENT_SECRET`, `GDRIVE_REFRESH_TOKEN` | Per-field overrides for a separate recordings account |
| `ANTHROPIC_API_KEY` | Transcript-restoration maintenance scripts |
| `TRANSCRIBE_SCRIPT`, `WHISPER_CLI_BIN`, `WHISPER_MODEL` | Override local transcription-tool paths |

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
- **Training exemplars** — an admin-authored worked-example document with one tab per
  code, threaded comments, and links back to the live codebook.
- **Session workflow** — upload and transcribe recordings, code whole-sentence spans,
  replay chat/spec context, and compare coders side by side.
- **Onboarding** — a guided tour followed by an admin-curated familiarization sequence.
- **Admin** — invite and familiarization controls at `/?admin`, absent from the nav.

## Method honesty

This tool implements **directed content analysis**, not reflexive thematic analysis.
The `cb_codebooks.method` field defaults to `directed_content_analysis`; the structured
code definitions, source citations, and coder comparison workflow follow that stance.

## Pointers

- Design spec: `docs/specs/2026-06-10-thematic-analysis-codebook-design.md`
- Implementation plan: `docs/plans/2026-06-10-thematic-analysis-codebook-implementation.md`
- SQL migrations: `docs/migrations/`

## Verification

```bash
npx tsc --noEmit     # types
npm test             # Vitest
npm run lint         # eslint + check-no-study-writes.sh
npm run build        # production build
```
