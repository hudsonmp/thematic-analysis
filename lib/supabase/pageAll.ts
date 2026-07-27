/**
 * pageAll — drain a PostgREST list query past the server's row cap.
 *
 * Supabase's PostgREST caps every un-ranged select at `max_rows` (1000 on
 * this project) and truncates SILENTLY — no error, no marker. Seven sessions
 * already exceed 1000 transcript segments, so any "select the whole list"
 * read returns a clean-looking prefix (the 60-minutes-of-a-90-minute-video
 * bug). This helper pages with `.range()` until a short page proves the end.
 *
 * The callback must CONSTRUCT a fresh query per page (PostgREST builders are
 * one-shot thenables) and MUST carry a deterministic total order — paging an
 * unordered select can duplicate or drop rows across page boundaries.
 *
 * PAGE must not exceed the server's max_rows: the termination test is
 * `rows.length < PAGE`, which is only sound when a full page can actually
 * come back full.
 */

export const PAGE = 1000;

type PageResult<T> = { data: T[] | null; error: { message: string } | null };

export async function pageAll<T>(
  page: (from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<{ data: T[]; error: { message: string } | null }> {
  const all: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) return { data: all, error };
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < PAGE) return { data: all, error: null };
  }
}
