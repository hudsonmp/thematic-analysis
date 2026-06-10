# Session Playback + Time-Anchored Coding (SP1) — Design Spec

**Date:** 2026-06-10
**Status:** Approved (scope: SP1) → building via subagent-driven-development
**Repo:** thematic-analysis (branch `feat/session-playback`, off `build/codebook-mvp`)

## Scope

SP1 of a 3-part analysis workbench (SP2 = map/event replay synced to video; SP3 = multi-method analysis — content counts, κ-from-codings, theory→event→code trace). This spec is **SP1 only**: ingest local recordings, a synchronized video/transcript player, and time-anchored coding + analytic memos. Map-replay and multi-method views are deferred but the clock-offset + episode_ref model is built to accept them.

## Context (verified)

- Recordings: `$RECORDINGS_DIR/<PID>/` (env `RECORDINGS_DIR` = `~/Desktop/Research/Season 2/CHI Formative:SIGCSE TS/Zoom Recordings`). Per PID: `<PID>_transcript.srt`, `<PID>_transcript.txt`, `video<id>.mp4`, `audio<id>.m4a`, `recording.conf` (`{"magic_number","items":[{"audio","video"}]}`). Ignore folders without a `<PID>_transcript.srt`.
- SRT clock = recording start (t=0). 651/263 are **single-track**: `idx` / `HH:MM:SS,mmm --> HH:MM:SS,mmm` / leading-space text, **no speaker labels**. Future = **multi-track**: text field is `<Speaker>: <text>`, overlapping ranges allowed, ordered by start time.
- `users.pid` (3-digit) = folder name → `user_id`. Pilots have platform events: 263=Fariha (186 ev/5 snap), 651=Qidi (123 ev/6 snap). SP1 does not need the events; the join is recorded for SP2.
- Tool: Next 16, Supabase (VT project `wuvtffnomynoafbilzxw`, `cb_` tables, **read-only against study tables** via `cbFrom`). Protected routes under `app/(protected)/`; nav = `CodebookNav`. Codebook binds to `visibility='shown'` study. `cb_codings` table exists, unused.

## SP1 components

### 1. Transcript parser — `lib/transcript/srt.ts` (pure, TDD)
`parseSrt(text): Segment[]` where `Segment = { idx, startMs, endMs, speaker: string|null, text }`. Handle both single-track (no speaker → `speaker:null`, full line is text) and multi-track (`<Speaker>: <text>` → split first `:`; if it matches a `Name:` prefix, set speaker). Trim leading space. Tolerate CRLF, blank-line separators, trailing newline. Timecode `HH:MM:SS,mmm` → ms. Robust to a final segment without trailing blank line.

### 2. Session discovery + media — `lib/sessions/discover.ts` (server-only)
`listSessions(): SessionMeta[]` scans `RECORDINGS_DIR`, returns one per PID-folder that has a `<PID>_transcript.srt`: `{ pid, dir, srtPath, txtPath?, videoFile, audioFile?, magicNumber }` (media filenames from `recording.conf`, fallback to glob `video*.mp4`/`audio*.m4a`). `getSession(pid)` → meta + parsed segments + resolved `user_id`/`study_id` (read `users` by pid, read-only; `studies` where visibility='shown') + the per-session `clockOffsetMs` (null until SP2). Validate `pid` is `^[0-9]+$` (no path traversal).

### 3. Media streaming route — `app/api/media/[pid]/[kind]/route.ts`
Streams the local `video`/`audio` for a discovered pid with **HTTP Range support** (206 partial, `Accept-Ranges`, `Content-Range`, `Content-Length`, correct `Content-Type`). Required for video seeking; files are 48–119 MB. Resolve the file via `getSession(pid)` only (never from the raw URL → no traversal). 404 for unknown pid/kind. Researcher-gated (under `(protected)` semantics — the route is in `app/api`, so check the researcher session in the handler, or rely on `proxy.ts` if it covers `/api`).

### 4. Player UI — `app/(protected)/sessions/page.tsx` + `app/(protected)/sessions/[pid]/page.tsx`
- `/sessions`: list discovered sessions (pid, participant first_name from users, duration = last segment endMs, #codings). Add "Sessions" to `CodebookNav`.
- `/sessions/[pid]`: `<video src=/api/media/<pid>/video controls>` + a transcript panel (segments; the segment whose [start,end] contains `currentTime` highlights via `timeupdate`; click a segment → `video.currentTime = startMs/1000`). Client component `SessionPlayer`; segments passed as props from the server page.

### 5. Time-anchored coding + memos — actions + UI
- Extend `EpisodeRef` (lib/types/contracts.ts) with a third variant `recording`: `{ kind:'recording', user_id, study_id, pid, span:[startMs,endMs], segment_idxs?: number[] }`. Keep the existing snapshot/event variants.
- `app/actions/codings.ts`: `addCoding({ codeId, coder, episodeRef })` (validates with Zod, looks up code's current version, writes `cb_codings`), `listCodings(pid)` (codings whose episode_ref.pid = pid, joined to code mnemonic), `deleteCoding(id)`.
- `cb_memos` migration (minimal): `id, codebook_id, pid, span jsonb null, author, body, created_at`. Actions `addMemo/listMemos(pid)/deleteMemo`.
- UI in `SessionPlayer`: select a span (brush across transcript segments, or "use current ±N s") → choose a code from the codebook (`listCodebookTree`) → `addCoding`. Show existing codings as markers/list (click → seek to span start). A memo box per session.

## Out of scope (SP2/SP3)
Map re-animation, event timeline, the clock-anchor UI (offset stays null in SP1), κ-from-codings, content-analysis counts, theory→event→code trace, multi-track speaker diarization beyond parsing.

## Verification
- `parseSrt` unit tests: single-track (651-style), multi-track (`Speaker: text`), timecode→ms, final-segment-no-trailing-blank, CRLF.
- `listSessions` returns 263 + 651, ignores the non-PID folder.
- Media route returns 206 + correct `Content-Range` for a `Range: bytes=0-1023` request on 651's video.
- `/sessions/[pid]` renders the video + transcript; clicking a segment seeks (manual).
- Add a coding on 651 → `cb_codings` row with `episode_ref.kind='recording'`, span set; appears in `listCodings`; delete removes it. Add a memo. Clean up test rows.
- Study tables untouched (lint + the post-test check).
