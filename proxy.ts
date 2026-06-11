import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

// Supabase Auth session-refresh + route gate (Next.js 16 Proxy, formerly
// Middleware). This is the canonical `@supabase/ssr` "updateSession" pattern,
// adapted to the `proxy.ts` signature.
//
// WHY THIS LIVES HERE (and not only in the layout): a refreshed access/refresh
// token can only be PERSISTED to the browser from a place that can write
// response cookies. A Server Component render cannot write cookies (see
// user-server.ts `setAll` try/catch — the write no-ops there). The Proxy runs
// on every navigation BEFORE the render and CAN write cookies, so it is the
// place that keeps the Supabase session alive across requests. `getUser()`
// triggers a token refresh when the access token is near expiry; the new tokens
// are written back to the outgoing response below.
//
// COOKIE PASS-THROUGH (the load-bearing part):
//  - READ: the server client's `getAll` reads from `request.cookies` (the
//    incoming request's cookies).
//  - WRITE: when Supabase refreshes the session it calls `setAll`. We write the
//    refreshed cookies onto BOTH the incoming `request.cookies` (so that a
//    redirect/rewrite built from this request carries them) AND a freshly
//    rebuilt `response` whose `Set-Cookie` headers reach the browser.
//
// This proxy is also the coarse route gate: if there is no signed-in user and
// the path is not a public auth route or static asset, redirect to
// /create/login. The redirect response copies the refreshed cookies so the
// session is never dropped on the way to the login page. The REAL per-request
// gate still lives in `app/(protected)/layout.tsx` (requireAuthUser) and in
// each Server Action — Proxy is defense-in-depth, not the sole check.

const PUBLIC_PATHS = new Set(['/create/login', '/create/register']);

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // `response` is rebuilt from the request so that cookies written by Supabase's
  // `setAll` (refreshed tokens) are carried on the outgoing response headers.
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          // 1) Reflect onto the request so any redirect/rewrite derived from it
          //    sees the refreshed session.
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          // 2) Rebuild the response from the mutated request, then set the
          //    Set-Cookie headers so the refreshed tokens reach the browser.
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // IMPORTANT: do NOT run any logic between createServerClient and getUser().
  // getUser() validates/refreshes the session token; the refreshed cookies are
  // captured by the setAll handler above.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Gate: unauthenticated requests to non-public paths go to the login page.
  // Public auth routes (login/register) and their Server Action POSTs share
  // these pathnames, so an unauthenticated researcher can still reach them.
  if (!user && !PUBLIC_PATHS.has(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = '/create/login';
    url.searchParams.set('next', pathname);
    const redirectResponse = NextResponse.redirect(url);
    // Carry any refreshed auth cookies onto the redirect so the session is not
    // dropped en route to the login page.
    response.cookies.getAll().forEach((cookie) => {
      redirectResponse.cookies.set(cookie);
    });
    return redirectResponse;
  }

  // Authenticated (or a public path): return the response WITH the refreshed
  // auth cookies intact so tokens persist across navigations.
  return response;
}

export const config = {
  // Run on every request EXCEPT Next.js internals and static metadata files.
  // Server Functions (POST to a route) are still covered because they share the
  // route's pathname. Excluding _next and favicon avoids running auth logic on
  // asset requests.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
