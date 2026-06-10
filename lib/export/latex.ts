/**
 * Pure LaTeX renderer for codebook export (Task 18, Part A).
 *
 * `codebookToLatex(tree, opts?)` turns a `listCodebookTree` aggregate into a
 * complete, compilable `article` document: a methods paragraph plus a
 * `longtable` codebook (one row per code's *current* version). It is PURE (no
 * I/O, no clock), so it runs identically server-side and client-side — the
 * export page renders it in the browser to drive a Blob download.
 *
 * EPISTEMIC-HONESTY GUARD (hard requirement): this tool implements DIRECTED
 * CONTENT ANALYSIS (Hsieh & Shannon, 2005) / coding-reliability (codebook)
 * thematic analysis (Boyatzis, 1998; MacQueen et al., 1998). It must NEVER
 * present itself as *reflexive* thematic analysis — codifying an a-priori,
 * double-coded, kappa-gated codebook under a reflexive-TA banner is the
 * documented Padiyath methodological incoherence. The methods boilerplate below
 * therefore names the method explicitly and the word "reflexive" appears
 * nowhere in any emitted string. A test enforces both.
 *
 * Input typing is structural (a narrowed view of the tree, mirroring
 * `snapshot.ts`), so this file stays off the `server-only` import chain and the
 * real `CodebookTree` satisfies it by being a superset.
 */

// ---------------------------------------------------------------------------
// Structural input — narrowed to the fields the renderer reads. The real
// `CodebookTree` (a superset) is assignable to this.
// ---------------------------------------------------------------------------

type LatexFacetValue = { id: string; key: string; label: string };

type LatexFacet = {
  id: string;
  key: string;
  label: string;
  values: LatexFacetValue[];
};

type LatexCodeVersion = {
  definition: string;
  include_if: unknown;
  exclude_if: unknown;
  exemplars: unknown;
  prediction: string | null;
};

type LatexCode = {
  mnemonic: string;
  origin: string;
  current: LatexCodeVersion | null;
  facetValueIds: string[];
  citationIds: string[];
};

type LatexCitation = { id: string; bibtex_key: string | null };

export type LatexTree = {
  facets: LatexFacet[];
  codes: LatexCode[];
  citations: LatexCitation[];
};

export type CodebookToLatexOptions = {
  /** Facet `key` to group the table by; codes lacking a value on it fall under
   *  an "Unassigned" group. Omit for a single flat table. */
  groupByFacetKey?: string;
};

// ---------------------------------------------------------------------------
// LaTeX escaping. Covers the ten characters that are special in LaTeX text
// mode: & % $ # _ { } ~ ^ \. Single-pass table lookup, so the `{}` that the
// \textbackslash / \textasciitilde / \textasciicircum macros introduce are
// NEVER re-scanned and thus never double-escaped (the classic two-pass bug).
// ---------------------------------------------------------------------------

const LATEX_ESCAPES: Record<string, string> = {
  '&': '\\&',
  '%': '\\%',
  $: '\\$',
  '#': '\\#',
  _: '\\_',
  '{': '\\{',
  '}': '\\}',
  '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}',
  '\\': '\\textbackslash{}',
};

export function escapeLatex(s: string): string {
  return s.replace(/[&%$#_{}~^\\]/g, (ch) => LATEX_ESCAPES[ch]);
}

// ---------------------------------------------------------------------------
// Cell helpers.
// ---------------------------------------------------------------------------

/** Coerce an unknown bullet-list value (`include_if`/`exclude_if`, stored as
 *  Json) to a string array, dropping non-strings and blanks. */
function asStringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
}

/** Coerce an unknown exemplars value to display strings. Each exemplar is
 *  `{ text, source_pid? }` (see contracts.ts); we render "text (pid)" when a
 *  source is present. Tolerant of malformed rows. */
function asExemplarStrings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (x && typeof x === 'object' && 'text' in x) {
      const text = (x as { text?: unknown }).text;
      if (typeof text === 'string' && text.trim()) {
        const pid = (x as { source_pid?: unknown }).source_pid;
        out.push(
          typeof pid === 'string' && pid.trim() ? `${text} (${pid})` : text,
        );
      }
    } else if (typeof x === 'string' && x.trim()) {
      out.push(x);
    }
  }
  return out;
}

/** Render a list of RAW strings as a small in-cell `itemize`, escaping each
 *  item. Empty list -> em dash. */
function listCell(items: string[]): string {
  if (items.length === 0) return '---';
  const lines = items.map((it) => `\\item ${escapeLatex(it)}`).join('\n');
  return `\\begin{itemize}[nosep,leftmargin=*]\n${lines}\n\\end{itemize}`;
}

/** Plain escaped text cell, em dash for empty. */
function textCell(s: string | null | undefined): string {
  const t = (s ?? '').trim();
  return t ? escapeLatex(t) : '---';
}

// ---------------------------------------------------------------------------
// Methods paragraph (the epistemic-honesty boilerplate).
// ---------------------------------------------------------------------------

function methodsParagraph(): string {
  return [
    '\\section*{Method}',
    '',
    'We analyzed the corpus using \\emph{directed content analysis} ' +
      '(Hsieh \\& Shannon, 2005): an a-priori, theory-driven coding scheme is ' +
      'specified in advance and applied deductively, in the coding-reliability ' +
      '(codebook) tradition of thematic analysis (Boyatzis, 1998; MacQueen et ' +
      'al., 1998). Each code below is defined by an explicit definition with ' +
      'include-/exclude-if rules and anchored exemplars, so that two coders can ' +
      'apply it consistently. To establish inter-rater reliability, coders first ' +
      "calibrated on a shared training subset until Cohen's $\\kappa \\geq 0.70$; " +
      'the codebook was then \\emph{frozen}, after which 25--30\\% of the corpus ' +
      'was independently double-coded to report reliability on held-out data. ' +
      'This is a coding-reliability codebook, not an interpretive account: codes ' +
      'are fixed, operationalized units applied for agreement, not themes ' +
      "generated through the analyst's evolving interpretation.",
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Table assembly.
// ---------------------------------------------------------------------------

const COLUMN_HEADER =
  'Mnemonic & Definition & Include-if & Exclude-if & Exemplar(s) & ' +
  'Prediction & Origin & Citations';

/** Resolve a code's linked citation ids to escaped bibtex keys (comma-joined).
 *  Ids that don't resolve to a key are dropped — same policy as the JSON
 *  export: the human-meaningful bibtex_key is the citation handle. */
function citationCell(code: LatexCode, keyById: Map<string, string>): string {
  const keys = code.citationIds
    .map((id) => keyById.get(id))
    .filter((k): k is string => k !== undefined);
  return keys.length ? keys.map(escapeLatex).join(', ') : '---';
}

/** One `longtable` body row for a code with a non-null current version. */
function codeRow(code: LatexCode, keyById: Map<string, string>): string {
  const v = code.current!;
  const cells = [
    `\\textbf{${escapeLatex(code.mnemonic)}}`,
    textCell(v.definition),
    listCell(asStringList(v.include_if)),
    listCell(asStringList(v.exclude_if)),
    listCell(asExemplarStrings(v.exemplars)),
    textCell(v.prediction),
    textCell(code.origin),
    citationCell(code, keyById),
  ];
  return `${cells.join(' &\n')} \\\\`;
}

/** A `\multicolumn` group subheading spanning all eight columns. */
function groupHeading(label: string): string {
  return `\\multicolumn{8}{l}{\\textbf{${escapeLatex(label)}}} \\\\\n\\midrule`;
}

export function codebookToLatex(
  tree: LatexTree,
  opts: CodebookToLatexOptions = {},
): string {
  // Codes with a null current version are SKIPPED: a code that has never been
  // given a version body has no definition/rules to render in a definition
  // table. This is intentional and noted in the module docstring.
  const renderable = tree.codes.filter((c) => c.current !== null);

  // citation_id -> bibtex_key (only rows that carry a key).
  const keyById = new Map<string, string>();
  for (const c of tree.citations) {
    if (c.bibtex_key) keyById.set(c.id, c.bibtex_key);
  }

  let bodyRows: string;

  if (opts.groupByFacetKey) {
    const facet = tree.facets.find((f) => f.key === opts.groupByFacetKey);
    const valueById = new Map<string, LatexFacetValue>();
    const facetValueIds = new Set<string>();
    if (facet) {
      for (const val of facet.values) {
        valueById.set(val.id, val);
        facetValueIds.add(val.id);
      }
    }

    // Group key = value label (or "Unassigned"). Facet-value order is
    // preserved, with Unassigned last. A code tagged with multiple values of
    // the facet appears once per value (multi-cardinality facets); an untagged
    // code goes to Unassigned.
    const groups = new Map<string, LatexCode[]>();
    const orderedLabels: string[] = [];
    const ensure = (label: string) => {
      if (!groups.has(label)) {
        groups.set(label, []);
        orderedLabels.push(label);
      }
      return groups.get(label)!;
    };
    if (facet) for (const val of facet.values) ensure(val.label);

    for (const code of renderable) {
      const tagged = code.facetValueIds.filter((id) => facetValueIds.has(id));
      if (tagged.length === 0) {
        ensure('Unassigned').push(code);
      } else {
        for (const id of tagged) ensure(valueById.get(id)!.label).push(code);
      }
    }

    const labels = orderedLabels.filter((l) => l !== 'Unassigned');
    if (groups.has('Unassigned')) labels.push('Unassigned');

    bodyRows = labels
      .filter((label) => (groups.get(label) ?? []).length > 0)
      .map((label) => {
        const rows = (groups.get(label) ?? [])
          .map((code) => codeRow(code, keyById))
          .join('\n\\midrule\n');
        return `${groupHeading(label)}\n${rows}`;
      })
      .join('\n\\midrule\n');
  } else {
    bodyRows = renderable
      .map((code) => codeRow(code, keyById))
      .join('\n\\midrule\n');
  }

  const preamble = [
    '\\documentclass[10pt]{article}',
    '\\usepackage[margin=1in]{geometry}',
    '\\usepackage{longtable}',
    '\\usepackage{booktabs}',
    '\\usepackage{array}',
    '\\usepackage{enumitem}',
    '\\usepackage[T1]{fontenc}',
    '\\setlength{\\extrarowheight}{2pt}',
  ].join('\n');

  // Column spec: a fixed-mnemonic column, ragged-right paragraph columns for the
  // text-heavy fields, and a final citations column. Widths are fractions of
  // \linewidth so the table fits the page.
  const colSpec =
    '>{\\raggedright\\arraybackslash}p{0.07\\linewidth}' + // Mnemonic
    '>{\\raggedright\\arraybackslash}p{0.20\\linewidth}' + // Definition
    '>{\\raggedright\\arraybackslash}p{0.12\\linewidth}' + // Include-if
    '>{\\raggedright\\arraybackslash}p{0.12\\linewidth}' + // Exclude-if
    '>{\\raggedright\\arraybackslash}p{0.15\\linewidth}' + // Exemplar(s)
    '>{\\raggedright\\arraybackslash}p{0.13\\linewidth}' + // Prediction
    '>{\\raggedright\\arraybackslash}p{0.07\\linewidth}' + // Origin
    '>{\\raggedright\\arraybackslash}p{0.08\\linewidth}'; //  Citations

  const table = [
    `\\begin{longtable}{${colSpec}}`,
    '\\toprule',
    `${COLUMN_HEADER} \\\\`,
    '\\midrule',
    '\\endfirsthead',
    '\\toprule',
    `${COLUMN_HEADER} \\\\`,
    '\\midrule',
    '\\endhead',
    '\\bottomrule',
    '\\endlastfoot',
    bodyRows,
    '\\bottomrule',
    '\\end{longtable}',
  ].join('\n');

  return [
    preamble,
    '',
    '\\begin{document}',
    '',
    methodsParagraph(),
    '',
    '\\section*{Codebook}',
    '',
    table,
    '',
    '\\end{document}',
    '',
  ].join('\n');
}
