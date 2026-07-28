# IRR (EasyDIAg) — design decisions

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

## What this feature deliberately does NOT do

- It does not write anything, and does not touch the coding UI.
- It does not de-duplicate the "Speaker" echo track (the metric absorbs it); the
  track cleanup remains a separate, optional ingest task.
- It does not implement γ (Mathet et al. 2015) or Krippendorff's u-α; EasyDIAg was
  the chosen method. Those remain candidates if boundary-level agreement (not just
  overlap-linking) is later required.
