# SP-A Platform Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Steps use `- [ ]`.

**Goal:** Turn the single-user local codebook tool into a multi-user, cloud, collaborative-coding platform: Supabase Auth (gated signup), cloud-stored Zoom sessions, per-coder annotations, an isolated own-coding view + a post-hoc Compare tab + a negotiated canonical layer, and realtime sync of your own work.

**Architecture:** Supabase Auth (`@supabase/ssr`) replaces the shared-password iron-session gate; RLS governs user-context tables. Media (video/audio) lives in a private Supabase Storage bucket, streamed via signed-URL Range; transcripts/codings in Postgres on the research-spike schema (`cb_sessions/cb_transcript_versions/cb_segments/cb_annotations/cb_annotation_codes`). Writes go through server actions bound to the user's session (so `coder_id = auth.uid()`); the browser uses a realtime client for live own-work sync. Study tables stay read-only.

**Tech Stack:** Next 16 (App Router, `next dev --webpack -p 3200`), `@supabase/ssr` 0.10 + `@supabase/supabase-js` 2 (Auth, Storage, Realtime, RLS), Postgres, Vitest. VT project `wuvtffnomynoafbilzxw`.

**Conventions:** Branch `feat/platform-foundation` (already created). Migrations via `mcp__vt-supabase__apply_migration`, types regen → `lib/types/cb-db.ts`. Never write study tables. `.env.local` gitignored. A dev server runs on :3200 — build/verify on :3201. Commit per task.

---

## File structure (locked)
```
lib/supabase/browser.ts            # createBrowserClient (anon key + user session; realtime)
lib/supabase/user-server.ts        # createUserServerClient (ssr, user cookies → auth.uid())
lib/auth/supabase-auth.ts          # getAuthUser(), requireAuthUser() server helpers
app/create/login/*                 # email/password sign-in (replace shared-password)
app/create/register/*              # gated signup (access code → supabase.auth.signUp)
app/(protected)/layout.tsx         # gate via getAuthUser()
app/actions/auth.ts                # registerAction, loginAction, logoutAction, ensureProfile
app/actions/sessions.ts            # createSessionFromUpload, listSessions, getSession (cloud)
app/actions/annotations.ts         # addAnnotation, listMyAnnotations, listAllAnnotations, deleteAnnotation, acceptIntoCanonical
app/api/media/[sessionId]/[kind]/route.ts   # signed-URL Range stream (cloud)
app/(protected)/sessions/upload/*  # folder-picker upload UI
app/(protected)/sessions/[id]/compare/page.tsx + components/sessions/CompareView.tsx
components/sessions/*               # player updated to cloud + per-coder annotations + realtime
docs/migrations/09..14_*.sql        # audit records
```

---

## Phase A1 — Auth (Supabase Auth replaces iron-session)

### Task 1: Supabase auth clients + env
**Files:** Create `lib/supabase/browser.ts`, `lib/supabase/user-server.ts`, `lib/auth/supabase-auth.ts`; modify `.env.local(.example)`.
- [ ] Step 1: Add `RESEARCHER_ACCESS_CODE=ascend3@vt` to `.env.local` and a placeholder to `.env.local.example`. (Keep `RESEARCHER_PASSWORD` for now; remove in Task 4.)
- [ ] Step 2: `lib/supabase/browser.ts`:
```ts
'use client';
import { createBrowserClient } from '@supabase/ssr';
export function createBrowser() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
```
- [ ] Step 3: `lib/supabase/user-server.ts` — an `@supabase/ssr` `createServerClient` bound to Next 16 cookies (read+write for auth token refresh). Mirror the existing `lib/supabase/server.ts` cookie wiring, but ensure it's usable in server actions (cookies mutable). Export `createUserServerClient()`.
- [ ] Step 4: `lib/auth/supabase-auth.ts`:
```ts
import 'server-only';
import { createUserServerClient } from '@/lib/supabase/user-server';
import { redirect } from 'next/navigation';
export async function getAuthUser() {
  const sb = await createUserServerClient();
  const { data } = await sb.auth.getUser();
  return data.user ?? null;
}
export async function requireAuthUser() {
  const u = await getAuthUser();
  if (!u) redirect('/create/login');
  return u;
}
```
- [ ] Step 5: `npx tsc --noEmit` exit 0. Commit `feat(auth): supabase auth clients + helpers`.

### Task 2: Profiles + RLS migration
**Files:** apply migration `09_auth_profiles_rls`; regen types.
- [ ] Step 1: Apply (vt-supabase):
```sql
create table cb_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text, initials text,
  created_at timestamptz not null default now()
);
alter table cb_profiles enable row level security;
create policy cb_profiles_self_rw on cb_profiles
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy cb_profiles_read_all on cb_profiles
  for select to authenticated using (true);  -- coder names visible in Compare

-- Codebook tables: collaborative — any authenticated user reads+writes the one shared codebook.
do $$ declare t text; begin
  foreach t in array array['cb_codebooks','cb_facets','cb_facet_values','cb_codes',
    'cb_code_versions','cb_code_facet_values','cb_citations','cb_code_citations',
    'cb_codebook_versions','cb_coder_comments','cb_reliability_runs','cb_memos']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I_auth_all on %I', t, t);
    execute format('create policy %I_auth_all on %I for all to authenticated using (true) with check (true)', t, t);
  end loop;
end $$;
```
- [ ] Step 2: `mcp__vt-supabase__generate_typescript_types` → overwrite `lib/types/cb-db.ts`. Save SQL to `docs/migrations/09_auth_profiles_rls.sql`.
- [ ] Step 3: `mcp__vt-supabase__get_advisors type=security` → note results (RLS now ON with policies). Commit.
- Note: study tables get NO policy (RLS-on, no policy = only service-role reads them — unchanged). Annotations/sessions tables get policies in Tasks 5 & 8.

### Task 3: Register (gated) + login + logout
**Files:** Create `app/actions/auth.ts`, `app/create/register/page.tsx` + form, modify `app/create/login/page.tsx` + form.
- [ ] Step 1: `app/actions/auth.ts` (`'use server'`):
  - `registerAction(prev, formData)`: read `email`, `password`, `accessCode`. If `accessCode !== process.env.RESEARCHER_ACCESS_CODE` → return `{error:'Invalid access code'}` (no signup). Else `createUserServerClient().auth.signUp({email,password})`; on success `ensureProfile`; redirect `/`. Surface auth errors.
  - `loginAction(prev, formData)`: `signInWithPassword({email,password})`; on success `ensureProfile`; redirect `/`.
  - `logoutAction()`: `auth.signOut()`; redirect `/create/login`.
  - `ensureProfile(user)`: upsert `cb_profiles` `{user_id, display_name: email, initials: derive}` if absent (service-role or user client; user client + the self RW policy works).
- [ ] Step 2: `/create/register` page — email + password + access-code form → `registerAction` (useActionState pattern, mirror the existing login form). `/create/login` → email + password → `loginAction`, link to register.
- [ ] Step 3: Verify (port 3201, build): wrong access code rejects; correct creates a Supabase user (check `auth.users` via execute_sql) + a `cb_profiles` row; login works; logout clears. CLEAN UP the test user (`delete from auth.users where email='...'`). Commit.

### Task 4: Protected gate via Supabase Auth
**Files:** Modify `app/(protected)/layout.tsx`, `app/(protected)/CodebookNav.tsx`; `proxy.ts` comment.
- [ ] Step 1: `(protected)/layout.tsx` — replace the iron-session `getResearcherSession().ok` check with `await requireAuthUser()`. Pass the user's display_name to the nav.
- [ ] Step 2: Nav: show signed-in user + a Logout button (`logoutAction`). 
- [ ] Step 3: `proxy.ts` — update the cookie-presence check to the Supabase auth cookie name (`sb-<ref>-auth-token` or use the `@supabase/ssr` `updateSession` middleware pattern — READ `node_modules/@supabase/ssr` docs; the canonical pattern is a `updateSession` in middleware/proxy that refreshes the token). Keep it a speedbump; the layout is the gate.
- [ ] Step 4: Verify: signed-out → `/` 302s to `/create/login`; signed-in → 200. `tsc/lint/build` green. Commit `feat(auth): supabase-auth protected gate`.

---

## Phase A2 — Cloud sessions (Storage + upload + streaming)

### Task 5: Sessions schema + Storage bucket
**Files:** apply migration `10_sessions`; create bucket; regen types.
- [ ] Step 1: Apply:
```sql
create table cb_sessions (
  id uuid primary key default gen_random_uuid(),
  pid_label text not null,
  collection text not null default 'uncategorized',
  track_mode text not null default 'single' check (track_mode in ('single','multi')),
  video_path text, audio_path text, srt_path text,
  recording_started_at timestamptz, duration_ms int,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create table cb_transcript_versions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references cb_sessions(id) on delete cascade,
  kind text not null check (kind in ('original','cleaned')),
  asr_engine text, is_verbatim boolean not null default true,
  derived_from_version_id uuid references cb_transcript_versions(id),
  created_at timestamptz not null default now(),
  unique (session_id, kind)
);
create table cb_segments (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references cb_sessions(id) on delete cascade,
  version_id uuid not null references cb_transcript_versions(id) on delete cascade,
  speaker text, track_index int,
  t_start_ms int not null, t_end_ms int not null,
  text text not null, words jsonb,
  ordinal int not null,
  source text not null default 'acoustic' check (source in ('acoustic','resegmented','manual')),
  created_at timestamptz not null default now()
);
create index on cb_transcript_versions(session_id);
create index on cb_segments(session_id, version_id, ordinal);
create index on cb_segments(session_id, t_start_ms);
alter table cb_sessions enable row level security;
alter table cb_transcript_versions enable row level security;
alter table cb_segments enable row level security;
create policy cb_sessions_read on cb_sessions for select to authenticated using (true);
create policy cb_sessions_write on cb_sessions for all to authenticated using (true) with check (true);
create policy cb_tv_read on cb_transcript_versions for select to authenticated using (true);
create policy cb_tv_write on cb_transcript_versions for all to authenticated using (true) with check (true);
create policy cb_seg_read on cb_segments for select to authenticated using (true);
create policy cb_seg_write on cb_segments for all to authenticated using (true) with check (true);
```
- [ ] Step 2: Create a PRIVATE Storage bucket `recordings` (via `mcp__vt-supabase__execute_sql`: `insert into storage.buckets (id,name,public) values ('recordings','recordings',false) on conflict do nothing;` and a storage RLS policy allowing authenticated read/write objects in that bucket). Regen types. Save SQL. Commit.

### Task 6: Upload flow
**Files:** Create `app/(protected)/sessions/upload/page.tsx` + `components/sessions/UploadSession.tsx` (client); `app/actions/sessions.ts` (`createSessionFromUpload`); reuse `lib/transcript/srt.ts`.
- [ ] Step 1: `UploadSession.tsx`: `<input type="file" webkitdirectory multiple>` → group selected files by their top folder (the PID). For each PID folder: find `<pid>_transcript.srt`, `video*.mp4`, `audio*.m4a`. Let the user pick a `collection` (free text or existing). On submit: upload media to Storage `recordings/<newSessionId>/video.mp4` etc. via the browser client (`supabase.storage.from('recordings').upload(path, file)` — show progress), read the SRT text client-side, then call `createSessionFromUpload({pid, collection, srtText, videoPath, audioPath, durationFromSrt})`.
- [ ] Step 2: `createSessionFromUpload` (server action, user client): insert `cb_sessions` (pid_label, collection, video_path, audio_path, srt_path, duration_ms, created_by=uid); insert `cb_transcript_versions(kind='original')`; `parseSrt(srtText)` → bulk-insert `cb_segments` (speaker null, source 'acoustic', ordinal by start, char range whole-segment implied). Return session id.
- [ ] Step 3: Verify (3201): upload the local `651` folder → objects appear in `recordings/<id>/`, `cb_sessions`+`cb_segments` rows created (count = parsed segments). CLEAN UP the uploaded objects + rows. Commit.

### Task 7: Cloud media streaming + cloud session reads
**Files:** Rewrite `app/api/media/[sessionId]/[kind]/route.ts`; rewrite `lib/sessions/*` reads → cloud; update `/sessions` + `/sessions/[id]` pages to read `cb_sessions`/`cb_segments`.
- [ ] Step 1: Media route: `requireAuthUser`; load `cb_sessions` by id; `supabase.storage.from('recordings').createSignedUrl(video_path, 60)`; **302 redirect** to the signed URL (Supabase signed URLs serve `Range` natively → seek works). 404 if missing. (This replaces the local-fs Range handler.)
- [ ] Step 2: `getSessionCloud(id)` server action → `{session, segments}` from Postgres (`cb_segments` for the original version, ordered). `listSessionsCloud()` → grouped by collection, by `pid_label`, with #my-annotations.
- [ ] Step 3: `/sessions` page → cloud list (by ID + collection). `/sessions/[id]` page → cloud `getSessionCloud`; `SessionPlayer` `src={/api/media/<id>/video}` unchanged. Remove the local `discover.ts`/`RECORDINGS_DIR` runtime read path (keep the SRT parser; the upload uses it).
- [ ] Step 4: Verify: `/sessions` lists the uploaded cloud session; `/sessions/[id]` plays the cloud video (signed-URL redirect, seek works) + transcript renders. Commit.

---

## Phase A3 — Per-coder annotations + realtime

### Task 8: Annotations schema (supersede cb_codings)
**Files:** apply migration `11_annotations`; regen types.
- [ ] Step 1: Apply:
```sql
create table cb_annotations (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references cb_sessions(id) on delete cascade,
  version_id uuid not null references cb_transcript_versions(id) on delete cascade,
  segment_id uuid not null references cb_segments(id) on delete cascade,
  char_start int not null default 0, char_end int not null default 0,
  quote_text text, prefix text, suffix text,
  t_start_ms int not null, t_end_ms int not null,
  anchor_status text not null default 'exact',
  kind text not null check (kind in ('code','quote')),
  coder_id uuid not null references auth.users(id),
  is_canonical boolean not null default false,
  created_at timestamptz not null default now()
);
create table cb_annotation_codes (
  annotation_id uuid not null references cb_annotations(id) on delete cascade,
  code_id uuid not null references cb_codes(id) on delete cascade,
  primary key (annotation_id, code_id)
);
create index on cb_annotations(session_id);
create index on cb_annotations(session_id, coder_id);
create index on cb_annotations(segment_id);
create index on cb_annotation_codes(annotation_id);
alter table cb_annotations enable row level security;
alter table cb_annotation_codes enable row level security;
-- read all (Compare + realtime); write only your own (or canonical)
create policy cb_ann_read on cb_annotations for select to authenticated using (true);
create policy cb_ann_insert on cb_annotations for insert to authenticated with check (coder_id = auth.uid());
create policy cb_ann_update on cb_annotations for update to authenticated using (coder_id = auth.uid()) with check (coder_id = auth.uid());
create policy cb_ann_delete on cb_annotations for delete to authenticated using (coder_id = auth.uid());
create policy cb_annc_read on cb_annotation_codes for select to authenticated using (true);
create policy cb_annc_write on cb_annotation_codes for all to authenticated
  using (exists (select 1 from cb_annotations a where a.id = annotation_id and a.coder_id = auth.uid()))
  with check (exists (select 1 from cb_annotations a where a.id = annotation_id and a.coder_id = auth.uid()));
```
- [ ] Step 2: Regen types; save SQL. `cb_codings` is superseded — leave it (unused); note in the migration comment. Commit.

### Task 9: Annotation actions + own-coding view (isolation)
**Files:** Rewrite `app/actions/annotations.ts` (replaces `app/actions/codings.ts`); modify `components/sessions/SessionPlayer.tsx` + `[id]/page.tsx`.
- [ ] Step 1: `annotations.ts` (user-server client → `auth.uid()`):
  - `addAnnotation({sessionId, versionId, segmentId, charStart, charEnd, quoteText, prefix, suffix, tStartMs, tEndMs, kind, codeIds})`: insert `cb_annotations` with `coder_id = uid`; insert `cb_annotation_codes` for codeIds. (RLS enforces ownership.)
  - `listMyAnnotations(sessionId)`: `where session_id=? and coder_id=auth.uid()`, joined to code mnemonics.
  - `deleteAnnotation(id)` (RLS: own only).
- [ ] Step 2: `[id]/page.tsx` loads `listMyAnnotations` (NOT all). `SessionPlayer` coding writes `addAnnotation` (coder implicit = you; remove the coder text input — #11). Show only your annotations.
- [ ] Step 3: Verify with two test users (execute_sql to confirm RLS: user B cannot insert an annotation with `coder_id = userA`; the own-view query returns only the caller's). CLEAN UP. Commit.

### Task 10: Realtime (own work across devices)
**Files:** modify `components/sessions/SessionPlayer.tsx` (+ a small `useRealtimeAnnotations` hook).
- [ ] Step 1: `components/sessions/useRealtimeAnnotations.ts` (client): subscribe via `createBrowser()` to `postgres_changes` on `cb_annotations` filtered `session_id=eq.<id>` AND (client-side) `coder_id === myUid`; on insert/delete, update local state (so a coding made on your laptop appears on your monitor tab live). Also subscribe to `cb_codes` changes to refresh the code picker.
- [ ] Step 2: Wire into SessionPlayer; pass `myUid` from the page (from `getAuthUser`). Verify: two tabs same user → an annotation in tab A appears in tab B without reload (manual/scripted). Commit.

---

## Phase A4 — Compare + canonical

### Task 11: Compare tab
**Files:** Create `app/(protected)/sessions/[id]/compare/page.tsx` + `components/sessions/CompareView.tsx`.
- [ ] Step 1: `listAllAnnotations(sessionId)` action → all coders' annotations joined to `cb_profiles.display_name` + code mnemonics, ordered by segment ordinal then coder. (RLS read-all permits this.)
- [ ] Step 2: `CompareView`: per segment (or time row), lanes by coder; mark agreement (same code on the same segment across coders) vs disagreement (distinct/missing). Read-only. A small legend. The video/transcript can be present (reuse player) but the point is the coder×code matrix per segment.
- [ ] Step 3: Add a "Compare" link on the session page. Verify: with two users' annotations on one session, Compare shows both lanes + diffs. Commit.

### Task 12: Canonical layer
**Files:** modify `app/actions/annotations.ts` (`acceptIntoCanonical`), `CompareView`.
- [ ] Step 1: `acceptIntoCanonical({segmentId, codeIds, sourceAnnotationId?})`: insert a `cb_annotations` row with `is_canonical=true`, `coder_id=uid` (the reconciler), copying span/time from the source/segment. A `listCanonical(sessionId)` reader.
- [ ] Step 2: In `CompareView`, an "→ canonical" affordance per agreed/selected coding writes the canonical row; a canonical lane shows the reconciled set. `/export` + the codebook table treat `is_canonical` annotations as the authoritative coding (update export's data source to canonical annotations when present — or note it for SP-C).
- [ ] Step 3: Verify: accept-into-canonical creates an `is_canonical` row; it appears in the canonical lane. Commit.

---

## Phase A5 — Verification

### Task 13: SP-A verification sweep
- [ ] Step 1: Auth: register gated by `ascend3@vt` (wrong code rejects, no user); login/logout; signed-out protected route → 302 login; `cb_profiles` row on login.
- [ ] Step 2: RLS: a second user cannot write annotations as another `coder_id` (execute_sql proves the insert is rejected). Study tables: no authenticated policy → not readable/writable by the anon/auth role; service-role reads only; `check-no-study-writes` lint clean; post-test `study_events` count unchanged (still 568).
- [ ] Step 3: Storage: upload a session → objects in `recordings/<id>/`; media route signed-URL streams with Range/seek on a second browser profile (simulating the second device).
- [ ] Step 4: Codings: own-view isolation (only your annotations); Compare shows all; canonical accept works; realtime own-work cross-tab.
- [ ] Step 5: `npm test`/`tsc`/`lint`/`build` green. Final commit + open PR (do NOT merge).

---

## Self-review
**Spec coverage:** Auth+gated-signup (T1–4 ✓ §A); cloud sessions/Storage/upload/streaming/collections/by-ID (T5–7 ✓ §B); transcript+annotation schema (T5,T8 ✓ §C); own-coding isolation + Compare + canonical (T9,T11,T12 ✓ §D); realtime own-work + cross-device (T10 ✓ §E); reliability placeholder (already SP-0 ✓); SP-B items explicitly out of scope (§F). RLS posture shift (T2,T5,T8). No gaps.
**Type consistency:** `cb_annotations`/`cb_annotation_codes`/`cb_segments`/`cb_sessions`/`cb_transcript_versions` names + columns consistent across T5/T8/T9/T11/T12; `getAuthUser`/`requireAuthUser` (T1) used by layout (T4) + actions (T6,T9); `coder_id = auth.uid()` enforced by RLS (T8) and set by actions (T9).
**Placeholders:** risky parts (RLS SQL, auth flow, Storage upload + signed-URL stream, realtime subscription) carry full SQL/code; CRUD/UI tasks give explicit contracts + the action signatures they bind to (the repo's established server-action + (protected) patterns are the template). Acceptable granularity given a skilled implementer + the existing codebase.
