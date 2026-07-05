// Grader tests (Task B2-3). STUBS ONLY — keyless, no real LLM, no network.
//
// The LLM surface is injected (plan Global Constraints), so every case here
// passes a hand-built `LlmFns` stub that returns a FIXED response. The
// execution-grader case is the exception to "no child process": it drives the
// REAL sandbox (a genuine node child) against the S0 reference policy, because
// the grader's whole job is running untrusted code and the round-trip is the
// only faithful test of that path. One scenario, kept fast.
//
// The trusted stub-return policy source is the S0 reference behavior ported to
// a plain-JS `function decide(world, event)` string — sourced from
// REFERENCE_POLICY[0] in lib/sim/__tests__/sim.test.ts (its S0 case: assign B
// then A to V1 on B's request, else noop).

import { describe, expect, it } from 'vitest';
import { extractCodeBlock, buildPolicyGenPrompt, buildJudgePrompt } from '../graders/prompts';
import { makeExecutionGrader } from '../graders/execution';
import { makeJudgeGrader } from '../graders/judge';
import type { GradeInput, LlmFns } from '../graders/types';
import { DEFAULT_PASS_THRESHOLD } from '../graders/types';
import type { Scenario } from '@/lib/study/study';

// --- fixtures --------------------------------------------------------------

// S0 reference policy as a fenced JS block (see REFERENCE_POLICY[0]). Used as
// the stubbed codegen output for the happy-path execution test.
const S0_POLICY_BLOCK = [
  'Here is the dispatch policy for the participant spec:',
  '',
  '```js',
  'function decide(world, event) {',
  "  if (event.type === 'ride_request' && event.rider === 'B') {",
  '    return [',
  "      { act: 'assign', vehicle: 'V1', rider: 'B' },",
  "      { act: 'assign', vehicle: 'V1', rider: 'A' },",
  '    ];',
  '  }',
  "  return [{ act: 'noop' }];",
  '}',
  '```',
].join('\n');

const A_CLAUSE_ID = 'c-given';
const B_CLAUSE_ID = 'c-when';
const C_CLAUSE_ID = 'c-then';
const D_CLAUSE_ID = 'c-and';

const SCENARIO_FIXTURE: Scenario = {
  id: 's-fixture',
  title: 'Scenario fixture',
  facilitatorNote: '',
  clauses: [
    { id: A_CLAUSE_ID, type: 'Given', text: 'V1 is at Lane Field.' },
    { id: B_CLAUSE_ID, type: 'When', text: 'Rider B requests a ride.' },
    { id: C_CLAUSE_ID, type: 'Then', text: 'B is picked up before A.' },
    { id: D_CLAUSE_ID, type: 'And', text: 'Both riders are served by V1.' },
  ],
};

function baseInput(overrides: Partial<GradeInput> = {}): GradeInput {
  return {
    pid: 'p1',
    phaseOrdinal: 0,
    scenarioIdx: 0,
    spec: 'When B requests, pick B up first, then A.',
    entities: [{ id: 'e1', name: 'Vehicle', elements: [{ id: 'el1', name: 'battery' }] }],
    scenario: SCENARIO_FIXTURE,
    oracleSpec: { content: 'ORACLE SPEC TEXT', hash: 'oh' },
    metricDoc: { content: 'METRIC DOC TEXT', hash: 'mh' },
    systemPrompt: 'You are a grader.',
    fewShot: [],
    llmConfig: { model: 'claude-sonnet-4-6' },
    ...overrides,
  };
}

/** Build an LlmFns stub. `completeText` fixes what `complete` returns;
 *  `jsonValue` fixes what `completeJson` returns (as its `.value`); either can
 *  throw by passing a function that throws. Unused arms throw loudly so a test
 *  that hits the wrong path fails visibly rather than silently. */
function stubLlm(opts: {
  completeText?: string;
  jsonValue?: unknown;
  completeThrows?: boolean;
  jsonThrows?: boolean;
}): LlmFns {
  return {
    complete: (async () => {
      if (opts.completeThrows) throw new Error('stub complete boom');
      if (opts.completeText === undefined) throw new Error('stub complete not configured');
      return { text: opts.completeText, usage: { inputTokens: 1, outputTokens: 1 } };
    }) as unknown as LlmFns['complete'],
    completeJson: (async () => {
      if (opts.jsonThrows) throw new Error('stub completeJson boom');
      if (opts.jsonValue === undefined) throw new Error('stub completeJson not configured');
      return { value: opts.jsonValue, usage: { inputTokens: 1, outputTokens: 1 } };
    }) as unknown as LlmFns['completeJson'],
  };
}

// --- extractCodeBlock ------------------------------------------------------

describe('extractCodeBlock', () => {
  it('extracts a single fenced block, stripping the language tag', () => {
    const text = 'prose\n```js\nfunction decide() { return []; }\n```\nmore prose';
    expect(extractCodeBlock(text)).toBe('function decide() { return []; }');
  });

  it('returns the LAST block when several are present', () => {
    const text = ['```js', 'const first = 1;', '```', 'and then', '```', 'const last = 2;', '```'].join(
      '\n',
    );
    expect(extractCodeBlock(text)).toBe('const last = 2;');
  });

  it('returns null when there is no fenced block', () => {
    expect(extractCodeBlock('just prose, no code here')).toBeNull();
  });

  it('does NOT match tilde fences (~~~) — only backtick fences', () => {
    const text = '~~~js\nfunction decide() { return []; }\n~~~';
    expect(extractCodeBlock(text)).toBeNull();
  });
});

// --- prompt builders (pure) ------------------------------------------------

describe('prompt builders', () => {
  it('buildPolicyGenPrompt names the decide signature, the vocabulary, and the faithfulness rule', () => {
    const p = buildPolicyGenPrompt('When B requests, pick B first.', [
      { id: 'e1', name: 'Vehicle', elements: [{ id: 'x', name: 'battery' }] },
    ]);
    expect(p).toContain('function decide(world, event)');
    // WorldView / SimEvent / PolicyAction vocabulary is present.
    expect(p).toContain('WorldView');
    expect(p).toContain('SimEvent');
    expect(p).toContain('PolicyAction');
    expect(p).toMatch(/assign|reassign|reposition|charge|noop/);
    // Faithfulness-including-gaps instruction (verbatim spirit from the plan).
    expect(p).toMatch(/faithfully/i);
    expect(p).toMatch(/do not add behaviors they did not specify/i);
    // The participant spec + entity model are embedded.
    expect(p).toContain('When B requests, pick B first.');
    expect(p).toContain('Vehicle');
    expect(p).toContain('battery');
  });

  it('buildJudgePrompt embeds metric.md + oracle-spec verbatim, the clauses, and the spec', () => {
    const p = buildJudgePrompt(baseInput());
    expect(p).toContain('METRIC DOC TEXT');
    expect(p).toContain('ORACLE SPEC TEXT');
    // Each authored clause id + text appears so the model can cite them.
    expect(p).toContain(A_CLAUSE_ID);
    expect(p).toContain('Rider B requests a ride.');
    expect(p).toContain('B is picked up before A.');
    // Participant spec.
    expect(p).toContain('When B requests, pick B up first, then A.');
  });
});

// --- execution grader ------------------------------------------------------

describe('makeExecutionGrader (deterministic backend)', () => {
  it('passes S0 when codegen returns the reference policy and the real sandbox runs it', async () => {
    const grader = makeExecutionGrader('deterministic');
    const verdict = await grader.grade(baseInput({ scenarioIdx: 0 }), stubLlm({ completeText: S0_POLICY_BLOCK }));

    expect(verdict.pass, JSON.stringify(verdict)).toBe(true);
    expect(verdict.score).not.toBeNull();
    expect(verdict.score as number).toBeGreaterThanOrEqual(DEFAULT_PASS_THRESHOLD);
    // Evidence contract: ALWAYS graderId + simBackend, plus the run artifacts.
    expect(verdict.evidence.graderId).toBe('execution-codegen');
    expect(verdict.evidence.simBackend).toBe('deterministic');
    expect(verdict.evidence.policySource).toContain('function decide');
    expect(verdict.evidence.endState).toBeTruthy();
    expect(verdict.evidence.expected).toBeTruthy();
    expect(Array.isArray(verdict.evidence.perCheck)).toBe(true);
    // S0 has 2 riders → 2 servedBy + 2 droppedAt + 1 vehicle charged = 5 checks.
    expect((verdict.evidence.perCheck as unknown[]).length).toBe(5);
  });

  it('returns pass:null with a no-code-block failure when codegen emits only prose', async () => {
    const grader = makeExecutionGrader('deterministic');
    const verdict = await grader.grade(
      baseInput({ scenarioIdx: 0 }),
      stubLlm({ completeText: 'I cannot write code, but here are my thoughts...' }),
    );

    expect(verdict.pass).toBeNull();
    expect(verdict.score).toBeNull();
    expect(verdict.evidence.failure).toBe('no code block');
    // The always-present evidence keys survive the failure path.
    expect(verdict.evidence.graderId).toBe('execution-codegen');
    expect(verdict.evidence.simBackend).toBe('deterministic');
  });

  it('returns pass:null when the sandbox fails (policy never defines decide)', async () => {
    const grader = makeExecutionGrader('deterministic');
    const block = '```js\nconst notDecide = 1;\n```';
    const verdict = await grader.grade(baseInput({ scenarioIdx: 0 }), stubLlm({ completeText: block }));

    expect(verdict.pass).toBeNull();
    expect(verdict.score).toBeNull();
    expect(String(verdict.evidence.failure)).toMatch(/decide is not a function/);
    expect(verdict.evidence.graderId).toBe('execution-codegen');
  });
});

// --- judge grader ----------------------------------------------------------

describe('makeJudgeGrader', () => {
  it('scores satisfied / total over authored clause ids (3 satisfied, 1 unsatisfied → 0.75, fail)', async () => {
    const grader = makeJudgeGrader();
    const jsonValue = {
      clauses: [
        { clauseId: A_CLAUSE_ID, verdict: 'satisfied', quote: 'V1 at Lane Field' },
        { clauseId: B_CLAUSE_ID, verdict: 'satisfied', quote: 'B requests' },
        { clauseId: C_CLAUSE_ID, verdict: 'satisfied', quote: 'B first' },
        { clauseId: D_CLAUSE_ID, verdict: 'unsatisfied', quote: '' },
      ],
      overallRationale: 'Three of four clauses are met.',
    };
    const verdict = await grader.grade(baseInput(), stubLlm({ jsonValue }));

    expect(verdict.score).toBeCloseTo(0.75, 6);
    expect(verdict.pass).toBe(false); // 0.75 < 0.8
    expect(verdict.evidence.graderId).toBe('llm-judge');
    expect(Array.isArray(verdict.evidence.clauseVerdicts)).toBe(true);
    expect((verdict.evidence.clauseVerdicts as unknown[]).length).toBe(4);
    expect(verdict.evidence.droppedIds).toEqual([]);
  });

  it('drops a hallucinated clauseId — it is not counted and lands in droppedIds', async () => {
    const grader = makeJudgeGrader();
    const jsonValue = {
      clauses: [
        { clauseId: A_CLAUSE_ID, verdict: 'satisfied', quote: 'q' },
        { clauseId: B_CLAUSE_ID, verdict: 'satisfied', quote: 'q' },
        { clauseId: C_CLAUSE_ID, verdict: 'satisfied', quote: 'q' },
        { clauseId: D_CLAUSE_ID, verdict: 'satisfied', quote: 'q' },
        { clauseId: 'c-hallucinated', verdict: 'unsatisfied', quote: '' },
      ],
      overallRationale: 'All authored clauses satisfied; one invented clause ignored.',
    };
    const verdict = await grader.grade(baseInput(), stubLlm({ jsonValue }));

    // 4 authored, all satisfied → 4/4 = 1.0; the hallucinated one does NOT
    // dilute the denominator.
    expect(verdict.score).toBe(1);
    expect(verdict.pass).toBe(true);
    expect(verdict.evidence.droppedIds).toEqual(['c-hallucinated']);
    // Only the 4 authored verdicts are counted.
    expect((verdict.evidence.clauseVerdicts as unknown[]).length).toBe(4);
  });

  it('returns pass:null when completeJson throws (verdict honesty)', async () => {
    const grader = makeJudgeGrader();
    const verdict = await grader.grade(baseInput(), stubLlm({ jsonThrows: true }));

    expect(verdict.pass).toBeNull();
    expect(verdict.score).toBeNull();
    expect(String(verdict.evidence.failure ?? verdict.evidence.error)).toMatch(/boom/);
    expect(verdict.evidence.graderId).toBe('llm-judge');
  });
});
