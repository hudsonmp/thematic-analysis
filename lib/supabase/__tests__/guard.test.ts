import { describe, it, expect } from 'vitest';
// Import from the pure core module, not `@/lib/supabase/guard`. `guard.ts` does
// `import 'server-only'`, which throws when imported outside a React-server
// context (e.g. the Vitest `node` env). `assertCbTable` is a pure function and
// lives in `guard-core.ts` (no `server-only`, no client import) precisely so it
// stays testable here; `guard.ts` re-exports it for app code.
import { assertCbTable } from '@/lib/supabase/guard-core';
describe('assertCbTable', () => {
  it('allows cb_ tables', () => { expect(() => assertCbTable('cb_codes')).not.toThrow(); });
  it('rejects study tables', () => {
    for (const t of ['studies','study_events','study_snapshots','users','onboarding_fields'])
      expect(() => assertCbTable(t)).toThrow(/read-only/);
  });
});
