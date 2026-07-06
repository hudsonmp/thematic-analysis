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
//     from the study's live `help_seeking` prompt; saving forks a child
//     (savePromptVariant, parent = the selected variant — lineage preserved).
//   - a few-shot set is prepended as chat messages BEFORE the grader prompt
//     (…input.fewShot in judge.ts / execution.ts); an empty/absent set is
//     zero-shot. The corpus turns are real study chat turns (user + assistant).

export const EDITOR_COPY = {
  oracleSpec:
    'The operational definition of what "satisfies scenario N" means. The judge grades against this verbatim; edit its [UNDECIDED] markers to make each pass condition concrete.',
  metric:
    'The grading rubric plus the improvement measure. It is embedded verbatim in every judge call and defines how the per-clause verdicts roll up to a score.',
  promptVariant:
    'The system prompt the grader runs under. Seeded from the study’s live help-seeking prompt; editing and saving forks a child variant, so the original’s lineage is preserved.',
  fewShot:
    'Example chat turns prepended to the grader prompt to steer its behavior. Build a set from real study turns; an empty set (none) means zero-shot.',
} as const;

export type EditorCopyKey = keyof typeof EDITOR_COPY;
