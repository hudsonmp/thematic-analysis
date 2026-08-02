# Composite codes: named buckets, human-in-the-loop parent assignment

2026-08-02 · settled with Hudson via brainstorming (bucket locality, parent presence, optional buckets)

## Purpose

Make the codebook dimensional: a parent code (e.g. `experiment-driven-change`) is
*composed of* named buckets of child codes. Two coders who pick different members
of the same bucket disagree at the child level but agree at the parent level, so
the composite layer absorbs which-member disagreement the way sentence
restoration absorbed which-boundary disagreement → measurable IRR lift
(child-κ vs parent-κ, side by side).

## Model

- A code is **composite** iff it owns ≥1 **bucket**. A bucket has a `name`
  ("scenario step"), a `position`, a `required` flag (default true), and a set
  of member child codes. Any code can be a member; a member that is itself
  composite is evaluated bottom-up on the same annotation → grandchildren work
  with no special case (cycle-guarded).
- **Fulfilled on an annotation** = the annotation's own code set covers every
  **required** bucket (≥1 member each; OR within bucket, AND across buckets).
  Optional buckets never block; their filled members still display as children.
- Validation: a composite must have ≥1 required bucket (all-optional rejected
  at build time).
- **The parent is a code-link on the same annotation as its children** — never
  a separate annotation. Eligibility is per-annotation (one highlight carries
  the children). Cost, accepted: children split across two separate highlights
  don't fire the parent. Benefit: IRR and co-occurrence consume the parent as
  an ordinary code with zero new plumbing.

## Lifecycle (human-in-the-loop, no drift)

| Event | Behavior |
|---|---|
| Annotation's codes newly satisfy a composite | Prompt: "Codes here fulfill «parent» — add it?" Add → write parent link. Deny → suppress (ephemeral, component state; re-prompts only if the code set changes again) |
| Remove a child; a **required** bucket drops to 0 members | Parent link auto-removed |
| Remove a child; bucket still has another member, or bucket is optional | Parent stays |
| Manually delete the parent link | Children untouched (no cascade) |

## Schema (additive)

```
cb_code_buckets         (id, parent_code_id → cb_codes, name, required bool default true, position)
cb_code_bucket_members  (bucket_id → cb_code_buckets, code_id → cb_codes, position, PK(bucket_id, code_id))
```

No change to `cb_annotations` / `cb_annotation_codes`. `parent_code_id`
(existing display hierarchy) is untouched and independent.

## Engine

`lib/codebook/composition.ts` — pure, no DB/DOM:

```ts
evaluate(codeIds: Set<string>, defs: CompositeDef[]) → {
  fulfilled: string[]                    // composite ids satisfied (recursive, bottom-up)
  partial: { id, missingBuckets[] }[]    // for popup progress display
}
```

Cycle guard: a composite encountered while its own evaluation is in progress
counts as unfulfilled. Unit tests: AND/OR truth table, optional buckets,
grandchild recursion, cycles, two-fill-one-stays retraction predicate.

## UI

1. **Tree page (`CodeEditor`)** — bucket builder: add/rename/reorder buckets,
   toggle required, pick member codes; delete bucket. Composite badge on the code.
2. **Coding popup, top-down** — pick a composite → its buckets expand → choose
   ≥1 member per required bucket → Assign writes children + parent in one save.
3. **Coding popup, bottom-up** — tag children normally; when the pending set
   satisfies a composite, inline Add/Deny prompt appears.
4. **Coded spans** — chips render parent with nested children (both levels
   visible while coding).
5. **IRR page** — composite codes labeled; per-code table shows child-κ and
   parent-κ adjacent so the convergence lift is readable.

## Non-goals (v1)

Persisted denials; episode-window eligibility; parent spanning multiple
annotations; auto-assign without prompt; migration of existing annotations.

## Delivery

Branch `feat/composite-codes`, stacked PRs, each gated by
tsc + eslint + vitest + build, left unmerged for Hudson:

1. Migrations + `composition.ts` + tests
2. Bucket builder on tree page
3. Popup top-down assign + parent/child chips
4. Bottom-up prompt + retraction lifecycle
5. IRR labeling + child-vs-parent κ readout
