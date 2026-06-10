'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { setCodeStatus, retireCode, type CodeStatus } from '@/app/actions/codes';
import type { CodeWithRefs, FacetWithValues } from '@/app/actions/codebook';
import type { ProtocolEpisode } from '@/app/actions/protocol';
import type { Tables } from '@/lib/types/cb-db';
import AnatomyEditor from './AnatomyEditor';
import FacetTagger from './FacetTagger';
import CitationLinker from './CitationLinker';
import VersionHistory from './VersionHistory';
import CommentThread from './CommentThread';

type CodeVersion = Tables<'cb_code_versions'>;
type Citation = Tables<'cb_citations'>;
type CoderComment = Tables<'cb_coder_comments'>;

const STATUSES: readonly CodeStatus[] = ['proposed', 'active', 'merged', 'retired'];

const STATUS_COLOR: Record<string, string> = {
  proposed: '#9ca3af',
  active: '#16a34a',
  merged: '#2563eb',
  retired: '#dc2626',
};

type TabKey = 'anatomy' | 'classification' | 'citations' | 'versions' | 'comments';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'anatomy', label: 'Anatomy' },
  { key: 'classification', label: 'Classification' },
  { key: 'citations', label: 'Citations' },
  { key: 'versions', label: 'Versions' },
  { key: 'comments', label: 'Comments' },
];

/**
 * Orchestrates the full code anatomy editor. Header carries mnemonic / name /
 * origin and the lifecycle status control; the body is a tabbed surface, one
 * focused component per tab. All data arrives as props from the server page;
 * child components own their own mutations + router.refresh().
 */
export default function CodeCard({
  code,
  facets,
  citations,
  versions,
  comments,
  episodes,
}: {
  code: CodeWithRefs;
  facets: FacetWithValues[];
  citations: Citation[];
  versions: CodeVersion[];
  comments: CoderComment[];
  episodes: ProtocolEpisode[];
}) {
  const router = useRouter();
  const [tab, setTab] = useState<TabKey>('anatomy');
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function changeStatus(status: CodeStatus) {
    if (status === code.status) return;
    setError(null);
    startTransition(async () => {
      try {
        if (status === 'retired') await retireCode(code.id);
        else await setCodeStatus(code.id, status);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Status change failed.');
      }
    });
  }

  const commentCount = comments.length;
  const unresolvedCount = comments.filter((c) => !c.resolved).length;

  return (
    <main className="flex-1 px-6 py-6 space-y-6 max-w-4xl">
      <div>
        <Link href="/" className="text-xs text-foreground/50 hover:text-foreground">
          ← Scheme
        </Link>
      </div>

      {/* Header */}
      <header className="space-y-2 border-b border-foreground/15 pb-4">
        <div className="flex items-baseline gap-3 flex-wrap">
          <h1 className="font-mono text-lg font-medium">{code.mnemonic}</h1>
          <span className="text-foreground/70">{code.name}</span>
          <span className="text-xs text-foreground/40 border border-foreground/15 px-1.5 py-0.5">
            {code.origin}
          </span>
        </div>
        <div className="flex items-center gap-2 flex-wrap text-sm">
          <span className="text-foreground/50 text-xs uppercase tracking-wider">Status</span>
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: STATUS_COLOR[code.status] ?? '#9ca3af' }}
            aria-hidden
          />
          <select
            value={code.status}
            disabled={isPending}
            onChange={(e) => changeStatus(e.target.value as CodeStatus)}
            className="border border-foreground/15 px-2 py-0.5 text-sm bg-background"
            aria-label="Code status"
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          {code.retired_at && (
            <span className="text-xs text-foreground/40">
              retired {new Date(code.retired_at).toLocaleDateString()}
            </span>
          )}
          {error && <span className="text-sm text-red-600">{error}</span>}
        </div>
      </header>

      {/* Tabs */}
      <nav className="flex gap-1 border-b border-foreground/15" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`px-3 py-1.5 text-sm -mb-px border-b-2 transition ${
              tab === t.key
                ? 'border-foreground text-foreground'
                : 'border-transparent text-foreground/50 hover:text-foreground'
            }`}
          >
            {t.label}
            {t.key === 'versions' && (
              <span className="ml-1 text-xs text-foreground/40">({versions.length})</span>
            )}
            {t.key === 'comments' && commentCount > 0 && (
              <span className="ml-1 text-xs text-foreground/40">
                ({unresolvedCount > 0 ? `${unresolvedCount}!/` : ''}
                {commentCount})
              </span>
            )}
          </button>
        ))}
      </nav>

      <section>
        {tab === 'anatomy' && (
          <AnatomyEditor codeId={code.id} current={code.current} episodes={episodes} />
        )}
        {tab === 'classification' && (
          <FacetTagger
            codeId={code.id}
            facets={facets}
            selectedValueIds={code.facetValueIds}
          />
        )}
        {tab === 'citations' && (
          <CitationLinker
            codeId={code.id}
            citations={citations}
            linkedCitationIds={code.citationIds}
          />
        )}
        {tab === 'versions' && (
          <VersionHistory versions={versions} currentVersionId={code.current_version_id} />
        )}
        {tab === 'comments' && <CommentThread codeId={code.id} comments={comments} />}
      </section>
    </main>
  );
}
