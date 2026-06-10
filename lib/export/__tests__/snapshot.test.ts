import { describe, it, expect } from 'vitest';
import { buildSnapshot } from '@/lib/export/snapshot';
import type { CodebookTree } from '@/app/actions/codebook';

/**
 * Hand-built fixture matching the `listCodebookTree` return shape. We only fill
 * the columns `buildSnapshot` reads; the rest are stubbed to satisfy the row
 * types without exercising them. The fixture is deliberately non-trivial:
 *  - two facets (single + multi cardinality), each with values;
 *  - one code with a current version, two facet-value tags (across both facets),
 *    and one linked citation;
 *  - one code with `current=null` and no tags/citations (the null-version path);
 *  - one citation whose bibtex_key is present (mapped) and the linked code's id
 *    resolves to that key.
 */
function fixture(): CodebookTree {
  return {
    codebook: {
      id: 'cb-1',
      study_id: 'study-1',
      name: 'Test codebook',
      method: 'directed_content_analysis',
      description: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
    facets: [
      {
        id: 'facet-A',
        codebook_id: 'cb-1',
        key: 'modality',
        label: 'Modality',
        description: null,
        cardinality: 'single',
        position: 0,
        created_at: '2026-01-01T00:00:00Z',
        values: [
          {
            id: 'fv-A1',
            facet_id: 'facet-A',
            key: 'visual',
            label: 'Visual',
            description: null,
            color: null,
            position: 0,
            created_at: '2026-01-01T00:00:00Z',
          },
          {
            id: 'fv-A2',
            facet_id: 'facet-A',
            key: 'verbal',
            label: 'Verbal',
            description: null,
            color: null,
            position: 1,
            created_at: '2026-01-01T00:00:00Z',
          },
        ],
      },
      {
        id: 'facet-B',
        codebook_id: 'cb-1',
        key: 'valence',
        label: 'Valence',
        description: null,
        cardinality: 'multi',
        position: 1,
        created_at: '2026-01-01T00:00:00Z',
        values: [
          {
            id: 'fv-B1',
            facet_id: 'facet-B',
            key: 'positive',
            label: 'Positive',
            description: null,
            color: null,
            position: 0,
            created_at: '2026-01-01T00:00:00Z',
          },
        ],
      },
    ],
    codes: [
      {
        id: 'code-1',
        codebook_id: 'cb-1',
        mnemonic: 'ALPHA',
        name: 'Alpha code',
        origin: 'a_priori',
        status: 'active',
        parent_code_id: null,
        current_version_id: 'ver-1',
        created_at: '2026-01-01T00:00:00Z',
        retired_at: null,
        current: {
          id: 'ver-1',
          code_id: 'code-1',
          version: 3,
          definition: 'When the learner does X.',
          include_if: ['mentions X'],
          exclude_if: ['mentions Y'],
          exemplars: [{ quote: 'I did X', source: 'p1' }],
          disconfirming_pattern: 'never mentions X',
          prediction: 'X correlates with success',
          prediction_falsifier: 'X with no success',
          change_note: 'tightened',
          created_at: '2026-01-01T00:00:00Z',
          created_by: null,
        },
        facetValueIds: ['fv-A1', 'fv-B1'],
        citationIds: ['cit-1'],
      },
      {
        id: 'code-2',
        codebook_id: 'cb-1',
        mnemonic: 'BETA',
        name: 'Beta code',
        origin: 'emergent',
        status: 'proposed',
        parent_code_id: null,
        current_version_id: null,
        created_at: '2026-01-01T00:00:00Z',
        retired_at: null,
        current: null,
        facetValueIds: [],
        citationIds: [],
      },
    ],
    citations: [
      {
        id: 'cit-1',
        codebook_id: 'cb-1',
        bibtex_key: 'smith2020',
        bibtex_raw: '@article{smith2020, ...}',
        title: 'A Study',
        authors: 'Smith, J.',
        year: 2020,
        doi: '10.1/x',
        url: null,
        parsed: null,
        created_at: '2026-01-01T00:00:00Z',
      },
    ],
  };
}

describe('buildSnapshot', () => {
  it('frozen_at is null (stamped by the action, not the pure builder)', () => {
    expect(buildSnapshot(fixture()).frozen_at).toBeNull();
  });

  it('produces facets with key/label/cardinality and nested value key/label', () => {
    const snap = buildSnapshot(fixture());
    expect(snap.facets).toHaveLength(2);
    expect(snap.facets[0]).toMatchObject({
      key: 'modality',
      label: 'Modality',
      cardinality: 'single',
    });
    expect(snap.facets[0].values).toEqual([
      { key: 'visual', label: 'Visual' },
      { key: 'verbal', label: 'Verbal' },
    ]);
    expect(snap.facets[1]).toMatchObject({ key: 'valence', cardinality: 'multi' });
  });

  it('produces citations with bibtex_key/title/authors/year/doi', () => {
    const snap = buildSnapshot(fixture());
    expect(snap.citations).toEqual([
      {
        bibtex_key: 'smith2020',
        title: 'A Study',
        authors: 'Smith, J.',
        year: 2020,
        doi: '10.1/x',
      },
    ]);
  });

  it('emits the full current_version object for a code that has one', () => {
    const snap = buildSnapshot(fixture());
    const alpha = snap.codes.find((c) => c.mnemonic === 'ALPHA')!;
    expect(alpha).toMatchObject({
      id: 'code-1',
      mnemonic: 'ALPHA',
      name: 'Alpha code',
      origin: 'a_priori',
      status: 'active',
    });
    expect(alpha.current_version).toEqual({
      version: 3,
      definition: 'When the learner does X.',
      include_if: ['mentions X'],
      exclude_if: ['mentions Y'],
      exemplars: [{ quote: 'I did X', source: 'p1' }],
      disconfirming_pattern: 'never mentions X',
      prediction: 'X correlates with success',
      prediction_falsifier: 'X with no success',
    });
  });

  it('yields current_version:null for a code whose current is null', () => {
    const snap = buildSnapshot(fixture());
    const beta = snap.codes.find((c) => c.mnemonic === 'BETA')!;
    expect(beta.current_version).toBeNull();
    expect(beta.facet_values).toEqual([]);
    expect(beta.citations).toEqual([]);
  });

  it('resolves facetValueIds -> {facet_key, value_key} via the tree facets', () => {
    const snap = buildSnapshot(fixture());
    const alpha = snap.codes.find((c) => c.mnemonic === 'ALPHA')!;
    expect(alpha.facet_values).toEqual([
      { facet_key: 'modality', value_key: 'visual' },
      { facet_key: 'valence', value_key: 'positive' },
    ]);
  });

  it('resolves citationIds -> bibtex_key via the tree citations', () => {
    const snap = buildSnapshot(fixture());
    const alpha = snap.codes.find((c) => c.mnemonic === 'ALPHA')!;
    expect(alpha.citations).toEqual(['smith2020']);
  });
});
