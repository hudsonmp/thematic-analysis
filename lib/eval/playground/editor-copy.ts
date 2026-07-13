// Plain-language descriptions of each config artifact, shown at the top of its
// editor so the researcher is not editing a blank textarea blind. Centralized
// here (a pure string module — no logic, no I/O) so the same wording is reused
// by the editor components and can be checked for accuracy against the code in
// one place.
//
// Each string is written to match what the artifact ACTUALLY does in a run:
//   - oracle-spec / metric are embedded VERBATIM into buildJudgePrompt
//     (lib/eval/graders/prompts.ts); their [UNDECIDED] markers come from
//     ORACLE_SPEC_DRAFT / METRIC_DRAFT (lib/eval/seeds.ts).
//   - a prompt variant is the `system` prompt the grader runs under, seeded
//     from GRADER_SYSTEM_PROMPT_DRAFT — a GRADING persona, NOT the study's
//     help-seeking prompt (the eval grades spec improvement, not help). Saving
//     forks a child (savePromptVariant, parent = the selected variant).
//   - a few-shot set is prepended as chat messages BEFORE the grader prompt
//     (…input.fewShot in judge.ts / execution.ts); an empty/absent set is
//     zero-shot — the DEFAULT and the right choice here. The corpus turns are
//     real study conversation turns (help-seeking), so adding them as examples
//     would push the grader back toward help-seeking — keep it zero-shot unless
//     you deliberately want that.

export const EDITOR_COPY = {
  oracleSpec:
    'The operational definition of what "satisfies scenario N" means. The judge grades against this verbatim; edit its [UNDECIDED] markers to make each pass condition concrete.',
  metric:
    'The grading rubric plus the improvement measure. It is embedded verbatim in every judge call and defines how the per-clause verdicts roll up to a score.',
  promptVariant:
    'The grader’s system prompt — a spec-evaluation persona, NOT a help-seeking assistant (the eval measures how specs improve, not help-seeking). Edit + save to fork a child variant; lineage is preserved.',
  fewShot:
    'Optional example turns prepended to steer the grader. Default and recommended: zero-shot (no examples). The corpus is real study conversation turns (help-seeking), so adding them nudges the grader toward help-seeking — leave it zero-shot unless you intend that.',
} as const;

export type EditorCopyKey = keyof typeof EDITOR_COPY;
