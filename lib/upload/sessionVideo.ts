/**
 * sessionVideo — pure decision logic for choosing the ONE session recording
 * out of a Zoom export folder that may contain multiple videos.
 *
 * Context: Zoom writes a new numbered file every time the host stops/starts the
 * recording. A study folder therefore contains a short CONSENT recording, the
 * long SESSION recording, and sometimes extra fragments. "Exactly two videos"
 * is false in practice (2-3+ is normal). The upload pipeline must transcribe
 * and store ONLY the session video and skip the consent.
 *
 * The decision signal is VIDEO DURATION. A later task feeds these durations from
 * ffprobe; this module is JUST the pure picker — no I/O, no `server-only`, no
 * Next API. Keeping it pure makes the policy trivially testable and reusable.
 */

/**
 * Videos whose duration is AT OR UNDER this threshold are "consent-length".
 * Consent recordings are short (a participant reading/agreeing to a form);
 * the actual study session runs much longer.
 */
export const CONSENT_MAX_MS = 10 * 60 * 1000;

/** A single video candidate from the Zoom export folder. */
export type CandidateVideo = {
  name: string;
  durationMs: number;
};

/**
 * The result of the picker.
 *
 * - `session`   — the one video to transcribe/store, or null only when there
 *                 were no videos at all.
 * - `consent`   — non-session videos that are ≤ CONSENT_MAX_MS, i.e. safe to
 *                 SKIP as consent recordings.
 * - `ambiguous` — true when the caller should surface a warning to a human
 *                 because the duration signal did not cleanly identify one
 *                 session (see reasons in `pickSessionVideo`).
 * - `reason`    — short machine/human-readable explanation of the decision.
 *
 * Note on the ">=2 long videos" case: a non-session video that is ABOVE
 * CONSENT_MAX_MS is deliberately represented as belonging to NEITHER `session`
 * NOR `consent`. It is not the session (a single longest is chosen) and it is
 * not a skippable consent clip (it's a real, long recording). Its existence is
 * surfaced ONLY through `ambiguous: true` + `reason`, so the caller never
 * silently drops a second genuine recording.
 */
export type SessionPick = {
  session: CandidateVideo | null;
  consent: CandidateVideo[];
  ambiguous: boolean;
  reason: string;
};

/**
 * Order two videos so the SESSION candidate sorts first:
 *   1. longer duration wins;
 *   2. deterministic tie-break: equal durations break by `name` ascending.
 * This is the single ordering used both to pick the longest and to make the
 * choice reproducible regardless of input array order.
 */
function bySessionPriority(a: CandidateVideo, b: CandidateVideo): number {
  if (b.durationMs !== a.durationMs) return b.durationMs - a.durationMs; // longest first
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; // name ascending
}

/**
 * Decide which video is the session and which (if any) are skippable consent
 * recordings, from duration alone.
 *
 * Rules (each maps to a test):
 *  1. Empty input → no session, no consent, not ambiguous.
 *  2. Exactly one video → it IS the session, even if under CONSENT_MAX_MS
 *     (never drop the only video). Not ambiguous.
 *  3. Multiple videos → the single LONGEST (tie-broken by name asc) is the
 *     session. Among the OTHERS:
 *       - any ≤ CONSENT_MAX_MS → consent (skipped);
 *       - any > CONSENT_MAX_MS → neither session nor consent → ambiguous=true,
 *         reason names how many long videos were found;
 *       - if EVERY video is ≤ CONSENT_MAX_MS (no clear session) → still pick
 *         the longest, but ambiguous=true.
 */
export function pickSessionVideo(videos: CandidateVideo[]): SessionPick {
  // Rule 1: empty input.
  if (videos.length === 0) {
    return { session: null, consent: [], ambiguous: false, reason: 'no videos' };
  }

  // Rule 2: a lone video is always the session, regardless of duration.
  if (videos.length === 1) {
    return {
      session: videos[0],
      consent: [],
      ambiguous: false,
      reason: 'single video — treated as session regardless of duration',
    };
  }

  // Rule 3: choose the longest as session via a stable, name-tie-broken sort.
  // Copy before sorting so we never mutate the caller's array.
  const ranked = [...videos].sort(bySessionPriority);
  const session = ranked[0];
  const others = ranked.slice(1);

  const consent = others.filter((v) => v.durationMs <= CONSENT_MAX_MS);
  const otherLong = others.filter((v) => v.durationMs > CONSENT_MAX_MS);

  // Total count of videos above the consent threshold (session may or may not
  // be one of them — in the all-short case it is not).
  const longCount =
    (session.durationMs > CONSENT_MAX_MS ? 1 : 0) + otherLong.length;

  if (otherLong.length > 0) {
    // ≥2 genuinely long recordings: longest still wins, but flag for a human.
    return {
      session,
      consent,
      ambiguous: true,
      reason: `${longCount} videos above consent threshold — picked longest, but ${otherLong.length} other long recording(s) not classified`,
    };
  }

  if (session.durationMs <= CONSENT_MAX_MS) {
    // No video clears the threshold: there is no confident session.
    return {
      session,
      consent,
      ambiguous: true,
      reason: 'all videos under consent threshold — picked longest',
    };
  }

  // Clean case: exactly one long session, the rest are consent-length.
  return {
    session,
    consent,
    ambiguous: false,
    reason: 'picked longest as session; shorter videos classified as consent',
  };
}
