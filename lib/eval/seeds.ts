// PURE seed content for the eval harness's self-initializing artifacts
// (sub-project B). When `listArtifacts` finds an empty kind it inserts the
// matching DRAFT below so the harness is usable on first load — but every
// operational definition in these drafts is a PROPOSAL derived from the
// authored Then/And clauses of the rideshare task, NOT a decided oracle.
// Hudson edits them (append-only versions via saveArtifact) before any
// verdict is trusted; the DRAFT banner at the top of each is the contract.
//
// Kept pure (no server-only, no I/O) so vitest can pin the content and the
// hash helper directly.

import { createHash } from 'node:crypto';

/** Lowercase hex sha-256 of `content` (utf8). Used as the artifact `hash`
 *  column so any two artifact versions with identical content are detectable
 *  (append-only versioning never overwrites, so dedupe is by hash). */
export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export const ORACLE_SPEC_DRAFT = `> **DRAFT — Hudson: edit before trusting any verdict.** Auto-derived from the
> authored Then-clauses; the operational definitions below are PROPOSALS.

## Global decisions (unresolved)

1. **SILENCE HANDLING** — when a participant's spec is silent on something the
   dispatch policy needs (e.g. tie-breaking between vehicles), is that
   "simulator default applies" or "clause fails"? [UNDECIDED — pick one]
2. **Matching strictness** — exact assignment match vs pickup ordering vs
   geographic end-state only. [UNDECIDED]

## Scenario 1

Authored basis (paraphrased from the authored Then/And clauses): Vehicle 1 pauses and picks up
Rider B from Lane Field (before A, because it passes Lane Field first); drops
B at Executive Airport; picks up Rider A at Executive Airport; drops A at
Newman Library.

Pass conditions (proposed):

- Vehicle 1 pauses its current trip and picks up Rider B from Lane Field
  BEFORE Rider A, because it passes Lane Field first.
- Vehicle 1 drops Rider B at Executive Airport.
- Vehicle 1 picks up Rider A at Executive Airport.
- Vehicle 1 drops Rider A at Newman Library.
- End-state: A at Newman Library, B at Executive Airport, all served by V1 in
  B-then-A order.

Tolerances: [UNDECIDED — e.g. is pickup ORDER required or only final positions?]

## Scenario 2

Authored basis (paraphrased from the authored Then/And clauses): Vehicle 1 adds Rider B to its
pickup queue; Vehicle 2 repositions to ASCEND³ (central) while idle; V1 drops
A at Newman Library then picks up B at Lane Field, drops B at Executive
Airport.

Pass conditions (proposed):

- Vehicle 1 adds Rider B to its pickup queue.
- Vehicle 2 repositions to ASCEND³ (central) while idle.
- [WHEN — simulator-provided trigger, not graded] Vehicle 1 drops Rider A at
  Newman Library.
- Vehicle 1 then picks up Rider B at Lane Field, then drops Rider B at
  Executive Airport.
- End-state: B served by V1; V2 repositioned, unused for pickups.

Tolerances: [UNDECIDED — e.g. is pickup ORDER required or only final positions?]

## Scenario 3

Authored basis (paraphrased from the authored Then/And clauses): when Rider C requests from Newman
Library (where V1 just dropped A), Rider B is REMOVED from V1's queue and
ADDED to V2; V2 drives to pick up B from ASCEND³; V1 takes C to Lane Field.

Pass conditions (proposed):

- When Rider C requests a ride from Newman Library (where V1 just dropped A),
  Rider B is REMOVED from Vehicle 1's queue and ADDED to Vehicle 2's.
- Vehicle 2 drives to pick up Rider B from ASCEND³.
- Vehicle 1 takes Rider C to Lane Field.
- End-state: reassignment happened; C served by V1; B served by V2.

Tolerances: [UNDECIDED — e.g. is pickup ORDER required or only final positions?]

## Scenario 4

Authored basis (paraphrased from the authored Then/And clauses): V1 battery falls below the 15%
operating threshold after dropping A → B is removed from V1's queue and added
to V2; V1 drives to the Depot to charge INSTEAD of picking up B; V2 picks up B
at Lane Field.

Pass conditions (proposed):

- [WHEN — simulator-provided trigger, not graded] Vehicle 1's battery falls
  below the 15% operating threshold after dropping Rider A.
- Rider B is removed from Vehicle 1's queue and added to Vehicle 2's.
- Vehicle 1 drives to the Depot to charge INSTEAD of picking up Rider B.
- Vehicle 2 picks up Rider B at Lane Field.
- End-state: V1 at Depot charging; B served by V2.

Tolerances: [UNDECIDED — e.g. is pickup ORDER required or only final positions?]
`;

export const METRIC_DRAFT = `> **DRAFT — Hudson: edit before trusting any verdict.** Rubric skeleton with
> proposed vocabulary and thresholds; every [UNDECIDED] below is yours to fix.

## Judge rubric (per phase)

For each authored Then/And clause of the scenario under grading, the judge
issues exactly one verdict:

- **satisfied** — the participant's spec, as written, entails the clause's
  outcome.
- **unsatisfied** — the spec contradicts the clause or specifies a different
  outcome.
- **unclear** — the spec neither entails nor contradicts the clause (silence
  or ambiguity; see the oracle spec's SILENCE HANDLING decision).

Every per-clause verdict MUST quote the spec text that grounds it. For
"unclear by silence", state explicitly that no grounding text exists.

## Scoring

- score = satisfied_clauses / applicable_clauses, in [0, 1].
- pass = score ≥ [UNDECIDED threshold, proposed 0.8].

## Improvement metric (per participant)

- delta_k = score(phase k) − score(phase k−1), over the 5 phase ordinals.
- Report the per-phase deltas AND the total delta (last phase − first phase).
- Computed over stored verdicts, not by re-prompting a model — so the metric
  is grader-agnostic and reproducible from the verdict table alone.
`;

// ---------------------------------------------------------------------------
// GRADER SYSTEM PROMPT — the `system` message BOTH graders run under (passed as
// input.systemPrompt in execution.ts / judge.ts). This REPLACES the old seed,
// which copied the study's live `help_seeking` assistant prompt — a role
// contradiction: a help-seeking assistant was being asked to grade. The eval's
// purpose is to measure how student SPECIFICATIONS improve across iterations,
// with NO help-seeking behavior. Like the other drafts, it is a PROPOSAL Hudson
// edits; the DRAFT banner is the contract.
// ---------------------------------------------------------------------------
export const GRADER_SYSTEM_PROMPT_DRAFT = `> **DRAFT — Hudson: edit before trusting any verdict.** This is the grader's
> persona. It is deliberately NOT a help-seeking assistant.

You are an evaluator of student-authored SPECIFICATIONS for an autonomous
rideshare-dispatch system. Each student writes a natural-language specification
(plus an entity / element data model) describing how vehicles should be
dispatched, and revises it across several iterations as new scenarios are
revealed.

Your only job is to assess a specification on its own terms — how faithfully and
completely it handles the task the surrounding instructions name. The research
question is how specifications IMPROVE over iterations, so your judgments must
reflect the specification exactly as written.

You are NOT a help-seeking assistant, a tutor, or a coding aide. Do not offer
help, coach the student, or repair, complete, or improve their specification.

Rules:
- Judge the specification AS WRITTEN. Do not fill silences or resolve
  ambiguities for or against the student — surface them.
- Ground every judgment in the specification's own text; quote it where the
  task asks you to.
- Follow the task-specific instructions in the USER message verbatim — they
  carry the rubric, the oracle, or the policy-synthesis request. This system
  prompt sets your ROLE; the user message sets the exact TASK.
- Be precise and terse. No encouragement, no meta-commentary, no help.
`;
