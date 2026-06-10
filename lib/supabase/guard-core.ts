/** Throws unless `table` is a codebook (`cb_`) table. The service-role key bypasses
 *  RLS, so this app-level guard is the read-only-against-study-data enforcement.
 *
 *  LIMITATION: this guard only covers `.from()` writes routed through `cbFrom`
 *  (it asserts the `cb_` prefix). It does NOT intercept `.rpc()` calls to study
 *  stored procedures, nor dynamic/computed table names that bypass `cbFrom`.
 *  Those paths rely on code review plus the `scripts/check-no-study-writes.sh`
 *  lint (run in `npm run lint`) and a post-test verification, not on this
 *  function. Keep all codebook writes flowing through `cbFrom` so this prefix
 *  check actually runs. */
export function assertCbTable(table: string): void {
  if (!/^cb_/.test(table)) {
    throw new Error(`Refusing to write to non-codebook table "${table}" (study data is read-only).`);
  }
}
