# Thematic-Analysis Session Overhaul — Design + Plan (2026-06-12)

> Execution: subagent-driven-development. One implementer per task, sequential where
> files overlap (SessionPlayer is the nexus of Tasks 1/3/4/5 → serialize those).
> Agents must NOT run `npm run build` / `next start` (shares `.next` with the live
> `:3200` dev server). Verify via `npx tsc --noEmit`, `npm run lint`, `npx vitest run`,
> and DB round-trips. The controller rebuilds + restarts `:3200` between batches.

Branch: `feat/live-coobservation` (PR #3). Read `node_modules/next/dist/docs/` before
touching Next APIs (this is a modified Next 16 — see AGENTS.md).

---

## Goal

Seven changes to the thematic-analysis tool (`~/thematic-analysis`):

0. **Batch folder upload** — drop multiple PID-named folders at once, grouped into a study.
1. **Transcript** — break only on speaker change (merge monologues); highlight→comment becomes
   a yellow-highlight + Cmd-Opt-M callout over the video.
2. **Events** — remove manual event-marking from live + sessions; auto-derive from `study_events`,
   mirrored onto the existing presets.
3. **Names** — in the transcript only, interviewer→"Researcher", interviewee→their PID number.
4. **Sessions UI** — video at 1/2 width (was 2/3); new-code creation panel with all schema fields
   + a system-assigned "study" field.
5. **Flags on timeline** — anchor video 0:00 to the rideshare task start (no manual anchor needed);
   flags carry timestamps and sit next to the transcript; code-creation panel sits below the video
   and the existing-codes rail (NOT below the transcript).

---

## Key facts (verified against code + VT DB `wuvtffnomynoafbilzxw`)

- **Transcript model**: SRT cue = `Speaker: text` → one `cb_segments` row. `speaker` = Zoom display
  name. Pilot `067` has 2 speakers: `DavidBarron` (participant, 610 segs) + `HudsonMitchell-P`
  (interviewer, 74 segs). Annotations anchor to `(segment_id, char_start, char_end)`.
- **Study clock**: `study_events` carry `module_start{moduleType}` and `step_advance{from,to}` with
  step keys (`intro`, `initial_spec`, `scenario_<n>_read|ponder|revise`, `scenario_<n>_retro_<m>`,
  `retro_<m>`, `done`, `body`, `context`). Task module = `moduleType:'task'` ("Rideshare Matching
  Platform"). `taskStartForPid(pid)` = its earliest `module_start.created_at`.
- **Existing engine (Task 2/5)**: `app/actions/live.ts:taskBoundaryEventsForPid`,
  `lib/live/episodes-from-events.ts:deriveEpisodeMarks`, `app/actions/episodes.ts:materializeAutoEpisodes`
  (requires `recording_started_at` — must relax), `app/actions/sessions.ts:autoAnchorSession`
  (`recordingStart ?? taskStart` — **defined but never called**).
- **Preset `cb_episodes`** (the 8 to mirror onto): Requirements Analysis · Writing Specification from
  Requirements · New Scenario Introduced · Editing Specification · Scenario Retrospective ·
  General Retrospective Question I · II · III.
- **Codebook scheme**: `cb_facets(type ∈ enum|boolean|open_text, cardinality ∈ single|multi)`.
  `createCode({codebookId,mnemonic,name,origin,version})→id`; `createCodesBulkWithFacets(...)`.
  Citation = system-assigned virtual facet via `cb_code_citations(role ∈ derived_from|near_miss|related)`.
  Grid columns derived by `facetRenderMode(type,cardinality)` in `lib/codebook/facet-types.ts`.
- **"Study"**: no `cb_studies`. `cb_codebooks.study_id`→shown study (one per codebook). Session has
  `cb_sessions.collection` (e.g. `"pilots"`) — the discriminating "study number" the code was authored
  under. → store per-code authoring study = the **current session's collection**.
- **SessionPlayer layout**: `grid lg:grid-cols-3`; video `lg:col-span-2`; transcript `lg:col-span-1`,
  body `h-[70vh]`. Manual Event section ≈ 1205–1283; handlers `handleMarkEpisode` 879–893,
  `handleDeleteEpisodeMark` 895–906; comment thread popover is a LEFT-column section 1394–1524;
  selection comment input in the coding toolbar 1362–1388.

---

## Design decisions

### Task 0 — Batch folder upload (`components/sessions/UploadSession.tsx`)
`<input webkitdirectory>` accepts only ONE root. Add a **drag-and-drop dropzone** that accepts MANY
folders at once via `DataTransferItem.webkitGetAsEntry()` → recurse each directory entry → `File[]`
with synthesized `webkitRelativePath = "<folderName>/<file>"`. Reuse `groupByPid` (top folder = PID).
Keep the existing input as a fallback. One `collection` (study) applies to the whole batch. No server
changes. This is the trivial task.

### Task 1a — Speaker-turn grouping (`lib/transcript/turns.ts` NEW + SessionPlayer render)
Pure `groupIntoTurns(segments) → Turn[]` where a Turn is a maximal run of consecutive segments with the
SAME `speaker`. `Turn = { speaker, segIndices:number[], startMs, endMs }`. Render one block per turn:
speaker label + ONE `[mm:ss]` seek (turn start), then the run's cues inline in a single `<p>`, EACH cue
still its own `<span data-seg-idx={i}>` (preserves sub-segment annotation anchoring + per-cue highlights).
Divider (`divide-y`) moves to between turns. Active-cue sync: scroll the turn containing `activeIdx`;
tint the active cue. No DB change. Tests: consecutive same-speaker merge; speaker change splits; single
speaker = one turn; null speakers (single-track) = one turn.

### Task 1b — Yellow highlight + Cmd-Opt-M comment callout (SessionPlayer)
- **Select text → persistent yellow highlight** (no popup). Add the live selection as a synthetic
  highlight (`kind:'pending'`, amber/yellow) layered through the existing `splitIntoPieces`, so the
  brushed span stays yellow even after the native selection clears.
- **Cmd-Opt-M** (keydown; `e.metaKey && e.altKey && (e.code==='KeyM'||e.key==='m'||'µ')`) → if a pending
  selection exists, open a **callout popover positioned over the video** (absolutely positioned inside a
  `relative` wrapper around the `<video>`), containing the excerpt + a textarea + Comment/Cancel. Submit →
  `handleCommentOnSelection` (existing: creates a `quote` anchor + first comment). Plain selection NEVER
  opens the popup.
- **Commented spans render yellow** and clicking one opens its thread in the SAME callout-over-video.
  Move the existing thread popover OUT of the left column into the callout. Quote/comment highlight color
  → amber/yellow (`bg-amber-300/60`); codes stay emerald.
- Keep "Apply code" / "Flag quote" in the left toolbar (those aren't "comment"); only the COMMENT box
  relocates to the callout.

### Task 2 — Auto-events, remove manual marking
**Remove (manual UI):**
- LiveFollow: event bar + "+ new event" + `addEvent`/`submitNewEvent` + `episodes` state/prop +
  `createEpisode` import (per agent map: lines 13,70,83–84,223–244,335–347,650–712).
- live/page.tsx: drop `listEpisodes` (line 44), `episodes` destructure (59), `episodes` prop (74).
- SessionPlayer: remove the episode `<select>` + "Mark here" (1227–1248), `handleMarkEpisode`,
  `handleDeleteEpisodeMark`, state `selectedEpisodeId/marking/busyEpisodeMarkId`, the per-row delete ✕
  (1270–1278), and imports `markSessionEpisode/deleteSessionEpisode`. **KEEP** the `sessionEpisodes`
  list as a read-only seek timeline.
**Retarget derivation onto the 8 presets** (`lib/live/episodes-from-events.ts` + `episodes.ts`):
extend `CanonicalStep` so each maps 1:1 to a preset name:
| step key (`to`)             | CanonicalStep        | preset name                              |
|-----------------------------|----------------------|------------------------------------------|
| `module_start` / `intro`    | `requirements`       | Requirements Analysis                    |
| `initial_spec`              | `specification`      | Writing Specification from Requirements  |
| `scenario_<n>_read`         | `scenario`           | New Scenario Introduced                  |
| `scenario_<n>_revise`       | `editing`            | Editing Specification                    |
| `scenario_<n>_retro_<m>`    | `scenario_retro`     | Scenario Retrospective                   |
| `retro_0|1|2`               | `general_retro_<m>`  | General Retrospective Question I|II|III  |
| `ponder` / `done`/`body`/…  | (drop)               | —                                        |
De-dup consecutive identical labels (existing behavior), but `general_retro_<m>` keeps its index so the
three standalone retros stay distinct. `CANONICAL_EPISODE_NAME` → the exact preset names above (Roman
numerals via a 0-based→I/II/III map). Update tests.
**Anchor-independent + automatic**: `materializeAutoEpisodes` falls back `recording_started_at ??
taskStartForPid(pid)` for the anchor (don't throw when the manual mark is unset). Call it from the
session `[id]` page loader (idempotent; cb_ writes only) so marks always exist on view.

### Task 3 — Transcript name anonymization (server-side)
`lib/transcript/anonymize.ts` NEW: `anonymizeSpeaker(speaker, pidLabel, researcherLabels) → string`
(researcher→`"Researcher"`, else→`pidLabel`; null speaker→null). `researcherSpeakerLabels()` server
helper = union of (a) a constant alias list seeded with Hudson's labels
(`["HudsonMitchell-P","HudsonMitchellPullman","Hudson Mitchell-Pullman"]`) and (b) cross-session
recurrence (speakers in ≥2 distinct `cb_sessions` via `cb_segments`). Apply in `getSessionCloud` +
`getSessionSegments` (sessions.ts) so `segment.speaker` is already the role label before it reaches the
client. Match is case-insensitive, exact label (not substring → avoids "David" collisions). Only the
transcript is affected; the live page's `firstName` etc. are untouched.

### Task 4 — 50/50 layout + new-code panel
- Layout: `grid lg:grid-cols-2`; video `lg:col-span-1`; transcript `lg:col-span-1`. Transcript body
  keeps `h-[70vh]`. Wrap `<video>` in a `relative` container (anchor for the Task 1b callout).
- **New-code panel** (`components/sessions/SessionCodeCreator.tsx` NEW), placed in the LEFT column BELOW
  the "My annotations" rail (Task 5 correction: below video+codes, not below transcript). Quick single-code
  add: Name (required) + auto mnemonic + all scheme facets rendered by `facetRenderMode` (reuse
  `lib/codebook/grid.ts` helpers / FacetTagger patterns) + a **read-only system field "Study"** showing the
  session's `collection`. Submit → `createCode(...)` then set facet values; persist `study_label`. On
  success, `router.refresh()` so the new code appears in the picker.

### Task 4/Migration — per-code authoring study
`docs/migrations/27_code_study_label.sql`: `alter table cb_codes add column study_label text;`
`createCode` accepts optional `studyLabel` and writes it. Session code panel passes the session's
`collection`. Standalone codebook page passes nothing (null). Apply to VT DB via `apply_migration`.

### Task 5 — Flags timeline anchor + flags-next-to-script
- **Anchor always resolves**: session `[id]` page computes `effectiveAnchor = recordingStartedAt ??
  taskStartForPid(pidLabel)`; pass as `recordingStartedAt` to the player. Remove the "anchor not set"
  dead-end branch; if even taskStart is null, hide the flag UI silently.
- **Flags next to the script**: in the transcript (right) column, render a flag gutter — each flag chip
  (swatch + label + `[mm:ss]`) aligned to the TURN whose `[startMs,endMs)` contains the flag's offset
  (`createdAt − anchor`, clamp ≥0); chips before that turn, click → seek. Keep a compact under-video
  overview rail too. Flags must show their timestamp.
- **Code panel placement**: the Task 4 panel is in the LEFT column below the codes rail (already specified).

---

## Task list (execution order)

1. **DB migration 27** (`study_label`) — apply via MCP + add file. [isolated]
2. **Pure libs** (independent files, no SessionPlayer): `lib/transcript/turns.ts`,
   `lib/transcript/anonymize.ts`, extend `lib/live/episodes-from-events.ts` + tests. [parallel-safe]
3. **Task 0** batch upload (`UploadSession.tsx`). [isolated — the "trivial subagent"]
4. **Server actions**: sessions.ts (anonymize in getSessionCloud/getSessionSegments + `researcherSpeakerLabels`),
   codes.ts (`createCode` studyLabel), episodes.ts (anchor fallback + retargeted `CANONICAL_EPISODE_NAME`).
5. **Task 2 removal**: LiveFollow + live/page.tsx (manual events). [no SessionPlayer overlap]
6. **SessionPlayer + session [id] page** (Tasks 1a,1b,4 layout+panel,5 flags+anchor, 2 player-side removal,
   3 consumes anonymized speakers): serialized sub-steps on the one file.
7. **New component** `SessionCodeCreator.tsx` (used by step 6).

After each batch: `npx tsc --noEmit && npm run lint && npx vitest run`. Controller rebuilds `.next` +
restarts `:3200` after step 6. Final: full suite + diff review + commit on `feat/live-coobservation`.

## Acceptance
- Drop ≥2 PID folders → all queued under one collection, upload sequentially.
- Transcript: one block per speaker turn; names show "Researcher" / PID; select→yellow; Cmd-Opt-M→callout
  over video; commented spans yellow.
- No manual event UI on live or session; `cb_session_episodes` auto-populate from `study_events` onto the
  8 presets; visible as a read-only seek list.
- Video at 1/2 width; new-code panel below the codes rail with all facets + read-only Study field.
- Flags place at `createdAt − taskStart` with no manual anchor; appear next to the transcript with `[mm:ss]`.
- `npx tsc --noEmit`, `npm run lint`, `npx vitest run` all green.
