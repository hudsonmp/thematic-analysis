/**
 * Pure snapshot assembler for the freeze gate (Task 12, Part A).
 *
 * `buildSnapshot(tree)` turns the `listCodebookTree` aggregate into the canonical
 * frozen-version JSON that gets stored in `cb_codebook_versions.snapshot`. It is
 * deliberately PURE (no I/O, no clock): `frozen_at` is emitted as `null` and the
 * freeze ACTION stamps the real timestamp at insert time. Keeping the time out of
 * the builder is what makes it unit-testable and deterministic.
 *
 * Design notes:
 *  - The input type is structural (a narrowed view of the tree), not an import of
 *    the `'use server'` action module, so this file stays free of the
 *    `server-only` import chain and runs in plain Node (vitest, the export path).
 *    The real `CodebookTree` row shape is a superset of `SnapshotTree`, so callers
 *    pass it directly.
 *  - facetValueIds (opaque uuids on each code) are resolved to stable
 *    `{facet_key, value_key}` pairs via the tree's facets, so the snapshot is
 *    self-describing and key-stable even if uuids churn across re-imports.
 *  - citationIds are resolved to `bibtex_key`; ids that don't resolve to a key
 *    (no row, or a row with a null bibtex_key) are dropped — the snapshot keys on
 *    the human-meaningful bibtex_key, which is the unique citation handle.
 */

type SnapshotFacetValue = {
  id: string;
  key: string;
  label: string;
};

type SnapshotFacet = {
  key: string;
  label: string;
  cardinality: string;
  values: SnapshotFacetValue[];
};

type SnapshotCodeVersion = {
  version: number;
  definition: string;
  include_if: unknown;
  exclude_if: unknown;
  exemplars: unknown;
  disconfirming_pattern: string | null;
  prediction: string | null;
  prediction_falsifier: string | null;
};

type SnapshotCode = {
  id: string;
  mnemonic: string;
  name: string;
  origin: string;
  status: string;
  current_version_id: string | null;
  current: SnapshotCodeVersion | null;
  facetValueIds: string[];
  citationIds: string[];
};

type SnapshotCitation = {
  id: string;
  bibtex_key: string | null;
  title: string | null;
  authors: string | null;
  year: number | null;
  doi: string | null;
};

/** Structural input — the `listCodebookTree` return shape narrowed to the fields
 *  the snapshot needs. The real `CodebookTree` satisfies this. */
export type SnapshotTree = {
  facets: SnapshotFacet[];
  codes: SnapshotCode[];
  citations: SnapshotCitation[];
};

export type FrozenCodeVersion = {
  version: number;
  definition: string;
  include_if: unknown;
  exclude_if: unknown;
  exemplars: unknown;
  disconfirming_pattern: string | null;
  prediction: string | null;
  prediction_falsifier: string | null;
};

export type FrozenCode = {
  id: string;
  mnemonic: string;
  name: string;
  origin: string;
  status: string;
  current_version: FrozenCodeVersion | null;
  facet_values: { facet_key: string; value_key: string }[];
  citations: string[];
};

export type FrozenFacet = {
  key: string;
  label: string;
  cardinality: string;
  values: { key: string; label: string }[];
};

export type FrozenCitation = {
  bibtex_key: string | null;
  title: string | null;
  authors: string | null;
  year: number | null;
  doi: string | null;
};

export type CodebookSnapshot = {
  frozen_at: string | null;
  codes: FrozenCode[];
  facets: FrozenFacet[];
  citations: FrozenCitation[];
};

export function buildSnapshot(tree: SnapshotTree): CodebookSnapshot {
  // facet_value_id -> {facet_key, value_key}
  const facetValueLookup = new Map<string, { facet_key: string; value_key: string }>();
  for (const facet of tree.facets) {
    for (const value of facet.values) {
      facetValueLookup.set(value.id, { facet_key: facet.key, value_key: value.key });
    }
  }

  // citation_id -> bibtex_key (only rows that actually carry a key)
  const citationKeyById = new Map<string, string>();
  for (const c of tree.citations) {
    if (c.bibtex_key) citationKeyById.set(c.id, c.bibtex_key);
  }

  const codes: FrozenCode[] = tree.codes.map((code) => ({
    id: code.id,
    mnemonic: code.mnemonic,
    name: code.name,
    origin: code.origin,
    status: code.status,
    current_version: code.current
      ? {
          version: code.current.version,
          definition: code.current.definition,
          include_if: code.current.include_if,
          exclude_if: code.current.exclude_if,
          exemplars: code.current.exemplars,
          disconfirming_pattern: code.current.disconfirming_pattern,
          prediction: code.current.prediction,
          prediction_falsifier: code.current.prediction_falsifier,
        }
      : null,
    facet_values: code.facetValueIds
      .map((id) => facetValueLookup.get(id))
      .filter((v): v is { facet_key: string; value_key: string } => v !== undefined),
    citations: code.citationIds
      .map((id) => citationKeyById.get(id))
      .filter((k): k is string => k !== undefined),
  }));

  const facets: FrozenFacet[] = tree.facets.map((facet) => ({
    key: facet.key,
    label: facet.label,
    cardinality: facet.cardinality,
    values: facet.values.map((v) => ({ key: v.key, label: v.label })),
  }));

  const citations: FrozenCitation[] = tree.citations.map((c) => ({
    bibtex_key: c.bibtex_key,
    title: c.title,
    authors: c.authors,
    year: c.year,
    doi: c.doi,
  }));

  return { frozen_at: null, codes, facets, citations };
}
