import { describe, expect, it } from 'vitest';
import { buildMergePrefill, unionExemplars, type MergeSource } from '@/lib/codebook/merge';

type Ex = { text: string; source_pid?: string };

describe('unionExemplars', () => {
  it('dedupes by exact trimmed text — first occurrence wins and keeps its extras', () => {
    const survivor: Ex[] = [{ text: 'she restates the prompt', source_pid: 'P01' }];
    const absorbed: Ex[] = [
      { text: '  she restates the prompt  ', source_pid: 'P07' }, // dupe (trim-equal)
      { text: 'asks the TA to confirm', source_pid: 'P03' },
    ];
    expect(unionExemplars([survivor, absorbed])).toEqual([
      { text: 'she restates the prompt', source_pid: 'P01' }, // P01 kept, P07 dropped
      { text: 'asks the TA to confirm', source_pid: 'P03' },
    ]);
  });

  it('preserves order: lists in the order given, each list in its own order', () => {
    const out = unionExemplars<Ex>([
      [{ text: 'a' }, { text: 'b' }],
      [{ text: 'c' }, { text: 'd' }],
      [{ text: 'e' }],
    ]);
    expect(out.map((e) => e.text)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('dedupes WITHIN a single list too', () => {
    const out = unionExemplars<Ex>([[{ text: 'x' }, { text: 'x ' }, { text: 'y' }]]);
    expect(out.map((e) => e.text)).toEqual(['x', 'y']);
  });

  it('drops empty/whitespace-only texts and handles empty input', () => {
    expect(unionExemplars<Ex>([[{ text: '' }, { text: '   ' }]])).toEqual([]);
    expect(unionExemplars<Ex>([])).toEqual([]);
    expect(unionExemplars<Ex>([[], []])).toEqual([]);
  });
});

describe('buildMergePrefill', () => {
  const survivor: MergeSource = {
    current: {
      definition: 'Karlsson (2023) framing.\n==\nApply when the student self-corrects.',
      include_if: ['self-correction is spoken aloud'],
      exclude_if: ['the TA prompted the correction'],
      exemplars: [{ text: 'wait, that loop is off by one', source_pid: 'P02' }],
      disconfirming_pattern: 'the fix is copy-pasted from the assistant',
    },
  };
  const absorbedA: MergeSource = {
    current: {
      definition: 'A near-duplicate == Apply on silent self-fixes.',
      include_if: ['absorbed clause that must NOT surface'],
      exclude_if: ['absorbed exclusion that must NOT surface'],
      exemplars: [
        { text: 'wait, that loop is off by one', source_pid: 'P09' }, // dupe of survivor's
        { text: 'rewrites the guard without being asked' },
      ],
      disconfirming_pattern: 'absorbed counter-example that must NOT surface',
    },
  };
  const absorbedB: MergeSource = {
    current: {
      definition: 'plain',
      include_if: [],
      exclude_if: [],
      exemplars: [{ text: 'deletes the print statements herself' }],
      disconfirming_pattern: null,
    },
  };

  it('anatomy comes from the SURVIVOR only; exemplars are the union, survivor-first', () => {
    const p = buildMergePrefill(survivor, [absorbedA, absorbedB]);
    expect(p.literature).toBe('Karlsson (2023) framing.');
    expect(p.applied).toBe('Apply when the student self-corrects.');
    expect(p.includeIf).toEqual(['self-correction is spoken aloud']);
    expect(p.excludeIf).toEqual(['the TA prompted the correction']);
    expect(p.counterExample).toBe('the fix is copy-pasted from the assistant');
    expect(p.exemplars).toEqual([
      { text: 'wait, that loop is off by one', source_pid: 'P02' }, // survivor's copy wins
      { text: 'rewrites the guard without being asked' },
      { text: 'deletes the print statements herself' },
    ]);
  });

  it('a definition without a separator prefills applied only', () => {
    const p = buildMergePrefill(absorbedB, []);
    expect(p.literature).toBe('');
    expect(p.applied).toBe('plain');
  });

  it('handles empty absorbed lists (a 1-source prefill is just the survivor)', () => {
    const p = buildMergePrefill(survivor, []);
    expect(p.exemplars).toEqual([
      { text: 'wait, that loop is off by one', source_pid: 'P02' },
    ]);
    expect(p.applied).toBe('Apply when the student self-corrects.');
  });

  it('handles missing current versions (null/absent) without throwing', () => {
    const bare: MergeSource = { current: null };
    expect(buildMergePrefill(bare, [survivor])).toEqual({
      literature: '',
      applied: '',
      includeIf: [],
      excludeIf: [],
      counterExample: '',
      // The versionless survivor contributes nothing; absorbed exemplars still union in.
      exemplars: [{ text: 'wait, that loop is off by one', source_pid: 'P02' }],
    });
    expect(buildMergePrefill({}, [{}]).exemplars).toEqual([]);
  });

  it('coerces malformed jsonb columns defensively (non-arrays, junk rows)', () => {
    const mangled: MergeSource = {
      current: {
        definition: 'ok',
        include_if: 'not-an-array',
        exclude_if: [1, 'kept', null],
        exemplars: [{ text: 'kept' }, { no_text: true }, null, 'string-row'],
        disconfirming_pattern: null,
      },
    };
    const p = buildMergePrefill(mangled, []);
    expect(p.includeIf).toEqual([]);
    expect(p.excludeIf).toEqual(['kept']);
    expect(p.exemplars).toEqual([{ text: 'kept' }]);
  });
});
