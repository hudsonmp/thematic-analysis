# SP-A — Platform Foundation Design Spec

**Date:** 2026-06-10
**Status:** Approved (decisions locked below) → writing-plans → subagent-driven-development
**Repo:** thematic-analysis (branch `feat/session-playback` → new branch `feat/platform-foundation`)
**Predecessors:** the codebook tool (PR #1), SP1 session playback, SP-0 quick wins. The transcript/annotation model follows the research spike (Move unit; segment-relative `(segment_id, char_start, char_end)` anchoring + quote-text recovery + materialized time; one schema for single/multi-track).

## Locked decisions
1. **Auth = Supabase Auth** (email + password). Account creation requires the access code `ascend3@vt`. Replaces the shared-password iron-session gate.
2. **Storage = full cloud.** Zoom folders (video + audio + transcript) → Supabase Storage; transcripts/codings in Postgres. Second device streams via signed-URL Range. (IRB flagged + deferred per Hudson.)
3. **Coding independence by UI:** the own-coding view shows ONLY your annotations. A separate **Compare** tab reveals all coders post-hoc. Realtime syncs *your own* work across *your* devices and propagates codebook edits — it never shows another coder's in-progress codes in your coding view.
4. **κ/IRR deprioritized** (reliability stays a placeholder). Schema keeps per-coder annotations so κ is computable later. The trustworthiness warrant is **negotiated agreement → a canonical layer**.

## Scope (SP-A) and the SP-B seam
SP-A delivers: accounts, cloud sessions (upload + Storage streaming + collections + by-ID listing), per-coder annotations, the isolated own-coding view, the Compare tab, a canonical layer, and realtime (own-work + codebook). SP-A populates the research-spike schema **minimally** — single-track acoustic segments from the existing SRT parser, annotations anchored at segment granularity (whole-segment span). **SP-B** later refines: Move re-segmentation, multi-track speaker attribution, original+cleaned versions + in-app cleaning, and sub-segment `char_start/char_end` highlighting + quote-flagging. The schema below is SP-B-ready so SP-B adds behavior, not migrations.

## A. Auth & accounts (replaces iron-session)

- **Supabase Auth (email/password).** Use `@supabase/ssr` server + browser clients with the project's anon key; the user JWT (not the service-role key) governs user-context reads/writes so RLS + realtime work per-coder.
- **Gated registration:** `/create/register` — a server action that requires `accessCode === process.env.RESEARCHER_ACCESS_CODE` (= `ascend3@vt`, moved out of `RESEARCHER_PASSWORD`) BEFORE calling `supabase.auth.signUp({email,password})`. Wrong code → reject, no user created.
- **`/create/login`** → `supabase.auth.signInWithPassword`. Sign-out action.
- **`cb_profiles`** `{ user_id uuid pk references auth.users on delete cascade, display_name text, initials text, created_at }` — coder identity/display (the session has a real uid now; `display_name`/`initials` show in Compare + as the coder on annotations). Row created on first login if absent.
- **The `(protected)` layout** validates `supabase.auth.getUser()` server-side (replaces the iron-session `ok` check); redirect to `/create/login` if no user. `proxy.ts` stays a cookie-presence speedbump; the layout is the real gate. Remove `verifyResearcherPassword`/`getResearcherSession` usage from protected routes (keep the files until fully migrated).
- **RLS:** enable RLS on all `cb_` tables. Policies: `cb_codebooks/cb_facets/cb_facet_values/cb_codes/cb_code_*` — read+write for any authenticated user (one shared codebook, collaborative). `cb_annotations/cb_annotation_codes/cb_memos(comments)` — read for any authenticated; insert/update/delete only where `coder_id = auth.uid()` (own work), EXCEPT the canonical layer (see D). `cb_sessions/cb_segments/cb_transcript_versions` — read for any authenticated; writes via the upload path. Study tables remain read-only (no policy → service-role-only reads, unchanged). Document that this replaces the "service-role bypasses RLS" posture for user-context tables; service-role is retained only for the upload/parse path and study-table reads.

## B. Cloud sessions (Storage + upload + streaming)

- **Storage bucket `recordings`** (private). Objects keyed `recordings/<session_id>/video.mp4`, `/audio.m4a`, `/transcript.srt`.
- **`cb_sessions`** `{ id uuid pk, pid_label text not null (the participant ID number — NO name), collection text not null default 'uncategorized', track_mode text check(single|multi) default 'single', video_path text, audio_path text, srt_path text, recording_started_at timestamptz, duration_ms int, created_by uuid references auth.users, created_at }`. `collection` groups sessions (e.g. `pilot`, `study`) — a plain text field for SP-A (a `cb_collections` table is YAGNI until it needs metadata).
- **Upload flow** `/sessions/upload`: a client folder-picker (`<input webkitdirectory multiple>`) selects one or more PID folders. For each: detect the `<pid>_transcript.srt` + `video*.mp4` + `audio*.m4a` (reuse the discovery logic, now over the File list, not the fs); upload media to Storage (resumable for large video via supabase-js `upload`); call a server action that parses the SRT (`parseSrt` — exists), inserts `cb_sessions` + `cb_transcript_versions(kind='original')` + `cb_segments`; assign the chosen `collection`. Show per-file upload progress. The local `lib/sessions/discover.ts` + `RECORDINGS_DIR` become the *local upload source* only; the runtime read path is the cloud.
- **Media streaming** `app/api/media/[sessionId]/[kind]`: resolve the session's Storage path, mint a short-lived **signed URL** (`createSignedUrl`) and 302-redirect to it (Supabase signed URLs honor `Range` natively, giving seek for free), OR proxy-stream with Range if a redirect leaks the URL undesirably. Researcher-gated (auth check). Replaces SP1's local-fs route.
- **`/sessions` list**: query `cb_sessions` grouped by `collection`; show `pid_label`, collection, duration, #your-codings — **by ID only, never a name**.

## C. Transcript & annotation schema (research-spike model; SP-B-ready)

```
cb_transcript_versions { id, session_id fk, kind check(original|cleaned), asr_engine text,
                         is_verbatim bool, derived_from_version_id fk null, created_at }
cb_segments { id, session_id fk, version_id fk, speaker text null, track_index int null,
              t_start_ms int, t_end_ms int, text text, words jsonb null, ordinal int,
              source text check(acoustic|resegmented|manual) default 'acoustic', created_at }
cb_annotations { id, session_id fk, version_id fk, segment_id fk, char_start int, char_end int,
                 quote_text text, prefix text, suffix text, t_start_ms int, t_end_ms int,
                 anchor_status text default 'exact', kind text check(code|quote),
                 coder_id uuid references auth.users, is_canonical bool default false, created_at }
cb_annotation_codes { annotation_id fk, code_id fk references cb_codes, primary key(annotation_id, code_id) }
```
- SP-A populates `cb_segments` from the single-track SRT (speaker null, source `acoustic`, char range = whole segment). `cb_annotations` in SP-A anchor at `char_start=0, char_end=length(segment.text)` (whole-segment); SP-B adds sub-segment char ranges + the cleaned version + Move re-segmentation. `t_start_ms/t_end_ms` materialized from the segment (SP-B: from word timings).
- **`cb_memos` → comments**: keep the table; it is the session/excerpt comment store (UI already says "Comments"). Add `coder_id uuid` if missing (default to the authenticated user). Optionally fold into `cb_annotations(kind='comment')` later; not in SP-A.
- The deferred `cb_codings` table (SP1) is **superseded** by `cb_annotations` + `cb_annotation_codes`. Migrate any rows (there are none in prod beyond test cleanup) and drop or leave `cb_codings` unused. SP1's `episode_ref.kind='recording'` codings map onto `cb_annotations` (segment-anchored). Update `app/actions/codings.ts` to write `cb_annotations`/`cb_annotation_codes` keyed by `coder_id = auth.uid()`.

## D. Multi-coder: own-coding, Compare, canonical

- **Own-coding view** `/sessions/[id]`: the player + transcript + coding, showing ONLY `cb_annotations where coder_id = auth.uid()` (independence). The coder field is implicit (= you; #11 — no per-coding picker). Realtime subscription on your own annotations (cross-device #16) + codebook codes.
- **Compare tab** `/sessions/[id]/compare`: read-only. For each segment/time, show every coder's annotations side-by-side (lanes by coder via `cb_profiles.display_name`), highlighting agreements/disagreements (same code on overlapping spans = agree; else diff). Post-hoc only — reachable any time, but it is a *reading* surface, not a coding surface.
- **Canonical layer:** annotations with `is_canonical = true` (authored during reconciliation). A reconciliation action in the Compare tab: "accept into canonical" copies/creates a canonical annotation (coder_id = the reconciler, `is_canonical=true`); canonical is the negotiated-agreement output. RLS: any authenticated user may write canonical rows (reconciliation is collaborative); SP-A keeps it simple (no locking). The canonical layer is what `/export` and downstream analysis (SP-C) treat as the authoritative coding.

## E. Realtime (#6, cross-device #16)
- Supabase Realtime (postgres_changes) subscriptions: (a) a coder's own `cb_annotations`/comments → live across their tabs/devices (laptop transcript ↔ monitor video/coding); (b) `cb_codes`/facets edits → propagate so the codebook stays current. NOT others' annotations into the own-coding view. The Compare tab MAY subscribe to all annotations (it's post-hoc/read-only, so live updates there don't violate independence).
- "Everything saved in real time": annotation/comment/cleaning writes persist immediately (optimistic UI + server action), no manual save.

## F. Out of scope (SP-B / SP-C)
Move re-segmentation; multi-track speaker attribution + WhisperX word timings; original+cleaned layers + in-app cleaning; sub-segment char highlighting; quote-flag-for-paper UX; Google-Docs-style code/comment UX; code grouping-by-theme + episode tags + episode presets; citation-at-code-creation. (These ride on SP-A's schema + accounts.)

## G. Verification
- Auth: register with `ascend3@vt` creates a Supabase user + `cb_profiles` row; wrong code rejects; login/logout; a `(protected)` route 302s to login when signed out; RLS denies cross-coder annotation writes (a user cannot insert an annotation with another `coder_id`).
- Storage: upload a PID folder → objects in `recordings/<id>/`; `cb_sessions`+`cb_segments` rows created; `/sessions` lists by ID + collection; the media route signed-URL streams video with Range (206/seek works) on a second browser/device.
- Codings: own-coding view shows only your annotations; a second account's annotations do NOT appear there but DO appear in Compare; "accept into canonical" produces an `is_canonical` row.
- Realtime: an annotation made in tab A appears in tab B (same user) without reload.
- Study tables untouched (RLS read-only / service-role read); no writes (the lint + a post-test check).
- `npm test`/`tsc`/`lint`/`build` green.
