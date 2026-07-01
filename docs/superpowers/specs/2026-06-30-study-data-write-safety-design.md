# Study-Data Write-Safety Guard — Design

**Date:** 2026-06-30
**Status:** Proposed (pending review + one prod-DB decision)
**Scope:** Cross-cutting safety infrastructure protecting IRB-covered participant data. Lands **before** sub-project B (which introduces the first writes) and hardens sub-project A (read-only) and the existing app. Referenced by `2026-06-30-progression-analysis-viewer-design.md`.

---

## 1. Why

The app shares ONE Supabase project with two datasets: writable `cb_*` codebook tables and **read-only IRB study data** (`study_*`, `users`, `studies`, `llm_prompts`). Study data is **real participant data** — irreplaceable, ethics-governed. Corruption or loss is a terminal failure, not a bug.

**Current defenses and their gaps (verified against the code, not assumed):**
- `cbFrom(table)` (`lib/supabase/guard.ts`) — compile-time `cb_${string}` bound + runtime `assertCbTable` (`/^cb_/`). The **only** sanctioned write path. **Guards `.from()` writes only** — by its own documented admission it does NOT intercept `.rpc()`, dynamic/computed table names, or direct `createServiceRoleClient()` use.
- `scripts/check-no-study-writes.sh` — greps `app/`+`lib/` for a study-table `.from(` with a write verb within 5 lines. **Gaps:** (a) `llm_prompts` is **not** in `STUDY_FROM_RE` (`study_snapshots` **is** — the earlier note that it was missing was wrong); (b) misses `.rpc(`; (c) misses write verbs >5 lines from the `.from(`; (d) misses dynamic table names; (e) greps only `app/`+`lib/`.
- **The core risk:** study **reads** run through `createServiceRoleClient()` — the service-role key **bypasses RLS and can write every table**. So the read path holds a fully-writable credential; only discipline stops a `.delete()`.

**New risk incoming:** sub-project B introduces the app's **first legitimate writes** beyond `cb_*` (prompt variants, eval runs/results, annotations). A misrouted write hitting `study_assistant_messages` or `llm_prompts` would silently contaminate the study corpus.

**Threat model (what must be impossible):** any INSERT/UPDATE/DELETE/UPSERT/DDL/`.rpc()`-with-side-effects reaching `study_*` / `users` / `studies` / `llm_prompts` from application code — via any vector: typed `.from()`, dynamic table name, stored proc, or direct client use.

---

## 2. Architecture — defense in depth (keystone first)

Five layers. **L1 is the only structural guarantee; L2–L5 are the depth on top.** Layers are independently shippable; sequencing in §3.

### L1 — Privilege separation (keystone; the real guarantee)
Make study reads use a credential that **physically cannot write study tables**, so no code path can corrupt them regardless of correctness.

Two viable Supabase-native mechanisms (pick one in review):
- **(1a, recommended) RLS `SELECT`-only policies + quarantine the service key.** Add `SELECT`-only RLS policies on `study_*`/`users`/`studies`/`llm_prompts` for the authenticated researcher role; switch all study **reads** to the **anon-key user client** (`createUserServerClient`, already RLS-bound to the researcher JWT). Then the **service-role key is used in exactly one place — `cbFrom` — and only for `cb_*`.** The researcher's read credential has no write grant on study tables (no write policy exists), so writes are refused by Postgres. This is the cleanest end state: the powerful key is quarantined; reads use a structurally read-only path.
- **(1b, alternative) Dedicated read-only DB role.** `CREATE ROLE study_readonly NOLOGIN; GRANT SELECT ON <study tables> TO study_readonly; GRANT study_readonly TO authenticator;` then reach study data via a JWT carrying `"role":"study_readonly"` (PostgREST `SET ROLE`). Study reads get a role with only `SELECT`. Keeps reads off RLS-policy management but adds a JWT-minting/signing path.

Both are **non-destructive DDL** (CREATE POLICY / CREATE ROLE + GRANT; no data touched). **Both touch the live production DB → this is the one decision that needs Hudson's explicit go-ahead; I will show the exact SQL and apply nothing without approval.** Until L1 lands, L2–L4 hold the line at the code/CI level.

### L2 — `studyFrom()` select-only guard (ship now; no prod change)
Mirror `cbFrom` for the read side. A single choke point through which **all** study access flows, select-only **by construction**:
```ts
// lib/supabase/study-guard.ts
type StudyTable = 'study_snapshots' | 'study_responses' | 'study_assistant_messages'
  | 'study_events' | 'study_scripts' | 'studies' | 'users' | 'llm_prompts' | 'onboarding_fields' | 'onboarding_responses';

// Returns a PostgREST query builder wrapped in a Proxy that permits the read chain
// (select/eq/in/order/limit/maybeSingle/single/filter/…) and THROWS on any
// write/side-effect verb (insert/update/update/delete/upsert) — closing the
// .rpc()/dynamic-name/off-window gaps the grep misses. Compile-time StudyTable
// bound + runtime allowlist mirror cbFrom's assertCbTable.
export function studyFrom<T extends StudyTable>(table: T): SelectOnly<...>;
```
- Runtime: `assertStudyTable(table)` (allowlist) + a Proxy that intercepts `insert|update|delete|upsert` (and any non-read method) and throws.
- `.rpc()` on study procs: forbidden by policy — no `studyFrom` surface exposes it; a separate lint (L3) flags any `.rpc(` in study context.
- **Migration:** repoint every existing study read (`app/actions/spec.ts`, `chat.ts`, `live.ts`) and the new `app/actions/progression.ts` from raw `createServiceRoleClient().from('study_*')` to `studyFrom(...)`. After this, `createServiceRoleClient()` is referenced **only** inside `guard.ts` (cbFrom) and `study-guard.ts` (studyFrom) — and under L1(1a), studyFrom uses the user client instead.
- Unit test: `studyFrom('llm_prompts').insert(...)` throws; `.select()` chain works; `assertStudyTable('cb_codes')` throws.

### L3 — CI hardening (ship now)
Extend `scripts/check-no-study-writes.sh` and add a companion check:
- Add `llm_prompts` (+ `onboarding_responses`) to `STUDY_FROM_RE`.
- Add a rule: **no `createServiceRoleClient(` usage outside `lib/supabase/guard.ts` and `lib/supabase/study-guard.ts`** (forces all DB access through the two guards). This is the highest-leverage single check — it closes dynamic-name and off-window gaps by removing the raw client from call sites.
- Flag any `.rpc(` in `app/`+`lib/` for manual review (allowlist known-safe cb_ procs if any).
- Widen the file scan beyond `app/`+`lib/` to `components/` (server actions can be colocated).
- Keep the existing window grep as a backstop. Add these to `npm run lint`.

### L4 — Build-time verification agent (the "verification agent"; ship now, in the SDD loop)
A dedicated **DB-safety reviewer** subagent, run as a **mandatory gate on every task's diff** in the subagent-driven build (not just data tasks). Its sole job, adversarially: *does this diff introduce or enable any write/DDL/side-effecting `.rpc` reaching study data; any `createServiceRoleClient` use outside the two guards; any dynamic/computed table name; any new `.from('study_…')` not wrapped by `studyFrom`?* It returns `{ safe: boolean, violations: [...] }`; a non-empty `violations` **blocks the task** until fixed. Complements (never replaces) L1–L3 — it catches intent/structure a grep can't, but is itself discipline, so it sits on top of the structural guarantee.

### L5 — Runtime write-verification for B's real writes (ship with B)
Sub-project B's writes go to **new, namespaced non-study tables** (`eval_prompt_variants`, `eval_runs`, `eval_results`, `eval_annotations` — `eval_*`), through a new `evalFrom(table)` guard (compile-time `eval_${string}` bound + runtime allowlist), exactly mirroring `cbFrom`. B **structurally cannot** name a study table.
On top, a lightweight **runtime audit** wraps every B write action: capture a cheap fingerprint of study tables (`SELECT count(*)` per table, or `max(updated_at)`/a digest) **before and after** the action and assert **unchanged**; on drift, abort + surface a loud error. This is the "verify any action that modifies the DB" audit — a secondary belt to the `evalFrom` structural belt.

---

## 3. Sequencing

| Layer | When | Prod DB change? | Blocks what |
|---|---|---|---|
| L2 `studyFrom` | **Now**, before/with A's reads | No | A's reads select-only by construction |
| L3 CI hardening | **Now** | No | Quarantines the service-role client |
| L4 build verifier | **Now**, every SDD task | No | Any write-risk diff |
| L1 privilege separation | **Fast-follow** (needs decision) | **Yes (non-destructive)** | Makes it structural, not disciplinary |
| L5 `evalFrom` + runtime audit | **With B** | Yes (new `eval_*` tables only) | B misrouting a write |

A (read-only) ships on L2–L4. B does not begin until **L1 is in place** (real writes must not exist while study reads still hold a writable credential).

---

## 4. Verification of the safety layer itself
- Unit: `studyFrom`/`evalFrom` throw on writes + on wrong-prefix tables; allow read chains.
- CI: the hardened script fails on a planted `study_*` write and on a raw `createServiceRoleClient` outside the guards (add a fixture test).
- Post-L1 proof: from the study read path, attempt an `INSERT`/`UPDATE`/`DELETE` on each study table and confirm Postgres refuses (permission denied) — the empirical demonstration that the guarantee is structural, run once against a scratch row idea WITHOUT touching real rows (attempt on a non-existent id; the permission error precedes any row match).

## 5. Open decision (needs Hudson)
**L1 mechanism + timing:** approve (1a) RLS `SELECT`-only policies + service-key quarantine [recommended], or (1b) dedicated read-only role — and confirm I may apply the (non-destructive) DDL to the production VT project **after showing the exact SQL**. Until then, A ships on L2–L4 and B is gated on L1.
