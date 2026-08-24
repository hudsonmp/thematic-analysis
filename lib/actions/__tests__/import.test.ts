import { describe, expect, it } from 'vitest';
import { parseActionBlock, planActionImport, resolveAction, splitActionBlocks, type ImportVocab } from '@/lib/actions/import';

const VOCAB: ImportVocab = {
  moves: [
    { id: 'm-create', name: 'Create', minObjects: 1 },
    { id: 'm-trace', name: 'Trace', minObjects: 2 },
  ],
  objects: [
    { id: 'o-entity', name: 'Entity', parentId: null },
    { id: 'o-scenario', name: 'Scenario', parentId: null },
    { id: 'o-given', name: 'Given scenario', parentId: 'o-scenario' },
    { id: 'o-story', name: 'User story', parentId: 'o-scenario' },
  ],
  roles: [
    { id: 'r-src', name: 'source' },
    { id: 'r-tgt', name: 'target' },
  ],
  questions: [
    {
      id: 'q-ext',
      prompt: 'Did external factors play a role?',
      kind: 'multiple_choice',
      required: true,
      options: [
        { id: 'opt-yes', label: 'Yes' },
        { id: 'opt-no', label: 'No' },
      ],
    },
    { id: 'q-note', prompt: 'Anything else?', kind: 'free_text', required: false, options: [] },
  ],
  actions: [
    {
      id: 'a-1',
      name: 'Create entity (existing)',
      moveIds: ['m-create'],
      objectIds: ['o-entity'],
      answers: [{ questionId: 'q-ext', optionId: 'opt-no', freeText: null }],
    },
  ],
};

const block = (yaml: string) => '```action\n' + yaml.trim() + '\n```\n';

const HEADER = '# Action Import\n\n```yaml\nschema_version: 2\n```\n\n## Action\n\n';

const CREATE_ENTITY = `
name: "Create entity"
move: "Create"
objects:
  - object: "Entity"
questions:
  - question: "Did external factors play a role?"
    answer:
      type: "option"
      value: "No"
`;

const TRACE = `
name: "Trace story to entity"
description: "Links a user story to the entity it names"
move: "Trace"
objects:
  - object: "Scenario"
    subclass: "User story"
    role: "source"
  - object: "Entity"
    role: "target"
questions:
  - question: "Did external factors play a role?"
    answer:
      value: "Yes"
  - question: "Anything else?"
    answer:
      type: text
      value: "  spotted   via the map  "
`;

describe('splitActionBlocks', () => {
  it('finds schema_version inside a yaml fence and every ```action block with its line', () => {
    const md = HEADER + block(CREATE_ENTITY) + '\nprose\n\n' + block(TRACE);
    const { schemaVersion, blocks } = splitActionBlocks(md);
    expect(schemaVersion).toBe('2');
    expect(blocks).toHaveLength(2);
    expect(blocks[0].index).toBe(0);
    expect(blocks[0].line).toBe(10);
    expect(blocks[0].body).toContain('name: "Create entity"');
    expect(blocks[1].index).toBe(1);
  });
  it('accepts a bare schema_version line and CRLF endings', () => {
    const md = ('schema_version: 2\r\n' + block(CREATE_ENTITY)).replace(/\n/g, '\r\n');
    const { schemaVersion, blocks } = splitActionBlocks(md);
    expect(schemaVersion).toBe('2');
    expect(blocks).toHaveLength(1);
  });
  it('ignores fences in other languages and schema_version inside an action block', () => {
    const md = '```yaml\nfoo: bar\n```\n' + block('schema_version: 9\nname: x');
    const { schemaVersion, blocks } = splitActionBlocks(md);
    expect(schemaVersion).toBeNull();
    expect(blocks).toHaveLength(1);
  });
  it('handles ~~~ fences and longer backtick fences', () => {
    const md = 'schema_version: 2\n~~~action\nname: a\n~~~\n````action\nname: b\n```\nstill inside\n````\n';
    const { blocks } = splitActionBlocks(md);
    expect(blocks.map((b) => b.body)).toEqual(['name: a', 'name: b\n```\nstill inside']);
  });
});

describe('parseActionBlock', () => {
  it('parses the full schema', () => {
    const r = parseActionBlock(TRACE);
    expect('raw' in r).toBe(true);
    if (!('raw' in r)) return;
    expect(r.raw.name).toBe('Trace story to entity');
    expect(r.raw.move).toBe('Trace');
    expect(r.raw.objects).toEqual([
      { object: 'Scenario', subclass: 'User story', role: 'source' },
      { object: 'Entity', subclass: null, role: 'target' },
    ]);
    expect(r.raw.questions[0]).toEqual({ question: 'Did external factors play a role?', answer: { type: null, value: 'Yes' } });
    expect(r.raw.questions[1].answer.type).toBe('text');
  });
  it('trims the name and rejects an empty one', () => {
    const ok = parseActionBlock('name: "  padded  "\nmove: Create\nobjects:\n  - object: Entity');
    expect('raw' in ok && ok.raw.name).toBe('padded');
    const bad = parseActionBlock('name: "   "\nmove: Create\nobjects:\n  - object: Entity');
    expect('errors' in bad && bad.errors.join(' ')).toMatch(/`name` is required/);
  });
  it('reports unknown keys, a plural moves key, and missing objects', () => {
    const r = parseActionBlock('name: x\nmoves: [Create]\nobjcts: []\nfoo: 1');
    expect('errors' in r).toBe(true);
    if (!('errors' in r)) return;
    expect(r.errors.join('\n')).toMatch(/Unknown key “moves”/);
    expect(r.errors.join('\n')).toMatch(/Unknown key “objcts”/);
    expect(r.errors.join('\n')).toMatch(/Use `move:` \(singular\)/);
    expect(r.errors.join('\n')).toMatch(/`objects` is required/);
  });
  it('reports YAML syntax errors and non-mapping blocks', () => {
    expect('errors' in parseActionBlock('name: "unterminated')).toBe(true);
    expect('errors' in parseActionBlock('- just\n- a list')).toBe(true);
    expect('errors' in parseActionBlock('   \n')).toBe(true);
  });
  it('requires answer.value when answer is a mapping', () => {
    const r = parseActionBlock(
      'name: x\nmove: Create\nobjects:\n  - object: Entity\nquestions:\n  - question: q\n    answer:\n      type: text',
    );
    expect('errors' in r && r.errors.join(' ')).toMatch(/`value` is required/);
  });
});

describe('resolveAction', () => {
  const parse = (yaml: string) => {
    const p = parseActionBlock(yaml);
    if ('errors' in p) throw new Error(p.errors.join(' '));
    return p.raw;
  };

  it('builds a draft with subclass ids, roles and answers keyed by question id', () => {
    const r = resolveAction(parse(TRACE), VOCAB);
    expect('draft' in r).toBe(true);
    if (!('draft' in r)) return;
    expect(r.draft).toEqual({
      name: 'Trace story to entity',
      description: 'Links a user story to the entity it names',
      moveIds: ['m-trace'],
      objectIds: ['o-story', 'o-entity'],
      answers: { 'q-ext': { optionId: 'opt-yes' }, 'q-note': { text: 'spotted   via the map' } },
      objectRoles: { 'o-story': 'r-src', 'o-entity': 'r-tgt' },
    });
  });
  it('matches names case- and whitespace-insensitively', () => {
    const r = resolveAction(
      parse('name: x\nmove: " create "\nobjects:\n  - object: entity\nquestions:\n  - question: "did external   factors play a role?"\n    answer: no'),
      VOCAB,
    );
    expect('draft' in r && r.draft.moveIds).toEqual(['m-create']);
    expect('draft' in r && r.draft.answers['q-ext']).toEqual({ optionId: 'opt-no' });
  });
  it('names every unresolvable reference', () => {
    const r = resolveAction(
      parse(
        'name: x\nmove: Destroy\nobjects:\n  - object: Widget\n  - object: Scenario\n    subclass: Epic\n    role: owner\nquestions:\n  - question: Why?\n    answer: because',
      ),
      VOCAB,
    );
    expect('errors' in r).toBe(true);
    if (!('errors' in r)) return;
    const text = r.errors.join('\n');
    expect(text).toMatch(/Move “Destroy” does not exist/);
    expect(text).toMatch(/object “Widget” does not exist/);
    expect(text).toMatch(/has no subclass “Epic”/);
    expect(text).toMatch(/question “Why\?” does not exist/);
    // the role is not checked because the subclass failed first
  });
  it('points a subclass named as the object at the right syntax', () => {
    const r = resolveAction(parse('name: x\nmove: Create\nobjects:\n  - object: "User story"'), VOCAB);
    expect('errors' in r && r.errors[0]).toMatch(/is a subclass of “Scenario” — write object: "Scenario", subclass: "User story"/);
  });
  it('rejects an object listed twice and an unknown role', () => {
    const r = resolveAction(
      parse('name: x\nmove: Trace\nobjects:\n  - object: Entity\n    role: source\n  - object: Entity\n    role: owner'),
      VOCAB,
    );
    expect('errors' in r && r.errors.join('\n')).toMatch(/is listed twice/);
  });
  it('rejects a mismatched answer type and an unknown option', () => {
    const mismatch = resolveAction(
      parse('name: x\nmove: Create\nobjects:\n  - object: Entity\nquestions:\n  - question: "Did external factors play a role?"\n    answer:\n      type: text\n      value: No'),
      VOCAB,
    );
    expect('errors' in mismatch && mismatch.errors[0]).toMatch(/is multiple choice/);
    const unknown = resolveAction(
      parse('name: x\nmove: Create\nobjects:\n  - object: Entity\nquestions:\n  - question: "Did external factors play a role?"\n    answer: Maybe'),
      VOCAB,
    );
    expect('errors' in unknown && unknown.errors[0]).toMatch(/has no option “Maybe” \(options: Yes, No\)/);
  });
  it('applies the draft rules: required question, min objects for the move', () => {
    const r = resolveAction(parse('name: x\nmove: Trace\nobjects:\n  - object: Entity'), VOCAB);
    expect('errors' in r).toBe(true);
    if (!('errors' in r)) return;
    expect(r.errors.join('\n')).toMatch(/needs at least 2 objects/);
    expect(r.errors.join('\n')).toMatch(/is required/);
  });
});

describe('planActionImport', () => {
  it('classifies blocks as create / duplicate / repeat / error and counts them', () => {
    const md =
      HEADER +
      block(CREATE_ENTITY) + // same signature as the existing action ⇒ duplicate (name differs, irrelevant)
      block(TRACE) + // ⇒ create
      block(TRACE.replace('Trace story to entity', 'Same signature, other name')) + // ⇒ repeat of block 1
      block('name: broken\nmove: Create\nobjects:\n  - object: Entity\nquestions:\n  - question: Why?\n    answer: x'); // ⇒ error (unknown question)
    const plan = planActionImport(md, VOCAB);
    expect(plan.fileErrors).toEqual([]);
    expect(plan.vocabAdds).toEqual({ moves: [], objects: [], roles: [] });
    expect(plan.items.map((i) => i.status)).toEqual(['duplicate', 'create', 'repeat', 'error']);
    expect(plan.counts).toEqual({ create: 1, duplicate: 1, repeat: 1, error: 1 });
    const dup = plan.items[0];
    expect(dup.status === 'duplicate' && dup.existingName).toBe('Create entity (existing)');
    const rep = plan.items[2];
    expect(rep.status === 'repeat' && rep.ofIndex).toBe(1);
    const err = plan.items[3];
    expect(err.name).toBe('broken');
    const created = plan.items[1];
    expect(created.status === 'create' && created.summary).toBe('Trace × Scenario › User story (source), Entity (target)');
  });
  it('treats the same signature with a different name as a duplicate, and the same name with a different signature as new', () => {
    const md =
      HEADER +
      block('name: "Create entity (existing)"\nmove: Create\nobjects:\n  - object: Scenario\nquestions:\n  - question: "Did external factors play a role?"\n    answer: No');
    const plan = planActionImport(md, VOCAB);
    expect(plan.items[0].status).toBe('create');
  });
  it('flags a missing or unsupported schema_version and a file without blocks', () => {
    expect(planActionImport(block(CREATE_ENTITY), VOCAB).fileErrors[0]).toMatch(/Missing `schema_version: 2`/);
    expect(planActionImport('schema_version: 1\n' + block(CREATE_ENTITY), VOCAB).fileErrors[0]).toMatch(/Unsupported schema_version “1”/);
    expect(planActionImport('schema_version: 2\nnothing here', VOCAB).fileErrors).toEqual(['No ```action blocks found.']);
    // a quoted version still counts
    expect(planActionImport('schema_version: "2"\n' + block(CREATE_ENTITY), VOCAB).fileErrors).toEqual([]);
  });
  describe('missing vocabulary is added, not refused', () => {
    const EXT_NO = 'questions:\n  - question: "Did external factors play a role?"\n    answer: No';

    it('plans to add a missing move, object, subclass and role and still creates the action', () => {
      const md =
        HEADER +
        block(`name: "Destroy widget"\nmove: Destroy\nobjects:\n  - object: Widget\n    role: owner\n  - object: Scenario\n    subclass: Epic\n${EXT_NO}`);
      const plan = planActionImport(md, VOCAB);
      expect(plan.fileErrors).toEqual([]);
      expect(plan.items[0].status).toBe('create');
      expect(plan.vocabAdds).toEqual({
        moves: ['Destroy'],
        objects: [
          { name: 'Widget', parent: null },
          { name: 'Epic', parent: 'Scenario' },
        ],
        roles: ['owner'],
      });
      const it0 = plan.items[0];
      expect(it0.status === 'create' && it0.summary).toBe('Destroy × Widget (owner), Scenario › Epic');
    });

    it('adds a missing parent together with its subclass', () => {
      const md = HEADER + block(`name: x\nmove: Create\nobjects:\n  - object: Artifact\n    subclass: Diagram\n${EXT_NO}`);
      const plan = planActionImport(md, VOCAB);
      expect(plan.items[0].status).toBe('create');
      expect(plan.vocabAdds.objects).toEqual([
        { name: 'Artifact', parent: null },
        { name: 'Diagram', parent: 'Artifact' },
      ]);
    });

    it('dedupes additions across blocks case/whitespace-insensitively, keeping the first spelling', () => {
      const md =
        HEADER +
        block(`name: a\nmove: Destroy\nobjects:\n  - object: Widget\n    role: owner\n${EXT_NO}`) +
        block(`name: b\nmove: " destroy "\nobjects:\n  - object: "WIDGET"\n    role: Owner\n  - object: Entity\n${EXT_NO}`);
      const plan = planActionImport(md, VOCAB);
      expect(plan.items.map((i) => i.status)).toEqual(['create', 'create']);
      expect(plan.vocabAdds).toEqual({ moves: ['Destroy'], objects: [{ name: 'Widget', parent: null }], roles: ['owner'] });
    });

    it('does not add vocabulary for a block that still fails for another reason', () => {
      const md = HEADER + block('name: x\nmove: Destroy\nobjects:\n  - object: Widget\nquestions:\n  - question: Why?\n    answer: x');
      const plan = planActionImport(md, VOCAB);
      expect(plan.items[0].status).toBe('error');
      expect(plan.vocabAdds).toEqual({ moves: [], objects: [], roles: [] });
    });

    it('still refuses a subclass written as the object, and an unknown question', () => {
      const md = HEADER + block(`name: x\nmove: Create\nobjects:\n  - object: "User story"\n${EXT_NO}`);
      const plan = planActionImport(md, VOCAB);
      expect(plan.items[0].status).toBe('error');
      expect(plan.items[0].status === 'error' && plan.items[0].errors[0]).toMatch(/is a subclass of “Scenario”/);
      expect(plan.vocabAdds.objects).toEqual([]);
    });

    it('a new move gets minObjects 1 so a one-object action passes', () => {
      const md = HEADER + block(`name: x\nmove: Inspect\nobjects:\n  - object: Entity\n${EXT_NO}`);
      const plan = planActionImport(md, VOCAB);
      expect(plan.items[0].status).toBe('create');
      expect(plan.vocabAdds.moves).toEqual(['Inspect']);
    });
  });

  it('labels a block that fails to parse by its name: line when it has one', () => {
    const plan = planActionImport(HEADER + block('name: "Half written\nmove: Create'), VOCAB);
    expect(plan.items[0].status).toBe('error');
    expect(plan.items[0].name).toBe('Half written');
  });
});
