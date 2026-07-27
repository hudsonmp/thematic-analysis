/**
 * editBursts — coalesce a participant's edit telemetry into timeline SPANS.
 *
 * The study app autosaves on a debounce, so `study_events` holds one row per
 * settled keystroke run (~115 per session). Rendered individually those are
 * noise; what a coder needs to SEE is "the participant was typing here". Two
 * edits closer than `gapMs` belong to the same burst; a lone edit still gets
 * `minSpanMs` of visible width so it cannot vanish at timeline scale.
 *
 * Pure: ISO timestamps in, {startMs,endMs,count} out, all on the recording
 * clock (offset from `anchorMs`, pre-recording edits clamped to 0 — same rule
 * the flag markers use).
 */

export type EditBurst = { startMs: number; endMs: number; count: number };

export function coalesceEditBursts(
  timestamps: string[],
  anchorMs: number,
  gapMs = 10_000,
  minSpanMs = 1_500,
): EditBurst[] {
  const offsets = timestamps
    .map((t) => Date.parse(t))
    .filter((ms) => !Number.isNaN(ms))
    .map((ms) => Math.max(0, ms - anchorMs))
    .sort((a, b) => a - b);

  const bursts: EditBurst[] = [];
  for (const at of offsets) {
    const last = bursts[bursts.length - 1];
    if (last && at - last.endMs <= gapMs) {
      last.endMs = at;
      last.count++;
    } else {
      bursts.push({ startMs: at, endMs: at, count: 1 });
    }
  }
  for (const b of bursts) {
    if (b.endMs - b.startMs < minSpanMs) b.endMs = b.startMs + minSpanMs;
  }
  return bursts;
}
