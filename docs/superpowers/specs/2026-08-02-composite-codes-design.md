# Combinatorial Codebook Specification (v2 — consolidated)

2026-08-02 · v2 authored by Hudson, supersedes the v1 "composite codes" draft in full.
Implementation notes (marked ⌘) record decisions the spec left open; everything else is the spec verbatim.

## Buckets and codes

There is a running list of modular buckets; buckets house codes. A bucket represents a general
action (e.g., Review). A bucket is fulfilled when at least one of its member codes is assigned;
multiple may be selected, one is required. Some codes within a bucket may be marked `mandatory`
(infrequent). Buckets carry a caption/short description with the same push/pull behavior as other
attributes.

Codes are **primitive** (no children — all current codes) or **combinatorial**: an ordered AND of
buckets, plus optional mandatory singleton codes that stand in place of a one-code bucket. There is
no OR in the grammar; apparent disjunction is handled by subsumption (below). Code definitions must
form a DAG — cycles are rejected at definition time.

## Ordering

Bucket numbering (1, 2, 3…) is a sequence constraint. Contiguous positions may be marked
**interchangeable**, yielding a series-parallel order (e.g., {1,2} ≺ 3 ≺ 4); arbitrary partial
orders are out of scope. Order is evaluated by **first evidence**: min sentence index of bucket i ≤
min of bucket i+1, ties permitted. Out-of-order fulfillment saves with an `order-violated` flag —
warn, never block. Substitution targets (below) must be an interchangeable group.

## Subsumption (substitution)

A code c₁ may substitute for a subset S of a parent c₂'s buckets iff, for every bucket in S, every
code admissible in c₁'s version of that bucket is also admissible in c₂'s version. Consequently:
**a fork may substitute into standard-bucket slots only after all fork-added codes have been pushed
to the modular bucket** (mandatory flags may stay fork-local). Implement as entailment, not stored
lists: when the popup opens and an in-span assignment of a subsuming code exists, auto-check the
covered buckets with provenance recorded ("via c₁"). Subsumption is transitive; the DAG guard
covers chains. Remaining buckets are fulfilled manually; the subsuming code's span counts toward
the parent span and its sentences may double-serve as evidence for other buckets.

## Forks and sync

A fork is an overlay: fork = modular + Δ, where Δ records only explicitly changed attributes
(added codes, mandatory flags, caption). **Pull** is automatic for any attribute not in Δ;
overridden attributes stay fork-local. **Push** (double-confirm) mutates the modular bucket; other
forks receive it as a pull under the same override rule. Conflicting pushes: last-write-wins at
modular, logged; overrides insulate forks that care. **Deletions never auto-pull** — flag for
manual resolution. Pulls apply in batches between coding sessions only, each recorded in the
version log.

> ⌘ Fork ownership: a fork is per-coder (`owner = auth.uid()`), one live fork per (coder, bucket).
> ⌘ "Pull in batches between sessions" is operationalized through snapshots: the effective fork
> view is computed at read time, but every assignment stores the snapshot ID it was coded under,
> and snapshots are cut at the mandated boundaries — so an in-flight session's provenance is
> pinned even though reads are live. Deviation documented here, not silent.

## Assignments and statuses

Assigning a combinatorial code opens a skippable popup (buckets, candidate children, mandatory
items). Statuses:

- **Attested** — coder asserts the parent holds; no/partial evidence documented. Valid; counts for
  IRR; implicitly asserts mandatory codes and ordering. Partial decomposition is
  attested-with-some-evidence, not a lesser validity class.
- **Decomposed** (partial/full) — children linked with sub-spans. Popups are skippable per level;
  decomposition of nested combinatorial children is opt-in.
- **Pending** — coder has *not yet asserted* (uncertain the code applies). Not an assignment.
  Resolves to attested/decomposed or deletion; deletions log the partially fulfilled buckets. All
  pendings resolve **before any cross-coder contact** about that session; IRR is blocked until
  then.

Attested and decomposed assignments are stored distinguishably. If later decomposition of an
attested assignment fails, flag it — do not silently delete.

## Spans

Child spans ⊆ parent span. One sentence may evidence multiple buckets and multiple parents
simultaneously. Child spans need not cover the parent span. Child and parent spans may be
non-contiguous; parents may overlap/interleave (UI renders parallel lanes — do not force
serialization). For decomposed assignments the parent span is **derived** (union of child spans,
coder-extendable); attested assignments use a drawn span. Decomposition may extend a parent span;
log the edit.

## Bottom-up promotion

Existing child assignments may be promoted into a new parent under the same constraints. Promotion
**links** existing assignments (never copies). Where multiple in-span candidates could fill a
bucket, the coder selects which. Popup pre-fills by entailment in both workflows. No auto-suggested
promotions until reliability is established.

## Versioning

Two mechanisms:

1. **Codebook snapshots** — immutable serialized JSON of full state (codes, buckets, forks/Δ,
   captions), monotonic integer + timestamp, append-only. Cut mandatorily before: any IRR session,
   any batch pull, any push to modular. Every assignment stores its snapshot ID.
2. **Assignment event log** — append-only: creations, status transitions, span extensions,
   promotions, deletions-with-partial-state, and sentence indices per bucket-fulfillment.

## IRR

Defined a priori: agreement = same parent code on same segment, regardless of decomposition path,
sub-spans, or attested/decomposed status. Child-level agreement is descriptive only. IRR is
computed within a single snapshot and reported with its ID; a session straddling a snapshot
boundary is calibration, not IRR. Codes intended to become combinatorial are converted **before**
IRR sessions. Log decomposition rate per code per coder; fully decompose a random ~15% audit
sample.

## Guards and out-of-grammar

Reject configurations where a parent references an empty bucket (via fork removals or modular
edits). Negation is not in the grammar; EXCLUDE IF conditions remain coder judgment, documented as
such.
