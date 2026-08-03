import { describe, expect, it } from 'vitest';
import { parseNote } from '@/components/codebook/NoteText';

/** The notes round-trip contract the editor + reader share. The empty-label
 *  case is the regression: "1." with branches must STAY an item — demoting it
 *  to a paragraph orphans the branches and dissolves the fork on next edit. */
describe('parseNote', () => {
  it('parses numbered steps with lettered fork branches', () => {
    const b = parseNote('1. review\na. option one\nb. option two\n2. edit');
    expect(b).toEqual([
      {
        kind: 'list',
        items: [
          {
            n: '1',
            text: 'review',
            subs: [
              { n: 'a', text: 'option one' },
              { n: 'b', text: 'option two' },
            ],
          },
          { n: '2', text: 'edit', subs: [] },
        ],
      },
    ]);
  });

  it('a BARE "1." keeps its fork (empty-label step is still an item)', () => {
    const b = parseNote('1.\na. left branch\nb. right branch');
    expect(b).toEqual([
      {
        kind: 'list',
        items: [
          {
            n: '1',
            text: '',
            subs: [
              { n: 'a', text: 'left branch' },
              { n: 'b', text: 'right branch' },
            ],
          },
        ],
      },
    ]);
  });

  it('does NOT mistake decimals for items — "1.5 units" stays prose', () => {
    expect(parseNote('1.5 units of margin')).toEqual([
      { kind: 'p', text: '1.5 units of margin' },
    ]);
  });

  it('a lettered line with no list above stays a paragraph', () => {
    expect(parseNote('a. stray branch')).toEqual([{ kind: 'p', text: 'a. stray branch' }]);
  });

  it('blank line ends a list; the next numbered line starts a new one', () => {
    const b = parseNote('1. one\n\n1. two');
    expect(b).toHaveLength(2);
    expect(b[0].kind).toBe('list');
    expect(b[1].kind).toBe('list');
  });
});
