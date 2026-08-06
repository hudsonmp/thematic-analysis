# IRR — design decisions

> **CURRENT PROCEDURE (2026-08-06, per the Aug 4 Zihan/David/Moonwara meeting;
> precedent map: `~/Desktop/Readings - Claude/08-04-2026-irr-reconciliation-precedent.html`).**
> Extends — does not replace — the 07-31 sentence-level method below.
>
> - **κ is POOLED over a selected session set**, not per-session:
>   `poolSentenceGrids` (`lib/irr/sentencegrid.ts`) sums each code's per-session
>   2×2 contingency tables and computes κ once from the summed table — "compute
>   IRR on those three [sessions]" (plan A). This is deliberately NOT a mean of
>   per-session κs: cell-summing weights sessions by their unit counts, and a
>   code with no variance in any single session can still be estimated pooled.
>   The ±1 relaxed tolerance is applied inside each session before summing, so
>   it never credits agreement across a session boundary.
> - **Preregistered target: mean strict per-code κ ≥ 0.70** (`lib/irr/target.ts`),
>   per the meeting ("aiming for a 0.7") and McDonald et al. 2019 §5.3.5 (state
>   a target agreement value with justification BEFORE the analysis). Decision
>   rule: reached → codebook certified, solo-code the remainder (the
>   calibrate → IRR-on-subset → split sequence of Kazemitabaar et al. 2023);
>   not reached → revise the codebook, run another independent round (David's
>   constraint: choosing IRR obligates acting on a bad κ). Do not lower the
>   target post hoc. This supersedes §7's .80/.667 per-code gate for the
>   POOLED decision; §7 remains sensible per-code triage guidance.
> - **Pool discipline.** A session enters the pool only if BOTH coders have code
>   annotations on its modal version (otherwise one coder's silence would score
>   as disagreement); exclusions are disclosed in the report note, never
>   silently absorbed. Which pooled sessions were CALIBRATION (coded with
>   reconciliation meetings — 548, 083) vs independent is a methods disclosure
>   the UI collects: excluding them is plan A (the Zihan-endorsed live plan);
>   including them is the pooled variant B (Zihan: legitimate because syncing
>   polishes the codebook without forcing code-level agreement — cite it, the
>   open citation gap in the precedent guide notwithstanding).
> - Code: `lib/irr/sentencegrid.ts` (`poolSentenceGrids` + relaxed cells),
>   `lib/irr/target.ts`, `app/actions/irr.ts` (multi-session `computeIrr`),
>   `components/irr/IrrReport.tsx` (pool picker, calib marking, target panel,
>   decision banner).

> **CURRENT METHOD (2026-07-31, David Smith Tuesday sync) — supersedes §§1–8 below.**
>
> The three-statistic apparatus (EasyDIAg, time-grid, char-sentence-grid) is
> retired. David's guidance: report **sentence-level agreement** + a **code
> co-occurrence heat map**, and treat IRR as a *diagnostic for systematic
> disagreement*, not a headline number.
>
> - **Coding unit = the SEGMENT.** The transcript is first passed through an LLM
>   sentence-restoration pass (`scripts/restore-sentences.mjs`) that adds only
>   punctuation/casing and splits into sentences — verified word-for-word against
>   the source (any deviation falls back to the raw cue), producing a
>   `kind='restored'` version with **one sentence per segment**. Coders highlight
>   whole segments (enforced in `SessionPlayer`), so the unit is the sentence and
>   boundary jitter cannot arise. Rationale for the sentence as the verbal-protocol
>   unit: Chi 1997; Ericsson & Simon 1993.
> - **Agreement: strict per-unit Cohen's κ, plus overlap-relaxed κ** (±1 adjacent
>   unit counts as agreement — David: "if someone marks one sentence and someone
>   the next, that is agreement"). Relaxed is the unitizing-tolerance read
>   (Krippendorff u-α 2015; Mathet γ 2015); strict is the conservative one. Both on
>   a-priori AND emergent codes.
> - **Code × code co-occurrence heat map** (`lib/irr/cooccurrence.ts`): φ
>   correlation of each code pair's per-unit presence, pooled across coders,
>   diagonal = 1. Highly correlated + weak agreement ⇒ **merge candidate** (David:
>   "if two codes are highly correlated and they have bad agreement, that's an
>   indication they need to be merged"). A code-subset selector restricts the table
>   and the map.
> - Code: `lib/irr/sentencegrid.ts` (unit-agnostic κ, reused for segment units),
>   `lib/irr/cooccurrence.ts`, `app/actions/irr.ts`, `components/irr/IrrReport.tsx`.
>
> The historical record below documents why the earlier time/event methods were
> tried and what the 548 boundary-jitter diagnosis found — kept because it is the
> evidence that motivated moving to a shared sentence unit.

---

## Historical: IRR (EasyDIAg) — design decisions

The `/reliability/irr` feature computes inter-rater reliability directly from the
live code annotations, so the two coders can double-code a subset and certify the
rest for single-coding. This document records every design decision and its
grounding in the literature. The feature is **read-only** and entirely separate
from the coding surface (`components/sessions/SessionPlayer.tsx` is untouched).

Code: `lib/irr/easydiag.ts` (pure algorithm + tests), `app/actions/irr.ts`
(read-only data load), `components/irr/IrrReport.tsx` + `app/(protected)/reliability/irr/page.tsx` (UI).

## 1. The unit of agreement is a TIME interval, not a transcript segment

Coding is open-span: coders highlight arbitrary character/time ranges. Two
coders never select identical spans, so agreement is undefined until the codings
are reconciled onto a shared frame. Two families exist (Bakeman, Quera & Gnisci
2009, *Behav. Res. Methods*, doi:10.3758/brm.41.1.137): a **time-based grid**
(slice into fixed units, agree per unit) and an **event-based match** (pair the
coders' events, then score).

We use the **event-based** family, in the **time domain**, for a data-specific
reason. The transcript has a three-track structure — participant mic, interviewer
mic, and an un-named "Speaker" room-audio track that duplicates both. In the one
double-coded session (pid 548), **41% of code anchors sit on the echo track**.
Snapping to segment *ordinals* would record phantom disagreement whenever two
coders anchored the same spoken moment to different tracks. Working in time
collapses the duplicate tracks automatically: a mic-track code and an echo-track
code for the same moment overlap in time and therefore link. Each annotation's
interval is its stored `[t_start_ms, t_end_ms]` (the coded span's enclosing-segment
time extent), so no de-duplication of the transcript is required for the metric.

## 2. Event linking by proportional overlap, not a fixed ±window (EasyDIAg)

A fixed onset tolerance ("±5 s") is scale-dependent: 5 s is loose for a
one-second exclamation code and strict for a thirty-second reasoning code, and
our scheme spans both. We therefore use Holle & Rein's EasyDIAg (2014,
*Behav. Res. Methods*, doi:10.3758/s13428-014-0506-7), whose linking criterion is
**scale-invariant proportional overlap**:

- overlap(a,b) = max(0, min(a.off,b.off) − max(a.on,b.on))
- link iff overlap / **max(dur(a), dur(b))** ≥ threshold (denominator is the
  *longer* annotation — the ELAN/EasyDIAg definition, confirmed from ELAN's
  implementation manual — not intersection-over-union).
- **Default threshold 0.60** (Holle & Rein's recommendation), adjustable in the
  UI so sensitivity can be inspected.
- One-to-one matching is resolved greedily by descending overlap ratio; this is
  a deterministic approximation of EasyDIAg's global assignment and agrees on all
  non-pathological cases. Known EasyDIAg limitation (documented, not fixed here):
  one long segment vs. several short ones may fail to link.

## 3. Chance correction by iterative proportional fitting, not plain Cohen's κ

After linking, a confusion table is built over the codes plus a **"Void"** row and
column for events one coder marked and the other did not. The **Void×Void cell is
a structural zero** — an event marked by *neither* coder cannot exist. Standard
Cohen's expected agreement (product of marginals) is invalid in the presence of a
structural zero, so EasyDIAg estimates the expected table by **iterative
proportional fitting** (Deming & Stephan 1940), holding the structural-zero cell
at 0. κ = (pₒ − pₑ)/(1 − pₑ) from that fitted table. This is the single detail a
naive re-implementation gets wrong, and the reason EasyDIAg exists.

We report three headline numbers, which measure different things (Bakeman et al.
recommend reporting more than one):
- **Segmentation agreement** — share of events that found a partner (agreement on
  *where* events are, ignoring code).
- **Categorization agreement** — share of linked pairs whose codes match
  (agreement on *which* code, given both saw an event).
- **Overall κ** — the joint segmentation+categorization IPF-κ over the full table.

## 4. Per-code reliability, never a single pooled number

Most codes are rare (in 548, top code = 19 instances, long tail at 1–5). A single
pooled κ averages reliable common codes with paradox-afflicted rare ones. So we
compute reliability **per code** (collapsing the axis to {k, ¬k, Void} and
re-running the IPF-κ), and report each κ beside:

- **Prevalence** and **raw agreement**, so a low κ next to high agreement and low
  prevalence is legible as the kappa paradox (Feinstein & Cicchetti 1990,
  doi:10.1016/0895-4356(90)90158-L), not real disagreement — the UI flags these
  in amber.
- **Gwet's AC1** (doi:10.1348/000711006X126600), a paradox-robust coefficient, as
  the number to trust when κ is depressed by base rate.

## 5. Instance-count guard

Reliability from few instances is untrustworthy; the governing quantity is
instances-per-code, not sessions (Hallgren 2012, doi:10.20982/tqmp.08.1.p023).
Codes below a min-instance floor (default 10, adjustable) are flagged `low-n` and
greyed — **not certifiable from the sample regardless of the point estimate**.

## 6. A-priori vs emergent are partitioned

IRR is the right warrant for construct-measuring (a-priori) codes; for emergent
codes coined during analysis it is at best a drift diagnostic, not a reliability
claim (McDonald, Schoenebeck & Forte 2019, CSCW, doi:10.1145/3359174). The table
tags each code's origin and can hide emergent codes; the underpowered warning
counts a-priori codes specifically.

## 7. Threshold guidance (shown, not enforced)

The Landis & Koch bands (doi:10.2307/2529310) are displayed as a reference but the
cutoffs are, per the authors, arbitrary. For the consequential decision of
licensing solo coding, adopt the stricter posture (McHugh 2012,
doi:10.11613/BM.2012.031): **κ ≥ .80 licenses solo-coding a code; .667–.80 keep
double-coding; < .667 revise the code's definition.** The tool computes; the gate
is the researcher's, applied per code.

## 8. Matched-effort window, and what the first run actually showed

A coder who stops early leaves the tail uncoded — that is not disagreement, so
`computeIrr` accepts an optional onset window `[windowStartMs, windowEndMs]`. In
session 548 the two coders are density-matched only through ~40 min (73 vs 65
events); from 40–60 min Moonwaraa tapered off (5 events to 39), so the whole-
session estimate is contaminated by ~35 one-sided events in the tail.

Restricting to the matched window barely moves the numbers, and that is itself
the finding:

| window | segmentation | categorization\|linked | overall κ |
|--------|--------------|------------------------|-----------|
| full (0–89 min) | 24% | 52% | 0.065 |
| 0–40 min | 29% | 56% | 0.088 |
| 0–25 min | 33% | 59% | 0.106 |

The tail is a minor deflator; the dominant signal is genuine — even where both
coded densely, the coders co-locate events only ~30% of the time and, given
co-location, agree on the code ~55% of the time. NO code clears κ ≥ .6 while
adequately sampled in any window.

**Which statistic is honest here** — neither the pooled κ nor the mean AC1:
- Overall κ (~0.06) is *deflated* by rarity + the segmentation gap.
- Mean per-code AC1 (~0.97) is *inflated*: for rare codes AC1's chance term is
  dominated by agreement-on-ABSENCE (both coders correctly NOT applying a rare
  code across many linked pairs), which is nearly free. AC1 is the right paradox
  guard for a *single prevalent* code, but a poor *summary* over a rare-heavy
  event-linked scheme.
- The faithful characterization is the two-number decomposition Bakeman et al.
  recommend: **segmentation agreement** (do they mark the same moment?) and
  **categorization | linked** (given they do, same code?). Both are reported as
  headline stats. On 548 they are ~30% and ~55% — i.e., not yet reliable enough
  to license single-coding, and the codebook/coding needs reconciliation first.

## What this feature deliberately does NOT do

- It does not write anything, and does not touch the coding UI.
- It does not de-duplicate the "Speaker" echo track (the metric absorbs it); the
  track cleanup remains a separate, optional ingest task.
- It does not implement γ (Mathet et al. 2015) or Krippendorff's u-α; EasyDIAg was
  the chosen method. Those remain candidates if boundary-level agreement (not just
  overlap-linking) is later required.

## 9. Sentence-grid κ (Method 3) — the recommended primary

The lit review (`~/Desktop/Readings - Claude/07-30-2026-irr-segmentation-methods.pdf`)
concluded that the fix for the boundary-jitter problem is a **shared unit**, and
recommended the **sentence** (Chi 1997: the utterance/sentence is the canonical grain
for verbal-protocol analysis; sentences are auto-segmentable and match the code
granularity). This is now a third IRR method beside EasyDIAg (Method 2) and time-grid
(Method 4).

**Enforcement (coding UI).** `lib/transcript/selection.ts` gains `sentenceSpans` (a
punctuation splitter, ASR-tolerant: a cue with no terminal `.!?` is one sentence) and
`snapToSentences`, which expands a selection OUTWARD to whole-sentence boundaries.
`SessionPlayer.handleTranscriptMouseUp` snaps the start edge within the first cue and
the end edge within the last cue (the only partially-covered cues) before the popup
opens, gated by an `enforceSentences` prop. Enforcement is ON for every session EXCEPT
the two already coded sub-sentence (548, 083), whose existing coding must stay
internally consistent.

**Why text, not time.** Sentence agreement is which-sentence, not when — so it needs
no timestamps. This matters because `cb_segments.words` is empty and the cleaned tracks
have multi-minute mega-segments that cannot be time-split. `lib/irr/sentencegrid.ts`
enumerates sentence units on the fly (`enumerateSentences`) and maps each annotation to
the units it covers (`sentencesForRange`); no DB re-segmentation.

**Two coefficients** (per the reporting decision):
- **Strict** (primary): per (sentence × code) presence, standard Cohen's κ. Justified
  as ordinary per-unit content-analysis agreement on a fixed recording/coding unit
  (Krippendorff 2004; Lombard et al. 2002).
- **Overlap-relaxed** (secondary): a strict disagreement on sentence S is upgraded to
  agreement iff the other coder applied the same code within ±1 sentence — a unitizing
  tolerance formalized by Krippendorff's unitizing α (Krippendorff et al. 2015) and the
  γ coefficient (Mathet et al. 2015), mirroring relaxed/overlap span-matching in NLP
  annotation. It only turns disagreements into agreements (never the reverse), so it
  inflates κ and is a sensitivity check, not the headline.

**Method 3 vs 4 reporting.** Sentence-grid κ is the **primary**; time-grid κ (1–2 s)
is the **robustness cross-check** (Bakeman et al. 2009 recommend reporting both a
unit-based and a time-based coefficient). Decision rule on the next double-coded,
sentence-enforced session: convergence → sentences win on interpretability;
sentence-κ ≫ time-κ → sentences are absorbing boundary variance (expected);
time-κ > sentence-κ → the splitter is mis-segmenting ideas and needs tuning. EasyDIAg
(Method 2) stays as the reported occurrence-level figure only.
