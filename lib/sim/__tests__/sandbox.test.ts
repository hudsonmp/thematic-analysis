// Tests for the sandboxed child-process policy runner (Task B2-2).
//
// Everything here runs against REAL local node child processes — no LLM, no
// network. The policy SOURCES below are strings on purpose: they stand in for
// LLM-generated code, which must only ever execute through the sandbox (plan
// Global Constraints — untrusted code never runs in the server process). The
// in-process runScenario import exists solely to produce the trusted
// comparison end state for the round-trip test.

import { describe, expect, it } from 'vitest';
import { runPolicyInSandbox, isPermissionFlagSupported } from '../sandbox';
import { runScenario, type PolicyFn } from '../harness';
import { SCENARIOS } from '../scenarios';

// The S0 reference behavior (mirrors REFERENCE_POLICY[0] in sim.test.ts) in
// both forms: a plain-JS source string for the sandbox, and the equivalent
// TS function for the trusted in-process run it is compared against.
const S0_REFERENCE_SOURCE = `
function decide(world, event) {
  if (event.type === 'ride_request' && event.rider === 'B') {
    return [
      { act: 'assign', vehicle: 'V1', rider: 'B' },
      { act: 'assign', vehicle: 'V1', rider: 'A' },
    ];
  }
  return [{ act: 'noop' }];
}
`;
const s0ReferencePolicy: PolicyFn = (_world, event) => {
  if (event.type === 'ride_request' && event.rider === 'B') {
    return [
      { act: 'assign', vehicle: 'V1', rider: 'B' },
      { act: 'assign', vehicle: 'V1', rider: 'A' },
    ];
  }
  return [{ act: 'noop' }];
};

describe('runPolicyInSandbox', () => {
  it('round-trips a correct policy on S0 to the exact in-process end state', async () => {
    const inProcess = runScenario(SCENARIOS[0], s0ReferencePolicy);
    const result = await runPolicyInSandbox(S0_REFERENCE_SOURCE, SCENARIOS[0]);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return; // narrowed above; keeps TS happy
    // Deep equality is safe: EndState is JSON-pure (strings, floats, nulls,
    // booleans), and JSON round-trips floats exactly, so the sandboxed run of
    // the identical sim code must reproduce the in-process result bit-for-bit
    // — log lines and battery floats included.
    expect(result.endState).toEqual(inProcess);
  });

  it('kills an infinite-loop policy at the timeout and reports it', async () => {
    const started = Date.now();
    const result = await runPolicyInSandbox(
      'function decide(){ while(true){} }',
      SCENARIOS[0],
      { timeoutMs: 500 },
    );
    const elapsed = Date.now() - started;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toMatch(/timeout after 500ms/);
    // ~2x the timeout plus spawn/kill overhead: proves the SIGKILL fired at
    // 500ms rather than the child running to some other backstop.
    expect(elapsed).toBeLessThan(1500);
  });

  it('reports a policy that calls process.exit(7) as a nonzero-exit failure', async () => {
    const result = await runPolicyInSandbox(
      'function decide(){ process.exit(7); }',
      SCENARIOS[0],
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toMatch(/code 7/);
  });

  it('reports a script that exits cleanly without printing the sentinel', async () => {
    const result = await runPolicyInSandbox('process.exit(0);', SCENARIOS[0]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toMatch(/sentinel/);
  });

  it('LAST-occurrence semantics: a fake sentinel printed BEFORE the real result loses', async () => {
    // The policy fabricates the sentinel plus junk JSON on stdout during
    // script evaluation — i.e. before the runner tail prints the real result.
    // The shipped parse splits on the sentinel and takes the LAST segment, so
    // the real result wins. This test pins that semantic explicitly.
    const source = `
process.stdout.write('noise __SIM_RESULT__{"x":1} more noise');
function decide() { return []; }
`;
    const result = await runPolicyInSandbox(source, SCENARIOS[0]);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.endState.completed).toBe(true);
    // A noop policy never assigns anyone in S0, so the real end state is
    // recognizably NOT the fake {"x":1} payload.
    expect(result.endState.riders.every((r) => r.servedBy === null)).toBe(true);
  });

  it('a fabricated final sentinel cannot smuggle a non-EndState past the zod schema', async () => {
    // Here the fake sentinel IS the last occurrence (the script exits before
    // the runner tail), so the fake JSON is what gets parsed — and the
    // EndState schema rejects it. Untrusted stdout cannot forge a verdict.
    const source = `
process.stdout.write('__SIM_RESULT__{"x":1}');
process.exit(0);
`;
    const result = await runPolicyInSandbox(source, SCENARIOS[0]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toMatch(/schema validation/);
  });

  it('the sandbox inherits NO environment (a probe policy sees no parent keys)', async () => {
    // The probe throws — failing the run with an informative message — if any
    // env key beyond macOS's platform-injected __CF_USER_TEXT_ENCODING is
    // visible. (posix_spawn injects that one key regardless of env:{}; it
    // carries the uid + text encoding, not secrets.) ok:true here IS the
    // assertion that ANTHROPIC_API_KEY, SUPABASE tokens, PATH, HOME, etc.
    // never reach untrusted code.
    const source = `
const __leaked = Object.keys(process.env).filter(function (k) { return k !== '__CF_USER_TEXT_ENCODING'; });
if (__leaked.length > 0) { throw new Error('ENV LEAK: ' + __leaked.join(',')); }
function decide() { return []; }
`;
    const result = await runPolicyInSandbox(source, SCENARIOS[0]);
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  it('kills and fails a policy that floods stdout past the 1 MB cap', async () => {
    const source = `
process.stdout.write('x'.repeat(2 * 1024 * 1024));
function decide() { return []; }
`;
    const result = await runPolicyInSandbox(source, SCENARIOS[0]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toMatch(/stdout exceeded/);
  });

  it('reports a policy source that never defines decide', async () => {
    const result = await runPolicyInSandbox('const notDecide = 1;', SCENARIOS[0]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toMatch(/decide is not a function/);
  });
});

describe('permission-flag probe', () => {
  it('runs without throwing and returns a stable boolean (value is environment-dependent)', () => {
    // Smoke only: whether this node supports --experimental-permission
    // depends on the machine. The contract is that the probe never throws,
    // yields a boolean, and caches (two calls agree).
    const first = isPermissionFlagSupported();
    expect(typeof first).toBe('boolean');
    expect(isPermissionFlagSupported()).toBe(first);
  });
});
