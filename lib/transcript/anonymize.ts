// Pure speaker-label anonymization for interview transcripts. No DOM, no I/O —
// safe to unit-test and to import from anywhere. The server-side resolution of
// WHICH labels count as interviewers (cross-session recurrence, per-study
// overrides) lives in sessions.ts; this module is the pure mapping only.
//
// Anonymization model: transcript segments carry a `speaker` = the Zoom display
// name (e.g. "HudsonMitchell-P" the interviewer, "DavidBarron" a participant).
// For privacy we replace the interviewer's name with the literal "Researcher"
// and every other speaker with the participant's id (PID). Matching is by an
// EXACT normalized key (trimmed + lowercased) — never a substring — so a
// participant named "DavidBarron" can never collide with a researcher alias like
// "DavidSmith".

/** The literal display label every interviewer speaker collapses to. */
export const RESEARCHER_LABEL = 'Researcher';

/**
 * A normalized comparison key for a speaker label: trimmed + lowercased. Used
 * for exact-label matching (NOT substring) so e.g. "DavidBarron" never collides
 * with a researcher alias "DavidSmith". Internal whitespace is preserved, so
 * "Hudson Mitchell-Pullman" and "hudson mitchell-pullman" share a key.
 */
export function speakerKey(label: string): string {
  return label.trim().toLowerCase();
}

/**
 * Map a raw transcript speaker label to its anonymized display form.
 *   - null/empty speaker (single-track transcript, or a whitespace-only label) →
 *     `null`, so the caller renders no label at all.
 *   - speaker whose key is in `researcherKeys` → {@link RESEARCHER_LABEL}.
 *   - any other (non-empty) speaker → `pidLabel`, the participant's number.
 *
 * `researcherKeys` is a Set of already-normalized keys (each produced via
 * {@link speakerKey}). Matching applies {@link speakerKey} to the incoming
 * `speaker`, so it is case-insensitive and exact.
 */
export function anonymizeSpeaker(
  speaker: string | null,
  pidLabel: string,
  researcherKeys: Set<string>,
): string | null {
  if (speaker === null) return null;
  const key = speakerKey(speaker);
  // A whitespace-only (or empty) label carries no speaker — render nothing.
  if (key === '') return null;
  if (researcherKeys.has(key)) return RESEARCHER_LABEL;
  return pidLabel;
}

/**
 * The hard-coded interviewer aliases seeded into the researcher set. Hudson is
 * the consistent interviewer for the current pilot, and these raw labels cover
 * the various Zoom display-name truncations of his name. Exported as RAW labels
 * (not yet normalized) so the server resolver can union them with
 * cross-session-recurrence labels and re-key them however it needs.
 */
export const SEEDED_RESEARCHER_ALIASES: readonly string[] = [
  'HudsonMitchell-P',
  'HudsonMitchellPullman',
  'Hudson Mitchell-Pullman',
  'Hudson Mitchell Pullman',
];

/**
 * The seeded interviewer aliases as a Set of normalized keys
 * ({@link speakerKey} applied to each of {@link SEEDED_RESEARCHER_ALIASES}).
 * Ready to pass straight to {@link anonymizeSpeaker}.
 */
export function seededResearcherKeys(): Set<string> {
  return new Set(SEEDED_RESEARCHER_ALIASES.map(speakerKey));
}

/**
 * Infer researcher aliases from cross-session recurrence — with a
 * CO-OCCURRENCE VETO.
 *
 * Premise of the inference: participants each appear in exactly one session,
 * so a speaker key recurring across sessions is the interviewer. That premise
 * fails for labels that recur because they are PLACEHOLDERS, not people:
 * Zoom's un-named track is literally "Speaker" in 20 sessions here, and the
 * bare recurrence rule credited 12k participant utterances to "Researcher".
 *
 * The veto is structural, not lexical: one session has ONE interviewer, so a
 * key that shares a session with a seeded researcher alias cannot itself be
 * the researcher — the researcher's track in that session is already spoken
 * for. This kills "Speaker" (it always co-occurs with the interviewer's real
 * name) and any future participant-name collision, while a genuine display-
 * name variant of the interviewer still promotes: it recurs in sessions where
 * NO seeded alias is present, which is exactly the gap the inference exists
 * to fill.
 *
 * Pure: takes each session's set of normalized keys, returns seeded ∪ inferred.
 */
export function inferResearcherKeys(
  sessionKeySets: ReadonlyMap<string, ReadonlySet<string>>,
  seeded: ReadonlySet<string> = seededResearcherKeys(),
): Set<string> {
  const sessionsByKey = new Map<string, number>();
  const vetoed = new Set<string>();

  for (const keys of sessionKeySets.values()) {
    const hasSeeded = [...keys].some((k) => seeded.has(k));
    for (const key of keys) {
      if (key === '' || seeded.has(key)) continue;
      sessionsByKey.set(key, (sessionsByKey.get(key) ?? 0) + 1);
      if (hasSeeded) vetoed.add(key);
    }
  }

  const out = new Set(seeded);
  for (const [key, n] of sessionsByKey) {
    if (n >= 2 && !vetoed.has(key)) out.add(key);
  }
  return out;
}
