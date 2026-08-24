import { describe, it, expect } from 'vitest';
import {
  threadIdsInDoc,
  threadExcerpt,
  codeIdsInDoc,
  mentionedSlugs,
  docHasContent,
  EMPTY_DOC,
  type PmNode,
} from '../threads';

const doc: PmNode = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Experiment goals: ', marks: [{ type: 'bold' }] },
        { type: 'text', text: 'I wonder ', marks: [{ type: 'comment', attrs: { threadId: 't1' } }] },
        {
          type: 'text',
          text: 'what would happen',
          marks: [{ type: 'bold' }, { type: 'comment', attrs: { threadId: 't1' } }],
        },
        { type: 'text', text: ' plain ' },
        { type: 'codeMention', attrs: { id: 'c9', label: 'vague-concept' } },
        { type: 'text', text: ' again', marks: [{ type: 'comment', attrs: { threadId: 't2' } }] },
        { type: 'text', text: ' dup', marks: [{ type: 'comment', attrs: { threadId: 't1' } }] },
      ],
    },
  ],
};

describe('threadIdsInDoc', () => {
  it('returns thread ids in document order, de-duplicated', () => {
    expect(threadIdsInDoc(doc)).toEqual(['t1', 't2']);
  });
  it('is empty for the empty doc / null', () => {
    expect(threadIdsInDoc(EMPTY_DOC)).toEqual([]);
    expect(threadIdsInDoc(null)).toEqual([]);
  });
});

describe('threadExcerpt', () => {
  it('concatenates every span carrying the thread, across other marks', () => {
    expect(threadExcerpt(doc, 't1')).toBe('I wonder what would happen dup');
    expect(threadExcerpt(doc, 'missing')).toBe('');
  });
});

describe('codeIdsInDoc', () => {
  it('collects inline mention node ids', () => {
    expect(codeIdsInDoc(doc)).toEqual(['c9']);
  });
});

describe('mentionedSlugs', () => {
  it('finds @slug tokens and strips trailing punctuation', () => {
    expect(mentionedSlugs('Currently coded as @instantiated-vague-concept.')).toEqual([
      'instantiated-vague-concept',
    ]);
    expect(mentionedSlugs('@a and (@b), then @a again')).toEqual(['a', 'b']);
  });
  it('ignores emails and bare @', () => {
    expect(mentionedSlugs('mail me a@b.c @ now')).toEqual([]);
  });
});

describe('docHasContent', () => {
  it('is false for the empty doc and whitespace-only text', () => {
    expect(docHasContent(EMPTY_DOC)).toBe(false);
    expect(
      docHasContent({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '  ' }] }] }),
    ).toBe(false);
  });
  it('is true when there is text or a mention', () => {
    expect(docHasContent(doc)).toBe(true);
    expect(
      docHasContent({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'codeMention', attrs: { id: 'x' } }] }],
      }),
    ).toBe(true);
  });
});
