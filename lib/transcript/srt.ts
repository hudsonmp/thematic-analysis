// Pure SubRip (.srt) parser. No I/O, no Node APIs — safe to unit-test and to
// import from anywhere (server or client). All transcript ingestion routes
// through `parseSrt`.

export type Segment = {
  idx: number;
  startMs: number;
  endMs: number;
  speaker: string | null;
  text: string;
};

export type SrtMode = 'single' | 'multi' | 'auto';

// A short prefix (1–40 chars, no colon/newline) then a colon and at least one
// space: `Speaker: text`. The trailing `\s` (not `\s*`) is deliberate — it is
// what distinguishes a speaker label `Participant: hi` from an inline ratio
// like `3:1`. A line like `the ratio is 3: 1` DOES match this pattern, which is
// why speaker detection is a per-FILE majority vote (see `parseSrt`), not a
// per-line decision: one stray colon can't flip an otherwise single-track file.
const SPEAKER_RE = /^([^:\n]{1,40}):\s(.*)$/;

const TIMECODE_RE = /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/;

/** A parsed block before speaker resolution (which is a per-file decision). */
type RawBlock = {
  idx: number;
  startMs: number;
  endMs: number;
  text: string;
};

function timecodeToMs(tc: string): number | null {
  const m = TIMECODE_RE.exec(tc);
  if (!m) return null;
  const [, hh, mm, ss, mmm] = m;
  return (
    Number(hh) * 3_600_000 +
    Number(mm) * 60_000 +
    Number(ss) * 1_000 +
    Number(mmm)
  );
}

function parseTimecodeLine(line: string): { startMs: number; endMs: number } | null {
  const parts = line.split('-->');
  if (parts.length !== 2) return null;
  const startMs = timecodeToMs(parts[0]);
  const endMs = timecodeToMs(parts[1]);
  if (startMs === null || endMs === null) return null;
  return { startMs, endMs };
}

/** Apply a resolved (file-level) speaker decision to one block's text. */
function resolveSpeaker(text: string, multi: boolean): { speaker: string | null; text: string } {
  if (multi) {
    const m = SPEAKER_RE.exec(text);
    if (m) return { speaker: m[1].trim(), text: m[2].trim() };
  }
  return { speaker: null, text };
}

/**
 * Parse a SubRip transcript into ordered segments.
 *
 * Tolerances: CRLF, a leading BOM, leading spaces on text lines, blank lines
 * between blocks, and a final block with no trailing blank line. Multiple text
 * lines in a block are joined with a single space. Blocks are NOT re-sorted —
 * input order is preserved (multi-track files have overlapping time ranges).
 *
 * Speaker handling is decided per FILE, not per line. In `'auto'`, if a MAJORITY
 * of blocks look like `Speaker: text` the file is multi-track; otherwise it is
 * single-track (speaker null). `'single'` / `'multi'` force the decision.
 */
export function parseSrt(input: string, mode: SrtMode = 'auto'): Segment[] {
  // Strip BOM, normalize line endings.
  const normalized = input.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Split into blocks on one-or-more blank lines (tolerates extra blank lines).
  const rawBlocks: RawBlock[] = [];
  for (const chunk of normalized.split(/\n[ \t]*\n+/)) {
    const lines = chunk.split('\n');
    // Drop leading empty lines (e.g. from a leading blank line in the file).
    while (lines.length && lines[0].trim() === '') lines.shift();
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    if (lines.length < 2) continue;

    const idx = Number.parseInt(lines[0].trim(), 10);
    const tc = parseTimecodeLine(lines[1]);
    if (Number.isNaN(idx) || !tc) continue;

    const text = lines
      .slice(2)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .join(' ');

    rawBlocks.push({ idx, startMs: tc.startMs, endMs: tc.endMs, text });
  }

  // Resolve the file-level speaker decision.
  let multi: boolean;
  if (mode === 'single') {
    multi = false;
  } else if (mode === 'multi') {
    multi = true;
  } else {
    const labeled = rawBlocks.filter((b) => SPEAKER_RE.test(b.text)).length;
    multi = rawBlocks.length > 0 && labeled * 2 > rawBlocks.length;
  }

  return rawBlocks.map((b) => {
    const { speaker, text } = resolveSpeaker(b.text, multi);
    return { idx: b.idx, startMs: b.startMs, endMs: b.endMs, speaker, text };
  });
}
