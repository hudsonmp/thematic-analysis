/** Throws unless `table` is a codebook (`cb_`) table. The service-role key bypasses
 *  RLS, so this app-level guard is the read-only-against-study-data enforcement. */
export function assertCbTable(table: string): void {
  if (!/^cb_/.test(table)) {
    throw new Error(`Refusing to write to non-codebook table "${table}" (study data is read-only).`);
  }
}
