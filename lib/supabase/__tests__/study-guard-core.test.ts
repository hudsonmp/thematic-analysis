import { describe, expect, it } from 'vitest';
import { PostgrestClient } from '@supabase/postgrest-js';
import {
  STUDY_TABLES,
  assertStudyTable,
  selectOnly,
} from '@/lib/supabase/study-guard-core';

describe('assertStudyTable', () => {
  it('accepts every allowlisted study table', () => {
    for (const t of STUDY_TABLES) expect(() => assertStudyTable(t)).not.toThrow();
  });
  it('rejects cb_ tables, eval tables, and unknown names', () => {
    for (const t of ['cb_codes', 'cb_sessions', 'eval_runs', 'auth.users', 'studiesx', '']) {
      expect(() => assertStudyTable(t)).toThrow(/not a study table/i);
    }
  });
});

describe('selectOnly', () => {
  const stub = {
    select: (cols: string) => `selected:${cols}`,
    insert: () => 'wrote',
    update: () => 'wrote',
    upsert: () => 'wrote',
    delete: () => 'wrote',
    url: 'https://example.test',
  };

  it('passes read members through untouched', () => {
    const guarded = selectOnly(stub);
    expect(guarded.select('id')).toBe('selected:id');
    expect(guarded.url).toBe('https://example.test');
  });

  it('throws on every write verb, at ACCESS time (before any call)', () => {
    const guarded = selectOnly(stub) as unknown as Record<string, unknown>;
    for (const verb of ['insert', 'update', 'upsert', 'delete']) {
      expect(() => guarded[verb]).toThrow(/read-only/i);
    }
  });
});

describe('postgrest surface canary', () => {
  // The selectOnly guard blocklists {insert,update,upsert,delete}. That is safe
  // ONLY while the real query builder's mutating surface is exactly that set. If
  // a postgrest-js upgrade adds a new verb (e.g. `merge`), this canary fails
  // loudly instead of the guard silently passing it through.
  it('real query-builder methods ⊆ known verbs + select', () => {
    const builder = new PostgrestClient('http://localhost').from('t');
    // Walk from the INSTANCE ITSELF up the full prototype chain (excluding
    // Object.prototype): an own-property class-field verb, or a future
    // postgrest-js refactor that moves a verb onto a base class, must not
    // slip past this canary. The typeof filter below discards data props.
    const names = new Set<string>();
    for (
      let o: object | null = builder;
      o && o !== Object.prototype;
      o = Object.getPrototypeOf(o)
    ) {
      for (const n of Object.getOwnPropertyNames(o)) names.add(n);
    }
    const methods = [...names].filter(
      (n) =>
        n !== 'constructor' &&
        typeof (builder as unknown as Record<string, unknown>)[n] === 'function',
    );
    const known = new Set([
      'select',
      'insert',
      'update',
      'upsert',
      'delete',
      // cloneRequestState: read-safe internal helper — copies the builder's
      // request state for immutable chaining; it constructs no write request.
      'cloneRequestState',
      // fetch: own-property data field holding the injected transport (the
      // plain fetch implementation). Not a query verb — calling it grants
      // nothing beyond global fetch; requests it makes carry no builder state.
      'fetch',
    ]);
    const unknown = methods.filter((m) => !known.has(m));
    expect(unknown).toEqual([]);
  });
});

describe('selectOnly over the real postgrest builder', () => {
  it('write verbs throw; read chain constructs without network', () => {
    const real = new PostgrestClient('http://localhost').from('t');
    const guarded = selectOnly(real);
    const asRecord = guarded as unknown as Record<string, unknown>;
    for (const verb of ['insert', 'update', 'upsert', 'delete']) {
      expect(() => asRecord[verb]).toThrow(/read-only/i);
    }
    // Chaining works through the bound method (no await → no network).
    const chain = guarded.select('id').eq('x', 1).limit(1);
    // Thenable ⇒ a real un-awaited PostgrestFilterBuilder; nothing fired.
    expect(typeof (chain as { then?: unknown }).then).toBe('function');
  });
});
