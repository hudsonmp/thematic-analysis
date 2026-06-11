import { describe, it, expect } from 'vitest';
import { codebookToLatex, escapeLatex } from '@/lib/export/latex';
import type { CodebookTree } from '@/app/actions/codebook';

/**
 * Hand-built fixtures for the PURE LaTeX renderer. We only populate the columns
 * the renderer reads; the remaining row fields are stubbed to satisfy the
 * generated row types without exercising them.
 *
 * The renderer's method MUST be directed content analysis (Hsieh & Shannon,
 * 2005) / coding-reliability (codebook) TA — never *reflexive* TA. The
 * no-"reflexive" assertion is a HARD epistemic-honesty guard, not a stylistic
 * preference: presenting this tool as reflexive TA is the documented Padiyath
 * incoherence.
 */

const NOW = '2026-01-01T00:00:00Z';

function singleCode(): CodebookTree {
  return {
    codebook: {
      id: 'cb-1',
      study_id: 'study-1',
      name: 'Test codebook',
      method: 'directed_content_analysis',
      description: null,
      created_at: NOW,
      updated_at: NOW,
    },
    facets: [
      {
        id: 'facet-A',
        codebook_id: 'cb-1',
        key: 'modality',
        label: 'Modality',
        description: null,
        cardinality: 'single',
        type: 'enum',
        position: 0,
        created_at: NOW,
        values: [
          {
            id: 'fv-A1',
            facet_id: 'facet-A',
            key: 'visual',
            label: 'Visual',
            description: null,
            color: null,
            position: 0,
            created_at: NOW,
          },
          {
            id: 'fv-A2',
            facet_id: 'facet-A',
            key: 'verbal',
            label: 'Verbal',
            description: null,
            color: null,
            position: 1,
            created_at: NOW,
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
        created_at: NOW,
        retired_at: null,
        current: {
          id: 'ver-1',
          code_id: 'code-1',
          version: 3,
          // Deliberately laden with LaTeX special characters.
          definition: '50% & a_b #1',
          include_if: ['mentions $x$'],
          exclude_if: ['has a ~tilde'],
          exemplars: [{ text: 'I did {it}', source_pid: 'p1' }],
          disconfirming_pattern: 'never X',
          prediction: 'X predicts Y',
          prediction_falsifier: 'X without Y',
          change_note: null,
          created_at: NOW,
          created_by: null,
        },
        facetValueIds: ['fv-A1'],
        facetFields: [],
        citationIds: ['cit-1'],
        episodeIds: [],
        labelIds: [],
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
        doi: null,
        url: null,
        parsed: null,
        created_at: NOW,
      },
    ],
    episodes: [],
    labels: [],
  };
}

/** Same shape but the one code has `current === null` (skip path). */
function nullCurrentCode(): CodebookTree {
  const tree = singleCode();
  tree.codes = [
    {
      ...tree.codes[0],
      id: 'code-skip',
      mnemonic: 'SKIPME',
      current_version_id: null,
      current: null,
      facetValueIds: [],
      citationIds: [],
    },
  ];
  return tree;
}

describe('escapeLatex', () => {
  it('escapes the ten LaTeX special characters', () => {
    expect(escapeLatex('50% & a_b #1')).toBe('50\\% \\& a\\_b \\#1');
    expect(escapeLatex('$x$')).toBe('\\$x\\$');
    expect(escapeLatex('a~b')).toBe('a\\textasciitilde{}b');
    expect(escapeLatex('a^b')).toBe('a\\textasciicircum{}b');
    expect(escapeLatex('a\\b')).toBe('a\\textbackslash{}b');
    expect(escapeLatex('{x}')).toBe('\\{x\\}');
  });
});

describe('codebookToLatex', () => {
  it('escapes user text in the body', () => {
    const out = codebookToLatex(singleCode());
    expect(out).toContain('50\\% \\& a\\_b \\#1');
  });

  it('includes the code mnemonic', () => {
    const out = codebookToLatex(singleCode());
    expect(out).toContain('ALPHA');
  });

  it('names the method "directed content analysis"', () => {
    const out = codebookToLatex(singleCode());
    expect(out).toContain('directed content analysis');
  });

  it('NEVER presents itself as reflexive thematic analysis (epistemic guard)', () => {
    const out = codebookToLatex(singleCode());
    expect(out.toLowerCase()).not.toContain('reflexive');
  });

  it('cites the coding-reliability / codebook strand and states the kappa procedure', () => {
    const out = codebookToLatex(singleCode());
    expect(out).toContain('Boyatzis');
    expect(out).toContain('MacQueen');
    // freeze + double-code 25–30% at kappa >= .70 (`--` is a LaTeX en dash)
    expect(out).toMatch(/0\.70|\.70/);
    expect(out).toMatch(/25(--|–|-)?30/);
    expect(out).toContain('frozen');
  });

  it('skips codes whose current version is null', () => {
    const out = codebookToLatex(nullCurrentCode());
    expect(out).not.toContain('SKIPME');
  });

  it('renders a flat longtable with the expected columns when ungrouped', () => {
    const out = codebookToLatex(singleCode());
    expect(out).toContain('\\begin{longtable}');
    expect(out).toContain('\\end{longtable}');
    expect(out).toContain('smith2020'); // citation bibtex key in its column
  });

  it('groups rows under a facet-value subheading when groupByFacetKey is set', () => {
    const out = codebookToLatex(singleCode(), { groupByFacetKey: 'modality' });
    // The code is tagged modality=visual, so its value label heads a group.
    expect(out).toContain('Visual');
    const visualIdx = out.indexOf('Visual');
    const alphaIdx = out.indexOf('ALPHA');
    expect(visualIdx).toBeGreaterThanOrEqual(0);
    expect(alphaIdx).toBeGreaterThan(visualIdx);
  });

  it('puts codes lacking a value on the grouping facet under "Unassigned"', () => {
    const tree = singleCode();
    tree.codes[0].facetValueIds = []; // no modality tag
    const out = codebookToLatex(tree, { groupByFacetKey: 'modality' });
    expect(out).toContain('Unassigned');
  });
});
