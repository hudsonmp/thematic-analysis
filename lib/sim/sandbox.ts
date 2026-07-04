// Sandboxed child-process runner for UNTRUSTED dispatch policies (Task B2-2).
//
// This is the only place LLM-generated policy code is allowed to execute
// (plan Global Constraints: untrusted code never runs in the server process).
// The policy source is concatenated with the trusted SIM_JS string into a
// self-contained script and run under `node -e` in a child process.
//
// SANDBOX TIERING — stated honestly:
//  - WITH `--experimental-permission` (probed once per process, below): the
//    child is denied filesystem and network access by default. This is the
//    belt against a hostile policy calling require('fs') or opening sockets
//    (`node -e` scripts DO have require in scope).
//  - WITHOUT the flag (probe fails on this node): the floor is
//      (1) a CLEARED environment — no ANTHROPIC_API_KEY, no Supabase tokens,
//          nothing to exfiltrate even if the code phones home;
//      (2) a SIGKILL timeout — no runaway compute;
//      (3) a 1 MB stdout cap — no memory blowup through the pipe;
//      (4) zod validation of the result — untrusted stdout cannot forge a
//          malformed EndState into the grader.
//    A hostile policy CAN still require('fs') and read world-readable files
//    or open a socket in this tier. That residual risk is accepted for a
//    research harness grading LLM output; it is risk-tiering, not a VM.

import { spawn, spawnSync } from 'node:child_process';
import { z } from 'zod';
import { SIM_JS } from './sim-source';
import type { EndState, LandmarkName, RiderId, ScenarioSetup, VehicleId } from './harness';

const SENTINEL = '__SIM_RESULT__';
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

// Defensive schema over the child's stdout: the sentinel-suffixed JSON comes
// from a process that just ran untrusted code, so nothing about its shape is
// taken on faith. Unknown keys are stripped (zod object default).
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
// top-level await / never at import time): one spawnSync asking node whether
// it accepts --experimental-permission. status 0 → the flag exists and an -e
// script runs under it, so every sandbox spawn includes it; anything else
// (unknown-option exit, missing binary weirdness) → run at the floor tier
// documented above.
let permissionFlagCache: boolean | null = null;

export function isPermissionFlagSupported(): boolean {
  if (permissionFlagCache === null) {
    const probe = spawnSync(
      process.execPath,
      ['--experimental-permission', '-e', 'process.exit(0)'],
      { env: EMPTY_ENV, stdio: 'ignore', timeout: 5000 },
    );
    permissionFlagCache = probe.status === 0;
  }
  return permissionFlagCache;
}

/** Assemble the self-contained sandbox script: CommonJS shim (SIM_JS assigns
 *  module.exports, and `const module = …` is legal at `node -e` top level) +
 *  the trusted sim + the frozen setup + the UNTRUSTED policy source + a
 *  runner tail that prints the sentinel-tagged result or exits 3.
 *
 *  The extraction binds `__runScenario`, NOT `runScenario`: SIM_JS declares
 *  `function runScenario` at top level, so re-binding the bare name in the
 *  same scope is a SyntaxError. Going through module.exports (rather than
 *  leaning on that hoisted declaration directly) keeps the sandbox coupled to
 *  the sim's EXPORT contract, same as harness.ts. */
function buildScript(policySource: string, setup: ScenarioSetup): string {
  return (
    'const module={exports:{}};\n' +
    SIM_JS +
    '\nconst __runScenario=module.exports.runScenario;\n' +
    'const __setup = ' +
    JSON.stringify(setup) +
    ';\n' +
    policySource +
    // `typeof decide` is safe even when the policy never declared it. The
    // check runs BEFORE the sim call, not as a throwing stand-in policy
    // passed INTO it: the sim catches per-event policy exceptions as noops
    // (a B2-1 world rule), so a deferred throw would be silently swallowed
    // into a fake do-nothing run instead of the honest exit-3 failure the
    // grader needs (verdict honesty, plan Global Constraints).
    "\ntry { if (typeof decide !== 'function') { throw new Error('decide is not a function'); } const endState = __runScenario(__setup, decide); process.stdout.write('" +
    SENTINEL +
    "' + JSON.stringify(endState)); } catch (e) { process.stderr.write(String(e && e.stack || e)); process.exit(3); }\n"
  );
}

export type SandboxResult = { ok: true; endState: EndState } | { ok: false; failure: string };

/**
 * Run one untrusted policy against one scenario in a sandboxed node child.
 * Never throws for anything the child does: every failure mode (nonzero
 * exit, timeout, stdout flood, missing/forged sentinel, malformed JSON,
 * schema miss) comes back as { ok: false, failure } with a stderr excerpt,
 * so the grader can record an honest pass:null verdict (plan Global
 * Constraints: verdict honesty).
 */
export async function runPolicyInSandbox(
  policySource: string,
  setup: ScenarioSetup,
  opts?: { timeoutMs?: number },
): Promise<SandboxResult> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const script = buildScript(policySource, setup);
  const nodeArgs = isPermissionFlagSupported()
    ? ['--experimental-permission', '-e', script]
    : ['-e', script];

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

      // LAST-occurrence sentinel parse: the runner tail's write is the final
      // thing a well-behaved script prints, so the segment after the last
      // sentinel is the real result even when the policy spammed fake
      // sentinels earlier. (A policy that prevents the tail from running ends
      // with ITS fake as the last segment — which is why the zod gate below
      // exists.)
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const segments = stdout.split(SENTINEL);
      if (segments.length < 2) {
        resolve({
          ok: false,
          failure: 'missing ' + SENTINEL + ' sentinel in sandbox stdout' + stderrExcerpt(),
        });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(segments[segments.length - 1]);
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
