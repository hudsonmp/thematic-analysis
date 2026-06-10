import { NextResponse, type NextRequest } from 'next/server';

// Cookie-presence check only. Full validation lives in server actions/pages.
//
// This is a researcher-only internal tool, so EVERY route is gated except the
// login page itself. (Contrast spec-study-app, whose proxy gates only /create
// because it also serves a participant-facing tree; here there is no public
// surface.) The matcher below uses a negative lookahead to run on all paths
// except Next internals and static assets, and we additionally let the login
// route through inside the function so an unauthenticated researcher can reach
// the password form.
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // The only publicly reachable route.
  if (pathname === '/create/login') {
    return NextResponse.next();
  }

  const hasResearcher = request.cookies.has('specstudy_researcher');
  if (!hasResearcher) {
    const url = request.nextUrl.clone();
    url.pathname = '/create/login';
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // Match every request path EXCEPT Next.js internals and static metadata
  // files. Server Functions (POST to a route) are still covered because they
  // share the route's pathname. Keeping the login page out of the matcher is
  // unnecessary (we short-circuit it in the function), but excluding _next and
  // favicon avoids running auth logic on asset requests.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
