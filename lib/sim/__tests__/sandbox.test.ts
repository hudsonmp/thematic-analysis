// Tests for the sandboxed child-process policy runner (Task B2-2).
//
// Everything here runs against REAL local node child processes — no LLM, no
// network. The policy SOURCES below are strings on purpose: they stand in for
// LLM-generated code, which must only ever execute through the sandbox (plan
// Global Constraints — untrusted code never runs in the server process). The
// in-process runScenario import exists solely to produce the trusted
// comparison end state for the round-trip test.

import { describe, expect, it } from 'vitest';
import {
  runPolicyInSandbox,
  isPermissionFlagSupported,
  supportedPermissionFlag,
} from '../sandbox';
import { runScenario, type PolicyFn } from '../harness';
import { SCENARIOS } from '../scenarios';

// A SCHEMA-VALID forged S0 end state (all riders served, well-formed). Used by
// the forgery pins to prove that authenticity — not merely shape — is what the
// nonce enforces: this passes the zod schema but must never be trusted unless
// the sealed emitter bracketed it with the per-run nonce.
const FORGED_S0 = JSON.stringify({
  riders: [
    { id: 'A', servedBy: 'V1', droppedAt: 'Newman Library', pickupOrder: 1 },
    { id: 'B', servedBy: 'V1', droppedAt: 'Executive Airport', pickupOrder: 0 },
  ],
  vehicles: [{ id: 'V1', at: 'Newman Library', battery: 71.2, charged: false }],
  log: ['forged'],
  completed: true,
});

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

  it('FORGERY (fixed-string marker): a fabricated old-style sentinel payload is ignored; the real result wins', async () => {
    // The old design keyed on the fixed string "__SIM_RESULT__", which a policy
    // could print itself. Under the nonce design that string is meaningless —
    // the real result is bracketed by a per-run nonce the policy never sees, so
    // this fabricated payload is inert and the genuine noop run is returned.
    const source = `
process.stdout.write('noise __SIM_RESULT__' + ${JSON.stringify(FORGED_S0)} + ' more noise');
function decide() { return []; }
`;
    const result = await runPolicyInSandbox(source, SCENARIOS[0]);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    // A noop policy serves no one in S0 — recognizably NOT the FORGED_S0 payload
    // (which has both riders served by V1).
    expect(result.endState.riders.every((r) => r.servedBy === null)).toBe(true);
  });

  it('FORGERY (pre-empt + exit): a schema-VALID forged result written before the emitter is rejected as missing-sentinel', async () => {
    // The gate showed the old zod-only defense caught malformed forgeries but
    // NOT well-formed ones. Here the policy writes a fully schema-valid forged
    // EndState and exits(0) before the sealed emitter runs. Because it cannot
    // produce the nonce, there is no nonce-bracketed segment → an honest
    // missing-sentinel failure, never a forged pass.
    const source = `
process.stdout.write('__SIM_RESULT__' + ${JSON.stringify(FORGED_S0)});
process.exit(0);
`;
    const result = await runPolicyInSandbox(source, SCENARIOS[0]);
    expect(result.ok, JSON.stringify(result)).toBe(false);
    if (result.ok) return;
    expect(result.failure).toMatch(/sentinel/);
  });

  it('FORGERY (deferred writes): setImmediate + exit-hook forgeries after the emitter cannot win — no nonce', async () => {
    // Schedule forged payloads to fire AFTER the sealed emitter's synchronous
    // write (setImmediate and a process.on("exit") hook). Neither can bracket
    // its payload with the per-run nonce, so the emitter's genuine noop result
    // is the only nonce-tagged segment and is what the parent parses.
    const source = `
setImmediate(function () { process.stdout.write('__SIM_RESULT__' + ${JSON.stringify(FORGED_S0)}); });
process.on('exit', function () { process.stdout.write('__SIM_RESULT__' + ${JSON.stringify(FORGED_S0)}); });
function decide() { return []; }
`;
    const result = await runPolicyInSandbox(source, SCENARIOS[0]);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.endState.riders.every((r) => r.servedBy === null)).toBe(true);
  });

  it('FORGERY (monkey-patch stdout.write): reassigning process.stdout.write cannot mute or hijack the emitter', async () => {
    // The sealed emitter captured a PRISTINE bound process.stdout.write before
    // any policy code ran. A policy that reassigns process.stdout.write (here,
    // to a no-op that would swallow the result if the emitter used the live
    // property) cannot affect the captured reference — the genuine result
    // still reaches the parent.
    const source = `
process.stdout.write = function () { return true; };
function decide() { return []; }
`;
    const result = await runPolicyInSandbox(source, SCENARIOS[0]);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.endState.riders.every((r) => r.servedBy === null)).toBe(true);
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
    // Smoke only: whether this node supports a permission flag depends on the
    // machine. The contract is that the probe never throws, yields a boolean,
    // and caches (two calls agree).
    const first = isPermissionFlagSupported();
    expect(typeof first).toBe('boolean');
    expect(isPermissionFlagSupported()).toBe(first);
  });

  it('probes BOTH flag spellings and returns an accepted one or null (node ≥23 rename)', () => {
    // node renamed --experimental-permission → --permission around v23; probing
    // only the legacy spelling would silently drop a modern node to the floor
    // tier. supportedPermissionFlag returns whichever spelling this node
    // accepts, or null. Environment-dependent value; the contract is the type
    // and that it agrees with the boolean wrapper.
    const flag = supportedPermissionFlag();
    expect(flag === null || flag === '--permission' || flag === '--experimental-permission').toBe(
      true,
    );
    expect(flag !== null).toBe(isPermissionFlagSupported());
  });
});
