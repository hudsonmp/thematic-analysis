'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { commitActionImport, previewActionImport, type ImportResult } from '@/app/actions/action-import';
import type { ImportPlan, VocabAdds } from '@/lib/actions/import';

const BTN = 'border border-foreground px-3 py-1 text-sm transition hover:bg-foreground hover:text-background disabled:opacity-50';
const LINK = 'text-xs text-foreground/60 underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50';

/**
 * "Import from .md" for the Actions tab. Pick a local Markdown file written in
 * the Action Import Schema v2 (schema_version: 2 + ```action YAML blocks),
 * preview what would happen block by block — create / already in the study /
 * repeats an earlier block / error with reasons — then commit. Nothing is
 * written until the researcher clicks Import, and duplicates are skipped by
 * composition signature so re-importing a corrected file is idempotent.
 */
export default function ImportActionsPanel({ codebookId, disabled }: { codebookId: string; disabled: boolean }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [isPending, startTransition] = useTransition();
  const [fileName, setFileName] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setFileName(null);
    setText(null);
    setPlan(null);
    setResult(null);
    setError(null);
    if (inputRef.current) inputRef.current.value = '';
  }

  async function onPick(file: File | undefined) {
    if (!file) return;
    setError(null);
    setResult(null);
    setPlan(null);
    setFileName(file.name);
    let contents: string;
    try {
      contents = await file.text();
    } catch {
      setError('Could not read that file.');
      return;
    }
    setText(contents);
    startTransition(async () => {
      try {
        setPlan(await previewActionImport(codebookId, contents));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Preview failed.');
      }
    });
  }

  function onCommit() {
    if (!text) return;
    setError(null);
    startTransition(async () => {
      try {
        const r = await commitActionImport(codebookId, text);
        setResult(r);
        setPlan(null);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Import failed.');
      }
    });
  }

  const busy = disabled || isPending;
  const canCommit = !!plan && plan.fileErrors.length === 0 && plan.counts.create > 0;

  return (
    <div className="mt-4 border-t border-foreground/10 pt-4" data-testid="import-actions">
      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={inputRef}
          type="file"
          accept=".md,.markdown,.txt,text/markdown,text/plain"
          className="hidden"
          onChange={(e) => void onPick(e.target.files?.[0])}
          data-testid="import-actions-file"
        />
        <button type="button" disabled={busy} onClick={() => inputRef.current?.click()} className={BTN}>
          Import from .md…
        </button>
        {fileName && (
          <span className="text-xs text-foreground/60">
            {fileName}
            {isPending && ' · reading…'}
          </span>
        )}
        {(plan || result || error) && (
          <button type="button" onClick={reset} disabled={isPending} className={LINK}>
            clear
          </button>
        )}
        {!fileName && (
          <span className="text-xs text-foreground/45">
            Action Import Schema v2 — <code>schema_version: 2</code> plus <code>```action</code> YAML blocks. Moves, objects
            and roles the file names that the study lacks are added on import; questions must already exist.
          </span>
        )}
      </div>

      {error && (
        <p className="mt-3 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700">{error}</p>
      )}

      {plan && (
        <div className="mt-3" data-testid="import-actions-preview">
          {plan.fileErrors.length > 0 && (
            <ul className="mb-2 list-disc pl-5 text-sm text-red-700">
              {plan.fileErrors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          <p className="mb-2 text-xs text-foreground/60">
            {plan.items.length} block{plan.items.length === 1 ? '' : 's'}:{' '}
            <span className="font-medium text-foreground">{plan.counts.create} to create</span>
            {plan.counts.duplicate > 0 && <> · {plan.counts.duplicate} already in the study</>}
            {plan.counts.repeat > 0 && <> · {plan.counts.repeat} repeated in the file</>}
            {plan.counts.error > 0 && <> · {plan.counts.error} with errors</>}
          </p>
          <VocabAddsLine adds={plan.vocabAdds} tense="will" />
          <ul className="divide-y divide-foreground/10 border border-foreground/15 text-sm">
            {plan.items.map((it) => (
              <li key={it.index} className="flex items-start gap-2 px-3 py-1.5">
                <span className="w-6 pt-0.5 font-mono text-xs text-foreground/40">{it.index + 1}.</span>
                <span className={`w-20 shrink-0 pt-0.5 font-mono text-[11px] uppercase ${STATUS_CLASS[it.status]}`}>
                  {STATUS_LABEL[it.status]}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-medium">{it.name ?? <em className="text-foreground/50">(unnamed)</em>}</span>
                    {'summary' in it && <span className="text-xs text-foreground/60">{it.summary}</span>}
                    <span className="text-[11px] text-foreground/40">line {it.line}</span>
                  </div>
                  {it.status === 'duplicate' && (
                    <p className="text-xs text-foreground/60">Same composition as “{it.existingName}” — skipped.</p>
                  )}
                  {it.status === 'repeat' && (
                    <p className="text-xs text-foreground/60">Same composition as block {it.ofIndex + 1} — skipped.</p>
                  )}
                  {it.status === 'error' && (
                    <ul className="list-disc pl-4 text-xs text-red-700">
                      {it.errors.map((e, i) => (
                        <li key={i}>{e}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex items-center gap-3">
            <button type="button" disabled={busy || !canCommit} onClick={onCommit} className={BTN} data-testid="import-actions-commit">
              Import {plan.counts.create} action{plan.counts.create === 1 ? '' : 's'}
            </button>
            {plan.counts.error > 0 && plan.counts.create > 0 && (
              <span className="text-xs text-foreground/55">Blocks with errors are left out; fix the file and import again.</span>
            )}
          </div>
        </div>
      )}

      {result && (
        <div className="mt-3 text-sm" data-testid="import-actions-result">
          <p>
            Imported <span className="font-medium">{result.created.length}</span> action
            {result.created.length === 1 ? '' : 's'}
            {result.skipped > 0 && <> · {result.skipped} skipped as duplicates</>}
            {result.failed.length > 0 && <> · {result.failed.length} failed</>}.
          </p>
          <VocabAddsLine adds={result.vocabAdded} tense="did" />
          {result.failed.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-xs text-red-700">
              {result.failed.map((f) => (
                <li key={f.index}>
                  Block {f.index + 1}
                  {f.name ? ` (${f.name})` : ''}: {f.errors.join(' ')}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** "Will also add: moves Destroy · objects Widget, Scenario › Epic · roles owner" — or nothing. */
function VocabAddsLine({ adds, tense }: { adds: VocabAdds; tense: 'will' | 'did' }) {
  const parts: string[] = [];
  if (adds.moves.length) parts.push(`move${adds.moves.length === 1 ? '' : 's'} ${adds.moves.join(', ')}`);
  if (adds.objects.length) {
    parts.push(
      `object${adds.objects.length === 1 ? '' : 's'} ${adds.objects.map((o) => (o.parent ? `${o.parent} › ${o.name}` : o.name)).join(', ')}`,
    );
  }
  if (adds.roles.length) parts.push(`role${adds.roles.length === 1 ? '' : 's'} ${adds.roles.join(', ')}`);
  if (!parts.length) return null;
  return (
    <p className="mb-2 text-xs text-foreground/70" data-testid="import-actions-vocab-adds">
      <span className="font-medium text-foreground">{tense === 'will' ? 'Will also add' : 'Also added'}</span>{' '}
      {parts.join(' · ')}
      {tense === 'will' && ' (not yet in the study).'}
      {tense === 'did' && '.'}
    </p>
  );
}

const STATUS_LABEL: Record<ImportPlan['items'][number]['status'], string> = {
  create: 'create',
  duplicate: 'exists',
  repeat: 'repeat',
  error: 'error',
};

const STATUS_CLASS: Record<ImportPlan['items'][number]['status'], string> = {
  create: 'text-emerald-700',
  duplicate: 'text-foreground/50',
  repeat: 'text-foreground/50',
  error: 'text-red-700',
};
