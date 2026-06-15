# TA Session Player — Review/Coding Modes + Margin Comments (2026-06-15)

> Round 2 of the session-player overhaul (follows `2026-06-12-ta-session-overhaul.md`).
> Branch `feat/live-coobservation` (PR #3). Autonomous execution authorized by Hudson
> ("Do not ask questions, do it all", "i will be gone") — this doc is the DECISION
> RECORD, not an approval gate. Verify per batch: `npx tsc --noEmit`, `npm run lint`,
> `npx vitest run`. Agents must NOT `npm run build`/`next start` (shares `.next` with the
> live `:3200` dev server). Read `node_modules/next/dist/docs/` before Next API changes.

All changes land in `components/sessions/SessionPlayer.tsx` plus two new files
(`lib/transcript/fuzzy.ts`, `components/sessions/CodingPanel.tsx`) and a one-field
extension to `lib/transcript/selection.ts`. The live page is UNTOUCHED — every item below
refers to the "Flags on timeline" / transcript surface, which is the session player.

---

## Decisions (mapped to Hudson's message)

### Mode model — NEW
A `mode: 'review' | 'coding'` toggle in the header.
- **Review** (default): `grid lg:grid-cols-3`; video `lg:col-span-1`; transcript region
  `lg:col-span-2`. Inside the 2/3 region the transcript TEXT is constrained
  (`max-w-[40rem]`/`pr` reserve) leaving a right **comment margin**.
- **Coding**: `grid lg:grid-cols-3`; video `col-span-1`; `CodingPanel` `col-span-1`
  (middle); transcript `col-span-1` (right, no comment margin in this mode).

### R5/R7 — Transcript visual
- Drop the container `border`, the `divide-y` between turns, and each turn's `border-l-2`
  box. Flowing text only; speaker label inline; one `[mm:ss]` seek per turn.
- Taller: `h-[80vh]` (was `70vh`). Narrower text block (room for the margin).
- `style={{ scrollbarGutter: 'stable' }}` + right padding so the scrollbar never overlaps
  text (Image #2).
- Annotated/active cues keep a subtle TEXT/background tint (no border boxes).

### R6 — Edit mode continuity
Cleaned-tab edit mode renders the turn as ONE flowing paragraph of inline
`contentEditable` cue spans (borderless), matching read mode, committing per-cue on blur
(reuses `handleSegmentTextCommit`; cue boundaries preserved so timing/anchors survive).
Replaces the stacked `SegmentTextEditor` boxes. JUDGMENT CALL: contentEditable+React is a
known footgun; cues are keyed on persisted text (remount-on-external-change) and read via
`textContent` on blur to avoid mid-edit clobber.

### R8 — Layout 1/3 ‖ 2/3
Review mode: video 1/3, transcript 2/3 (see Mode model).

### R9/R11 — Margin comments (Google-Docs)
- DELETE the over-video callout (`relative` video wrapper popover) AND the "My
  annotations" rail (Image #4). The coding toolbar's Apply/Flag/comment-hint block also
  goes (code-applying moves to Coding mode).
- Right region = transcript text (narrow) + an absolutely-positioned **comment margin
  layer**. A comment card aligns to its anchor's vertical offset within the scroll
  container; colliding cards push DOWN (simple de-overlap, not full Docs layout).
- Select text (stays yellow via the existing `pending` synthetic highlight) → `⌘⌥M` opens
  a margin composer card at the selection, textarea auto-focused. Save →
  `handleCommentOnSelection` (creates a `quote` anchor + first comment), card becomes the
  thread. Clicking a yellow span opens/scrolls its card. JUDGMENT CALL: alignment is
  best-effort to anchor `offsetTop`; if measurement is unavailable the card falls to
  document-order in the margin.

### R10 — ⌘⇧J = important quote
While a margin card (composer or thread) is focused, `⌘⇧J` marks the card's anchor
annotation as `kind:'quote'` (important quote). For the composer (no anchor yet) it sets a
"flag as quote" intent so the created annotation is a quote (it already is — so `⌘⇧J` in
the composer additionally posts the draft if present, else just confirms quote intent).
Implement via a new `setAnnotationKind(annotationId,'quote')` server action (cb_ write).

### R4 — Flags highlight the transcript
Each MEANINGFUL observation (see R3) with a resolvable offset → the cue active at that
offset (`findActiveIndex(segments, offsetMs)`) → a synthetic `Highlight{kind:'flag',
color:<swatch>}` on that cue (whole-cue range). Merged into the per-segment highlight map.
`renderHighlightedText` paints `kind:'flag'` pieces with the swatch color (inline style),
non-clickable (or click → seek to the flag). Requires extending `Highlight` with an
optional `color?: string` and `splitIntoPieces` carrying it through (the renderer reads
the covering highlight's color).

### R1 — Collapse flags list
The "Flags on timeline" rail list becomes a `max-h` (~8 rows) `overflow-y-auto` container
so content below it (current-event box is ABOVE; code panel BELOW) stays reachable.

### R2 — Current-event box
ABOVE the "Flags on timeline" section: a small `max-h` scrollable box showing the CURRENT
auto-derived episode (last `sessionEpisodes` with `tStartMs <= currentMs`) + the next one
visible, scrollable to the rest. Needs a `currentMs` state updated (rounded to seconds) in
`handleTimeUpdate`. Replaces the full "Events" list (which collapses into this box).

### R3 — Drop empty "Note" flags
A shared predicate `isMeaningfulObservation(o) = !!o.flagLabel || !!o.body || o.isQuote`.
Bare notes / stale mis-translated events (no flag, no body, not a quote) are filtered from
`flagMarkers` (UI filter, non-destructive — the cb_observations rows are left intact).

### R12/R13 — Coding mode + fuzzy search (`CodingPanel.tsx` NEW)
Middle panel in coding mode. `lib/transcript/fuzzy.ts` = pure subsequence/score fuzzy
match (no RAG — Hudson's revised call). Panel: a search input → ranked code list (fuzzy
over `mnemonic` + `name`; definitions aren't client-side yet — noted limitation), shows the
current video time, lets you optionally keep a text selection, and on Enter (or click)
applies the highlighted code at the current time: anchored to the brushed selection if any,
else to the cue active at `currentMs` (whole-cue anchor). Reuses `addAnnotation`. Keyboard:
↑/↓ move the fuzzy result cursor, Enter applies.

---

## Execution batches (each: tsc + lint + vitest, then commit)

1. **Foundation/low-risk**: `selection.ts` `Highlight.color`; `fuzzy.ts`+test;
   SessionPlayer `isMeaningfulObservation` filter (R3), flags collapse (R1),
   `currentMs` + current-event box (R2), flag→text highlights (R4).
2. **Layout**: mode toggle + 3-col grids (R8/R12-layout); transcript visual cleanup
   (R5/R7) + narrow text block.
3. **Comments**: remove over-video callout + My-annotations rail + old coding toolbar
   (R11); build the margin comment layer + `⌘⌥M` composer + `⌘⇧J` quote (R9/R10);
   `setAnnotationKind` action.
4. **Coding mode**: `CodingPanel.tsx` + wiring (R12/R13).
5. **Edit mode**: continuous inline-editable cues (R6).

## Acceptance
- Header toggles Review/Coding. Review = video 1/3 + transcript 2/3 + comment margin;
  Coding = video 1/3 + coding panel 1/3 + transcript 1/3.
- Transcript: no box/cells, taller, narrower text, scrollbar not over text; edit mode flows.
- Select→yellow; `⌘⌥M` → margin comment card (focused); `⌘⇧J` in card → important quote;
  clicking a yellow span opens its card. No My-annotations rail, no over-video popup.
- Flags: empty "Note" rows gone; list scrolls at ~8; current-event box above it; each flag
  tints the cue at its timestamp.
- Coding mode: fuzzy code search applies a code at the current time (+ optional selection).
- `npx tsc --noEmit`, `npm run lint`, `npx vitest run` green.
