import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { Database } from '@/lib/types/cb-db';

/**
 * An `@supabase/ssr` server client bound to the signed-in user via the ANON key
 * (so `auth.uid()` reflects the authenticated user, unlike the service-role
 * client). It can both READ and WRITE auth cookies, which is required for token
 * refresh inside Server Actions and Route Handlers.
 *
 * The `setAll` handler is wrapped in try/catch because Next.js disallows writing
 * cookies from a Server Component render. In that context the write is a no-op;
 * the middleware / a Server Action is expected to persist the refreshed session.
 */
export async function createUserServerClient() {
  const cookieStore = await cookies();
  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Called from a Server Component, where cookies cannot be written.
            // Safe to ignore — session refresh is handled in middleware /
            // Server Actions where the cookie store is writable.
          }
        },
      },
    },
  );
}
