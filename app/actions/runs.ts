'use server';

import { evalFrom } from '@/lib/supabase/eval-guard';
import { withStudyAudit } from '@/lib/eval/audit';
import { requireAuthUser } from '@/lib/auth/supabase-auth';
import { getParticipantProgression } from '@/app/actions/progression';
import { validateLlmConfig } from '@/lib/llm/config';
import { sha256Hex } from '@/lib/eval/seeds';
import { llmComplete, llmCompleteJson } from '@/lib/llm/client';
import { makeExecutionGrader } from '@/lib/eval/graders/execution';
import { makeJudgeGrader } from '@/lib/eval/graders/judge';
import type { GradeInput, GraderModule, LlmFns, Verdict } from '@/lib/eval/graders/types';
import { cohensKappa, disagreements } from '@/lib/eval/agreement';
import type { Scenario } from '@/lib/study/study';
import type { Json } from '@/lib/types/cb-db';

// ---------------------------------------------------------------------------
// Run executor + agreement reporting (sub-project B, Task B2-4).
//
// A RUN is one grader × one config applied to a set of participants: for each
// participant's per-phase spec snapshots, grade the spec against the authored
// scenarios and persist one eval_verdict per (pid, phase ordinal, scenario)
// cell. compareRuns then joins two runs' verdicts cell-by-cell and computes
// Cohen's κ so the researcher can measure how much two graders (or two configs)
// actually agree.
//
// SAFETY POSTURE (spec L5), identical to app/actions/eval.ts:
//   - Study data is READ-ONLY here and is touched ONLY through
//     getParticipantProgression (app/actions/progression.ts), which reads
//     study_snapshots/users via the SELECT-only studyFrom guard. This file adds
//     NO new study read path and NO study write.
//   - ALL eval writes go through evalFrom (closed allowlist, user client — the
//     service key never touches this path) and are wrapped in withStudyAudit
//     (pre/post study-table fingerprint belt; a moved study row count throws).
//   - No .rpc, no raw service client (check-no-study-writes.sh Rules 2 & 3).
//   - PII = pid only. Verdicts store pid + phase ordinal + scenario idx; no
//     name/email ever enters this layer (progression.ts already strips them).
//
// FIXED-TARGET GRADING (v1 measurement choice — documented, reversible):
//   Every phase snapshot is graded against ALL FOUR authored scenarios, not
//   only the scenario that was "revealed" at that phase. Rationale: the study's
//   dependent variable is whether a participant's SPEC improves across phases,
//   and "improves" only means something against a FIXED target set. If phase k
//   were graded only against scenario k (revealed-only), a rising score could
//   be an easier target rather than a better spec, and cross-phase deltas would
//   be non-comparable (different denominators per phase). Grading every phase
//   against the same four scenarios makes delta_k (metric.md) a like-for-like
//   comparison and lets the initial (requirement-only) spec be scored against
//   scenarios it had not yet seen — the cleanest baseline.
//   REVEALED-ONLY ALTERNATIVE (left to Hudson): grade phase k only against the
//   scenarios revealed by phase k (ordinal 0 → none/requirement-only; ordinal
//   1+n → scenario n). That measures "did the participant fix the thing they
//   just saw" rather than "is the spec globally better". It is the natural lens
//   for a formative/help-seeking analysis; fixed-target is the natural lens for
//   a summative improvement analysis. Switching is a filter on the
//   (phaseOrdinal × scenarioIdx) grid below — the verdict schema already
//   carries both coordinates, so a revealed-only VIEW can be computed from
//   fixed-target verdicts without re-running.
//
// The RunRequest exposes phaseOrdinals?/scenarioIdxs? so a caller CAN narrow
// the grid (e.g. to reproduce revealed-only), but the DEFAULT is the full
// fixed-target grid: all five phase ordinals (0–4) × all four scenarios (0–3).
// ---------------------------------------------------------------------------

/** Phase ordinals a run may target: the five progression step slots
 *  (0 = requirement, 1–4 = after scenarios 1–4). `final` (slot 5) is NOT a
 *  gradable phase — it is a byte-identical re-flush of the last scenario
 *  (progression engine), so it carries no distinct spec state. */
const ALL_PHASE_ORDINALS = [0, 1, 2, 3, 4] as const;
const ALL_SCENARIO_IDXS = [0, 1, 2, 3] as const;

export type RunRequest = {
  name: string;
  pids: string[];
  graderId: 'execution-codegen' | 'llm-judge';
  simBackend: 'deterministic' | 'llm' | null;
  llmConfig: unknown;
  promptVariantId: string;
  fewShotSetId: string | null;
  oracleArtifactId: string;
  metricArtifactId: string;
  phaseOrdinals?: number[];
  scenarioIdxs?: (0 | 1 | 2 | 3)[];
};

/** The real LLM surface (keyless stubs are only for grader unit tests; a live
 *  run needs the actual client). */
const REAL_LLM_FNS: LlmFns = { complete: llmComplete, completeJson: llmCompleteJson };

// ---------------------------------------------------------------------------
// Loader helpers (module-private; 'use server' files may only export async fns
// + types). Each reads through evalFrom and throws readably when a referenced
// row is missing — a run must not silently proceed with a half-resolved config.
// ---------------------------------------------------------------------------

async function loadArtifact(
  id: string,
  kind: 'oracle_spec' | 'metric',
): Promise<{ content: string; hash: string }> {
  const res = await (await evalFrom('eval_artifacts')).select('content, hash, kind').eq('id', id).maybeSingle();
  if (res.error) throw new Error(`createAndExecuteRun: eval_artifacts read failed: ${res.error.message}`);
  if (!res.data) throw new Error(`createAndExecuteRun: ${kind} artifact ${id} not found.`);
  if (res.data.kind !== kind) {
    throw new Error(`createAndExecuteRun: artifact ${id} is kind '${res.data.kind}', expected '${kind}'.`);
  }
  return { content: res.data.content, hash: res.data.hash };
}

async function loadPromptVariant(id: string): Promise<string> {
  const res = await (await evalFrom('eval_prompt_variants')).select('system_prompt').eq('id', id).maybeSingle();
  if (res.error) throw new Error(`createAndExecuteRun: eval_prompt_variants read failed: ${res.error.message}`);
  if (!res.data) throw new Error(`createAndExecuteRun: prompt variant ${id} not found.`);
  return res.data.system_prompt;
}

async function loadFewShot(id: string | null): Promise<{ role: 'user' | 'assistant'; content: string }[]> {
  if (id === null) return [];
  const res = await (await evalFrom('eval_few_shot_sets')).select('examples').eq('id', id).maybeSingle();
  if (res.error) throw new Error(`createAndExecuteRun: eval_few_shot_sets read failed: ${res.error.message}`);
  if (!res.data) throw new Error(`createAndExecuteRun: few-shot set ${id} not found.`);
  const raw = Array.isArray(res.data.examples) ? res.data.examples : [];
  // Coerce to the message shape the graders expect; drop malformed entries
  // (mirrors eval.ts's coerceFewShotExample — hand-edited jsonb tolerance).
  const out: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    const rec = e as Record<string, unknown>;
    if ((rec.role === 'user' || rec.role === 'assistant') && typeof rec.content === 'string' && rec.content !== '') {
      out.push({ role: rec.role, content: rec.content });
    }
  }
  return out;
}

/** Resolve the grader module from the request. execution-codegen needs a sim
 *  backend (default 'deterministic' when null); llm-judge ignores it. */
function resolveGrader(req: RunRequest): GraderModule {
  if (req.graderId === 'llm-judge') return makeJudgeGrader();
  return makeExecutionGrader(req.simBackend === 'llm' ? 'llm' : 'deterministic');
}

// ---------------------------------------------------------------------------
// createAndExecuteRun — the executor.
// ---------------------------------------------------------------------------

/**
 * Create a run row, grade the requested (pid × phase × scenario) grid, persist
 * one verdict per cell, and mark the run complete (or failed). Returns the run
 * id immediately usable to poll listVerdicts.
 *
 * Sequencing is DELIBERATELY sequential (a plain for-loop, one grader call at a
 * time): grader calls hit the Anthropic API, and a fan-out would trip rate
 * limits and interleave partial writes. A run of ~27 pids × 5 phases × 4
 * scenarios is O(hundreds) of calls — slow but rate-limit-friendly and easy to
 * reason about on failure.
 *
 * PER-CELL ISOLATION: a single grader.grade throwing (LLM error, sandbox
 * failure) is caught and stored as a pass:null verdict with the error in
 * evidence — one bad cell never aborts the run. The run status flips to
 * 'failed' ONLY if the loop's own orchestration throws (a loader, a DB write,
 * or the audit belt) — i.e. something structural, not a gradable-cell failure.
 */
export async function createAndExecuteRun(req: RunRequest): Promise<{ runId: string }> {
  await requireAuthUser();

  // 1. Validate the LLM config at the edge (throw with the validator's own
  //    readable messages — the same validation the client re-runs).
  const cfg = validateLlmConfig(req.llmConfig);
  if (!cfg.ok) {
    throw new Error(`createAndExecuteRun: invalid llmConfig — ${cfg.errors.join('; ')}`);
  }

  const cleanName = (req.name ?? '').trim();
  if (!cleanName) throw new Error('createAndExecuteRun: name must be non-empty.');
  const pids = (req.pids ?? []).map((p) => (p ?? '').trim()).filter((p) => p !== '');
  if (pids.length === 0) throw new Error('createAndExecuteRun: at least one pid is required.');

  const phaseOrdinals =
    req.phaseOrdinals && req.phaseOrdinals.length > 0 ? req.phaseOrdinals : [...ALL_PHASE_ORDINALS];
  const scenarioIdxs =
    req.scenarioIdxs && req.scenarioIdxs.length > 0 ? req.scenarioIdxs : [...ALL_SCENARIO_IDXS];

  // 2. Resolve every config dependency BEFORE inserting the run row, so a
  //    missing artifact/variant fails fast without leaving an orphan run.
  const oracle = await loadArtifact(req.oracleArtifactId, 'oracle_spec');
  const metric = await loadArtifact(req.metricArtifactId, 'metric');
  const systemPrompt = await loadPromptVariant(req.promptVariantId);
  const fewShot = await loadFewShot(req.fewShotSetId ?? null);
  const grader = resolveGrader(req);

  // config_hash: the provenance fingerprint stamped on EVERY verdict. It binds
  // a verdict to the EXACT grading configuration so two verdicts are comparable
  // iff their hashes match. Captures grader identity, sim backend, the CONTENT
  // hashes of oracle+metric (so an artifact edit changes the hash), the prompt
  // variant id, and the validated llmConfig. (few-shot set id is intentionally
  // NOT in the hash — see the concern noted in the report; add it here if
  // few-shot content should partition comparability.)
  const configHash = sha256Hex(
    JSON.stringify({
      graderId: req.graderId,
      simBackend: req.simBackend,
      oracleHash: oracle.hash,
      metricHash: metric.hash,
      promptVariantId: req.promptVariantId,
      llmConfig: cfg.config,
    }),
  );

  // 3. Insert the run row (status 'running') — audited.
  const runRow = await withStudyAudit('createAndExecuteRun:insert', async () => {
    const ins = await (await evalFrom('eval_runs'))
      .insert({
        name: cleanName,
        participant_pids: pids,
        grader_id: req.graderId,
        sim_backend: req.simBackend,
        llm_config: cfg.config as unknown as Json,
        prompt_variant_id: req.promptVariantId,
        few_shot_set_id: req.fewShotSetId ?? null,
        oracle_artifact_id: req.oracleArtifactId,
        metric_artifact_id: req.metricArtifactId,
        status: 'running',
      })
      .select('id')
      .single();
    if (ins.error) throw new Error(`createAndExecuteRun: eval_runs insert failed: ${ins.error.message}`);
    return ins.data;
  });
  const runId = runRow.id;

  // 4. Grade the grid. Any orchestration failure flips the run to 'failed';
  //    per-cell grader failures are captured as pass:null verdicts and do NOT.
  try {
    for (const pid of pids) {
      const progression = await getParticipantProgression(pid);
      if (!progression) continue; // unknown/stale pid — nothing to grade.

      // Index the phase snapshots by ordinal (step.snapshot may be null for a
      // truncated tail; only non-null snapshots are gradable).
      const snapshotByOrdinal = new Map<number, { spec: string; entities: GradeInput['entities'] }>();
      for (const step of progression.steps) {
        if (step.snapshot) {
          snapshotByOrdinal.set(step.ordinal, {
            spec: step.snapshot.spec,
            entities: step.snapshot.entities,
          });
        }
      }

      for (const phaseOrdinal of phaseOrdinals) {
        const snap = snapshotByOrdinal.get(phaseOrdinal);
        if (!snap) continue; // no spec state at this phase for this pid — skip.

        for (const scenarioIdx of scenarioIdxs) {
          const idx = scenarioIdx as 0 | 1 | 2 | 3;
          // Authored clauses for the judge grader. The editor authors 1–4
          // scenarios; if this idx has no authored scenario, record an honest
          // pass:null rather than crash or fabricate.
          const authored: Scenario | undefined = progression.scenarios[idx];
          let verdict: Verdict;
          if (!authored) {
            verdict = {
              pass: null,
              score: null,
              rationale: `no authored scenario at index ${idx} for this study`,
              evidence: { graderId: req.graderId, error: `missing authored scenario ${idx}` },
            };
          } else {
            const input: GradeInput = {
              pid,
              phaseOrdinal,
              scenarioIdx: idx,
              spec: snap.spec,
              entities: snap.entities,
              scenario: authored,
              oracleSpec: oracle,
              metricDoc: metric,
              systemPrompt,
              fewShot,
              llmConfig: cfg.config,
            };
            try {
              verdict = await grader.grade(input, REAL_LLM_FNS);
            } catch (err) {
              // Honest ungradable: a per-cell failure never aborts the run.
              verdict = {
                pass: null,
                score: null,
                rationale: `grader threw: ${err instanceof Error ? err.message : String(err)}`,
                evidence: {
                  graderId: req.graderId,
                  error: err instanceof Error ? err.message : String(err),
                },
              };
            }
          }

          await withStudyAudit('createAndExecuteRun:verdict', async () => {
            const ins = await (await evalFrom('eval_verdicts')).insert({
              run_id: runId,
              pid,
              phase_ordinal: phaseOrdinal,
              scenario_idx: idx,
              pass: verdict.pass,
              score: verdict.score,
              rationale: verdict.rationale,
              evidence: verdict.evidence as unknown as Json,
              config_hash: configHash,
            });
            if (ins.error) {
              throw new Error(`createAndExecuteRun: eval_verdicts insert failed: ${ins.error.message}`);
            }
          });
        }
      }
    }
  } catch (err) {
    // Orchestration failure: mark the run failed and rethrow. Best-effort — if
    // the status update ITSELF fails we still surface the original error.
    const message = err instanceof Error ? err.message : String(err);
    try {
      await withStudyAudit('createAndExecuteRun:fail', async () => {
        const upd = await (await evalFrom('eval_runs'))
          .update({ status: 'failed', error: message })
          .eq('id', runId);
        if (upd.error) {
          throw new Error(`createAndExecuteRun: status='failed' update failed: ${upd.error.message}`);
        }
      });
    } catch (statusErr) {
      console.error(`[runs] failed to mark run ${runId} failed after error:`, statusErr);
    }
    throw err;
  }

  // 5. Mark complete — audited.
  await withStudyAudit('createAndExecuteRun:complete', async () => {
    const upd = await (await evalFrom('eval_runs')).update({ status: 'complete' }).eq('id', runId);
    if (upd.error) {
      throw new Error(`createAndExecuteRun: status='complete' update failed: ${upd.error.message}`);
    }
  });

  return { runId };
}

// ---------------------------------------------------------------------------
// Reads.
// ---------------------------------------------------------------------------

export type RunSummary = {
  id: string;
  name: string;
  graderId: string;
  simBackend: string | null;
  status: string;
  createdAt: string;
  verdictCount: number;
};

/**
 * All runs, newest first, each with a verdict count. Two reads (runs + a
 * grouped count over verdicts) rather than a join, to keep the query inside the
 * evalFrom guard's simple builder surface.
 */
export async function listRuns(): Promise<RunSummary[]> {
  await requireAuthUser();

  const runsRes = await (await evalFrom('eval_runs')).select('*').order('created_at', { ascending: false });
  if (runsRes.error) throw new Error(`listRuns: eval_runs read failed: ${runsRes.error.message}`);
  const runs = runsRes.data ?? [];
  if (runs.length === 0) return [];

  // Count verdicts per run: fetch run_id only, tally in memory (single
  // researcher, verdict volume is O(thousands) — cheap, avoids .rpc).
  const vRes = await (await evalFrom('eval_verdicts')).select('run_id');
  if (vRes.error) throw new Error(`listRuns: eval_verdicts read failed: ${vRes.error.message}`);
  const countByRun = new Map<string, number>();
  for (const v of vRes.data ?? []) countByRun.set(v.run_id, (countByRun.get(v.run_id) ?? 0) + 1);

  return runs.map((r) => ({
    id: r.id,
    name: r.name,
    graderId: r.grader_id,
    simBackend: r.sim_backend,
    status: r.status,
    createdAt: r.created_at,
    verdictCount: countByRun.get(r.id) ?? 0,
  }));
}

export type VerdictRow = {
  id: string;
  runId: string;
  pid: string;
  phaseOrdinal: number;
  scenarioIdx: number | null;
  pass: boolean | null;
  score: number | null;
  rationale: string;
  evidence: unknown;
};

/** All verdicts for a run, ordered by (pid, phase, scenario) for a stable
 *  render and a deterministic compareRuns join order. */
export async function listVerdicts(runId: string): Promise<VerdictRow[]> {
  await requireAuthUser();

  const res = await (await evalFrom('eval_verdicts'))
    .select('*')
    .eq('run_id', runId)
    .order('pid', { ascending: true })
    .order('phase_ordinal', { ascending: true })
    .order('scenario_idx', { ascending: true });
  if (res.error) throw new Error(`listVerdicts: eval_verdicts read failed: ${res.error.message}`);

  return (res.data ?? []).map((r) => ({
    id: r.id,
    runId: r.run_id,
    pid: r.pid,
    phaseOrdinal: r.phase_ordinal,
    scenarioIdx: r.scenario_idx,
    pass: r.pass,
    score: r.score,
    rationale: r.rationale,
    evidence: r.evidence,
  }));
}

// ---------------------------------------------------------------------------
// compareRuns — the agreement report.
// ---------------------------------------------------------------------------

export type AgreementReport = {
  runA: string;
  runB: string;
  kappa: number | null;
  agreement: number | null;
  n: number;
  disagreements: {
    pid: string;
    phaseOrdinal: number;
    scenarioIdx: number | null;
    passA: boolean | null;
    passB: boolean | null;
  }[];
};

/** Join key for one gradable cell. `scenario_idx` null → 'x' so a
 *  scenario-less verdict still keys deterministically (execution/judge always
 *  set it, but the column is nullable). */
function cellKey(v: { pid: string; phaseOrdinal: number; scenarioIdx: number | null }): string {
  return `${v.pid}|${v.phaseOrdinal}|${v.scenarioIdx ?? 'x'}`;
}

/**
 * Inter-run agreement: join both runs' verdicts on (pid, phaseOrdinal,
 * scenarioIdx) and feed the aligned pass-label vectors to cohensKappa. Only
 * cells PRESENT IN BOTH runs enter the comparison — a cell one run graded and
 * the other didn't is not an agreement question. The κ math then further
 * excludes any joined cell where either pass is null (pairwise-complete), while
 * the `disagreements` list surfaces null-vs-boolean cells for inspection.
 */
export async function compareRuns(runIdA: string, runIdB: string): Promise<AgreementReport> {
  await requireAuthUser();

  const [va, vb] = await Promise.all([listVerdicts(runIdA), listVerdicts(runIdB)]);

  const bByCell = new Map<string, VerdictRow>();
  for (const v of vb) bByCell.set(cellKey(v), v);

  // Deterministic join order: iterate A's verdicts (already ordered by
  // pid/phase/scenario in listVerdicts) and pair each with B's same-cell
  // verdict. Cells only in A or only in B are dropped from the comparison.
  type Paired = {
    pid: string;
    phaseOrdinal: number;
    scenarioIdx: number | null;
    passA: boolean | null;
    passB: boolean | null;
  };
  const paired: Paired[] = [];
  for (const a of va) {
    const b = bByCell.get(cellKey(a));
    if (!b) continue;
    paired.push({
      pid: a.pid,
      phaseOrdinal: a.phaseOrdinal,
      scenarioIdx: a.scenarioIdx,
      passA: a.pass,
      passB: b.pass,
    });
  }

  const { kappa, agreement, n } = cohensKappa(
    paired.map((p) => p.passA),
    paired.map((p) => p.passB),
  );

  const disc = disagreements(
    paired,
    (p) => cellKey(p),
    (p) => p.passA,
    (p) => p.passB,
  );
  const discSet = new Set(disc.map((d) => d.key));

  return {
    runA: runIdA,
    runB: runIdB,
    kappa,
    agreement,
    n,
    disagreements: paired.filter((p) => discSet.has(cellKey(p))),
  };
}
