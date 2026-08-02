'use client';

/**
 * Render a code's NOTES with @slug mentions highlighted — the same @-mention
 * convention definitions use (MentionTextarea writes them; this displays them).
 * Pure presentation: split on @slug tokens, style the mentions mono+emerald so
 * a linked code reads as a code wherever notes appear (popup hover, document).
 */
export default function NoteText({ text }: { text: string }) {
  const parts = text.split(/(@[a-z0-9][a-z0-9-]*)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('@') ? (
          <span key={i} className="font-mono text-[0.92em] text-emerald-700 dark:text-emerald-400">
            {p}
          </span>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}
