import { describe, expect, it } from 'vitest';
import {
  answerRows,
  cleanObjectRoles,
  compositionKey,
  compositionLabel,
  findExactAction,
  validateComposition,
  encodeTrigger,
  parseTrigger,
  triggerLabel,
  groupActive,
  groupObjects,
  keepParentSelection,
  objectLabel,
  parentProblem,
  toggleObjectSelection,
  isAnswered,
  requiredObjectCount,
  validateActionDraft,
  type MoveLite,
  type ObjectLite,
  type QuestionLite,
  type RoleLite,
} from '@/lib/actions/schema';

const MOVES: MoveLite[] = [
  { id: 'create', name: 'Create', minObjects: 1 },
  { id: 'trace', name: 'Trace', minObjects: 2 },
  { id: 'recall', name: 'Recall', minObjects: 1 },
];

const QUESTIONS: QuestionLite[] = [
  {
    id: 'ext',
    prompt: 'Did external factors play a role?',
    kind: 'multiple_choice',
    required: true,
    options: [
      { id: 'yes', label: 'Yes' },
      { id: 'no', label: 'No' },
    ],
  },
  { id: 'note', prompt: 'Anything else?', kind: 'free_text', required: false, options: [] },
];

const base = {
  name: 'Create entity',
  moveIds: ['create'],
  objectIds: ['entity'],
  answers: { ext: { optionId: 'no' } },
};

describe('requiredObjectCount', () => {
  it('is 1 with no moves selected', () => {
    expect(requiredObjectCount(MOVES, [])).toBe(1);
  });
  it('is the MAX min_objects across the selected moves', () => {
    expect(requiredObjectCount(MOVES, ['create'])).toBe(1);
    expect(requiredObjectCount(MOVES, ['create', 'trace'])).toBe(2);
  });
  it('ignores ids that are not moves', () => {
    expect(requiredObjectCount(MOVES, ['ghost'])).toBe(1);
  });
});

describe('isAnswered', () => {
  const mc = QUESTIONS[0];
  const ft = QUESTIONS[1];
  it('multiple_choice needs an option that belongs to the question', () => {
    expect(isAnswered(mc, { optionId: 'yes' })).toBe(true);
    expect(isAnswered(mc, { optionId: 'other' })).toBe(false);
    expect(isAnswered(mc, { text: 'yes' })).toBe(false);
    expect(isAnswered(mc, undefined)).toBe(false);
  });
  it('free_text needs non-blank text', () => {
    expect(isAnswered(ft, { text: 'hi' })).toBe(true);
    expect(isAnswered(ft, { text: '   ' })).toBe(false);
    expect(isAnswered(ft, { optionId: 'yes' })).toBe(false);
  });
});

describe('validateActionDraft', () => {
  it('accepts a complete draft', () => {
    expect(validateActionDraft(base, MOVES, QUESTIONS)).toEqual([]);
  });

  it('requires a name and at least one move', () => {
    const problems = validateActionDraft({ ...base, name: ' ', moveIds: [] }, MOVES, QUESTIONS);
    expect(problems).toContain('Action needs a name.');
    expect(problems).toContain('Pick at least one move.');
  });

  it('allows exactly one move — two simultaneous moves are two actions', () => {
    const problems = validateActionDraft({ ...base, moveIds: ['create', 'trace'], objectIds: ['a', 'b'] }, MOVES, QUESTIONS);
    expect(problems).toEqual(['An action has exactly one move — if two moves happen at once, create two actions.']);
    // A duplicated id is still one move.
    expect(validateActionDraft({ ...base, moveIds: ['create', 'create'] }, MOVES, QUESTIONS)).toEqual([]);
  });

  it('enforces the selected move’s object floor', () => {
    expect(validateActionDraft({ ...base, objectIds: [] }, MOVES, QUESTIONS)).toContain(
      'Pick at least one object.',
    );
    const problems = validateActionDraft({ ...base, moveIds: ['trace'] }, MOVES, QUESTIONS);
    expect(problems).toEqual(['The selected move needs at least 2 objects (1 picked).']);
    expect(
      validateActionDraft({ ...base, moveIds: ['trace'], objectIds: ['a', 'b'] }, MOVES, QUESTIONS),
    ).toEqual([]);
  });

  it('de-duplicates objects before counting', () => {
    const problems = validateActionDraft(
      { ...base, moveIds: ['trace'], objectIds: ['a', 'a'] },
      MOVES,
      QUESTIONS,
    );
    expect(problems).toEqual(['The selected move needs at least 2 objects (1 picked).']);
  });

  it('requires answers to required questions only', () => {
    expect(validateActionDraft({ ...base, answers: {} }, MOVES, QUESTIONS)).toEqual([
      '“Did external factors play a role?” is required.',
    ]);
    expect(
      validateActionDraft({ ...base, answers: { ext: { optionId: 'yes' }, note: { text: '' } } }, MOVES, QUESTIONS),
    ).toEqual([]);
  });

  it('rejects an option from a different question', () => {
    expect(validateActionDraft({ ...base, answers: { ext: { optionId: 'zzz' } } }, MOVES, QUESTIONS)).toEqual([
      '“Did external factors play a role?”: the chosen option does not belong to this question.',
    ]);
  });

  it('rejects a move id that no longer exists', () => {
    expect(validateActionDraft({ ...base, moveIds: ['ghost'] }, MOVES, QUESTIONS)).toContain(
      'Action references a move that no longer exists.',
    );
  });
});

describe('answerRows', () => {
  it('keeps only given answers for live questions, trimming free text', () => {
    expect(
      answerRows({ ext: { optionId: 'yes' }, note: { text: '  ok  ' }, gone: { text: 'x' } }, QUESTIONS),
    ).toEqual([
      { questionId: 'ext', optionId: 'yes', freeText: null },
      { questionId: 'note', optionId: null, freeText: 'ok' },
    ]);
  });
  it('drops blank free text and foreign options', () => {
    expect(answerRows({ ext: { optionId: 'nope' }, note: { text: '  ' } }, QUESTIONS)).toEqual([]);
  });
});

describe('object subclasses', () => {
  const OBJECTS: ObjectLite[] = [
    { id: 'scenario', name: 'Scenario', parentId: null },
    { id: 'given', name: 'Given scenario', parentId: 'scenario' },
    { id: 'story', name: 'User story', parentId: 'scenario' },
    { id: 'entity', name: 'Entity', parentId: null },
    { id: 'orphan', name: 'Orphan', parentId: 'gone' },
  ];

  it('groupObjects nests subclasses under their parent in input order', () => {
    const groups = groupObjects(OBJECTS);
    expect(groups.map((g) => g.root.id)).toEqual(['scenario', 'entity', 'orphan']);
    expect(groups[0].children.map((c) => c.id)).toEqual(['given', 'story']);
    expect(groups[1].children).toEqual([]);
  });

  it('groupObjects treats an object whose parent is missing as top-level', () => {
    const groups = groupObjects(OBJECTS);
    expect(groups.find((g) => g.root.id === 'orphan')?.children).toEqual([]);
  });

  describe('toggleObjectSelection (coding picker)', () => {
    const g = groupObjects(OBJECTS)[0]; // Scenario › { Given scenario, User story }

    it('picking an unpicked parent adds just the parent', () => {
      expect(toggleObjectSelection([], g, 'scenario')).toEqual(['scenario']);
    });
    it('unpicking an active parent clears the parent and all of its subclasses', () => {
      expect(toggleObjectSelection(['entity', 'given', 'story'], g, 'scenario')).toEqual(['entity']);
      expect(toggleObjectSelection(['scenario', 'entity'], g, 'scenario')).toEqual(['entity']);
    });
    it('refining to a subclass swaps the parent out for the subclass', () => {
      expect(toggleObjectSelection(['scenario', 'entity'], g, 'given')).toEqual(['entity', 'given']);
    });
    it('several subclasses of one parent may be picked together (e.g. Trace needs two objects)', () => {
      expect(toggleObjectSelection(['given'], g, 'story')).toEqual(['given', 'story']);
    });
    it('unpicking the last subclass falls back to the parent so the group stays picked', () => {
      expect(toggleObjectSelection(['given', 'entity'], g, 'given')).toEqual(['entity', 'scenario']);
      expect(toggleObjectSelection(['given', 'story'], g, 'given')).toEqual(['story']);
    });
    it('"keep the parent" from a refined state drops the subclasses', () => {
      expect(keepParentSelection(['given', 'story', 'entity'], g)).toEqual(['entity', 'scenario']);
      expect(keepParentSelection(['scenario'], g)).toEqual(['scenario']);
    });
    it('groupActive reports whether the parent or any subclass is picked', () => {
      expect(groupActive(['entity'], g)).toBe(false);
      expect(groupActive(['story'], g)).toBe(true);
      expect(groupActive(['scenario'], g)).toBe(true);
    });
  });

  it('objectLabel prefixes a subclass with its parent', () => {
    expect(objectLabel(OBJECTS, 'given')).toBe('Scenario › Given scenario');
    expect(objectLabel(OBJECTS, 'entity')).toBe('Entity');
    expect(objectLabel(OBJECTS, 'orphan')).toBe('Orphan');
    expect(objectLabel(OBJECTS, 'nope')).toBe('?');
  });

  it('parentProblem allows a top-level parent for a childless object', () => {
    expect(parentProblem(OBJECTS, 'entity', 'scenario')).toBeNull();
    expect(parentProblem(OBJECTS, null, 'scenario')).toBeNull();
    expect(parentProblem(OBJECTS, 'given', null)).toBeNull();
  });

  it('parentProblem rejects self, unknown, nested, and parents that have children', () => {
    expect(parentProblem(OBJECTS, 'entity', 'entity')).toMatch(/itself/);
    expect(parentProblem(OBJECTS, 'entity', 'missing')).toMatch(/exist/);
    expect(parentProblem(OBJECTS, 'entity', 'given')).toMatch(/one level/);
    expect(parentProblem(OBJECTS, 'scenario', 'entity')).toMatch(/has subclasses/);
  });
});

describe('option triggers (migration 47)', () => {
  const VOCAB = {
    actions: [{ id: 'a1', name: 'Create entity' }],
    objects: [
      { id: 'scenario', name: 'Scenario', parentId: null },
      { id: 'given', name: 'Given scenario', parentId: 'scenario' },
    ] as ObjectLite[],
    moves: MOVES,
  };

  it('encodeTrigger / parseTrigger round-trip every kind and treat empty as no trigger', () => {
    for (const kind of ['action', 'object', 'move'] as const) {
      const t = { kind, id: 'x:with:colons' };
      expect(parseTrigger(encodeTrigger(t))).toEqual(t);
    }
    expect(encodeTrigger(null)).toBe('');
    expect(parseTrigger('')).toBeNull();
    expect(parseTrigger(null)).toBeNull();
  });

  it('parseTrigger rejects malformed or unknown-kind values', () => {
    expect(parseTrigger('a1')).toBeNull();
    expect(parseTrigger(':a1')).toBeNull();
    expect(parseTrigger('action:')).toBeNull();
    expect(parseTrigger('code:a1')).toBeNull();
  });

  it('triggerLabel names the kind and the target, using the object hierarchy label', () => {
    expect(triggerLabel({ kind: 'action', id: 'a1' }, VOCAB)).toBe('action · Create entity');
    expect(triggerLabel({ kind: 'move', id: 'trace' }, VOCAB)).toBe('move · Trace');
    expect(triggerLabel({ kind: 'object', id: 'given' }, VOCAB)).toBe('object · Scenario › Given scenario');
  });

  it('triggerLabel is null for no trigger or a deleted target', () => {
    expect(triggerLabel(null, VOCAB)).toBeNull();
    expect(triggerLabel({ kind: 'action', id: 'gone' }, VOCAB)).toBeNull();
    expect(triggerLabel({ kind: 'object', id: 'gone' }, VOCAB)).toBeNull();
    expect(triggerLabel({ kind: 'move', id: 'gone' }, VOCAB)).toBeNull();
  });
});

describe('compositions (migration 48)', () => {
  const OBJECTS: ObjectLite[] = [
    { id: 'scenario', name: 'Scenario', parentId: null },
    { id: 'given', name: 'Given scenario', parentId: 'scenario' },
    { id: 'entity', name: 'Entity', parentId: null },
  ];
  const ACTIONS = [
    {
      id: 'a1',
      moveIds: ['create'],
      objectIds: ['entity'],
      answers: [{ questionId: 'ext', optionId: 'no', freeText: null }],
    },
    {
      id: 'a2',
      moveIds: ['trace', 'create'],
      objectIds: ['given', 'entity'],
      answers: [],
    },
  ];

  it('compositionKey ignores move/object ORDER and duplicates', () => {
    const a = compositionKey({ moveIds: ['create', 'trace'], objectIds: ['entity', 'given'], answers: [] }, QUESTIONS);
    const b = compositionKey({ moveIds: ['trace', 'create', 'create'], objectIds: ['given', 'entity'], answers: [] }, QUESTIONS);
    expect(a).toBe(b);
  });

  it('compositionKey ignores answer ORDER, blank answers, and deleted questions; normalizes free text whitespace', () => {
    const a = compositionKey(
      {
        moveIds: ['create'],
        objectIds: ['entity'],
        answers: [
          { questionId: 'note', optionId: null, freeText: '  hello   world ' },
          { questionId: 'ext', optionId: 'no', freeText: null },
          { questionId: 'gone', optionId: 'x', freeText: null },
        ],
      },
      QUESTIONS,
    );
    const b = compositionKey(
      {
        moveIds: ['create'],
        objectIds: ['entity'],
        answers: [
          { questionId: 'ext', optionId: 'no', freeText: null },
          { questionId: 'note', optionId: null, freeText: 'hello world' },
        ],
      },
      QUESTIONS,
    );
    const c = compositionKey(
      {
        moveIds: ['create'],
        objectIds: ['entity'],
        answers: [
          { questionId: 'ext', optionId: 'no', freeText: null },
          { questionId: 'note', optionId: null, freeText: '   ' },
        ],
      },
      QUESTIONS,
    );
    expect(a).toBe(b);
    expect(c).not.toBe(a);
    expect(c).toBe(compositionKey({ moveIds: ['create'], objectIds: ['entity'], answers: [{ questionId: 'ext', optionId: 'no', freeText: null }] }, QUESTIONS));
  });

  it('compositionKey distinguishes different answers', () => {
    const yes = compositionKey({ moveIds: ['create'], objectIds: ['entity'], answers: [{ questionId: 'ext', optionId: 'yes', freeText: null }] }, QUESTIONS);
    const no = compositionKey({ moveIds: ['create'], objectIds: ['entity'], answers: [{ questionId: 'ext', optionId: 'no', freeText: null }] }, QUESTIONS);
    expect(yes).not.toBe(no);
  });

  it('findExactAction matches order-insensitively and returns null otherwise', () => {
    expect(findExactAction(ACTIONS, { moveIds: ['create', 'trace'], objectIds: ['entity', 'given'], answers: [] }, QUESTIONS)?.id).toBe('a2');
    expect(
      findExactAction(ACTIONS, { moveIds: ['create'], objectIds: ['entity'], answers: answerRows({ ext: { optionId: 'no' } }, QUESTIONS) }, QUESTIONS)?.id,
    ).toBe('a1');
    expect(
      findExactAction(ACTIONS, { moveIds: ['create'], objectIds: ['entity'], answers: answerRows({ ext: { optionId: 'yes' } }, QUESTIONS) }, QUESTIONS),
    ).toBeNull();
    expect(findExactAction(ACTIONS, { moveIds: ['create'], objectIds: ['scenario'], answers: [] }, QUESTIONS)).toBeNull();
  });

  it('validateComposition applies the action rules minus the name', () => {
    expect(validateComposition({ moveIds: [], objectIds: [], answers: {} }, MOVES, QUESTIONS)).toEqual([
      'Pick at least one move.',
      'Pick at least one object.',
      '“Did external factors play a role?” is required.',
    ]);
    expect(validateComposition({ moveIds: ['create'], objectIds: ['entity'], answers: { ext: { optionId: 'no' } } }, MOVES, QUESTIONS)).toEqual([]);
  });

  it('compositionLabel joins moves with + and objects with , using hierarchy labels', () => {
    expect(compositionLabel({ moveIds: ['create', 'trace'], objectIds: ['given', 'entity'] }, { moves: MOVES, objects: OBJECTS })).toBe(
      'Create + Trace × Scenario › Given scenario, Entity',
    );
    expect(compositionLabel({ moveIds: [], objectIds: ['ghost'] }, { moves: MOVES, objects: OBJECTS })).toBe('(no move) × ?');
  });
});

describe('object roles (migration 50)', () => {
  const ROLES: RoleLite[] = [
    { id: 'source', name: 'source' },
    { id: 'target', name: 'target' },
  ];
  const OBJECTS: ObjectLite[] = [
    { id: 'scenario', name: 'Scenario', parentId: null },
    { id: 'entity', name: 'Entity', parentId: null },
  ];

  it('cleanObjectRoles keeps only roles on selected objects that name a live role', () => {
    expect(
      cleanObjectRoles({ entity: 'source', scenario: 'ghost', other: 'target', given: null }, ['entity', 'scenario'], ROLES),
    ).toEqual({ entity: 'source' });
    expect(cleanObjectRoles(undefined, ['entity'], ROLES)).toEqual({});
  });

  it('validateActionDraft accepts roles as optional and rejects an unknown role', () => {
    const draft = { ...base, moveIds: ['trace'], objectIds: ['entity', 'scenario'] };
    expect(validateActionDraft(draft, MOVES, QUESTIONS, ROLES)).toEqual([]);
    expect(validateActionDraft({ ...draft, objectRoles: { entity: 'source' } }, MOVES, QUESTIONS, ROLES)).toEqual([]);
    expect(validateActionDraft({ ...draft, objectRoles: { entity: 'ghost' } }, MOVES, QUESTIONS, ROLES)).toEqual([
      'Action references a role that no longer exists.',
    ]);
    // A role on an object that is not selected is ignored, not an error.
    expect(validateActionDraft({ ...draft, objectRoles: { other: 'ghost' } }, MOVES, QUESTIONS, ROLES)).toEqual([]);
    // Without a role vocabulary passed, roles are not checked (legacy callers).
    expect(validateActionDraft({ ...draft, objectRoles: { entity: 'ghost' } }, MOVES, QUESTIONS)).toEqual([]);
  });

  it('compositionKey includes roles on selected objects and ignores roles elsewhere', () => {
    const none = compositionKey({ moveIds: ['trace'], objectIds: ['entity', 'scenario'], answers: [] }, QUESTIONS);
    const empty = compositionKey({ moveIds: ['trace'], objectIds: ['entity', 'scenario'], answers: [], objectRoles: {} }, QUESTIONS);
    const stray = compositionKey(
      { moveIds: ['trace'], objectIds: ['entity', 'scenario'], answers: [], objectRoles: { other: 'source' } },
      QUESTIONS,
    );
    const st = compositionKey(
      { moveIds: ['trace'], objectIds: ['entity', 'scenario'], answers: [], objectRoles: { entity: 'source', scenario: 'target' } },
      QUESTIONS,
    );
    const ts = compositionKey(
      { moveIds: ['trace'], objectIds: ['scenario', 'entity'], answers: [], objectRoles: { scenario: 'source', entity: 'target' } },
      QUESTIONS,
    );
    const stAgain = compositionKey(
      { moveIds: ['trace'], objectIds: ['scenario', 'entity'], answers: [], objectRoles: { scenario: 'target', entity: 'source' } },
      QUESTIONS,
    );
    expect(none).toBe(empty);
    expect(none).toBe(stray);
    expect(st).not.toBe(none);
    expect(st).not.toBe(ts);
    expect(st).toBe(stAgain);
  });

  it('findExactAction treats roles as part of the composition', () => {
    const actions = [
      { id: 'plain', moveIds: ['trace'], objectIds: ['entity', 'scenario'], answers: [], objectRoles: {} },
      { id: 'roled', moveIds: ['trace'], objectIds: ['entity', 'scenario'], answers: [], objectRoles: { entity: 'source', scenario: 'target' } },
    ];
    expect(findExactAction(actions, { moveIds: ['trace'], objectIds: ['scenario', 'entity'], answers: [] }, QUESTIONS)?.id).toBe('plain');
    expect(
      findExactAction(actions, { moveIds: ['trace'], objectIds: ['scenario', 'entity'], answers: [], objectRoles: { scenario: 'target', entity: 'source' } }, QUESTIONS)?.id,
    ).toBe('roled');
    expect(
      findExactAction(actions, { moveIds: ['trace'], objectIds: ['scenario', 'entity'], answers: [], objectRoles: { scenario: 'source' } }, QUESTIONS),
    ).toBeNull();
  });

  it('compositionLabel shows a role after its object when given the role vocabulary', () => {
    expect(
      compositionLabel(
        { moveIds: ['trace'], objectIds: ['entity', 'scenario'], objectRoles: { entity: 'source', scenario: 'ghost' } },
        { moves: MOVES, objects: OBJECTS, roles: ROLES },
      ),
    ).toBe('Trace × Entity (source), Scenario');
    // No role vocabulary → roles are not rendered.
    expect(
      compositionLabel({ moveIds: ['trace'], objectIds: ['entity'], objectRoles: { entity: 'source' } }, { moves: MOVES, objects: OBJECTS }),
    ).toBe('Trace × Entity');
  });
});
