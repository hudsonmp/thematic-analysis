# Live timer + researcher→participant push — cross-repo design

- **Date:** 2026-06-18
- **Repos:** `thematic-analysis` (researcher `/live`) + `spec-study-app` (participant `/study`)
- **thematic-analysis branch:** `feat/live-timer-push` (off `feat/live-coobservation`)
- **Status:** APPROVED — C = hard buckets (Hudson 2026-06-18); gate resolved.

## Problem

The researcher's `/live` screen and the participant's `/study` screen run on one Supabase
project but share no real-time link. We need: (1) two researcher→participant pushes
(an "overall time remaining" popup and a "get help" popup that can open the LLM
assistant); (2) a task timer redefined to 10 min for requirements + 15 min per
scenario (retrospective folded into the scenario), shown as BOTH cumulative and
per-task remaining; (3) that timer mirrored on `/live`.

## Resolved decisions

- **(A) Warning — auto AND manual, distinct.** An *automatic* per-task 2-min warning
  popup fires on the participant when the CURRENT task has ≤ 2:00 left (repurpose the
  existing `TimeWarningPopup` onto the per-task clock — no researcher action). A
  *separate manual* `/live` button lets the researcher push a popup showing the
  participant their OVERALL (cumulative) remaining time.
- **(B) At task-0 — advisory.** When a task's remaining hits 0, the participant sees a
  popup and nothing else: no auto-advance, no hard stop; the clock keeps running
  (negative). Both screens may show the overage.
- **(C) Timer model — HARD per-phase buckets (confirmed).** Each phase has an
  independent budget: requirements 10 min, each scenario 15 min. Buckets are WALLED
  OFF: overrunning one task never touches another's budget, and finishing early
  FORFEITS the unused time (no carryover). `taskRemaining = B_current −
  elapsedInCurrentPhase`; `cumulativeRemaining = max(0, taskRemaining) + Σ(B_p for
  phases AFTER current)`. Completed phases contribute 0. The at-0 popup fires on
  `taskRemaining ≤ 0`, advisory only.

### Boundary behavior to surface in UI
Cumulative DROPS at a phase boundary when a task finishes early (unused time forfeited);
an overrun is floored at 0 (not refunded into cumulative). This is intrinsic to hard
buckets — make the per-task and cumulative numbers visibly distinct so the drop reads as
"that task's time is gone," not a bug.

## Timer model (precise — the cross-repo contract)

Phases, in order, per the `task` module: **REQUIREMENTS** (budget 10 min) = intro +
`initial_spec`; then for each scenario `idx` 0..N-1: **SCENARIO idx** (budget 15 min) =
`scenario_read → [ponder] → revise → [retro × q]`. `N = t.scenarios.length` (1–3). Phase
sequence = `[requirements, scenario0, …, scenario(N-1)]`.

- Budgets: `B_requirements = 10*60_000`, `B_scenario = 15*60_000` (each scenario).
- `phaseStart(p)` = the `created_at` of that phase's entry event (`initial_spec` for
  requirements; `scenario_read` for scenario idx). Each phase's clock starts on ITS
  entry (the requirements clock starts at `initial_spec` — new grant near
  `ParticipantFlow.tsx:2110-2118`; today there is NO requirements budget at all and the
  clock starts at the first scenario).
- `currentPhase` = the phase of the latest entry event.
- `taskRemaining(now) = B_current − (now − phaseStart(current))` — may go negative.
- `cumulativeRemaining(now) = max(0, taskRemaining) + Σ B_p over phases AFTER current`.
  Completed phases contribute 0 (no carryover — unused forfeited, overrun not borrowed).
- Logic uses raw negatives (drive the 2-min and at-0 popups); the mm:ss display clamps
  at 0.

The algorithm is implemented in BOTH repos (they can't import each other) from the SAME
`study_events`; these formulas + a SHARED FIXTURE SET (authored in S1, copied to T1) keep
them identical number-for-number. The participant display is authoritative; `/live` is a
deterministic recompute, not a trust-the-broadcast mirror (no drift).

## Realtime broadcast contract

- **Substrate:** Supabase Realtime BROADCAST (ephemeral, NO DB row → never writes a
  study table; read-only invariant preserved). First realtime + first browser Supabase
  client in spec-study-app.
- **Channel:** `live:participant:<pid>` (pid = 3-digit label both apps key on).
- **Events (researcher → participant):**
  - `show_time` — participant opens a popup showing ITS OWN computed cumulative
    remaining (payload empty; the number is local, not sent).
  - `offer_help` — participant opens a popup with an "Open assistant" button.
- **Participant logs receipt** as a `study_event` (`event_type:'researcher_push'`,
  `payload:{kind}`) via the existing server-action path — research data on scaffolding.
- **Authz GATE — RESOLVED (2026-06-18, empirical).** On project `wuvtffnomynoafbilzxw`,
  `realtime.messages` has RLS ENABLED with ZERO policies → AUTHORIZED (private) channels
  are blocked. PUBLIC broadcast does NOT consult `realtime.messages` RLS, so it works
  for both the authed researcher client and the anon participant client. DECISION: use a
  PUBLIC broadcast channel (`config.private = false`, the default); NO migration needed.
  Accepted risk: a guesser with the public anon key + a 3-digit pid could send/receive —
  negligible for an internal study with non-sensitive trigger payloads. Harden later:
  private channel + a `realtime.messages` RLS policy.

## Decomposition

### spec-study-app
- **S1 — timer model (hard buckets) + fixtures.** Add `REQUIREMENTS_BUDGET_MS = 10min`;
  restructure `timer.ts` to expose `{cumulativeRemainingMs, currentPhase, taskRemainingMs}`
  per the formulas above from phase budgets + boundaries; start the requirements clock at
  `initial_spec` (new grant near `:2110-2118`). Update `CarryoverClock`
  (`ParticipantFlow.tsx:1293-1328`) to show BOTH cumulative + task remaining; remove the
  hardcoded `"15:00"` (`:1308`). Author a SHARED FIXTURE SET (input event sequences →
  expected cumulative/task numbers) that T1 will reuse verbatim. Tests.
- **S2 — auto per-task warning + at-0 popup.** Fire `TimeWarningPopup` on
  `taskRemaining ≤ 2min` (was pooled); add an advisory at-0 popup (dismissible) on
  `taskRemaining ≤ 0`.
- **S3 — realtime subscribe + pushes.** First browser Supabase client (anon key); thread
  `user.pid` to the client (`app/study/page.tsx:57`); subscribe to PUBLIC broadcast
  `live:participant:<pid>`; render the two researcher-pushed popups as `fixed` siblings
  in `Shell` (`:646`); lift `AssistantPanel.open` to a prop/ref so the help popup can
  open it; log receipts as `study_events`.

### thematic-analysis
- **T1 — timer mirror on `/live`.** A PURE `lib/live/countdown.ts` (the model above) with
  S1's shared fixtures; extend `liveStatusForPid`/`live.ts` to return phase boundaries
  (derive from `study_events` `module_start`/`step_advance` payloads — already queried at
  `live.ts:220`); show cumulative + task remaining in `LiveFollow`'s clock section
  (`~lines 428-469`).
- **T2 — the two manual push buttons.** A browser broadcast SENDER on
  `live:participant:<pid>` (via `createBrowser`); two buttons in `LiveFollow` (next to the
  recording controls): "Show time remaining" → `show_time`; "Offer help" → `offer_help`.

## Build order & dependencies

S1 is foundational (defines budgets/phases/boundaries + the shared fixtures). Then T1
(reuses S1's fixtures) and S2 (consumes S1's per-task remaining). The channel contract is
shared by S3 + T2. Order: **S1 → T1 → S2 → S3 → T2.**

## Constraints (all tasks)

- thematic-analysis: study tables READ-ONLY (`check-no-study-writes.sh` green); broadcast
  writes NO DB row, so it's allowed. Branch `feat/live-timer-push`; never main; never merge.
  spec-study-app work goes on its own feature branch; never main; never merge.
- Both repos are MODIFIED Next.js — read `AGENTS.md` + `node_modules/next/dist/docs/`
  before Next API changes. Do NOT run `npm run build`/`next start` (shared `.next`);
  verify via `tsc --noEmit`, `lint`, `vitest`.
- The timer formulas + fixtures are the cross-repo contract — S1 and T1 MUST agree
  number-for-number against the same fixtures.
- Experimenter-effect: the two manual pushes change participant behavior; their firing is
  an uncontrolled variable. Log every push (`study_event`) and standardize a firing rule
  in the protocol.
