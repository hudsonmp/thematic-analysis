// Pure core of the STUDY-read guard (no next/headers, no client) so it unit-tests
// under vitest. Mirrors guard-core.ts (assertCbTable) on the read side: study
// tables are IRB-covered and READ-ONLY for this app — `studyFrom` (study-guard.ts)
// composes this core with the user client.

/** Every study-side table this app may READ. Closed allowlist — adding a table is
 *  a deliberate, reviewed act. (cb_* tables are NOT here: they go through cbFrom.) */
export const STUDY_TABLES = [
  'studies',
  'study_events',
  'study_snapshots',
  'study_responses',
  'study_scripts',
  'study_assistant_messages',
  'users',
  'onboarding_fields',
  'onboarding_responses',
  'llm_prompts',
] as const;

export type StudyTable = (typeof STUDY_TABLES)[number];

/** Throws unless `table` is on the closed study-table allowlist. Runtime twin of
 *  the compile-time `StudyTable` bound (mirrors assertCbTable's role for cbFrom). */
export function assertStudyTable(table: string): void {
  if (!(STUDY_TABLES as readonly string[]).includes(table)) {
    throw new Error(
      `studyFrom: "${table}" is not a study table (closed allowlist; cb_ writes go through cbFrom).`,
    );
  }
}

/** PostgREST query-builder members that mutate. Blocked at PROPERTY ACCESS, so a
 *  write attempt throws before any request is even constructed. Write verbs only
 *  exist on the top-level query builder (`.from(t)`); the filter builder returned
 *  by `.select()` has none, so guarding this one level closes the write surface. */
const WRITE_VERBS = new Set(['insert', 'update', 'upsert', 'delete']);

/** The select-only view of a builder type (what `studyFrom` returns). */
export type SelectOnly<B> = Omit<B, 'insert' | 'update' | 'upsert' | 'delete'>;

/** Wrap a query builder so any write-verb ACCESS throws. Reads pass through with
 *  correct `this` binding (methods are bound to the underlying builder). */
export function selectOnly<B extends object>(builder: B): SelectOnly<B> {
  return new Proxy(builder, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && WRITE_VERBS.has(prop)) {
        throw new Error(
          `studyFrom: study tables are read-only — "${prop}" is forbidden (write participant data never).`,
        );
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as SelectOnly<B>;
}
