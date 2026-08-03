'use client';

/**
 * Render a code's NOTES with light structure, parsed from plain text so notes
 * stay portable (one string in cb_codes.notes, no rich-text format):
 *
 *   `1.` / `2.` … at line start → numbered items
 *   `a.` / `b.` … at line start → lettered FORK branches under the item above
 *   `@slug`                     → mention of another code (mono + emerald)
 *   anything else               → plain paragraph
 *
 * The two levels are exactly Hudson's sketch: a numbered step that forks into
 * parallel lettered alternatives. Same renderer everywhere notes appear
 * (coding-popup hover, printable document), so what you type is what prints.
 */

type Block =
  | { kind: 'p'; text: string }
  | { kind: 'list'; items: { n: string; text: string; subs: { n: string; text: string }[] }[] };

function parse(text: string): Block[] {
  const blocks: Block[] = [];
  let list: Extract<Block, { kind: 'list' }> | null = null;

  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (line.trim() === '') {
      list = null; // blank line ends the current list
      continue;
    }
    const num = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    const sub = line.match(/^\s*([a-z])[.)]\s+(.*)$/);
    if (num) {
      if (!list) {
        list = { kind: 'list', items: [] };
        blocks.push(list);
      }
      list.items.push({ n: num[1], text: num[2], subs: [] });
    } else if (sub && list && list.items.length > 0) {
      list.items[list.items.length - 1].subs.push({ n: sub[1], text: sub[2] });
    } else {
      list = null;
      blocks.push({ kind: 'p', text: line.trim() });
    }
  }
  return blocks;
}

/** Inline pass: highlight @slug mentions. */
function Inline({ text }: { text: string }) {
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

export default function NoteText({ text }: { text: string }) {
  const blocks = parse(text);
  return (
    <div className="space-y-1">
      {blocks.map((b, i) =>
        b.kind === 'p' ? (
          <p key={i}>
            <Inline text={b.text} />
          </p>
        ) : (
          <ol key={i} className="space-y-0.5">
            {b.items.map((it, j) => (
              <li key={j}>
                <span className="text-foreground/45">{it.n}.</span> <Inline text={it.text} />
                {it.subs.length > 0 && (
                  // The FORK: parallel lettered branches under one numbered step.
                  <ol className="mt-0.5 space-y-0.5 pl-4">
                    {it.subs.map((s, k) => (
                      <li key={k}>
                        <span className="text-foreground/45">{s.n}.</span> <Inline text={s.text} />
                      </li>
                    ))}
                  </ol>
                )}
              </li>
            ))}
          </ol>
        ),
      )}
    </div>
  );
}
