# Eval Harness B1 — Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship sub-project B's foundations: the `evalFrom()` write guard over the new `eval_*` tables (already migrated to prod as `eval_harness_tables`), the runtime study-table audit (safety L5), the Anthropic LLM client layer with model-conditional config validation, and the eval data actions (artifacts / prompt variants / few-shot sets / annotations) with their seeds.

**Architecture:** Mirrors the shipped A patterns exactly: pure cores in `lib/` (vitest-tested) + `server-only` compositions + `'use server'` actions; `evalFrom` (user client, `eval_` prefix bound) mirrors `cbFrom`/`studyFrom`; study data is READ via `studyFrom` only; every eval write action wraps in the pre/post study-fingerprint audit.

**Tech Stack:** Next.js 16.2.6, `@anthropic-ai/sdk` (NEW dependency), zod (already present), Supabase user client, vitest.

## Global Constraints

- Same as plan `2026-07-04-progression-analysis-viewer.md` Global Constraints (branch `feat/progression-analysis`, main checkout, no `dev`/`build`, verify via `npx tsc --noEmit` + `npx vitest run` + `npm run lint`, study tables IRB read-only via `studyFrom`, pid-only PII, repo comment style).
- **eval_* tables are writable ONLY through `evalFrom()`** — never `cbFrom` (asserts cb_ prefix), never the service client, never raw user-client `.from('eval_…')` in actions.
- **LLM ground truth (from the claude-api reference, cached 2026-06):** model ids `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5` (exact strings, no date suffixes). `temperature` is REJECTED (400) on `claude-opus-4-8`; allowed (0..1) on sonnet/haiku. `output_config: {effort}` valid on opus-4-8 + sonnet-4-6 (low|medium|high|xhigh(opus)|max), NOT haiku. Structured outputs via `output_config.format` json_schema; `strict`-style schemas need `additionalProperties: false`. Non-streaming `max_tokens` ≤ ~16000. No assistant prefill. Errors: use typed classes (`Anthropic.RateLimitError` etc.), most-specific-first.
- `ANTHROPIC_API_KEY` will be added to `.env.local` by Hudson; code must throw a clear error at CALL time when absent (never at import time), and all LLM-layer tests must run WITHOUT the key (pure validation + stubbed client).

---

### Task B1-1: eval types + `evalFrom()` guard

**Files:**
- Modify: `lib/types/cb-db.ts` (hand-add the six `eval_*` table types, following the `cb_session_coding_status` hand-add convention — Row/Insert/Update + Relationships; FK relationships between eval tables included; no cross-schema FKs)
- Create: `lib/supabase/eval-guard-core.ts`, `lib/supabase/eval-guard.ts`
- Test: `lib/supabase/__tests__/eval-guard-core.test.ts`

**Interfaces:**
- Consumes: `createUserServerClient`, `Database`.
- Produces: `EVAL_TABLES` const, `type EvalTable`, `assertEvalTable(table: string): void`, `async function evalFrom<T extends EvalTable>(table: T)` — FULL query builder (reads AND writes; eval tables are B's own data, unlike studyFrom's select-only proxy).

**Steps (TDD):**
1. Write failing test: `assertEvalTable` accepts all six (`eval_artifacts`, `eval_prompt_variants`, `eval_few_shot_sets`, `eval_annotations`, `eval_runs`, `eval_verdicts`); rejects `cb_codes`, `study_snapshots`, `users`, `llm_prompts`, `evalx_runs`, `''` with /not an eval table/i. Run → module-not-found FAIL.
2. Implement `eval-guard-core.ts`: mirror `study-guard-core.ts`'s allowlist half exactly (const array, type, assert). NO selectOnly proxy — writes are the point. Doc comment: eval_* is B's OWN storage (safety spec L5); the guard exists so a typo'd table name can never reach cb_/study_ data through this path, and so CI can quarantine raw clients to the three guard modules.
3. Implement `eval-guard.ts` (`server-only`): `assertEvalTable(table); const sb = await createUserServerClient(); return sb.from(table);` with the doc comment noting the USER client (RLS full-access for the researcher; the service key stays quarantined to cbFrom).
4. Add the six table types to `cb-db.ts` matching the applied migration columns exactly (uuid ids, nullable FKs `parent_id`/`folded_into_variant_id`/`prompt_variant_id`/`few_shot_set_id`/`oracle_artifact_id`/`metric_artifact_id`, `participant_pids: string[]`, jsonb → `Json`, timestamps `string`). Include Relationships entries for the intra-eval FKs (mirror how cb_ FK entries are written).
5. `npx tsc --noEmit && npx vitest run lib/supabase && npm run lint` → green. NOTE: the guard script's Rule 2 quarantine allowlist does NOT need changing — evalFrom uses the user client, not the service client. Verify lint stays green to prove it.
6. Commit: `feat(eval): eval_* table types + evalFrom guard (safety L5 storage)`

---

### Task B1-2: runtime study-fingerprint audit

**Files:**
- Create: `lib/eval/audit-core.ts` (pure), `lib/eval/audit.ts` (server-only)
- Test: `lib/eval/__tests__/audit-core.test.ts`

**Interfaces:**
- Produces: `type StudyFingerprint = Record<string, number>` (table → row count); `diffFingerprints(before: StudyFingerprint, after: StudyFingerprint): string[]` (human-readable drift lines, [] = clean) in core; `async takeStudyFingerprint(): Promise<StudyFingerprint>` and `async withStudyAudit<T>(label: string, fn: () => Promise<T>): Promise<T>` in audit.ts.

**Steps (TDD):**
1. Failing tests for `diffFingerprints`: identical → []; count changed → one line naming table/before/after; table missing in after → flagged; extra table in after → flagged.
2. Implement core (pure object diff, sorted output for determinism).
3. Implement `audit.ts`: `takeStudyFingerprint` runs `(await studyFrom(t)).select('*', { count: 'exact', head: true })` for every entry of `STUDY_TABLES` (import from study-guard-core) and records `count ?? -1`; `withStudyAudit` = fingerprint → `await fn()` → fingerprint → if `diffFingerprints` non-empty, `throw new Error('STUDY-DATA AUDIT FAILURE after "<label>": <lines joined>')` — loud, never swallowed; returns fn's result otherwise. Doc comment: this is safety L5's runtime belt — head-count fingerprints are cheap (10 head requests) and detect INSERT/DELETE drift; UPDATE drift is covered by the structural layers (SELECT-only RLS + studyFrom), not this belt; state that honestly.
4. Full battery green. Commit: `feat(eval): pre/post study-table fingerprint audit (safety L5 runtime belt)`

---

### Task B1-3: LLM client layer

**Files:**
- Modify: `package.json` (+ lockfile) via `npm install @anthropic-ai/sdk`
- Create: `lib/llm/config.ts` (pure), `lib/llm/client.ts` (server-only)
- Test: `lib/llm/__tests__/config.test.ts`

**Interfaces:**
- Produces (pure): `EVAL_MODELS = ['claude-opus-4-8','claude-sonnet-4-6','claude-haiku-4-5'] as const`; `type EvalModel`; `type LlmConfig = { model: EvalModel; temperature?: number; maxTokens?: number; effort?: 'low'|'medium'|'high'|'xhigh'|'max' }`; `validateLlmConfig(raw: unknown): { ok: true; config: LlmConfig } | { ok: false; errors: string[] }`.
- Produces (server): `async llmComplete(cfg: LlmConfig, opts: { system: string; messages: {role:'user'|'assistant';content:string}[] }): Promise<{ text: string; usage: {inputTokens:number;outputTokens:number} }>` and `async llmCompleteJson<T>(cfg, opts & { schema: z.ZodType<T>; schemaName: string }): Promise<{ value: T; usage: ... }>`.

**Steps (TDD):**
1. Failing tests for `validateLlmConfig` — the model-conditional rules ARE the point:
   - valid: sonnet + temperature 0.7; opus with effort 'xhigh' and NO temperature; haiku bare.
   - invalid: `temperature` present with model `claude-opus-4-8` → error naming the constraint ("temperature is not supported on claude-opus-4-8 (removed in the 4.7+ API)"); temperature 1.5 or -0.1 → range error; `effort` with haiku → error; `effort: 'xhigh'` with sonnet → error (xhigh is opus-only); unknown model → error listing EVAL_MODELS; maxTokens > 16000 → error ("non-streaming ceiling; raise only with streaming support"); non-object / junk fields → errors (strict parse via zod `.strict()`).
2. Implement `config.ts` with a zod schema + `superRefine` for the cross-field rules; export the zod schema too (`llmConfigSchema`) for reuse in actions. Doc-comment each rule with its API-ground-truth source (claude-api reference: sampling params removed on opus-4-8; effort unsupported on haiku; xhigh opus-only).
3. `npm install @anthropic-ai/sdk` (dependencies).
4. Implement `client.ts` (`import 'server-only'`):
   ```ts
   import Anthropic from '@anthropic-ai/sdk';
   function getClient(): Anthropic {
     if (!process.env.ANTHROPIC_API_KEY) {
       throw new Error('ANTHROPIC_API_KEY is not set — add it to .env.local to run LLM graders.');
     }
     return new Anthropic();
   }
   ```
   `llmComplete`: build params — `model`, `max_tokens: cfg.maxTokens ?? 8192`, `system`, `messages`; include `temperature` ONLY when defined (validator already guarantees model compatibility); include `output_config: { effort }` only when defined. Extract text via `response.content` narrowing on `block.type === 'text'` (join). Map usage. `llmCompleteJson`: use `zodOutputFormat` from `@anthropic-ai/sdk/helpers/zod` with `client.messages.parse(...)`, return `parsed_output` (throw a descriptive error when null: include stop_reason). Catch NOTHING here — typed SDK errors propagate to the caller (actions decide retry/display); doc-comment says so.
5. tsc + vitest + lint green (client.ts compiles; its network path is untested by design — no key in CI).
6. Commit: `feat(llm): Anthropic client layer — model-conditional config validation + structured-output helper`

---

### Task B1-4: eval data actions + seeds

**Files:**
- Create: `app/actions/eval.ts`
- Create: `lib/eval/seeds.ts` (the DRAFT oracle-spec.md + metric.md contents as exported string consts + `sha256Hex(content)` helper using node:crypto)
- Test: `lib/eval/__tests__/seeds.test.ts` (hash is stable/hex; drafts mention all four scenarios and the DRAFT marker)

**Interfaces (consumed by B2/B3 — exact):**
```ts
export type EvalArtifact = { id: string; kind: 'oracle_spec'|'metric'; name: string; content: string; hash: string; createdAt: string };
export async function listArtifacts(kind: 'oracle_spec'|'metric'): Promise<EvalArtifact[]>;          // newest first
export async function saveArtifact(kind: 'oracle_spec'|'metric', name: string, content: string): Promise<EvalArtifact>; // append-only version
export type PromptVariant = { id: string; name: string; systemPrompt: string; parentId: string|null; createdAt: string };
export async function listPromptVariants(): Promise<PromptVariant[]>;                                 // seeds from llm_prompts.help_seeking when empty
export async function savePromptVariant(name: string, systemPrompt: string, parentId: string|null): Promise<PromptVariant>;
export type FewShotExample = { sourceMessageId: string|null; role: 'user'|'assistant'; content: string };
export type FewShotSet = { id: string; name: string; examples: FewShotExample[]; createdAt: string };
export async function listFewShotSets(): Promise<FewShotSet[]>;
export async function saveFewShotSet(name: string, examples: FewShotExample[]): Promise<FewShotSet>;
export type AssistantTurn = { id: string; role: 'user'|'assistant'; content: string; scenarioIdx: number|null; pid: string };
export async function listAssistantTurnsForFewShot(): Promise<AssistantTurn[]>;                        // task-module turns w/ pid, READ-ONLY via studyFrom
export async function saveAnnotation(input: { runId?: string; verdictId?: string; note: string }): Promise<void>;
export async function foldAnnotationsIntoVariant(annotationIds: string[], baseVariantId: string, newName: string): Promise<PromptVariant>;
```
Implementation requirements: `requireAuthUser()` first in every action; ALL eval writes via `evalFrom` AND wrapped in `withStudyAudit('<action name>', ...)`; study reads (llm_prompts seed, study_assistant_messages listing joined to users for pid) via `studyFrom` only, empty-shape discipline. `listAssistantTurnsForFewShot` resolves pids via one `users` read (id→pid map), selects `id, user_id, role, content, scenario_idx` from `study_assistant_messages` filtered to the task module (`taskModuleIdFrom(getShownStudy())`), ordered `created_at`. `foldAnnotationsIntoVariant` composes: read base variant + annotations via evalFrom, create new variant whose systemPrompt = base + `\n\n## Researcher annotations (folded <ISO date>)\n- <note>` lines, set `folded_into_variant_id` on the annotations. Seeds: on `listArtifacts` returning empty for a kind, insert the DRAFT seed (from `lib/eval/seeds.ts`) and return it — self-initializing, idempotent by the empty check. Seed contents: oracle-spec DRAFT = per-scenario "satisfies" definitions derived from the authored Then-clauses with explicit `> DRAFT — Hudson: edit before trusting any verdict` header + the silence-handling open decision called out; metric DRAFT = judge rubric skeleton (per-clause satisfied/unsatisfied/unclear + improvement delta definition) with the same DRAFT header.

**Steps:** failing seeds test → implement seeds → implement actions → full battery → commit `feat(eval): artifact/variant/few-shot/annotation actions with self-initializing DRAFT seeds`.

---

### Task B1-5: verification + docs stub

1. Full battery: tsc, vitest (all), lint. 
2. Create `docs/eval-paradigms.md`: header + first two entries (decisions-as-data architecture citing the B spec; LLM layer model rules citing the claude-api reference constraints) + "updated in the same PR as any module/paradigm change" rule. Commit `docs(eval): paradigms running doc — B1 foundations entries`.

## Self-Review
- Coverage vs B spec §5/§6: tables ✓ (migration applied), evalFrom ✓ (B1-1), audit ✓ (B1-2), SDK+key handling+model rules ✓ (B1-3), artifacts/variants/few-shot/annotations + seeds from llm_prompts + 234-turn corpus ✓ (B1-4), paradigms doc ✓ (B1-5). Deferred to B2: graders, sims, sandbox, runs/verdicts execution. To B3: all UI incl. select-all/deselect-all multiselect (Hudson's explicit ask), agreement κ + disagreement browser.
- No placeholders; interfaces exact; types named consistently with A's conventions.
