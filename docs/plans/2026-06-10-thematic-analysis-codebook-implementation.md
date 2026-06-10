# Thematic-Analysis Codebook — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the directed-content-analysis codebook authoring tool (repo `thematic-analysis`), bound read-only to the `spec-study-app` rideshare protocol, per `docs/specs/2026-06-10-thematic-analysis-codebook-design.md`.

**Architecture:** Next.js 16 App Router + Supabase (same VT project `wuvtffnomynoafbilzxw`, `cb_`-prefixed tables, read-only against study tables). Pure reliability math + Zod contracts are unit-tested with Vitest; data access via service-role server actions guarded by `cbWrite()`; UI is server components + client editors. Codebook is a versioned instrument with a freeze gate; the freeze snapshot is the κ-audit source of truth.

**Tech Stack:** Next 16.2.6 (`next dev --webpack`, port 3200), React 19.2.4, TypeScript 5, Tailwind 4, `@supabase/ssr` 0.10.3 + `@supabase/supabase-js` 2, `iron-session` 8, `zod` 4, Vitest 3 (new — for unit tests).

**Conventions:** Mirror `spec-study-app` exactly where a pattern exists. Read `node_modules/next/dist/docs/` before using Next 16 framework APIs (they differ from training data). Commit after every task. Never write to study tables. `.env.local` and `.vercel` stay gitignored.

---

## File structure (locked before tasks)

```
thematic-analysis/
  package.json, tsconfig.json, next.config.ts, postcss.config.mjs,
    eslint.config.mjs, vitest.config.ts, .env.local.example, proxy.ts
  app/
    layout.tsx, globals.css, page.tsx                 # scheme/matrix view
    create/login/page.tsx + actions.ts                # researcher gate
    codes/[id]/page.tsx                                # code card
    citations/page.tsx
    reliability/page.tsx
    export/page.tsx
    api/ (none in MVP)
    actions/                                           # server actions, one file per aggregate
      codebook.ts, facets.ts, codes.ts, citations.ts,
      comments.ts, freeze.ts, reliability.ts, protocol.ts
  components/
    matrix/MatrixView.tsx, FacetEditor.tsx
    code/CodeCard.tsx, AnatomyEditor.tsx, BulletListEditor.tsx,
      VersionHistory.tsx, FacetTagger.tsx, CitationLinker.tsx,
      CommentThread.tsx, EpisodePicker.tsx
    citations/CitationLibrary.tsx
    reliability/ReliabilityPanel.tsx, LabelTableInput.tsx, KappaResult.tsx
    export/ExportView.tsx
    ui/ (shared primitives)
  lib/
    supabase/server.ts, service.ts, guard.ts          # cbWrite + readStudy
    auth/researcher.ts                                 # copied verbatim from spec-study-app
    study/study.ts, screens.ts                         # VENDORED mirror (sha header)
    types/cb-db.ts                                      # generated from Supabase
    types/contracts.ts                                  # Zod schemas (Exemplar, EpisodeRef…)
    reliability/stats.ts                                # Po, kappa, PABAK, alpha, bands
    bibtex/parse.ts                                     # BibTeX → fields
    export/latex.ts, export/json.ts                     # codebook serializers
  lib/**/__tests__/*.test.ts                            # Vitest unit tests
  docs/specs/..., docs/plans/...
```

---

## Phase 0 — Scaffold & infrastructure

### Task 1: Scaffold the Next.js app and Vitest

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `postcss.config.mjs`, `eslint.config.mjs`, `vitest.config.ts`, `app/layout.tsx`, `app/globals.css`, `app/page.tsx`, `.env.local.example`

- [ ] **Step 1: Scaffold** in `~/thematic-analysis` (already a git repo on branch `spec/codebook-mvp`; create a new branch `build/codebook-mvp` off it first):
```bash
cd ~/thematic-analysis && git checkout -b build/codebook-mvp
npx create-next-app@16.2.6 . --typescript --tailwind --app --eslint \
  --import-alias "@/*" --no-src-dir --use-npm --skip-install --yes
```
If `create-next-app` refuses a non-empty dir, scaffold in `/tmp/ta-scaffold` and copy files in, preserving `docs/` and `.git/`.

- [ ] **Step 2: Pin versions + scripts** — edit `package.json` to match spec-study-app exactly and add Vitest:
```jsonc
{
  "scripts": {
    "dev": "next dev --webpack -p 3200",
    "build": "next build",
    "start": "next start -p 3200",
    "lint": "eslint",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@supabase/ssr": "^0.10.3", "@supabase/supabase-js": "^2.106.2",
    "iron-session": "^8.0.4", "next": "16.2.6",
    "react": "19.2.4", "react-dom": "19.2.4", "zod": "^4.4.3"
  },
  "devDependencies": {
    "@tailwindcss/postcss": "^4", "@types/node": "^20", "@types/react": "^19",
    "@types/react-dom": "^19", "eslint": "^9", "eslint-config-next": "16.2.6",
    "tailwindcss": "^4", "typescript": "^5", "vitest": "^3", "server-only": "^0.0.1"
  }
}
```
Then `npm install`.

- [ ] **Step 3: vitest.config.ts**
```ts
import { defineConfig } from 'vitest/config';
import path from 'node:path';
export default defineConfig({
  test: { environment: 'node', include: ['lib/**/__tests__/**/*.test.ts'] },
  resolve: { alias: { '@': path.resolve(__dirname, '.') } },
});
```

- [ ] **Step 4: `.env.local.example`** (copy real values into `.env.local`, which is gitignored):
```
NEXT_PUBLIC_SUPABASE_URL=https://wuvtffnomynoafbilzxw.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
RESEARCHER_PASSWORD=
COOKIE_SECRET=
```
Copy `SUPABASE_*` and `COOKIE_SECRET`/`RESEARCHER_PASSWORD` values from `~/spec-study-app/.env.local`.

- [ ] **Step 5: Verify build** — `npm run build` succeeds; `npm run dev` serves on :3200. Trim `app/page.tsx` to a placeholder `<main>Codebook</main>`.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "chore: scaffold next 16 + vitest"`

### Task 2: Vendor the platform protocol files

**Files:**
- Create: `lib/study/study.ts`, `lib/study/screens.ts`

- [ ] **Step 1: Copy with sha header.** Get the source sha: `cd ~/spec-study-app && git rev-parse --short HEAD`. Copy `lib/types/study.ts` → `~/thematic-analysis/lib/study/study.ts` and `lib/study/screens.ts` → `~/thematic-analysis/lib/study/screens.ts`. Prepend to each:
```ts
// MIRRORED FROM spec-study-app @ <sha> — keep in sync; do not edit semantics.
// Source: spec-study-app/lib/types/study.ts (resp. lib/study/screens.ts)
```
Fix `screens.ts`'s import to `import type { Module, ProjectContent } from '@/lib/study/study';`.

- [ ] **Step 2: Type-check** — `npx tsc --noEmit` passes (these files have no other deps).

- [ ] **Step 3: Smoke test** — `lib/study/__tests__/screens.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { enumerateScreens } from '@/lib/study/screens';
describe('vendored enumerateScreens', () => {
  it('returns [] for empty content', () => {
    expect(enumerateScreens({ modules: [] })).toEqual([]);
  });
});
```
Run `npm test` → PASS. (If the empty-content shape differs, adjust to the real `ProjectContent` shape from the file.)

- [ ] **Step 4: Commit** — `git commit -am "feat: vendor study.ts + screens.ts from spec-study-app"`

### Task 3: Supabase clients + write-guard

**Files:**
- Create: `lib/supabase/service.ts`, `lib/supabase/server.ts`, `lib/supabase/guard.ts`, `lib/supabase/__tests__/guard.test.ts`

- [ ] **Step 1: Write failing guard test** — `lib/supabase/__tests__/guard.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { assertCbTable } from '@/lib/supabase/guard';
describe('assertCbTable', () => {
  it('allows cb_ tables', () => { expect(() => assertCbTable('cb_codes')).not.toThrow(); });
  it('rejects study tables', () => {
    for (const t of ['studies','study_events','study_snapshots','users','onboarding_fields'])
      expect(() => assertCbTable(t)).toThrow(/read-only/);
  });
});
```

- [ ] **Step 2: Run → FAIL** (`assertCbTable` undefined).

- [ ] **Step 3: Implement** `lib/supabase/guard.ts`:
```ts
import 'server-only';
import { createServiceRoleClient } from '@/lib/supabase/service';

/** Throws unless `table` is a codebook table. The service-role key bypasses RLS,
 *  so this app-level guard is the read-only-against-study-data enforcement. */
export function assertCbTable(table: string): void {
  if (!/^cb_/.test(table)) {
    throw new Error(`Refusing to write to non-codebook table "${table}" (study data is read-only).`);
  }
}

/** Use for ALL codebook writes. */
export function cbFrom(table: string) {
  assertCbTable(table);
  return createServiceRoleClient().from(table);
}
```

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Implement clients** — copy `~/spec-study-app/lib/supabase/service.ts` and `server.ts` verbatim (they already create the service-role + ssr clients), changing the generated-types import to `@/lib/types/cb-db`. If `cb-db.ts` doesn't exist yet, temporarily type the client as `any` and tighten in Task 5.

- [ ] **Step 6: ESLint rule** — add to `eslint.config.mjs` a `no-restricted-syntax` rule forbidding `.insert/.update/.delete/.upsert` chained on `.from('study…'|'users'|'onboarding…')`. Minimum viable: a CI grep script `scripts/check-no-study-writes.sh` that greps the repo and exits 1 on a match; wire into `npm run lint`.

- [ ] **Step 7: Commit** — `git commit -am "feat: supabase clients + cbFrom write-guard"`

### Task 4: Researcher auth + route gate

**Files:**
- Create: `lib/auth/researcher.ts`, `app/create/login/page.tsx`, `app/create/login/actions.ts`, `proxy.ts`

- [ ] **Step 1: Copy** `~/spec-study-app/lib/auth/researcher.ts` verbatim.
- [ ] **Step 2: Login page + action** — a password form posting to a server action that calls `verifyResearcherPassword`, sets `session.ok=true`, redirects to `/`. Mirror spec-study-app's `/create/login`.
- [ ] **Step 3: proxy.ts** — gate all routes except `/create/login` and static assets: if no researcher session, redirect to `/create/login`. Mirror spec-study-app's `proxy.ts` matcher pattern (read it first).
- [ ] **Step 4: Manual verify** — `npm run dev`; `/` redirects to login; correct password → `/`.
- [ ] **Step 5: Commit** — `git commit -am "feat: researcher auth gate"`

---

## Phase 1 — Database

### Task 5: Migrations + generated types

**Files:** applied via `mcp__vt-supabase__apply_migration` (remote); record SQL in `docs/migrations/*.sql` for audit. Create: `lib/types/cb-db.ts` (generated).

- [ ] **Step 1: Apply migration `cb_core`** (codebook, facets, values):
```sql
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
```

- [ ] **Step 2: Apply migration `cb_codes`** (note: create `cb_code_versions` and `cb_codes` so the circular FK is added last):
```sql
create table cb_codes (
  id uuid primary key default gen_random_uuid(),
  codebook_id uuid not null references cb_codebooks(id) on delete cascade,
  mnemonic text not null, name text not null,
  origin text not null check (origin in ('a_priori','pilot','emergent')),
  status text not null default 'proposed'
    check (status in ('proposed','active','merged','retired')),
  parent_code_id uuid references cb_codes(id),
  current_version_id uuid,           -- FK added after cb_code_versions exists
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
```

- [ ] **Step 3: Apply migration `cb_citations`**:
```sql
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
```

- [ ] **Step 4: Apply migration `cb_freeze_reliability`**:
```sql
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
  code_version int, author text not null, body text not null,
  resolved boolean not null default false,
  created_at timestamptz not null default now(),
  foreign key (code_id, code_version)
    references cb_code_versions(code_id, version) on delete set null
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
  foreign key (code_id, code_version)
    references cb_code_versions(code_id, version) on delete restrict
);
create index on cb_codebook_versions(codebook_id);
create index on cb_coder_comments(code_id);
create index on cb_reliability_runs(codebook_id);
create index on cb_reliability_runs(codebook_version_id);
create index on cb_codings(code_id);
create index on cb_codings(codebook_version_id);
```

- [ ] **Step 5: Generate types** — `mcp__vt-supabase__generate_typescript_types` → save to `lib/types/cb-db.ts`. Update supabase clients to `createServiceRoleClient<Database>()`.
- [ ] **Step 6: Security advisors** — `mcp__vt-supabase__get_advisors type=security`; resolve any unindexed-FK / RLS warnings (enable RLS on `cb_*` with a permissive policy is unnecessary since access is service-role only — document that the advisor's RLS warning is accepted, mirroring spec-study-app).
- [ ] **Step 7: Verify isolation** — `mcp__vt-supabase__list_tables` shows all `cb_*` plus the unchanged study tables.
- [ ] **Step 8: Commit** — `git add docs/migrations lib/types/cb-db.ts && git commit -m "feat(db): cb_* schema + generated types"`

---

## Phase 2 — Pure logic (TDD, highest correctness risk)

### Task 6: Reliability statistics

**Files:** Create `lib/reliability/stats.ts`, `lib/reliability/__tests__/stats.test.ts`

- [ ] **Step 1: Write failing tests** with hand-computed fixtures (include the kappa paradox + binary PABAK):
```ts
import { describe, it, expect } from 'vitest';
import { percentAgreement, cohenKappa, pabak, prevalenceIndex, biasIndex,
         krippendorffAlphaNominal, landisKochBand, type LabelPair } from '@/lib/reliability/stats';

const close = (a: number, b: number, eps = 1e-3) => Math.abs(a - b) < eps;

describe('reliability stats', () => {
  // Perfect agreement
  const perfect: LabelPair[] = [['a','a'],['b','b'],['a','a']];
  it('Po=1, kappa=1 on perfect', () => {
    expect(percentAgreement(perfect)).toBe(1);
    expect(cohenKappa(perfect)).toBe(1);
  });
  // Cohen 1960 style worked example: 2x2
  //   A\B  yes  no
  //   yes   45   15
  //   no     5   35   -> N=100, Po=.80, Pe=.5*.6+.5*.4? compute exactly in test
  it('cohen kappa matches hand calc on 2x2', () => {
    const pairs: LabelPair[] = [
      ...Array(45).fill(['yes','yes']), ...Array(15).fill(['yes','no']),
      ...Array(5).fill(['no','yes']),  ...Array(35).fill(['no','no']),
    ] as LabelPair[];
    expect(close(percentAgreement(pairs), 0.80)).toBe(true);
    // marginals A: yes=60/100, no=40/100; B: yes=50/100, no=50/100
    // Pe = .6*.5 + .4*.5 = .50 ; kappa = (.80-.50)/(1-.50) = .60
    expect(close(cohenKappa(pairs), 0.60)).toBe(true);
  });
  // Kappa paradox: high Po, low kappa (skewed prevalence)
  it('kappa paradox: high Po, depressed kappa', () => {
    const pairs: LabelPair[] = [
      ...Array(85).fill(['yes','yes']), ...Array(5).fill(['yes','no']),
      ...Array(5).fill(['no','yes']),  ...Array(5).fill(['no','no']),
    ] as LabelPair[];
    expect(percentAgreement(pairs)).toBeGreaterThan(0.85);
    expect(cohenKappa(pairs)).toBeLessThan(0.5);     // paradox
    expect(pabak(pairs)).toBeGreaterThan(cohenKappa(pairs)); // PABAK rescues
  });
  it('pabak = 2*Po - 1 for binary', () => {
    const pairs: LabelPair[] = [...Array(8).fill(['a','a']), ...Array(2).fill(['a','b'])] as LabelPair[];
    expect(close(pabak(pairs), 2*0.8 - 1)).toBe(true);
  });
  it('pabak null for >2 categories', () => {
    const pairs: LabelPair[] = [['a','a'],['b','c'],['c','c']];
    expect(pabak(pairs)).toBeNull();
  });
  it('krippendorff alpha ~ kappa on nominal 2-coder complete data', () => {
    const pairs: LabelPair[] = [
      ...Array(45).fill(['yes','yes']), ...Array(15).fill(['yes','no']),
      ...Array(5).fill(['no','yes']),  ...Array(35).fill(['no','no']),
    ] as LabelPair[];
    expect(close(krippendorffAlphaNominal(pairs), 0.60, 0.05)).toBe(true);
  });
  it('landis-koch bands', () => {
    expect(landisKochBand(0.05)).toBe('slight');
    expect(landisKochBand(0.7)).toBe('substantial');
    expect(landisKochBand(0.9)).toBe('almost perfect');
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** `lib/reliability/stats.ts` (pure, no I/O):
```ts
export type LabelPair = [string, string]; // [coderA, coderB] per unit

export function percentAgreement(pairs: LabelPair[]): number {
  if (!pairs.length) return NaN;
  const agree = pairs.filter(([a, b]) => a === b).length;
  return agree / pairs.length;
}

function categories(pairs: LabelPair[]): string[] {
  return [...new Set(pairs.flat())];
}

export function cohenKappa(pairs: LabelPair[]): number {
  const n = pairs.length; if (!n) return NaN;
  const po = percentAgreement(pairs);
  const cats = categories(pairs);
  const aCount: Record<string, number> = {}, bCount: Record<string, number> = {};
  for (const c of cats) { aCount[c] = 0; bCount[c] = 0; }
  for (const [a, b] of pairs) { aCount[a]++; bCount[b]++; }
  const pe = cats.reduce((s, c) => s + (aCount[c] / n) * (bCount[c] / n), 0);
  return pe === 1 ? 1 : (po - pe) / (1 - pe);
}

/** Binary-only (exactly 2 distinct labels). Returns null otherwise. */
export function pabak(pairs: LabelPair[]): number | null {
  if (categories(pairs).length !== 2) return null;
  return 2 * percentAgreement(pairs) - 1;
}

/** Byrt et al. prevalence index (binary): |p_yes_overall - p_no_overall|/... here
 *  reported as (n_both_pos - n_both_neg)/N for the 2x2 case; null if non-binary. */
export function prevalenceIndex(pairs: LabelPair[]): number | null {
  const cats = categories(pairs); if (cats.length !== 2) return null;
  const [x, y] = cats; const n = pairs.length;
  const bothX = pairs.filter(([a, b]) => a === x && b === x).length;
  const bothY = pairs.filter(([a, b]) => a === y && b === y).length;
  return Math.abs(bothX - bothY) / n;
}

/** Bias index (binary): |a_yes - b_yes|/N ; null if non-binary. */
export function biasIndex(pairs: LabelPair[]): number | null {
  const cats = categories(pairs); if (cats.length !== 2) return null;
  const [x] = cats; const n = pairs.length;
  const aX = pairs.filter(([a]) => a === x).length;
  const bX = pairs.filter(([, b]) => b === x).length;
  return Math.abs(aX - bX) / n;
}

/** Krippendorff's alpha, nominal, complete data, any #coders given as per-unit arrays.
 *  For 2-coder LabelPair input, wrap as units of 2. Coincidence-matrix method
 *  (Hayes & Krippendorff 2007). */
export function krippendorffAlphaNominal(pairs: LabelPair[]): number {
  const units = pairs.map((p) => [...p]);
  const cats = categories(pairs);
  // Build coincidence matrix o_{ck}
  const o: Record<string, Record<string, number>> = {};
  for (const c of cats) { o[c] = {}; for (const k of cats) o[c][k] = 0; }
  let totalPairable = 0;
  for (const unit of units) {
    const m = unit.length; if (m < 2) continue;
    for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) if (i !== j) {
      o[unit[i]][unit[j]] += 1 / (m - 1);
    }
    totalPairable += m;
  }
  const nc: Record<string, number> = {};
  for (const c of cats) nc[c] = cats.reduce((s, k) => s + o[c][k], 0);
  const n = cats.reduce((s, c) => s + nc[c], 0);
  // Observed disagreement Do and expected De (nominal metric: 1 if c≠k else 0)
  let Do = 0; for (const c of cats) for (const k of cats) if (c !== k) Do += o[c][k];
  let De = 0; for (const c of cats) for (const k of cats) if (c !== k) De += nc[c] * nc[k];
  Do = Do; De = De / (n - 1);
  return De === 0 ? 1 : 1 - Do / De;
}

export type KappaBand =
  | 'poor' | 'slight' | 'fair' | 'moderate' | 'substantial' | 'almost perfect';
export function landisKochBand(k: number): KappaBand {
  if (k < 0) return 'poor';
  if (k <= 0.20) return 'slight';
  if (k <= 0.40) return 'fair';
  if (k <= 0.60) return 'moderate';
  if (k <= 0.80) return 'substantial';
  return 'almost perfect';
}

export const MIS_CARVED_THRESHOLD = 0.5;
export function isMisCarved(k: number): boolean { return k < MIS_CARVED_THRESHOLD; }
```

- [ ] **Step 4: Run → PASS.** If Krippendorff α is off, fix `De` normalization to the standard `De = (1/(n-1)) Σ_{c≠k} nc·nk` and re-verify against the Hayes & Krippendorff (2007) worked example; adjust the test's tolerance only if the published value differs.
- [ ] **Step 5: Commit** — `git commit -am "feat(reliability): Po, Cohen kappa, PABAK, Krippendorff alpha + bands (tested)"`

### Task 7: Zod contracts + BibTeX parser

**Files:** Create `lib/types/contracts.ts`, `lib/bibtex/parse.ts`, `lib/bibtex/__tests__/parse.test.ts`, `lib/types/__tests__/contracts.test.ts`

- [ ] **Step 1: Zod contracts** `lib/types/contracts.ts`:
```ts
import { z } from 'zod';
export const EpisodeRef = z.object({
  module_id: z.string(),
  scenario_idx: z.number().int(),
  phase: z.enum(['initial','read','ponder','revise','retro','final']),
  span: z.tuple([z.number(), z.number()]).optional(),
});
export const Exemplar = z.object({
  text: z.string().min(1),
  source_pid: z.string().optional(),
  episode_ref: EpisodeRef.optional(),
});
export const BulletList = z.array(z.string());
export const CodeVersionInput = z.object({
  definition: z.string().min(1),
  include_if: BulletList,
  exclude_if: BulletList,
  exemplars: z.array(Exemplar),
  disconfirming_pattern: z.string().optional(),
  prediction: z.string().optional(),
  prediction_falsifier: z.string().optional(),
  change_note: z.string().optional(),
});
export type EpisodeRefT = z.infer<typeof EpisodeRef>;
export type ExemplarT = z.infer<typeof Exemplar>;
export type CodeVersionInputT = z.infer<typeof CodeVersionInput>;
```
- [ ] **Step 2: contracts test** — assert valid Exemplar parses; bad phase rejects.
- [ ] **Step 3: BibTeX parser test** — single + multi-entry blob, field extraction:
```ts
import { describe, it, expect } from 'vitest';
import { parseBibtex } from '@/lib/bibtex/parse';
describe('parseBibtex', () => {
  it('parses one entry', () => {
    const out = parseBibtex(`@article{hsieh2005directed,
      title = {Three Approaches to Qualitative Content Analysis},
      author = {Hsieh, Hsiu-Fang and Shannon, Sarah E.},
      year = {2005}, doi = {10.1177/1049732305276687}}`);
    expect(out).toHaveLength(1);
    expect(out[0].bibtex_key).toBe('hsieh2005directed');
    expect(out[0].year).toBe(2005);
    expect(out[0].title).toMatch(/Three Approaches/);
  });
  it('parses multiple entries', () => {
    const out = parseBibtex(`@book{a, title={A}, year={1990}} @article{b, title={B}, year={2001}}`);
    expect(out.map(e => e.bibtex_key)).toEqual(['a','b']);
  });
});
```
- [ ] **Step 4: Run → FAIL.**
- [ ] **Step 5: Implement** `lib/bibtex/parse.ts` — a pragmatic parser: split on `@type{`, balance braces to find each entry, extract `key` (first token before first comma) and `field = {…}|"…"|bareword` pairs; coerce `year` to int; keep `bibtex_raw`. Return `{ bibtex_key, bibtex_raw, title?, authors?, year?, doi?, url?, parsed }[]`. Document brace-nesting limitations in a comment.
- [ ] **Step 6: Run → PASS.**
- [ ] **Step 7: Commit** — `git commit -am "feat: zod contracts + bibtex parser (tested)"`

---

## Phase 3 — Server actions (data layer; service-role, cbFrom-guarded)

> Each action file is `'use server'`, imports `cbFrom`/`createServiceRoleClient`, validates input with Zod, and is called from UI. Read `app/study/actions.ts` in spec-study-app for the established action shape before writing. Reads of `studies` use `createServiceRoleClient().from('studies').select(...)` (read-only, allowed).

### Task 8: Codebook + facet/value actions
**Files:** Create `app/actions/codebook.ts`, `app/actions/facets.ts`
- [ ] Step 1: `getOrCreateCodebook()` — find the `cb_codebooks` row for the `visibility='shown'` study; create if absent. `listCodebookTree(id)` returns facets+values+codes(+current version)+citations in one call for the UI.
- [ ] Step 2: facet CRUD — `createFacet/renameFacet/reorderFacet/deleteFacet`, `createFacetValue/updateFacetValue/reorderFacetValue/deleteFacetValue`. All via `cbFrom`.
- [ ] Step 3: Manual verify in a scratch route or `node` script: create codebook bound to shown study; create a facet + values; confirm rows via `mcp__vt-supabase__execute_sql`.
- [ ] Step 4: Commit.

### Task 9: Code + version + facet-tag actions
**Files:** Create `app/actions/codes.ts`
- [ ] Step 1: `createCode({mnemonic,name,origin})` inserts `cb_codes` (status `proposed`) + version 1 from `CodeVersionInput`, then sets `current_version_id` atomically (insert version → update code) in sequence; return the code id.
- [ ] Step 2: `saveNewVersion(codeId, CodeVersionInput)` — compute next `version = current+1`, insert, update `current_version_id`. Validate with `CodeVersionInput`.
- [ ] Step 3: `setCodeStatus`, `setCodeFacetValues(codeId, facetValueIds[])` (replace-set in `cb_code_facet_values`).
- [ ] Step 4: Manual verify: create code, edit → two version rows, `current_version_id` points to v2.
- [ ] Step 5: Commit.

### Task 10: Citation actions
**Files:** Create `app/actions/citations.ts`
- [ ] Step 1: `addCitations(codebookId, blob)` → `parseBibtex` → upsert each into `cb_citations`.
- [ ] Step 2: `linkCitation(codeId, citationId, role)`, `unlinkCitation`.
- [ ] Step 3: Manual verify with a 2-entry blob; link one. Commit.

### Task 11: Coder comment actions
**Files:** Create `app/actions/comments.ts`
- [ ] Step 1: `addComment(codeId, codeVersion|null, body)` (author = researcher session), `resolveComment(id)`, `listComments(codeId)`. Commit after manual verify.

### Task 12: Freeze + reliability actions
**Files:** Create `app/actions/freeze.ts`, `app/actions/reliability.ts`, `lib/export/json.ts`
- [ ] Step 1: `buildSnapshot(codebookId)` (in `freeze.ts`) — assemble the §3.5 snapshot JSON from one read of all cb_ tables; pure-ish (takes the queried rows). Unit-test the assembler with fixture rows in `app/actions/__tests__/snapshot.test.ts` (asserts shape matches §3.5).
- [ ] Step 2: `freezeCodebook(codebookId, label, round, note)` — insert `cb_codebook_versions` with the snapshot.
- [ ] Step 3: `computeReliability({codebookId, codebookVersionId, scope, scopeRef, labelTable})` — parse the pasted CSV/TSV into `LabelPair[]`, call stats from Task 6, persist a `cb_reliability_runs` row with all stats; return `{po,kappa,pabak,alpha,prevalence,bias,band,misCarved}`.
- [ ] Step 4: `dismissMisCarved(runId, rationale)` sets `dismissed_note`.
- [ ] Step 5: Commit.

---

## Phase 4 — UI

> Server components fetch via actions; client components handle editing. Tailwind 4. Keep each component focused (file structure above). Styling minimal/clean; logic and data-binding are the bar, not pixels. After each task: `npm run build` passes + manual check on :3200.

### Task 13: App shell + nav
- [ ] Layout with nav (Scheme / Citations / Reliability / Export), researcher-only (gated by proxy). Commit.

### Task 14: Scheme / matrix view (`app/page.tsx` + `components/matrix/*`)
- [ ] Step 1: `MatrixView` — two facet selectors (rows, cols); render a grid of cells; each cell lists code chips whose `cb_code_facet_values` match both axis values; "unassigned" lane for codes missing a tag on a selected facet. Clicking a chip → `/codes/[id]`. "New code" button.
- [ ] Step 2: `FacetEditor` — inline add/rename/reorder/delete facets + values (calls Task 8 actions). Empty-state when no facets.
- [ ] Step 3: Manual verify: create Stage+Locus facets & values; tag a code; it lands in the right cell. Commit.

### Task 15: Code card (`app/codes/[id]/page.tsx` + `components/code/*`)
- [ ] Step 1: `AnatomyEditor` with `BulletListEditor` for include-if/exclude-if, an exemplars editor (text + optional `EpisodePicker`), definition, disconfirming pattern, prediction + falsifier, origin, status. "Save as new version" calls `saveNewVersion`.
- [ ] Step 2: `FacetTagger` (multi-select of facet values, single/multi per cardinality) → `setCodeFacetValues`.
- [ ] Step 3: `CitationLinker` (multi-select from library, role) → link/unlink.
- [ ] Step 4: `VersionHistory` (read prior versions + change notes).
- [ ] Step 5: `CommentThread` (add/resolve).
- [ ] Step 6: `EpisodePicker` — Module→Scenario→Phase breadcrumb from `enumerateScreens(studies.authored_data.content)` (read via a `protocol.ts` action); stores into the exemplar's `episode_ref`; validates against current screens, warns if stale.
- [ ] Step 7: Manual verify full anatomy round-trip + versioning. Commit per sub-component.

### Task 16: Citation library (`app/citations/page.tsx`)
- [ ] Paste-blob textarea → `addCitations`; list parsed entries; edit/delete. Manual verify. Commit.

### Task 17: Reliability panel (`app/reliability/page.tsx` + `components/reliability/*`)
- [ ] Step 1: Calibration-round indicator + **Freeze** button (`freezeCodebook`) + list of frozen versions.
- [ ] Step 2: `LabelTableInput` (paste CSV/TSV: `unit, coderA, coderB`) + scope selector (overall / per facet-value / per code) + frozen-version selector → `computeReliability`.
- [ ] Step 3: `KappaResult` — show Po, κ (+ Landis-Koch band, labelled conventional), PABAK (or "n/a — non-binary"), α, prevalence/bias; advisory mis-carved flag with dismiss-with-rationale.
- [ ] Step 4: Manual verify with the Task-6 fixtures (paste perfect, paradox, binary). Commit.

### Task 18: Export (`app/export/page.tsx` + `lib/export/latex.ts`)
- [ ] Step 1: `lib/export/latex.ts` — render the codebook (current versions grouped by a chosen facet) as a LaTeX longtable: columns mnemonic, definition, include-if, exclude-if, exemplar, prediction, origin, citations; plus a methods paragraph naming **directed content analysis** and citing the coding-reliability strand (never reflexive TA). Unit-test that output contains `directed content analysis` and does NOT contain `reflexive`.
- [ ] Step 2: `lib/export/json.ts` — full codebook dump (reuse `buildSnapshot`).
- [ ] Step 3: Export page with download buttons. Manual verify LaTeX compiles. Commit.

---

## Phase 5 — Verification

### Task 19: §6 verification sweep
- [ ] Step 1: `mcp__vt-supabase__list_tables` → `cb_*` present, study tables unchanged.
- [ ] Step 2: Run `scripts/check-no-study-writes.sh` (grep) → no study writes; `npm run lint` clean.
- [ ] Step 3: After `npm test`, `mcp__vt-supabase__execute_sql`: `select count(*) from study_events where created_at > now() - interval '10 minutes'` → confirm no new rows from the tool.
- [ ] Step 4: `npm test` all green; `npm run build` clean; `npx tsc --noEmit` clean.
- [ ] Step 5: Walk the §6 acceptance list (codebook bind, facets/matrix, code+version, citations, comments, freeze+snapshot, reliability fixtures incl. paradox + binary PABAK, LaTeX/JSON export, `cb_codings` unreferenced).
- [ ] Step 6: Final commit + open a PR from `build/codebook-mvp` (do NOT merge; await Hudson).

---

## Self-review (run by plan author)

**Spec coverage:** every spec §maps to a task — facets/modular scheme→T8,T14; code anatomy+prediction+disconfirming→T9,T15; origin→T9; BibTeX→T7,T10,T16; coder comments→T11,T15; freeze/versioning→T5,T12,T17; reliability §2.9 (Po/κ/PABAK/α/bands/mis-carved)→T6,T12,T17; protocol binding (visibility='shown', enumerateScreens, episode picker)→T2,T8,T15; read-only guard→T3,T19; export LaTeX+JSON→T18; deferred `cb_codings` seam→T5 (defined), unreferenced verified T19. No gaps.

**Type consistency:** `LabelPair`, `CodeVersionInput`, `EpisodeRef`, `Exemplar` defined in T6/T7 and consumed in T12/T15/T18 under the same names. `cbFrom`/`assertCbTable` (T3) used by all action tasks. `enumerateScreens` (T2) used by T8/T15. `buildSnapshot` (T12) reused by T18 JSON export.

**Placeholders:** logic tasks (T6,T7) carry full tested code; migrations (T5) full SQL; UI tasks specify component contracts + the action calls they bind to (acceptable granularity for a skilled implementer — the data/logic layer they depend on is fully specified).
