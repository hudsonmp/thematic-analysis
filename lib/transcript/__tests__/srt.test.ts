import { describe, it, expect } from 'vitest';
import { parseSrt, type Segment } from '@/lib/transcript/srt';

describe('parseSrt', () => {
  it('1. parses single-track (651-style) blocks: null speaker, trimmed text, ms timecodes', () => {
    const input =
      '1\n00:00:00,000 --> 00:00:07,180\n just want to check\n\n' +
      '2\n00:00:07,180 --> 00:00:12,140\n scrambled okay\n';
    const segs = parseSrt(input);
    expect(segs).toHaveLength(2);

    expect(segs[0]).toEqual<Segment>({
      idx: 1,
      startMs: 0,
      endMs: 7180,
      speaker: null,
      text: 'just want to check',
    });
    expect(segs[1]).toEqual<Segment>({
      idx: 2,
      startMs: 7180,
      endMs: 12140,
      speaker: null,
      text: 'scrambled okay',
    });
  });

  it('2. parses multi-track blocks: splits Speaker: text, preserves input order even when overlapping', () => {
    const input =
      '1\n00:00:24,000 --> 00:00:29,500\nParticipant: epiphany probably\n\n' +
      '2\n00:00:25,100 --> 00:00:27,000\nFacilitator: mm hm\n';
    const segs = parseSrt(input);
    expect(segs).toHaveLength(2);

    expect(segs[0].speaker).toBe('Participant');
    expect(segs[0].text).toBe('epiphany probably');
    expect(segs[0].startMs).toBe(24000);

    // Order preserved: block 2 stays second even though it overlaps block 1.
    expect(segs[1].speaker).toBe('Facilitator');
    expect(segs[1].text).toBe('mm hm');
    expect(segs[1].startMs).toBe(25100);
    expect(segs[1].endMs).toBe(27000);
  });

  it('3. auto mode does NOT split a single-track file with a stray colon line (e.g. "the ratio is 3: 1")', () => {
    // A realistic single-track file: most lines have no colon, ONE has "3: 1".
    // The per-file majority vote keeps it single-track, so the stray colon line
    // is not mis-split.
    const input =
      '1\n00:00:00,000 --> 00:00:05,000\njust want to check of course\n\n' +
      '2\n00:00:05,000 --> 00:00:10,000\nscrambled okay and i am gonna think aloud\n\n' +
      '3\n00:00:10,000 --> 00:00:15,000\nthe ratio is 3: 1 in this problem\n\n' +
      '4\n00:00:15,000 --> 00:00:20,000\nokay cool all right warm up\n';
    const segs = parseSrt(input);
    expect(segs).toHaveLength(4);
    for (const s of segs) expect(s.speaker).toBeNull();
    expect(segs[2].text).toBe('the ratio is 3: 1 in this problem');
  });

  it('4. tolerates CRLF and a final block with no trailing blank line', () => {
    const input =
      '1\r\n00:00:00,000 --> 00:00:02,000\r\nfirst line\r\n\r\n' +
      '2\r\n00:00:02,000 --> 00:00:04,000\r\nsecond line';
    const segs = parseSrt(input);
    expect(segs).toHaveLength(2);
    expect(segs[0].text).toBe('first line');
    expect(segs[1]).toEqual<Segment>({
      idx: 2,
      startMs: 2000,
      endMs: 4000,
      speaker: null,
      text: 'second line',
    });
  });

  it('5. converts timecode 01:02:03,456 to 3723456 ms', () => {
    const input = '1\n01:02:03,456 --> 01:02:04,000\nhello\n';
    const segs = parseSrt(input);
    expect(segs).toHaveLength(1);
    expect(segs[0].startMs).toBe(3723456);
    expect(segs[0].endMs).toBe(3724000);
  });

  it('joins multiple text lines in a block with a space', () => {
    const input = '1\n00:00:00,000 --> 00:00:05,000\nline one\nline two\n';
    const segs = parseSrt(input);
    expect(segs).toHaveLength(1);
    expect(segs[0].text).toBe('line one line two');
  });

  it('tolerates a BOM and blank lines between blocks', () => {
    const input =
      '﻿1\n00:00:00,000 --> 00:00:01,000\nalpha\n\n\n\n' +
      '2\n00:00:01,000 --> 00:00:02,000\nbeta\n';
    const segs = parseSrt(input);
    expect(segs).toHaveLength(2);
    expect(segs[0].idx).toBe(1);
    expect(segs[0].text).toBe('alpha');
    expect(segs[1].text).toBe('beta');
  });

  it("force 'single' keeps a colon-prefixed line whole", () => {
    const input = '1\n00:00:00,000 --> 00:00:05,000\nParticipant: epiphany probably\n';
    const segs = parseSrt(input, 'single');
    expect(segs[0].speaker).toBeNull();
    expect(segs[0].text).toBe('Participant: epiphany probably');
  });

  it("force 'multi' splits even a minority of colon lines", () => {
    const input =
      '1\n00:00:00,000 --> 00:00:05,000\nParticipant: hi\n\n' +
      '2\n00:00:05,000 --> 00:00:10,000\nno colon here\n';
    const segs = parseSrt(input, 'multi');
    expect(segs[0].speaker).toBe('Participant');
    expect(segs[0].text).toBe('hi');
    // A block without a prefix falls back to null speaker, full text.
    expect(segs[1].speaker).toBeNull();
    expect(segs[1].text).toBe('no colon here');
  });
});
