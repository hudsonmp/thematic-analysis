// Dynamic retrospective questions — PURE seams (no React/Supabase/DOM), so both
// the LIVE sender's default-target derivation and the CODING panel's playhead-gated
// display are unit-testable in isolation.
//
// CROSS-REPO CONTEXT. On /live the researcher composes a custom retrospective
// question for a scenario; the participant receives it on the broadcast contract
// (`retro_question` event, payload `{ text, scenarioIdx }` — see
// spec-study-app/lib/study/push.ts) and queues it for that scenario's retro step.
// The same send PERSISTS to cb_observations as a RETRO-QUESTION row (a row whose
// `retro_question_scenario_idx` is non-null; the question text lives in `body`).
// Migration 31_observation_retro_question.

/** A participant's `phaseStartsMs` (mirrors live.ts `PhaseStartsMs` /
 *  countdown.ts `TimerInput.phaseStartsMs`): `scenarios` is sparse by 0-based
 *  index, each slot the scenario's entry instant (ms epoch) or `undefined` if
 *  unentered. */
type PhaseStartsLike = {
  requirements?: number;
  scenarios: (number | undefined)[];
};

/**
 * The participant's CURRENT scenario index (0-based) — the live sender's default
 * retro-question target. It is the HIGHEST entered scenario slot: the participant
 * advances forward, so the last scenario whose entry instant is recorded is the
 * one they are on. Returns null when no scenario has been entered yet (still in
 * the requirements phase / pre-task).
 *
 * Robust to sparse slots (a back-navigation could leave a later slot set while an
 * earlier one is not) and to a missing `scenarios` array — never throws.
 */
export function currentScenarioIdx(phaseStarts: PhaseStartsLike): number | null {
  const scenarios = phaseStarts?.scenarios;
  if (!Array.isArray(scenarios)) return null;
  let current: number | null = null;
  for (let i = 0; i < scenarios.length; i++) {
    if (typeof scenarios[i] === 'number') current = i;
  }
  return current;
}

/** The minimal observation-row shape `retroQuestionsAt` reads — the
 *  `cb_observations` fields that identify and place a retro-question row. The
 *  coding tool's `ObservationView` is assignable to this. */
export type RetroQuestionRow = {
  id: string;
  /** The question text (the row's `body`). */
  body: string | null;
  /** The non-null discriminator + 0-based target scenario; null ⇒ not a retro row. */
  retroQuestionScenarioIdx: number | null;
  /** The row's `created_at` (ISO). */
  createdAt: string;
};

/** One retro question placed on the playhead timeline, for the spec-mode panel. */
export type RetroQuestionMark = {
  id: string;
  /** The question text shown as "Retrospective question asked: …". */
  body: string;
  /** The 0-based scenario the question targeted. */
  scenarioIdx: number;
  /** The question's video offset (`createdAt − anchor`, floored at 0). */
  offsetMs: number;
};

/**
 * The retro questions ALREADY ASKED by the current playhead instant, time-ordered.
 * "Already asked" = the question's record-relative offset (`createdAt − anchorMs`,
 * floored at 0) is ≤ the playhead (`currentMs`) — so as the analyst scrubs, a
 * question surfaces exactly when the participant would have received it. This
 * mirrors the flag/chat/spec ONE-CLOCK contract in SessionPlayer (same `anchorMs`,
 * same `currentMs`).
 *
 * Only RETRO-QUESTION rows (`retroQuestionScenarioIdx != null`) participate; every
 * other observation is ignored. A null anchor yields [] (the question can't be
 * placed on the timeline — mirrors the flag/spec panes). A row with an unparseable
 * `createdAt` is dropped, never throwing.
 */
export function retroQuestionsAt(
  rows: RetroQuestionRow[],
  anchorMs: number | null,
  currentMs: number,
): RetroQuestionMark[] {
  if (anchorMs === null) return [];
  return rows
    .filter((r) => typeof r.retroQuestionScenarioIdx === 'number')
    .map((r): RetroQuestionMark | null => {
      const createdMs = Date.parse(r.createdAt);
      if (Number.isNaN(createdMs)) return null;
      const offsetMs = Math.max(0, createdMs - anchorMs);
      return {
        id: r.id,
        body: r.body ?? '',
        scenarioIdx: r.retroQuestionScenarioIdx as number,
        offsetMs,
      };
    })
    .filter((m): m is RetroQuestionMark => m !== null && m.offsetMs <= currentMs)
    .sort((a, b) => a.offsetMs - b.offsetMs);
}
