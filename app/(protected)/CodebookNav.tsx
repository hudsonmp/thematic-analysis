'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { logoutAction } from '@/app/actions/auth';

type NavLink = { href: string; label: string };

const LINKS: NavLink[] = [
  { href: '/', label: 'Scheme' },
  { href: '/sessions/live', label: 'Live' },
  { href: '/sessions', label: 'Sessions' },
  { href: '/episodes', label: 'Events' },
  { href: '/flag-types', label: 'Flags' },
  { href: '/labels', label: 'Labels' },
  { href: '/citations', label: 'Citations' },
  { href: '/reliability', label: 'Reliability' },
  { href: '/export', label: 'Export' },
];

/**
 * Shared chrome for every protected page. The session is already gated by the
 * route-group layout, so this is presentation-only; the study + codebook names
 * are fetched server-side in the layout and passed as props (a Client Component
 * must never call server actions during render).
 */
export default function CodebookNav({
  studyName,
  codebookName,
  displayName,
}: {
  studyName: string | null;
  codebookName: string | null;
  displayName: string;
}) {
  const pathname = usePathname();

  const isActive = (href: string) => {
    if (href === '/') return pathname === '/';
    if (!pathname.startsWith(href)) return false;
    // Don't let a shorter prefix steal the highlight from a more specific
    // sibling link (e.g. `/sessions` must NOT light up on `/sessions/live`,
    // which has its own nav entry). Active iff no longer nav href also matches.
    return !LINKS.some(
      (l) => l.href !== href && l.href.startsWith(href) && pathname.startsWith(l.href),
    );
  };

  return (
    <header className="border-b border-foreground/15">
      <nav className="flex items-center justify-between gap-6 px-6 py-3">
        <div className="flex items-baseline gap-6">
          <span className="text-sm font-medium tracking-tight">Codebook</span>
          <ul className="flex items-center gap-4">
            {LINKS.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className={`text-sm transition hover:text-foreground ${
                    isActive(link.href)
                      ? 'text-foreground border-b border-foreground pb-0.5'
                      : 'text-foreground/60'
                  }`}
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex items-center gap-6">
          <div className="text-right text-xs text-foreground/60 leading-tight">
            {codebookName && (
              <div className="text-foreground/80">{codebookName}</div>
            )}
            {studyName && <div>study: {studyName}</div>}
          </div>
          <div className="flex items-center gap-3 border-l border-foreground/15 pl-6">
            <span className="text-xs text-foreground/80">{displayName}</span>
            {/* Logout is a Server Action (no client JS): the form POSTs to
                logoutAction, which signs out and redirects to /create/login. */}
            <form action={logoutAction}>
              <button
                type="submit"
                className="text-xs text-foreground/60 underline underline-offset-2 transition hover:text-foreground"
              >
                Logout
              </button>
            </form>
          </div>
        </div>
      </nav>
    </header>
  );
}
