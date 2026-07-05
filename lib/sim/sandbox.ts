// Sandboxed child-process runner for UNTRUSTED dispatch policies (Task B2-2).
//
// This is the only place LLM-generated policy code is allowed to execute
// (plan Global Constraints: untrusted code never runs in the server process).
// The policy source is concatenated with the trusted SIM_JS string into a
// self-contained script and run under `node -e` in a child process.
//
// VERDICT INTEGRITY — the result cannot be forged (B2-2 gate, BLOCKING fix).
//  The policy source runs as TOP-LEVEL code, so it shares the child's stdout
//  and global scope with the code that emits the result. A naive fixed-string
//  sentinel is therefore forgeable: a policy can print its own
//  `<sentinel><perfect endState>` (via a later write, an exit hook, a
//  setImmediate, or by monkey-patching process.stdout.write) and win a
//  last-occurrence parse — the gate demonstrated four such vectors returning a
//  fabricated passing verdict. The fix (see buildScript): a SEALED EMITTER
//  captured in a private IIFE that runs BEFORE any policy code. It closes over
//  (a) a per-run unguessable nonce and (b) a pristine bound process.stdout.write
//  taken before the policy can patch it. The result is bracketed by the nonce
//  on both sides. Because the nonce and the captured writer are IIFE locals,
//  the policy's sibling top-level scope cannot read them and cannot produce a
//  nonce-tagged segment; the only path that emits one is the sealed emitter,
//  which always routes through the trusted sim. INVARIANT: the returned
//  endState is a faithful serialization of a trusted-sim run, or an honest
//  failure — never an attacker-chosen object. The emitter also serializes
//  through a null-prototype safe-clone built from captured primitives, so
//  Object.prototype.toJSON / getter poisoning cannot rewrite the payload
//  either (an attack on the clone throws → honest failure, not a forgery).
//
// SANDBOX TIERING — stated honestly:
//  - WITH a permission flag (`--permission` on node ≥23, else the older
//    `--experimental-permission`; both probed below): the child is denied
//    filesystem and network access by default. This is the belt against a
//    hostile policy calling require('fs') or opening sockets (`node -e`
//    scripts DO have require in scope). stdout writes remain allowed, so the
//    sealed emitter is unaffected.
//  - WITHOUT any flag (probe fails — e.g. a future node that renames the flag
//    again, or an old node predating it): the floor is
//      (1) a CLEARED environment — no ANTHROPIC_API_KEY, no Supabase tokens,
//          nothing to exfiltrate even if the code phones home;
//      (2) a SIGKILL timeout — no runaway compute;
//      (3) a 1 MB stdout cap — no memory blowup through the pipe;
//      (4) the unforgeable-nonce result channel above.
//    A hostile policy CAN still require('fs') and read world-readable files or
//    open a socket in THIS tier — the fs/net belt silently drops when no flag
//    is accepted (node's flag rename is exactly such a silent trigger, which
//    is why the probe tries both spellings). That residual is accepted for a
//    research harness grading LLM output; it is risk-tiering, not a VM.

import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { SIM_JS } from './sim-source';
import type { EndState, LandmarkName, RiderId, ScenarioSetup, VehicleId } from './harness';

const DEFAULT_TIMEOUT_MS = 2000;
const MAX_STDOUT_BYTES = 1024 * 1024;
const STDERR_EXCERPT_CHARS = 500;

// A genuinely empty child environment. The cast exists because Next's
// ambient types declare NODE_ENV as a REQUIRED ProcessEnv property — true
// for this server's own process.env, deliberately false for the sandbox:
// the child getting NOTHING (no NODE_ENV either) is the security property.
const EMPTY_ENV = {} as NodeJS.ProcessEnv;

// Literal id/landmark vocabularies for the zod enums below. harness.ts only
// exports these as TYPES and scenarios.ts exports no arrays, so they are
// defined locally — `satisfies` proves every entry is a real harness literal
// (a rename there breaks the build here), but an ADDITION there must be
// mirrored here by hand: keep in sync with lib/sim/harness.ts.
const LANDMARK_NAMES = [
  'Depot / Charging',
  'Newman Library',
  'Lane Field',
  'Executive Airport',
  'ASCEND³',
] as const satisfies readonly LandmarkName[];
const VEHICLE_IDS = ['V1', 'V2'] as const satisfies readonly VehicleId[];
const RIDER_IDS = ['A', 'B', 'C'] as const satisfies readonly RiderId[];

// Defensive schema over the child's result payload: even though the nonce
// guarantees the payload came from the sealed emitter (i.e. from the trusted
// sim), the shape is still validated — unknown keys are stripped (zod object
// default), enums/types enforced — so a malformed sim output can never reach
// the grader as a "valid" EndState.
const endStateSchema = z.object({
  riders: z.array(
    z.object({
      id: z.enum(RIDER_IDS),
      servedBy: z.enum(VEHICLE_IDS).nullable(),
      droppedAt: z.enum(LANDMARK_NAMES).nullable(),
      pickupOrder: z.number().nullable(),
    }),
  ),
  vehicles: z.array(
    z.object({
      id: z.enum(VEHICLE_IDS),
      at: z.enum(LANDMARK_NAMES),
      battery: z.number(),
      charged: z.boolean(),
    }),
  ),
  log: z.array(z.string()),
  completed: z.boolean(),
});

// --- permission-flag probe -------------------------------------------------
// Probed lazily on first use and cached for the process lifetime (never a
// top-level await / never at import time). node renamed the permission flag
// from `--experimental-permission` to `--permission` around node 23, and an
// unknown flag exits NON-ZERO — so probing only the old spelling would
// silently drop a node ≥23 host to the floor tier. We try the current
// spelling first, then the legacy one, and cache the accepted flag (or `null`
// when neither is accepted). Denying fs/net is the belt; stdout stays open so
// the result channel is unaffected either way.
const PERMISSION_FLAGS = ['--permission', '--experimental-permission'] as const;
let permissionFlagCache: string | null | undefined;

/** The permission flag this node accepts (denies fs/net by default), or null
 *  if neither spelling is accepted (floor tier). Cached for the process. */
export function supportedPermissionFlag(): string | null {
  if (permissionFlagCache === undefined) {
    permissionFlagCache = null;
    for (const flag of PERMISSION_FLAGS) {
      const probe = spawnSync(process.execPath, [flag, '-e', 'process.exit(0)'], {
        env: EMPTY_ENV,
        stdio: 'ignore',
        timeout: 5000,
      });
      if (probe.status === 0) {
        permissionFlagCache = flag;
        break;
      }
    }
  }
  return permissionFlagCache;
}

/** True when SOME permission flag is accepted (strong tier). Thin boolean
 *  wrapper over supportedPermissionFlag for callers that only need the tier. */
export function isPermissionFlagSupported(): boolean {
  return supportedPermissionFlag() !== null;
}

/** Assemble the self-contained sandbox script: CommonJS shim (SIM_JS assigns
 *  module.exports, and `const module = …` is legal at `node -e` top level) +
 *  the trusted sim + the frozen setup + a SEALED EMITTER (private IIFE) +
 *  the UNTRUSTED policy source + a single call to the emitter.
 *
 *  Ordering is load-bearing for verdict integrity: the emitter IIFE runs and
 *  captures its pristine writer + private nonce BEFORE the policy source runs,
 *  so no policy top-level statement (nor any handler it schedules) can read
 *  the nonce or reach the captured writer. `__runScenario` is bound off
 *  module.exports (SIM_JS declares `function runScenario` at top level, so
 *  re-binding the bare name is a SyntaxError; going through the export keeps
 *  the sandbox coupled to the sim's EXPORT contract, same as harness.ts). */
function buildScript(policySource: string, setup: ScenarioSetup, nonce: string): string {
  return (
    'const module={exports:{}};\n' +
    SIM_JS +
    '\nconst __runScenario=module.exports.runScenario;\n' +
    'const __setup=' +
    JSON.stringify(setup) +
    ';\n' +
    // Sealed emitter. Captures, before any untrusted code: a pristine bound
    // stdout writer, process.exit/stderr, JSON.stringify, and the primitives
    // needed for a prototype-free deep clone. `__done` makes the first call
    // authoritative (a policy that pre-calls the emitter only substitutes a
    // different — still trusted-sim — run; later calls are no-ops).
    'const __emit=(function(){' +
    'var __w=process.stdout.write.bind(process.stdout);' +
    'var __err=process.stderr.write.bind(process.stderr);' +
    'var __exit=process.exit.bind(process);' +
    'var __stringify=JSON.stringify;' +
    'var __create=Object.create;' +
    'var __hop=Object.prototype.hasOwnProperty;' +
    'var __isArr=Array.isArray;' +
    'var __nonce=' +
    JSON.stringify(nonce) +
    ';' +
    'var __done=false;' +
    // Null-prototype deep clone from captured primitives: the clone has no
    // prototype, so JSON.stringify cannot be diverted by a poisoned
    // Object.prototype.toJSON. Any attack that makes this throw is caught
    // below → honest exit 3, never a forged payload.
    'function __safe(v){' +
    'if(__isArr(v)){var a=[];var n=v.length;for(var i=0;i<n;i++){a[i]=__safe(v[i]);}return a;}' +
    "if(v!==null&&typeof v==='object'){var o=__create(null);for(var k in v){if(__hop.call(v,k)){o[k]=__safe(v[k]);}}return o;}" +
    'return v;' +
    '}' +
    'return function(decideFn){' +
    'if(__done)return;__done=true;' +
    "if(typeof decideFn!=='function'){__err('decide is not a function');__exit(3);return;}" +
    'try{var es=__runScenario(__setup,decideFn);__w(__nonce+__stringify(__safe(es))+__nonce);}' +
    'catch(e){__err(String(e&&e.stack||e));__exit(3);}' +
    '};' +
    '})();\n' +
    policySource +
    "\n__emit(typeof decide==='function'?decide:undefined);\n"
  );
}

export type SandboxResult = { ok: true; endState: EndState } | { ok: false; failure: string };

/**
 * Run one untrusted policy against one scenario in a sandboxed node child.
 * Never throws for anything the child does: every failure mode (nonzero exit,
 * timeout, stdout flood, missing/forged result, malformed JSON, schema miss)
 * comes back as { ok: false, failure } with a stderr excerpt, so the grader
 * can record an honest pass:null verdict (plan Global Constraints: verdict
 * honesty). A forged result is impossible (see buildScript): a policy that
 * cannot emit the per-run nonce simply produces no result → missing-sentinel
 * failure, which is honest.
 */
export async function runPolicyInSandbox(
  policySource: string,
  setup: ScenarioSetup,
  opts?: { timeoutMs?: number },
): Promise<SandboxResult> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Unguessable per-run marker: a UUID the untrusted policy has no way to
  // learn (it is an IIFE local in the child; it never appears in a serialized
  // EndState, whose fields are landmark/vehicle/rider literals, floats, and
  // sim-generated log strings). Only the sealed emitter can bracket a payload
  // with it.
  const nonce = ' ' + randomUUID() + ' ';
  const script = buildScript(policySource, setup, nonce);
  const flag = supportedPermissionFlag();
  const nodeArgs = flag ? [flag, '-e', script] : ['-e', script];

  return new Promise((resolve) => {
    // process.execPath, not 'node': env:{} empties PATH too, and a PATH-less
    // lookup ENOENTs on any machine whose node lives outside /usr/bin:/bin
    // (verified on this one). execPath is the same binary, resolved
    // absolutely — no lookup, and no version skew with the parent.
    const child = spawn(process.execPath, nodeArgs, {
      env: EMPTY_ENV, // NO inherited environment — the sandbox floor, tier notes above
      stdio: ['ignore', 'pipe', 'pipe'] as const,
    });

    // Buffers, not strings: a UTF-8 code point (e.g. the ³ in ASCEND³ log
    // lines) can straddle a chunk boundary; per-chunk toString would mangle it.
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let overflowed = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        if (!overflowed) {
          overflowed = true;
          child.kill('SIGKILL');
        }
        return; // stop accumulating — the run is already condemned
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      // Keep only what the 500-char excerpt could ever need (x4 slack for
      // multi-byte characters) — stderr is untrusted output too.
      if (stderrBytes < STDERR_EXCERPT_CHARS * 4) {
        stderrBytes += chunk.length;
        stderrChunks.push(chunk);
      }
    });

    const stderrExcerpt = (): string => {
      const text = Buffer.concat(stderrChunks).toString('utf8').trim();
      return text ? '; stderr: ' + text.slice(0, STDERR_EXCERPT_CHARS) : '';
    };

    child.on('error', (err) => {
      // Spawn-level failure (the child never ran) — e.g. execPath vanished.
      clearTimeout(timer);
      resolve({ ok: false, failure: 'failed to spawn sandbox process: ' + err.message });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);

      if (timedOut) {
        resolve({ ok: false, failure: 'timeout after ' + timeoutMs + 'ms' + stderrExcerpt() });
        return;
      }
      if (overflowed) {
        resolve({
          ok: false,
          failure: 'stdout exceeded ' + MAX_STDOUT_BYTES + ' bytes' + stderrExcerpt(),
        });
        return;
      }
      if (code !== 0) {
        const how = code === null ? 'killed by signal ' + signal : 'sandbox exited with code ' + code;
        resolve({ ok: false, failure: how + stderrExcerpt() });
        return;
      }

      // Unforgeable-nonce extraction: the sealed emitter is the ONLY code that
      // can bracket a payload with the per-run nonce (which the policy never
      // sees), so the region between the first and second nonce occurrence is
      // exactly the trusted sim's serialized EndState — untouched by any
      // policy garbage printed before, between (impossible — no nonce), or
      // after. A policy that cannot emit the nonce leaves fewer than two
      // occurrences → an honest missing-sentinel failure.
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const open = stdout.indexOf(nonce);
      const close = open >= 0 ? stdout.indexOf(nonce, open + nonce.length) : -1;
      if (open < 0 || close < 0) {
        resolve({
          ok: false,
          failure: 'missing result sentinel in sandbox stdout' + stderrExcerpt(),
        });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout.slice(open + nonce.length, close));
      } catch (err) {
        resolve({
          ok: false,
          failure:
            'result JSON parse error: ' +
            (err instanceof Error ? err.message : String(err)) +
            stderrExcerpt(),
        });
        return;
      }
      const checked = endStateSchema.safeParse(parsed);
      if (!checked.success) {
        const issues = checked.error.issues
          .slice(0, 5)
          .map((i) => (i.path.length ? i.path.join('.') : '(root)') + ': ' + i.message)
          .join('; ');
        resolve({
          ok: false,
          failure: 'result failed EndState schema validation: ' + issues + stderrExcerpt(),
        });
        return;
      }
      resolve({ ok: true, endState: checked.data });
    });
  });
}
