// LLM-judge grader (Task B2-3).
//
// Asks a model whether the participant's SPECIFICATION TEXT satisfies the
// authored Given/When/Then clauses, one verdict per clause, each grounded in a
// quote. This is the complement to the execution grader: execution measures
// what the spec DOES (compiled + run), judge measures what the spec SAYS.
//
// SCORING: score = satisfied / (satisfied + unsatisfied + unclear), counting
// ONLY clauses whose clauseId matches an AUTHORED clause id. A model can
// hallucinate a clauseId; those are dropped (recorded in evidence.droppedIds)
// so a fabricated id can neither inflate nor dilute the denominator. pass =
// score ≥ DEFAULT_PASS_THRESHOLD.
//
// VERDICT HONESTY: if completeJson throws or returns an unusable shape →
// pass:null with the reason in evidence — never a fabricated verdict.

import { z } from 'zod';
import { DEFAULT_PASS_THRESHOLD, type GradeInput, type GraderModule, type LlmFns, type Verdict } from './types';
import { buildJudgePrompt } from './prompts';

const GRADER_ID = 'llm-judge' as const;

// Per-clause verdict schema. `.strict()` on the outer object keeps the wire
// schema additionalProperties-safe for the structured-output API (matches the
// client's zodOutputFormat path). Each clause verdict is one of the three
// closed labels; `quote` grounds it in the participant's text.
const clauseVerdictSchema = z.object({
  clauseId: z.string(),
  verdict: z.enum(['satisfied', 'unsatisfied', 'unclear']),
  quote: z.string(),
});
const judgeSchema = z
  .object({
    clauses: z.array(clauseVerdictSchema),
    overallRationale: z.string(),
  })
  .strict();

type ClauseVerdict = z.infer<typeof clauseVerdictSchema>;

/** A pass:null verdict that ALWAYS carries the evidence contract's graderId. */
function ungradable(failure: string, extra: Record<string, unknown> = {}): Verdict {
  return {
    pass: null,
    score: null,
    rationale: `llm-judge could not grade: ${failure}`,
    evidence: { graderId: GRADER_ID, failure, ...extra },
  };
}

/**
 * Build the llm-judge grader. The run executor (B2-4) calls
 * `grade(input, realLlmFns)`; tests pass a keyless completeJson stub.
 */
export function makeJudgeGrader(): GraderModule {
  return {
    id: GRADER_ID,
    async grade(input: GradeInput, llm: LlmFns): Promise<Verdict> {
      let parsed: z.infer<typeof judgeSchema>;
      try {
        const { value } = await llm.completeJson(input.llmConfig, {
          system: input.systemPrompt,
          messages: [
            ...input.fewShot,
            { role: 'user', content: buildJudgePrompt(input) },
          ],
          schema: judgeSchema,
          schemaName: 'ClauseVerdicts',
        });
        parsed = value;
      } catch (err) {
        return ungradable(err instanceof Error ? err.message : String(err));
      }

      // Partition the model's clause verdicts by whether the clauseId matches
      // an AUTHORED clause. Hallucinated ids are dropped from scoring.
      const authoredIds = new Set(input.scenario.clauses.map((c) => c.id));
      const counted: ClauseVerdict[] = [];
      const droppedIds: string[] = [];
      for (const cv of parsed.clauses) {
        if (authoredIds.has(cv.clauseId)) counted.push(cv);
        else droppedIds.push(cv.clauseId);
      }

      const total = counted.length;
      if (total === 0) {
        // The model addressed no authored clause — nothing gradable.
        return ungradable('no authored clause verdicts returned', {
          droppedIds,
          overallRationale: parsed.overallRationale,
        });
      }

      const satisfied = counted.filter((c) => c.verdict === 'satisfied').length;
      const score = satisfied / total;
      const pass = score >= DEFAULT_PASS_THRESHOLD;

      return {
        pass,
        score,
        rationale: parsed.overallRationale,
        evidence: {
          graderId: GRADER_ID,
          clauseVerdicts: counted,
          droppedIds,
        },
      };
    },
  };
}
