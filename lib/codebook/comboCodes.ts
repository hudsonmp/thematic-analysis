/**
 * comboCodes — map codebook-tree codes to the CodeCombobox's ComboCode shape
 * (the coding popup's PopupCode fields: definition, exemplars, counter-example,
 * origin). One mapper so every picker searches and hover-expands the SAME
 * metadata the coding screen shows — mirrors the sessions page's extraction.
 *
 * Structurally typed (a narrowed view of CodeWithRefs) so it stays pure and
 * off the server-only import chain.
 */

import type { ComboCode } from '@/components/codebook/CodeCombobox';

type TreeCodeLike = {
  id: string;
  mnemonic: string;
  origin: string;
  current: {
    definition: string | null;
    exemplars: unknown;
    disconfirming_pattern: string | null;
  } | null;
};

/** Pull exemplar texts defensively — `exemplars` is jsonb (`{ text, … }[]`);
 *  a malformed row must not throw. Same policy as the session page. */
function exemplarTexts(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((e) =>
      e && typeof e === 'object' && typeof (e as { text?: unknown }).text === 'string'
        ? (e as { text: string }).text
        : '',
    )
    .filter((t) => t !== '');
}

export function toComboCodes(codes: TreeCodeLike[]): ComboCode[] {
  return codes.map((c) => ({
    id: c.id,
    mnemonic: c.mnemonic,
    origin: c.origin,
    definition: c.current?.definition ?? null,
    exemplars: exemplarTexts(c.current?.exemplars),
    counterExample: c.current?.disconfirming_pattern ?? null,
  }));
}
