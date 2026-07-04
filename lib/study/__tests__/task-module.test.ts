import { describe, expect, it } from 'vitest';
import { parseTaskAuthoring, taskModuleIdFrom } from '@/lib/study/task-module';

const AUTHORED = {
  modules: [
    { id: 'warm1', type: 'task_warmup', title: 'Warmup' },
    {
      id: '3g7lg4if',
      type: 'task',
      title: 'Rideshare Matching Platform',
      requirements: [{ id: 'r1', role: 'rider', want: 'an empty car', so: 'comfort' }],
      scenarios: [
        {
          id: 's0', title: 'Scenario I', facilitatorNote: '',
          clauses: [{ id: 'c1', type: 'Given', text: 'one vehicle', marker: 'new' }],
        },
      ],
    },
  ],
};

describe('taskModuleIdFrom', () => {
  it('finds the type:"task" module id', () => {
    expect(taskModuleIdFrom(AUTHORED as never)).toBe('3g7lg4if');
  });
  it.each([null, 'str', 42, [], { modules: 'x' }, { modules: [{ type: 'task' }] }])(
    'returns null for malformed authored_data %#',
    (bad) => expect(taskModuleIdFrom(bad as never)).toBeNull(),
  );
});

describe('parseTaskAuthoring', () => {
  it('extracts moduleId, title, requirements, scenarios', () => {
    const t = parseTaskAuthoring(AUTHORED as never);
    expect(t?.moduleId).toBe('3g7lg4if');
    expect(t?.requirements).toHaveLength(1);
    expect(t?.scenarios[0].clauses[0]).toMatchObject({ type: 'Given', marker: 'new' });
  });
  it('drops malformed clause/requirement entries instead of throwing', () => {
    const messy = {
      modules: [{
        id: 't', type: 'task', title: 'T',
        requirements: [null, { id: 'r', role: 'x', want: 'y', so: 'z' }, 'junk'],
        scenarios: [{ id: 's', title: 'S', facilitatorNote: '', clauses: [null, { id: 'c', type: 'Then', text: 'ok' }] }],
      }],
    };
    const t = parseTaskAuthoring(messy as never);
    expect(t?.requirements).toHaveLength(1);
    expect(t?.scenarios[0].clauses).toHaveLength(1);
  });
  it('returns null when there is no task module', () =>
    expect(parseTaskAuthoring({ modules: [{ id: 'w', type: 'task_warmup' }] } as never)).toBeNull());
});
