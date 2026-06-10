'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  addComment,
  setCommentResolved,
  deleteComment,
} from '@/app/actions/comments';
import type { Tables } from '@/lib/types/cb-db';

type CoderComment = Tables<'cb_coder_comments'>;

/**
 * Coder comment thread. The researcher session carries no per-coder identity
 * (single shared password — see addComment), so the comment author is a typed
 * name/initials field, required before a comment can be added. Supports
 * resolve/unresolve and delete. After every mutation we router.refresh() so the
 * server re-reads the thread (the parent page passes `comments` as props).
 *
 * The author input persists across submits within a session so a coder doesn't
 * retype their initials on each comment.
 */
export default function CommentThread({
  codeId,
  comments,
}: {
  codeId: string;
  comments: CoderComment[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [author, setAuthor] = useState('');
  const [body, setBody] = useState('');

  function run(fn: () => Promise<unknown>) {
    setError(null);
    startTransition(async () => {
      try {
        await fn();
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Comment action failed.');
      }
    });
  }

  function submit() {
    const a = author.trim();
    const b = body.trim();
    if (!a) {
      setError('Enter your name or initials to attribute the comment.');
      return;
    }
    if (!b) {
      setError('Comment body is empty.');
      return;
    }
    run(async () => {
      await addComment({ codeId, author: a, body: b });
      setBody('');
    });
  }

  return (
    <div className="space-y-3">
      {comments.length === 0 && (
        <p className="text-sm text-foreground/40">No comments yet.</p>
      )}
      <ul className="space-y-2">
        {comments.map((c) => (
          <li
            key={c.id}
            className={`border px-3 py-2 ${
              c.resolved ? 'border-foreground/10 bg-foreground/[0.02]' : 'border-foreground/20'
            }`}
          >
            <div className="flex items-center gap-2 text-xs text-foreground/50">
              <span className="font-medium text-foreground/70">{c.author}</span>
              {c.code_version != null && (
                <span className="font-mono">v{c.code_version}</span>
              )}
              <span>{new Date(c.created_at).toLocaleString()}</span>
              {c.resolved && (
                <span className="text-green-700 uppercase tracking-wider">resolved</span>
              )}
              <span className="ml-auto flex gap-2">
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => run(() => setCommentResolved(c.id, !c.resolved))}
                  className="hover:underline disabled:opacity-50"
                >
                  {c.resolved ? 'Reopen' : 'Resolve'}
                </button>
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => {
                    if (confirm('Delete this comment?')) run(() => deleteComment(c.id));
                  }}
                  className="text-red-600 hover:underline disabled:opacity-50"
                >
                  Delete
                </button>
              </span>
            </div>
            <p className={`text-sm mt-1 whitespace-pre-wrap ${c.resolved ? 'text-foreground/50' : ''}`}>
              {c.body}
            </p>
          </li>
        ))}
      </ul>

      {/* Add comment */}
      <div className="border-t border-foreground/15 pt-3 space-y-2">
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-2 flex-wrap">
          <input
            value={author}
            disabled={isPending}
            onChange={(e) => setAuthor(e.target.value)}
            placeholder="name / initials"
            className="border border-foreground/15 px-2 py-1 text-sm bg-background w-40"
            aria-label="Comment author"
          />
          <input
            value={body}
            disabled={isPending}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Comment…"
            className="border border-foreground/15 px-2 py-1 text-sm bg-background flex-1 min-w-48"
            aria-label="Comment body"
          />
          <button
            type="button"
            disabled={isPending}
            onClick={submit}
            className="border border-foreground px-3 py-1 text-sm hover:bg-foreground hover:text-background transition disabled:opacity-50"
          >
            Add comment
          </button>
        </div>
      </div>
    </div>
  );
}
