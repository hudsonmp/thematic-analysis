'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { logoutAction } from '@/app/actions/auth';
import { NAV_GROUPS, activeGroupKey, activeHref } from '@/lib/nav/menu';
import CodebookSwitcher, { type CodebookOption } from '@/components/CodebookSwitcher';

/**
 * Shared chrome for every protected page. The session is already gated by the
 * route-group layout, so this is presentation-only; the study name + codebook
 * list are fetched server-side in the layout and passed as props (a Client
 * Component must never call server actions during render). The codebook name
 * line is now the CodebookSwitcher — a per-browser active-codebook select.
 *
 * Thirteen flat links became three menus — Codebook / Recording / Eval. The
 * grouping and the active-link resolution live in `lib/nav/menu.ts` as pure
 * data + functions; this file is only the disclosure behaviour (open on click,
 * close on outside-click / Escape / navigation).
 */
export default function CodebookNav({
  studyName,
  codebooks,
  activeCodebookId,
  canEditCodebooks = false,
  displayName,
  isAdmin = false,
}: {
  studyName: string | null;
  codebooks: CodebookOption[];
  activeCodebookId: string | null;
  canEditCodebooks?: boolean;
  displayName: string;
  isAdmin?: boolean;
}) {
  const pathname = usePathname();
  const navRef = useRef<HTMLDivElement | null>(null);

  // The open menu is remembered WITH the route it was opened on, and read back
  // only while that route still holds. Navigating therefore closes the menu by
  // derivation — no reset-in-effect, so it never renders open for a frame on the
  // new page (and the react-hooks/set-state-in-effect rule stays satisfied).
  const [opened, setOpened] = useState<{ key: string; path: string } | null>(null);
  const openKey = opened !== null && opened.path === pathname ? opened.key : null;
  const setOpenKey = (key: string | null) =>
    setOpened(key === null ? null : { key, path: pathname });

  const currentHref = activeHref(pathname);
  const currentGroup = activeGroupKey(pathname);

  // Close on Escape, or on a pointer-down anywhere outside the nav. Bound only
  // while a menu is open so the listeners aren't live for the whole session.
  useEffect(() => {
    if (openKey === null) return;
    // `setOpened(null)` directly, not the `setOpenKey` wrapper: the wrapper closes
    // over `pathname` and is recreated every render, so depending on it would
    // rebind these listeners on each one. Closing needs no pathname anyway.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpened(null);
    };
    const onDown = (e: PointerEvent) => {
      if (!navRef.current?.contains(e.target as Node)) setOpened(null);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [openKey]);

  return (
    <header className="border-b border-foreground/15 print:hidden">
      <nav className="flex items-center justify-between gap-6 px-6 py-3">
        <div className="flex items-baseline gap-6" ref={navRef}>
          <span className="text-sm font-medium tracking-tight">Codebook</span>
          <ul className="flex items-center gap-1">
            {NAV_GROUPS.map((group) => {
              const isOpen = openKey === group.key;
              const isCurrent = currentGroup === group.key;
              return (
                <li key={group.key} className="relative">
                  <button
                    type="button"
                    aria-haspopup="menu"
                    aria-expanded={isOpen}
                    onClick={() => setOpenKey(isOpen ? null : group.key)}
                    className={`rounded px-2 py-1 text-sm transition hover:bg-foreground/5 hover:text-foreground ${
                      isCurrent || isOpen ? 'text-foreground' : 'text-foreground/60'
                    }`}
                  >
                    {group.label}
                    <span
                      aria-hidden
                      className={`ml-1.5 inline-block text-[9px] transition-transform ${
                        isOpen ? 'rotate-180' : ''
                      }`}
                    >
                      ▾
                    </span>
                    {isCurrent && (
                      <span
                        aria-hidden
                        className="absolute inset-x-2 -bottom-0.5 block h-px bg-foreground"
                      />
                    )}
                  </button>

                  {isOpen && (
                    <div
                      role="menu"
                      className="absolute left-0 top-full z-50 mt-2 w-60 border border-foreground/15 bg-background py-1 shadow-lg"
                    >
                      {group.items
                        .filter((item) => !item.adminOnly || isAdmin)
                        .map((item) => {
                        const active = currentHref === item.href;
                        return (
                          <Link
                            key={item.href}
                            role="menuitem"
                            href={item.href}
                            className={`block px-3 py-2 transition hover:bg-foreground/5 ${
                              active ? 'bg-foreground/5' : ''
                            }`}
                          >
                            <span
                              className={`block text-sm ${
                                active ? 'text-foreground' : 'text-foreground/80'
                              }`}
                            >
                              {item.label}
                            </span>
                            {item.hint && (
                              <span className="block text-xs text-foreground/45">
                                {item.hint}
                              </span>
                            )}
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
        <div className="flex items-center gap-6">
          {/* Active-codebook switcher: the select shows the active codebook's
              name (replacing the old static name line); switching/creating/
              renaming lives in the client component, which refreshes the
              router so the whole Server Component tree re-resolves. */}
          <div className="flex flex-col items-end gap-0.5 text-right text-xs text-foreground/60 leading-tight">
            <CodebookSwitcher
              codebooks={codebooks}
              activeId={activeCodebookId}
              canEdit={canEditCodebooks}
            />
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
