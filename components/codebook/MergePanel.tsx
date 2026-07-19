'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { mergeCodes } from '@/app/actions/codes';
import MentionTextarea, { type MentionCode } from '@/components/codebook/MentionTextarea';
import BulletListEditor from '@/components/code/BulletListEditor';
import { splitDefinition, joinDefinition } from '@/lib/codebook/definition';
import {
  asExemplarList,
  asStringList,
  buildMergePrefill,
  type ExemplarLike,
  type MergeSource,
} from '@/lib/codebook/merge';
import type { CodeVersionInputT, EpisodeRefT, ExemplarT } from '@/lib/types/contracts';

/** What the merge screen needs to know about a LIVE code — a projection of
 *  CodeWithRefs the server page builds (id + slug + origin + the current
 *  version's anatomy fields). The jsonb list columns stay `unknown` and are
 *  coerced by lib/codebook/merge.ts. */
export type MergeCode = {
  id: string;
  mnemonic: string;
  origin: string;
  current: {
    definition: string;
    include_if: unknown;
    exclude_if: unknown;
    exemplars: unknown;
    disconfirming_pattern: string | null;
  } | null;
};

/** Local draft exemplar — always carries the fields (no optional erasure) so
 *  the controlled inputs have stable values. `episode_ref` rides through
 *  untouched from the stored rows; the server re-validates it on submit. */
type DraftExemplar = {
  text: string;
  source_pid: string;
  episode_ref: EpisodeRefT | undefined;
};

function toDrafts(rows: ExemplarLike[]): DraftExemplar[] {
  return rows.map((raw) => {
    const e = raw as Partial<ExemplarT> & { text: string };
    return {
      text: e.text,
      source_pid: typeof e.source_pid === 'string' ? e.source_pid : '',
      episode_ref: e.episode_ref,
    };
  });
}

/** First ~80 chars of the APPLIED half of a definition, for the picker rows. */
function appliedPreview(definition: string | null | undefined): string {
  const applied = splitDefinition(definition).applied;
  return applied.length > 80 ? `${applied.slice(0, 80)}…` : applied;
}

/**
 * PURE draft computation for a (selection, survivor) pair — shared by the
 * in-panel applyPrefill and the mount-time seed when the codebook tree carries
 * a ready selection in (?ids=…). Null when the pair cannot form a merge.
 */
function prefillFor(
  codes: MergeCode[],
  selectedIds: string[],
  survivorId: string | null,
): {
  literature: string;
  applied: string;
  includeIf: string[];
  excludeIf: string[];
  exemplars: DraftExemplar[];
  counterExample: string;
  changeNote: string;
} | null {
  if (survivorId === null || selectedIds.length < 2) return null;
  const byId = new Map(codes.map((c) => [c.id, c]));
  const surv = byId.get(survivorId);
  if (!surv) return null;
  const absorbed = selectedIds
    .filter((id) => id !== survivorId)
    .map((id) => byId.get(id))
    .filter((c): c is MergeCode => c !== undefined);
  const p = buildMergePrefill(surv as MergeSource, absorbed as MergeSource[]);
  return {
    literature: p.literature,
    applied: p.applied,
    includeIf: p.includeIf,
    excludeIf: p.excludeIf,
    exemplars: toDrafts(p.exemplars),
    counterExample: p.counterExample,
    changeNote: `merge: ${absorbed.map((c) => c.mnemonic).join(', ')} -> ${surv.mnemonic}`,
  };
}

/**
 * The merge screen: pick 2+ live codes, choose the SURVIVOR, author the merged
 * version, commit. The DB function `cb_merge_codes` does the re-pointing and
 * retiring atomically (see actions/codes.ts mergeCodes); this panel owns only
 * the draft.
 *
 * DRAFT RESET SEMANTICS: the merged-result editor is PREFILLED from the
 * survivor's anatomy + the exemplar union (buildMergePrefill), and it is
 * RE-PREFILLED — discarding any edits — whenever the survivor radio OR the
 * selection set changes. Both change what the draft derives from (a different
 * survivor means different anatomy; a different selection means a different
 * exemplar union), and silently keeping stale edits would misattribute one
 * code's prose to another. A note by the editor says so.
 */
export default function MergePanel({
  codes,
  allCodes,
  initialSelectedIds = [],
}: {
  /** Every LIVE code (retired_at null), with current-version anatomy. */
  codes: MergeCode[];
  /** Every live code as {id, mnemonic} — the @-mention candidate pool. */
  allCodes: MentionCode[];
  /** Pre-selection carried in from the codebook tree's merge mode
   *  (/codebook/merge?ids=…), already validated against live codes by the page.
   *  Order = the tree's click order, so the first is the default survivor. */
  initialSelectedIds?: string[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Selection, in CLICK ORDER — order matters: the first selected code is the
  // default survivor, and the exemplar union walks absorbed codes in this order.
  const [selected, setSelected] = useState<string[]>(initialSelectedIds);
  const [survivorId, setSurvivorId] = useState<string | null>(
    initialSelectedIds.length >= 2 ? initialSelectedIds[0] : null,
  );

  // Merged-result draft (see reset semantics above). When the tree carried in a
  // ready selection, seed the draft from it immediately — the panel opens
  // straight on step 2/3 instead of an empty checkbox list.
  const initialPrefill =
    initialSelectedIds.length >= 2
      ? prefillFor(codes, initialSelectedIds, initialSelectedIds[0])
      : null;
  const [literature, setLiterature] = useState(initialPrefill?.literature ?? '');
  const [applied, setApplied] = useState(initialPrefill?.applied ?? '');
  const [includeIf, setIncludeIf] = useState<string[]>(initialPrefill?.includeIf ?? []);
  const [excludeIf, setExcludeIf] = useState<string[]>(initialPrefill?.excludeIf ?? []);
  const [exemplars, setExemplars] = useState<DraftExemplar[]>(initialPrefill?.exemplars ?? []);
  const [counterExample, setCounterExample] = useState(initialPrefill?.counterExample ?? '');
  const [changeNote, setChangeNote] = useState(initialPrefill?.changeNote ?? '');

  // Two-click commit: first click arms, second fires. Esc / click-away disarms.
  const [armed, setArmed] = useState(false);
  const confirmRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!armed) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setArmed(false);
    }
    function onMouseDown(e: MouseEvent) {
      if (confirmRef.current && !confirmRef.current.contains(e.target as Node)) {
        setArmed(false);
      }
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [armed]);

  const byId = new Map(codes.map((c) => [c.id, c]));
  const selectedCodes = selected
    .map((id) => byId.get(id))
    .filter((c): c is MergeCode => c !== undefined);
  const survivor = survivorId !== null ? (byId.get(survivorId) ?? null) : null;
  const absorbedIds = selected.filter((id) => id !== survivorId);

  /** Rebuild the draft for a (selection, survivor) pair — the single place the
   *  editor state is written outside the field handlers themselves. */
  function applyPrefill(nextSelected: string[], nextSurvivor: string | null) {
    const p = prefillFor(codes, nextSelected, nextSurvivor);
    setLiterature(p?.literature ?? '');
    setApplied(p?.applied ?? '');
    setIncludeIf(p?.includeIf ?? []);
    setExcludeIf(p?.excludeIf ?? []);
    setExemplars(p?.exemplars ?? []);
    setCounterExample(p?.counterExample ?? '');
    setChangeNote(p?.changeNote ?? '');
  }

  function toggle(id: string) {
    const next = selected.includes(id)
      ? selected.filter((s) => s !== id)
      : [...selected, id];
    // Default survivor = first selected; keep an explicit pick while it remains selected.
    const nextSurvivor =
      survivorId !== null && next.includes(survivorId) ? survivorId : (next[0] ?? null);
    setSelected(next);
    setSurvivorId(nextSurvivor);
    applyPrefill(next, nextSurvivor);
    setArmed(false);
    setError(null);
  }

  function pickSurvivor(id: string) {
    if (id === survivorId) return;
    setSurvivorId(id);
    applyPrefill(selected, id);
    setArmed(false);
    setError(null);
  }

  function editExemplar(idx: number, text: string) {
    setExemplars((xs) => xs.map((x, i) => (i === idx ? { ...x, text } : x)));
  }
  function removeExemplar(idx: number) {
    setExemplars((xs) => xs.filter((_, i) => i !== idx));
  }

  function arm() {
    setError(null);
    if (!applied.trim()) {
      setError('Definition is required.');
      return;
    }
    setArmed(true);
  }

  function commit() {
    if (survivorId === null || absorbedIds.length === 0) return;
    setError(null);

    // Drop exemplar rows whose text was emptied (schema requires text.min(1)).
    const cleanedExemplars: ExemplarT[] = exemplars
      .filter((x) => x.text.trim() !== '')
      .map((x) => ({
        text: x.text.trim(),
        ...(x.source_pid.trim() ? { source_pid: x.source_pid.trim() } : {}),
        ...(x.episode_ref ? { episode_ref: x.episode_ref } : {}),
      }));

    const version: CodeVersionInputT = {
      definition: joinDefinition(literature, applied),
      include_if: includeIf.map((s) => s.trim()).filter(Boolean),
      exclude_if: excludeIf.map((s) => s.trim()).filter(Boolean),
      exemplars: cleanedExemplars,
      ...(counterExample.trim() ? { disconfirming_pattern: counterExample.trim() } : {}),
      ...(changeNote.trim() ? { change_note: changeNote.trim() } : {}),
    };

    startTransition(async () => {
      try {
        await mergeCodes({ survivorId, absorbedIds, version });
        router.push('/codebook');
        router.refresh();
      } catch (err) {
        setArmed(false);
        setError(err instanceof Error ? err.message : 'Merge failed.');
      }
    });
  }

  // @-mention candidates: every live code EXCEPT the ones being merged — the
  // absorbed codes are about to retire, and the survivor citing itself in its
  // own definition says nothing (the editors' convention).
  const mentionables = allCodes.filter((c) => !selected.includes(c.id));

  return (
    <main className="mx-auto max-w-6xl px-6 py-8 space-y-10">
      <header className="space-y-1">
        <h1 className="text-lg font-medium tracking-tight">Merge codes</h1>
        <p className="text-sm text-foreground/50">
          Collapse duplicate codes into one survivor. The others retire; their
          annotations, citations, labels, and comments move to the survivor.
        </p>
      </header>

      {/* STEP 1 — pick the codes to merge */}
      <section className="space-y-2">
        <p className="text-xs uppercase tracking-wider text-foreground/50">
          1 · Select codes ({selected.length} selected — pick at least 2)
        </p>
        {codes.length < 2 && (
          <p className="text-sm text-foreground/40">
            Fewer than two live codes — nothing to merge.
          </p>
        )}
        <ul className="border border-foreground/15 divide-y divide-foreground/10 max-h-80 overflow-y-auto">
          {codes.map((c) => (
            <li key={c.id}>
              <label className="flex items-baseline gap-2 px-2 py-1 cursor-pointer hover:bg-foreground/[0.03]">
                <input
                  type="checkbox"
                  checked={selected.includes(c.id)}
                  disabled={isPending}
                  onChange={() => toggle(c.id)}
                  aria-label={`Select ${c.mnemonic}`}
                />
                <span className="font-mono text-xs shrink-0">{c.mnemonic}</span>
                <span className="text-xs text-foreground/50 truncate">
                  {appliedPreview(c.current?.definition)}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </section>

      {/* STEP 2 — side-by-side, radio picks the survivor */}
      {selected.length >= 2 && (
        <section className="space-y-2">
          <p className="text-xs uppercase tracking-wider text-foreground/50">
            2 · Choose the survivor
          </p>
          <div className="overflow-x-auto">
            <div className="flex gap-4 pb-2">
              {selectedCodes.map((c) => {
                const isSurvivor = c.id === survivorId;
                const def = splitDefinition(c.current?.definition);
                const include = asStringList(c.current?.include_if);
                const exclude = asStringList(c.current?.exclude_if);
                const exs = toDrafts(asExemplarList(c.current?.exemplars));
                return (
                  <div
                    key={c.id}
                    className={`w-72 shrink-0 border p-3 space-y-3 ${
                      isSurvivor ? 'border-foreground/40' : 'border-foreground/15'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="survivor"
                          checked={isSurvivor}
                          disabled={isPending}
                          onChange={() => pickSurvivor(c.id)}
                          aria-label={`Survivor: ${c.mnemonic}`}
                        />
                        <span className="font-mono text-sm">{c.mnemonic}</span>
                      </label>
                      {isSurvivor ? (
                        <span className="text-[10px] uppercase tracking-wider text-foreground/60">
                          survivor
                        </span>
                      ) : (
                        <span className="text-[10px] uppercase tracking-wider text-foreground/40 border border-foreground/15 px-1">
                          will retire
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-foreground/40 font-mono">{c.origin}</p>
                    {def.literature !== null && (
                      <div className="space-y-0.5">
                        <p className="text-[10px] uppercase tracking-wider text-foreground/40">
                          Literature
                        </p>
                        <p className="text-xs text-foreground/50 whitespace-pre-wrap">
                          {def.literature}
                        </p>
                      </div>
                    )}
                    <div className="space-y-0.5">
                      <p className="text-[10px] uppercase tracking-wider text-foreground/40">
                        Definition
                      </p>
                      <p className="text-sm whitespace-pre-wrap">{def.applied || '—'}</p>
                    </div>
                    {include.length > 0 && (
                      <div className="space-y-0.5">
                        <p className="text-[10px] uppercase tracking-wider text-foreground/40">
                          Include if
                        </p>
                        <ul className="space-y-0.5">
                          {include.map((s, i) => (
                            <li key={i} className="text-xs flex gap-1.5">
                              <span className="text-foreground/30 select-none">•</span>
                              <span>{s}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {exclude.length > 0 && (
                      <div className="space-y-0.5">
                        <p className="text-[10px] uppercase tracking-wider text-foreground/40">
                          Exclude if
                        </p>
                        <ul className="space-y-0.5">
                          {exclude.map((s, i) => (
                            <li key={i} className="text-xs flex gap-1.5">
                              <span className="text-foreground/30 select-none">•</span>
                              <span>{s}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {exs.length > 0 && (
                      <div className="space-y-0.5">
                        <p className="text-[10px] uppercase tracking-wider text-foreground/40">
                          Exemplars
                        </p>
                        <ul className="space-y-1">
                          {exs.map((x, i) => (
                            <li key={i} className="text-xs text-foreground/70">
                              “{x.text}”
                              {x.source_pid && (
                                <span className="ml-1 font-mono text-[10px] text-foreground/40">
                                  {x.source_pid}
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {c.current?.disconfirming_pattern && (
                      <div className="space-y-0.5">
                        <p className="text-[10px] uppercase tracking-wider text-foreground/40">
                          Counter-example
                        </p>
                        <p className="text-xs text-foreground/60 whitespace-pre-wrap">
                          {c.current.disconfirming_pattern}
                        </p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      )}

      {/* STEP 3 — the merged result */}
      {selected.length >= 2 && survivor !== null && (
        <section className="space-y-6 border-t border-foreground/15 pt-6">
          <div className="space-y-1">
            <p className="text-xs uppercase tracking-wider text-foreground/50">
              3 · Merged result — becomes {survivor.mnemonic}&apos;s new version
            </p>
            <p className="text-xs text-foreground/40">
              Prefilled from the survivor&apos;s anatomy plus every selected
              code&apos;s exemplars. Switching the survivor (or changing the
              selection) resets these edits.
            </p>
          </div>

          <div className="space-y-1">
            <label className="text-xs uppercase tracking-wider text-foreground/50">
              Literature description
            </label>
            <MentionTextarea
              value={literature}
              disabled={isPending}
              onChange={setLiterature}
              codes={mentionables}
              rows={3}
              placeholder="The theoretical framing from the literature — shown in the codebook, hidden while coding."
              className="w-full border border-foreground/15 px-2 py-1.5 text-sm bg-background"
              aria-label="Literature description"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs uppercase tracking-wider text-foreground/50">
              Definition <span className="text-red-600">*</span>
            </label>
            <MentionTextarea
              value={applied}
              disabled={isPending}
              onChange={setApplied}
              codes={mentionables}
              rows={3}
              placeholder="What the merged code captures — the rule a coder applies. @ mentions another code."
              className="w-full border border-foreground/15 px-2 py-1.5 text-sm bg-background"
              aria-label="Definition"
            />
          </div>

          <div className="grid gap-6 md:grid-cols-2">
            <BulletListEditor
              label="Include if"
              items={includeIf}
              onChange={setIncludeIf}
              disabled={isPending}
              placeholder="Apply this code when…"
            />
            <BulletListEditor
              label="Exclude if"
              items={excludeIf}
              onChange={setExcludeIf}
              disabled={isPending}
              placeholder="Do NOT apply this code when…"
            />
          </div>

          <div className="space-y-2">
            <p className="text-xs uppercase tracking-wider text-foreground/50">
              Exemplars (union of all selected codes)
            </p>
            {exemplars.length === 0 && (
              <p className="text-xs text-foreground/30">No exemplars on any selected code.</p>
            )}
            <ul className="space-y-1.5">
              {exemplars.map((x, idx) => (
                <li key={idx} className="flex items-start gap-1.5">
                  <textarea
                    value={x.text}
                    disabled={isPending}
                    onChange={(e) => editExemplar(idx, e.target.value)}
                    rows={2}
                    className="flex-1 border border-foreground/15 px-2 py-1 text-sm bg-background"
                    aria-label={`Exemplar ${idx + 1} text`}
                  />
                  {x.source_pid && (
                    <span className="font-mono text-[10px] text-foreground/40 pt-1.5 shrink-0">
                      {x.source_pid}
                    </span>
                  )}
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => removeExemplar(idx)}
                    className="px-1 text-xs text-red-600 hover:underline disabled:opacity-50"
                    aria-label={`Remove exemplar ${idx + 1}`}
                    title="Remove exemplar"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="space-y-1">
            <label className="text-xs uppercase tracking-wider text-foreground/50">
              Counter-example
            </label>
            <MentionTextarea
              value={counterExample}
              disabled={isPending}
              onChange={setCounterExample}
              codes={mentionables}
              rows={2}
              placeholder="What evidence would count AGAINST this code applying."
              className="w-full border border-foreground/15 px-2 py-1.5 text-sm bg-background"
              aria-label="Counter-example"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs uppercase tracking-wider text-foreground/50">
              Change note
            </label>
            <input
              value={changeNote}
              disabled={isPending}
              onChange={(e) => setChangeNote(e.target.value)}
              className="w-full border border-foreground/15 px-2 py-1 text-sm bg-background font-mono"
              aria-label="Change note"
            />
          </div>

          <div ref={confirmRef} className="space-y-2 border-t border-foreground/15 pt-4">
            {error && <p className="text-sm text-red-600">{error}</p>}
            {!armed ? (
              <button
                type="button"
                disabled={isPending}
                onClick={arm}
                className="border border-foreground px-3 py-1.5 text-sm hover:bg-foreground hover:text-background transition disabled:opacity-50"
              >
                Merge {selected.length} codes into {survivor.mnemonic}
              </button>
            ) : (
              <button
                type="button"
                disabled={isPending}
                onClick={commit}
                className="border border-red-600 text-red-600 px-3 py-1.5 text-sm hover:bg-red-600 hover:text-background transition disabled:opacity-50"
              >
                {isPending
                  ? 'Merging…'
                  : `Confirm — ${absorbedIds.length} ${
                      absorbedIds.length === 1 ? 'code retires' : 'codes retire'
                    }`}
              </button>
            )}
            {armed && !isPending && (
              <p className="text-xs text-foreground/40">
                Esc or click away to cancel. This retires the absorbed codes and
                moves their references to {survivor.mnemonic}.
              </p>
            )}
          </div>
        </section>
      )}
    </main>
  );
}
