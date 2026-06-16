// The canonical session "collection" vocabulary. A session's `collection` is the
// bucket it belongs to AND the `study_label` stamped on any code authored from that
// session (see app/actions/codes.ts). It used to be a free-text field; we constrain
// it to a small fixed set so the sessions index organizes cleanly into buckets and
// code attribution is consistent.
//
// `pilot` = a pilot/dry-run recording; `study` = a real study session. Legacy rows
// may hold other values (e.g. an older "pilots"); the UI surfaces such a value as the
// row's current selection rather than dropping it (see `collectionOptions`), so no
// data is silently rewritten — the researcher reassigns with one click.

export const SESSION_COLLECTIONS = ['pilot', 'study'] as const;

export type SessionCollection = (typeof SESSION_COLLECTIONS)[number];

/** The default collection for a freshly uploaded session. */
export const DEFAULT_SESSION_COLLECTION: SessionCollection = 'study';

/**
 * The option list to show for a `<select>` bound to `current`. The canonical set,
 * plus `current` itself when it is a legacy/non-canonical value — so an existing
 * session whose collection is outside {pilot, study} still renders its real value
 * (and stays selectable) instead of appearing mis-assigned. Returns the canonical
 * set unchanged when `current` is already canonical (or blank).
 */
export function collectionOptions(current: string | null | undefined): string[] {
  const c = (current ?? '').trim();
  if (c === '' || (SESSION_COLLECTIONS as readonly string[]).includes(c)) {
    return [...SESSION_COLLECTIONS];
  }
  return [...SESSION_COLLECTIONS, c];
}
