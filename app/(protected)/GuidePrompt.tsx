'use client';

import Link from 'next/link';
import { useSyncExternalStore } from 'react';

const KEY = 'cb:guide-dismissed';
const EVENT = 'cb-guide-dismissed';

// localStorage through useSyncExternalStore (the repo's established pattern): the
// store is the source of truth, the server snapshot says "dismissed" so the banner
// never flashes during hydration for returning users, and a dismissal in one tab
// hides it in all of them.
function subscribe(onChange: () => void) {
  window.addEventListener(EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}
const getSnapshot = () => window.localStorage.getItem(KEY) === '1';
const getServerSnapshot = () => true;

/**
 * The one-time "new here?" banner pointing at /guide. Dismissal is local to the
 * browser, deliberately: the guide is a courtesy, not a gate, and tracking
 * completion server-side would turn onboarding into compliance.
 */
export default function GuidePrompt() {
  const dismissed = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  if (dismissed) return null;

  return (
    <div className="flex items-center gap-3 border-b border-sky-500/30 bg-sky-500/10 px-6 py-2 text-sm print:hidden">
      <span className="text-foreground/80">
        New to the coding platform? The guide walks every feature and ends with your
        data-familiarization sessions.
      </span>
      <Link href="/guide" className="font-medium underline underline-offset-2">
        Take the guide →
      </Link>
      <button
        type="button"
        onClick={() => {
          window.localStorage.setItem(KEY, '1');
          window.dispatchEvent(new Event(EVENT));
        }}
        aria-label="Dismiss"
        className="ml-auto px-1 text-foreground/40 hover:text-foreground"
      >
        ×
      </button>
    </div>
  );
}
