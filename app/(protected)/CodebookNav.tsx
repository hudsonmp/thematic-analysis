'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

type NavLink = { href: string; label: string };

const LINKS: NavLink[] = [
  { href: '/', label: 'Scheme' },
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
}: {
  studyName: string | null;
  codebookName: string | null;
}) {
  const pathname = usePathname();

  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname.startsWith(href);

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
        <div className="text-right text-xs text-foreground/60 leading-tight">
          {codebookName && (
            <div className="text-foreground/80">{codebookName}</div>
          )}
          {studyName && <div>study: {studyName}</div>}
        </div>
      </nav>
    </header>
  );
}
