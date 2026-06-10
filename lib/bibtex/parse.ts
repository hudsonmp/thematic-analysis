/**
 * Minimal, dependency-free BibTeX parser.
 *
 * Citations are pasted by researchers as a single entry or a whole `.bib` blob.
 * We scan for `@<type>{ ... }`, brace-balance each entry (so nested `{}` inside
 * field values do not terminate the entry early), pull the citation key, then
 * split the body into `field = {…}` / `field = "…"` / `field = bareword` pairs.
 *
 * Brace-nesting limits (documented intentionally):
 *  - Field VALUES are brace-balanced, so `title = {A {B} C}` is captured whole.
 *  - Inner braces are kept verbatim in `parsed` (we only strip the single
 *    OUTER delimiter pair); we do NOT recursively unwrap or de-LaTeX them.
 *    e.g. `{The {DNA} of X}` -> `The {DNA} of X`. Callers that need a clean
 *    display string can post-process. Quoted values may NOT contain a raw
 *    unescaped `"` (standard BibTeX restriction); brace values are preferred.
 *  - Malformed entries (no key, unbalanced braces) are skipped, not thrown.
 */

export type ParsedCitation = {
  bibtex_key: string;
  bibtex_raw: string;
  title?: string;
  authors?: string;
  year?: number;
  doi?: string;
  url?: string;
  parsed: Record<string, string>;
};

/**
 * From `start` (index of `{` after the entry type), return the index just past
 * the matching closing `}`, brace-balanced. Returns -1 if never balanced.
 */
function findMatchingBrace(input: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < input.length; i++) {
    const ch = input[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i; // index of the closing brace
    }
  }
  return -1;
}

/** Strip a single matching outer delimiter pair: {…} or "…". */
function unwrap(value: string): string {
  const v = value.trim();
  if (v.startsWith('{') && v.endsWith('}')) return v.slice(1, -1).trim();
  if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).trim();
  return v;
}

/**
 * Parse the comma-separated `field = value` body of one entry (the text after
 * the citation key, before the entry's closing brace). Brace- and quote-aware
 * so commas inside values do not split fields.
 */
function parseFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let i = 0;
  const n = body.length;

  while (i < n) {
    // Skip separators / whitespace.
    while (i < n && (body[i] === ',' || /\s/.test(body[i]))) i++;
    if (i >= n) break;

    // Read field name up to '='.
    const nameStart = i;
    while (i < n && body[i] !== '=' && body[i] !== ',') i++;
    if (i >= n || body[i] !== '=') break; // no '=' -> stop (malformed tail)
    const name = body.slice(nameStart, i).trim().toLowerCase();
    i++; // consume '='

    // Skip whitespace before the value.
    while (i < n && /\s/.test(body[i])) i++;
    if (i >= n) break;

    let value = '';
    const ch = body[i];
    if (ch === '{') {
      const end = findMatchingBrace(body, i);
      if (end === -1) break; // unbalanced -> stop parsing this entry's body
      value = body.slice(i, end + 1);
      i = end + 1;
    } else if (ch === '"') {
      // Quoted string: read to the next unescaped closing quote.
      let j = i + 1;
      while (j < n && body[j] !== '"') j++;
      if (j >= n) break; // unterminated
      value = body.slice(i, j + 1);
      i = j + 1;
    } else {
      // Bareword value (number or macro): read to next comma at top level.
      let j = i;
      while (j < n && body[j] !== ',') j++;
      value = body.slice(i, j);
      i = j;
    }

    if (name) fields[name] = unwrap(value);
  }

  return fields;
}

/**
 * Parse a BibTeX string into structured citations. Conservative: returns [] for
 * empty / non-bibtex input and skips individual malformed entries.
 */
export function parseBibtex(input: string): ParsedCitation[] {
  if (!input || typeof input !== 'string') return [];

  const out: ParsedCitation[] = [];
  // Match `@type{` — type is letters; allow whitespace before the brace.
  const entryStart = /@([A-Za-z]+)\s*\{/g;

  let m: RegExpExecArray | null;
  while ((m = entryStart.exec(input)) !== null) {
    const braceIdx = entryStart.lastIndex - 1; // position of the '{'
    const closeIdx = findMatchingBrace(input, braceIdx);
    if (closeIdx === -1) break; // unbalanced from here on; bail out

    const raw = input.slice(m.index, closeIdx + 1);
    const inner = input.slice(braceIdx + 1, closeIdx); // between the outer braces

    // Citation key = first token up to the first comma.
    const commaIdx = inner.indexOf(',');
    const key = (commaIdx === -1 ? inner : inner.slice(0, commaIdx)).trim();

    // Advance scanner past this entry so nested @ inside values is not re-matched.
    entryStart.lastIndex = closeIdx + 1;

    if (!key) continue; // malformed (e.g. `@string` macro or empty key) -> skip

    const body = commaIdx === -1 ? '' : inner.slice(commaIdx + 1);
    const parsed = parseFields(body);

    const citation: ParsedCitation = {
      bibtex_key: key,
      bibtex_raw: raw,
      parsed,
    };

    if (parsed.title) citation.title = parsed.title;
    if (parsed.author) citation.authors = parsed.author;
    if (parsed.doi) citation.doi = parsed.doi;
    if (parsed.url) citation.url = parsed.url;
    if (parsed.year !== undefined) {
      const y = parseInt(parsed.year, 10);
      if (!Number.isNaN(y)) citation.year = y;
    }

    out.push(citation);
  }

  return out;
}
