import { describe, expect, it } from 'vitest';
import {
  EMPTY_FILTERS,
  actionHasObject,
  actionHaystack,
  answerKey,
  foldUsage,
  hasActiveFilters,
  highlightRuns,
  matchesFilters,
  mergeUsage,
  rankActions,
  structuralSummary,
  type SearchVocab,
  type SearchableAction,
} from '@/lib/actions/search';

const VOCAB: SearchVocab = {
  moves: [
    { id: 'infer', name: 'Infer' },
    { id: 'create', name: 'Create' },
    { id: 'trace', name: 'Trace' },
  ],
  objects: [
    { id: 'scenario', name: 'Scenario', parentId: null },
    { id: 'story', name: 'User story', parentId: 'scenario' },
    { id: 'goal', name: 'Goal', parentId: null },
    { id: 'entity', name: 'Entity', parentId: null },
    { id: 'spec', name: 'Specification', parentId: null },
  ],
  roles: [
    { id: 'evidence', name: 'evidence' },
    { id: 'product', name: 'product' },
  ],
  questions: [
    {
      id: 'ext',
      prompt: 'Did external factors play a role?',
      options: [
        { id: 'yes', label: 'Yes — domain knowledge' },
        { id: 'no', label: 'No' },
      ],
    },
    { id: 'note', prompt: 'Note', options: [] },
  ],
};

const A = (over: Partial<SearchableAction> & { id: string; name: string }): SearchableAction => ({
  description: null,
  moveIds: [],
  objectIds: [],
  objectRoles: {},
  answers: [],
  ...over,
});

const inferGoal = A({
  id: 'a1',
  name: 'Infer purpose of scenario',
  description: 'Derive what a scenario is intended to reveal.',
  position: 0,
  moveIds: ['infer'],
  objectIds: ['scenario', 'goal'],
  objectRoles: { scenario: 'evidence', goal: 'product' },
  answers: [{ questionId: 'ext', optionId: 'yes', freeText: null }],
});
const inferEntity = A({
  id: 'a2',
  name: 'Infer entity from scenario',
  description: 'Identify a structural component implied by a scenario.',
  position: 1,
  moveIds: ['infer'],
  objectIds: ['story', 'entity'],
  objectRoles: { story: 'evidence' },
  answers: [{ questionId: 'ext', optionId: 'no', freeText: null }],
});
const createSpec = A({
  id: 'a3',
  name: 'Create specification',
  position: 2,
  moveIds: ['create'],
  objectIds: ['spec'],
  answers: [{ questionId: 'note', optionId: null, freeText: 'wrote it down' }],
});
const traceSpecScenario = A({
  id: 'a4',
  name: 'Trace spec to scenario',
  position: 3,
  moveIds: ['trace'],
  objectIds: ['spec', 'scenario'],
});
const ALL = [inferGoal, inferEntity, createSpec, traceSpecScenario];

describe('actionHaystack', () => {
  it('includes name, description, move, object (with parent), role, and answer text — not prompts', () => {
    const h = actionHaystack(inferEntity, VOCAB);
    expect(h).toContain('Infer entity from scenario');
    expect(h).toContain('Identify a structural');
    expect(h).toContain('Infer');
    expect(h).toContain('Scenario › User story');
    expect(h).toContain('evidence');
    expect(h).toContain('No');
    expect(h).not.toContain('external factors');
  });
  it('includes free-text answers', () => {
    expect(actionHaystack(createSpec, VOCAB)).toContain('wrote it down');
  });
});

describe('actionHasObject', () => {
  it('matches a direct object and a parent through its subclass', () => {
    expect(actionHasObject(inferEntity, 'story', VOCAB.objects)).toBe(true);
    expect(actionHasObject(inferEntity, 'scenario', VOCAB.objects)).toBe(true);
    expect(actionHasObject(inferGoal, 'story', VOCAB.objects)).toBe(false);
  });
});

describe('matchesFilters', () => {
  it('empty filters match everything', () => {
    for (const a of ALL) expect(matchesFilters(a, EMPTY_FILTERS, VOCAB)).toBe(true);
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
  });
  it('move is single-select', () => {
    const f = { ...EMPTY_FILTERS, moveId: 'infer' };
    expect(ALL.filter((a) => matchesFilters(a, f, VOCAB)).map((a) => a.id)).toEqual(['a1', 'a2']);
  });
  it('objects are AND within: every selected object must be present', () => {
    const f = { ...EMPTY_FILTERS, objectIds: ['spec', 'scenario'] };
    expect(ALL.filter((a) => matchesFilters(a, f, VOCAB)).map((a) => a.id)).toEqual(['a4']);
  });
  it('a selected parent matches actions naming any of its subclasses', () => {
    const f = { ...EMPTY_FILTERS, objectIds: ['scenario'] };
    expect(ALL.filter((a) => matchesFilters(a, f, VOCAB)).map((a) => a.id)).toEqual(['a1', 'a2', 'a4']);
  });
  it('categories are AND across: move + objects', () => {
    const f = { ...EMPTY_FILTERS, moveId: 'infer', objectIds: ['scenario', 'goal'] };
    expect(ALL.filter((a) => matchesFilters(a, f, VOCAB)).map((a) => a.id)).toEqual(['a1']);
  });
  it('roles are OR within', () => {
    const f = { ...EMPTY_FILTERS, roleIds: ['product', 'evidence'] };
    expect(ALL.filter((a) => matchesFilters(a, f, VOCAB)).map((a) => a.id)).toEqual(['a1', 'a2']);
    expect(matchesFilters(inferEntity, { ...EMPTY_FILTERS, roleIds: ['product'] }, VOCAB)).toBe(false);
  });
  it('answers are OR within and keyed by question=option', () => {
    const f = { ...EMPTY_FILTERS, answerKeys: [answerKey('ext', 'no')] };
    expect(ALL.filter((a) => matchesFilters(a, f, VOCAB)).map((a) => a.id)).toEqual(['a2']);
    const g = { ...EMPTY_FILTERS, answerKeys: [answerKey('ext', 'no'), answerKey('ext', 'yes')] };
    expect(ALL.filter((a) => matchesFilters(a, g, VOCAB)).map((a) => a.id)).toEqual(['a1', 'a2']);
  });
});

describe('rankActions', () => {
  it('empty query + no filters returns everything in catalog order', () => {
    expect(rankActions('', ALL, EMPTY_FILTERS, VOCAB).map((r) => r.action.id)).toEqual(['a1', 'a2', 'a3', 'a4']);
  });
  it('exact name match ranks first regardless of fuzzy score', () => {
    const r = rankActions('create specification', ALL, EMPTY_FILTERS, VOCAB);
    expect(r[0].action.id).toBe('a3');
    expect(r[0].tier).toBe(2);
  });
  it('query narrows the filtered set (AND with filters)', () => {
    const r = rankActions('entity', ALL, { ...EMPTY_FILTERS, moveId: 'infer' }, VOCAB);
    expect(r.map((x) => x.action.id)).toEqual(['a2']);
  });
  it('query is fuzzy across move/object/role/answer text', () => {
    expect(rankActions('evidence', ALL, EMPTY_FILTERS, VOCAB).map((x) => x.action.id).sort()).toEqual(['a1', 'a2']);
    expect(rankActions('wrote', ALL, EMPTY_FILTERS, VOCAB).map((x) => x.action.id)).toEqual(['a3']);
    expect(rankActions('domain', ALL, EMPTY_FILTERS, VOCAB).map((x) => x.action.id)).toEqual(['a1']);
  });
  it('ties break by usage count, then recency, then position', () => {
    const usage = { a2: { count: 3, lastMs: 10 }, a1: { count: 3, lastMs: 20 }, a4: { count: 1, lastMs: 99 } };
    expect(rankActions('', ALL, EMPTY_FILTERS, VOCAB, usage).map((r) => r.action.id)).toEqual(['a1', 'a2', 'a4', 'a3']);
  });
  it('reports matched indices into name and description for highlighting', () => {
    const [top] = rankActions('Infer purpose', ALL, EMPTY_FILTERS, VOCAB);
    expect(top.action.id).toBe('a1');
    expect(top.nameIndices.slice(0, 5)).toEqual([0, 1, 2, 3, 4]);
    expect(rankActions('', ALL, EMPTY_FILTERS, VOCAB)[0].nameIndices).toEqual([]);
  });
});

describe('structuralSummary', () => {
  it('renders MOVE · Object [role] → Object [role]', () => {
    expect(structuralSummary(inferGoal, VOCAB)).toBe('INFER · Scenario [evidence] → Goal [product]');
    expect(structuralSummary(inferEntity, VOCAB)).toBe('INFER · Scenario › User story [evidence] → Entity');
    expect(structuralSummary(createSpec, VOCAB)).toBe('CREATE · Specification');
  });
});

describe('highlightRuns', () => {
  it('splits text into hit / non-hit runs', () => {
    expect(highlightRuns('Infer', [0, 1])).toEqual([
      { text: 'In', hit: true },
      { text: 'fer', hit: false },
    ]);
    expect(highlightRuns('abc', [])).toEqual([{ text: 'abc', hit: false }]);
    expect(highlightRuns('', [])).toEqual([]);
  });
});

describe('usage folding', () => {
  it('counts per action, keeps the latest timestamp, ignores ad hoc rows', () => {
    const u = foldUsage([
      { actionId: 'a1', createdAt: '2026-08-01T00:00:00Z' },
      { actionId: 'a1', createdAt: '2026-08-02T00:00:00Z' },
      { actionId: null, createdAt: '2026-08-03T00:00:00Z' },
      { actionId: 'a2', createdAt: 5 },
    ]);
    expect(u.a1).toEqual({ count: 2, lastMs: Date.parse('2026-08-02T00:00:00Z') });
    expect(u.a2).toEqual({ count: 1, lastMs: 5 });
    expect(Object.keys(u)).toEqual(['a1', 'a2']);
  });
  it('merges by summing counts and taking the later timestamp', () => {
    const m = mergeUsage({ a1: { count: 1, lastMs: 1 } }, { a1: { count: 2, lastMs: 9 }, a2: { count: 1, lastMs: 3 } });
    expect(m).toEqual({ a1: { count: 3, lastMs: 9 }, a2: { count: 1, lastMs: 3 } });
  });
});
