/**
 * codePicker — PURE search over the flat code list, for placing an EXISTING code
 * onto a node.
 *
 * This is the affordance that makes duplicates real. Placement is many-to-many on
 * purpose: the same code may legitimately hang under two constructs, and seeing it
 * in both is informative rather than a bug. But a tray that only offers UNPLACED
 * codes can never produce a second placement — so the model would allow duplicates
 * while the interface quietly forbade them. This module backs the picker that
 * searches ALL codes, not just homeless ones.
 *
 * It reports each hit's PLACEMENT STATUS, because "add this code here" means three
 * different things depending on where the code already lives, and the researcher
 * must be able to tell them apart before clicking:
 *
 *   'unplaced'  — it has no home yet. Placing it is just filing it.
 *   'elsewhere' — it already sits under other nodes. Placing it here CREATES A
 *                 DUPLICATE: deliberate, but it must be a visible decision, not an
 *                 accident. The names of those other nodes come back with the hit
 *                 so the picker can show them.
 *   'here'      — already placed on this node. Offering it again would be a no-op
 *                 dressed up as an action (attach is idempotent, so nothing would
 *                 break — it would just lie about having done something).
 */

import type { Tables } from '@/lib/types/cb-db';

type Code = Tables<'cb_codes'>;

export type PlacementStatus = 'unplaced' | 'elsewhere' | 'here';

export type CodeHit = {
  id: string;
  mnemonic: string;
  name: string;
  status: PlacementStatus;
  /** Names of the OTHER nodes this code sits under. Empty unless 'elsewhere'. */
  otherNodes: string[];
};

/** The minimum a code needs to expose for the picker. */
type Placeable = Pick<Code, 'id' | 'mnemonic' | 'name'> & { labelIds: string[] };

/**
 * Search `codes` for `query`, ranked and annotated with placement status relative
 * to `labelId` (the node the picker is open on; `null` = no node selected).
 *
 * Matching is case-insensitive substring on mnemonic OR name — a researcher hunts
 * by either, and a fuzzy matcher would surface confident nonsense on a two-letter
 * mnemonic. An EMPTY query returns everything (the picker opens as a browsable
 * list, not a blank slate).
 *
 * Ranking, most-useful first:
 *   1. mnemonic prefix   — you typed "AMB" and meant the code called AMB
 *   2. name prefix
 *   3. any other substring hit
 * ties break alphabetically by mnemonic, so the order is deterministic (and so the
 * list does not reshuffle under the cursor between renders).
 *
 * Codes already placed HERE are NOT filtered out — they are returned with status
 * 'here' so the picker can show them greyed with "already here" rather than making
 * the researcher wonder why a code they know exists is missing from the results.
 */
export function searchCodes(
  codes: Placeable[],
  query: string,
  labelId: string | null,
  nodeNameById: ReadonlyMap<string, string> = new Map(),
): CodeHit[] {
  const q = query.trim().toLowerCase();

  const scored: { hit: CodeHit; rank: number }[] = [];

  for (const c of codes) {
    const mnemonic = c.mnemonic.toLowerCase();
    const name = c.name.toLowerCase();

    let rank: number;
    if (q === '') rank = 3;
    else if (mnemonic.startsWith(q)) rank = 0;
    else if (name.startsWith(q)) rank = 1;
    else if (mnemonic.includes(q) || name.includes(q)) rank = 2;
    else continue; // no match

    const others = c.labelIds.filter((id) => id !== labelId);
    const status: PlacementStatus =
      labelId !== null && c.labelIds.includes(labelId)
        ? 'here'
        : c.labelIds.length === 0
          ? 'unplaced'
          : 'elsewhere';

    scored.push({
      rank,
      hit: {
        id: c.id,
        mnemonic: c.mnemonic,
        name: c.name,
        status,
        // Only meaningful when the code lives somewhere other than here.
        otherNodes:
          status === 'unplaced'
            ? []
            : others.map((id) => nodeNameById.get(id) ?? '—'),
      },
    });
  }

  scored.sort((a, b) =>
    a.rank !== b.rank
      ? a.rank - b.rank
      : a.hit.mnemonic.localeCompare(b.hit.mnemonic),
  );

  return scored.map((s) => s.hit);
}
