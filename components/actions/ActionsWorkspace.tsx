'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import ImportActionsPanel from '@/components/actions/ImportActionsPanel';
import {
  createAction,
  createMove,
  createObject,
  createQuestion,
  createQuestionOption,
  createRole,
  deleteAction,
  deleteMove,
  deleteObject,
  deleteQuestion,
  deleteQuestionOption,
  deleteRole,
  reorderActions,
  reorderMoves,
  reorderObjects,
  reorderQuestionOptions,
  reorderQuestions,
  reorderRoles,
  updateAction,
  updateMove,
  updateObject,
  updateQuestion,
  updateQuestionOption,
  updateRole,
  type ActionEntry,
  type ActionObject,
  type ActionQuestion,
  type ActionSchema,
} from '@/app/actions/action-schema';
import {
  compositionLabel,
  encodeTrigger,
  groupObjects,
  objectLabel,
  parseTrigger,
  requiredObjectCount,
  triggerLabel,
  validateActionDraft,
  type ActionDraft,
  type AnswerDraft,
  type ObjectRoles,
  type QuestionKind,
} from '@/lib/actions/schema';
import ObjectRolesPicker from '@/components/actions/ObjectRolesPicker';

type Tab = 'moves' | 'objects' | 'roles' | 'questions' | 'actions';

const TABS: { key: Tab; label: string }[] = [
  { key: 'moves', label: 'Moves' },
  { key: 'objects', label: 'Objects' },
  { key: 'roles', label: 'Roles' },
  { key: 'questions', label: 'Questions' },
  { key: 'actions', label: 'Actions' },
];

const INPUT = 'border border-foreground/15 bg-background px-2 py-1 text-sm disabled:opacity-60';
const BTN = 'border border-foreground px-3 py-1 text-sm transition hover:bg-foreground hover:text-background disabled:opacity-50';
const GHOST = 'px-1 text-foreground/40 hover:text-foreground disabled:opacity-30';

/**
 * /actions workspace. Four panels over one loaded schema: the MOVE and OBJECT
 * vocabularies, the extra QUESTIONS (with per-option "what happens next"), and
 * the ACTION catalog composed from them. Same mutation shape as FlagTypeManager:
 * Server Actions from event handlers, `router.refresh()` to re-run the loader,
 * one transition so the whole panel shows a coarse saving state.
 */
export default function ActionsWorkspace({
  codebookId,
  schema,
  canEdit,
  initialTab,
}: {
  codebookId: string;
  schema: ActionSchema;
  canEdit: boolean;
  initialTab: Tab;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(fn: () => Promise<unknown>) {
    setError(null);
    startTransition(async () => {
      try {
        await fn();
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Mutation failed.');
      }
    });
  }

  const disabled = !canEdit || isPending;
  const counts: Record<Tab, number> = {
    moves: schema.moves.length,
    objects: schema.objects.length,
    roles: schema.roles.length,
    questions: schema.questions.length,
    actions: schema.actions.length,
  };

  return (
    <main className="px-6 py-6">
      <header className="mb-4">
        <h1 className="text-lg font-medium tracking-tight">
          Actions{' '}
          {isPending && <span className="text-sm font-normal text-foreground/40">· saving…</span>}
        </h1>
        {!canEdit && <p className="text-sm text-foreground/60">Your account is view-only.</p>}
      </header>

      <nav className="mb-4 flex gap-1 border-b border-foreground/15" aria-label="Action schema sections">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => {
              setTab(t.key);
              setError(null);
            }}
            className={`-mb-px border-b-2 px-3 py-1.5 text-sm transition ${
              tab === t.key
                ? 'border-foreground text-foreground'
                : 'border-transparent text-foreground/55 hover:text-foreground'
            }`}
          >
            {t.label}
            <span className="ml-1.5 font-mono text-[11px] text-foreground/40">{counts[t.key]}</span>
          </button>
        ))}
      </nav>

      {error && (
        <p className="mb-3 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {tab === 'moves' && <MovesPanel codebookId={codebookId} schema={schema} disabled={disabled} canEdit={canEdit} run={run} />}
      {tab === 'objects' && <ObjectsPanel codebookId={codebookId} schema={schema} disabled={disabled} canEdit={canEdit} run={run} />}
      {tab === 'roles' && <RolesPanel codebookId={codebookId} schema={schema} disabled={disabled} canEdit={canEdit} run={run} />}
      {tab === 'questions' && (
        <QuestionsPanel codebookId={codebookId} schema={schema} disabled={disabled} canEdit={canEdit} run={run} />
      )}
      {tab === 'actions' && (
        <ActionsPanel codebookId={codebookId} schema={schema} disabled={disabled} canEdit={canEdit} run={run} />
      )}
    </main>
  );
}

type PanelProps = {
  codebookId: string;
  schema: ActionSchema;
  disabled: boolean;
  canEdit: boolean;
  run: (fn: () => Promise<unknown>) => void;
};

/** ↑ ↓ × for one row in an ordered list. */
function RowControls({
  index,
  length,
  label,
  disabled,
  onMove,
  onDelete,
}: {
  index: number;
  length: number;
  label: string;
  disabled: boolean;
  onMove: (delta: number) => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <button type="button" disabled={disabled || index === 0} onClick={() => onMove(-1)} aria-label={`Move ${label} up`} title="Move up" className={GHOST}>
        ↑
      </button>
      <button type="button" disabled={disabled || index === length - 1} onClick={() => onMove(1)} aria-label={`Move ${label} down`} title="Move down" className={GHOST}>
        ↓
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          if (confirm(`Delete “${label}”?`)) onDelete();
        }}
        aria-label={`Delete ${label}`}
        className="px-1 text-red-600 hover:underline disabled:opacity-50"
      >
        ×
      </button>
    </div>
  );
}

function swapIds(ids: string[], index: number, delta: number): string[] | null {
  const next = index + delta;
  if (next < 0 || next >= ids.length) return null;
  const out = [...ids];
  [out[index], out[next]] = [out[next], out[index]];
  return out;
}

// ---------------------------------------------------------------------------
// Moves
// ---------------------------------------------------------------------------

function MovesPanel({ codebookId, schema, disabled, canEdit, run }: PanelProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [minObjects, setMinObjects] = useState(1);
  const moves = schema.moves;
  const usage = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of schema.actions) for (const id of a.moveIds) m.set(id, (m.get(id) ?? 0) + 1);
    return m;
  }, [schema.actions]);

  return (
    <section>
      {moves.length === 0 ? (
        <p className="mb-6 text-sm text-foreground/50">No moves yet. Add one below.</p>
      ) : (
        <ul className="mb-6 divide-y divide-foreground/10 border border-foreground/15">
          <li className="grid grid-cols-[2rem_12rem_1fr_7rem_5rem] items-center gap-2 px-3 py-1 text-[11px] uppercase tracking-wider text-foreground/45">
            <span />
            <span>name</span>
            <span>description</span>
            <span title="Fewest objects an action with this move must name">min objects</span>
            <span />
          </li>
          {moves.map((m, i) => (
            <li key={m.id} className="grid grid-cols-[2rem_12rem_1fr_7rem_5rem] items-center gap-2 px-3 py-2">
              <span className="font-mono text-xs text-foreground/40">{i + 1}.</span>
              <input
                defaultValue={m.name}
                disabled={disabled}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v && v !== m.name) run(() => updateMove(m.id, { name: v }));
                }}
                className={INPUT}
                aria-label={`Rename move ${m.name}`}
              />
              <input
                defaultValue={m.description ?? ''}
                placeholder="optional description"
                disabled={disabled}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v !== (m.description ?? '')) run(() => updateMove(m.id, { description: v }));
                }}
                className={INPUT}
                aria-label={`Describe move ${m.name}`}
              />
              <input
                type="number"
                min={1}
                step={1}
                defaultValue={m.minObjects}
                disabled={disabled}
                onBlur={(e) => {
                  const v = Math.max(1, Math.floor(Number(e.target.value) || 1));
                  if (v !== m.minObjects) run(() => updateMove(m.id, { minObjects: v }));
                  else e.target.value = String(m.minObjects);
                }}
                className={`${INPUT} w-20`}
                aria-label={`Minimum objects for ${m.name}`}
              />
              <div className="flex items-center justify-end gap-2">
                {usage.get(m.id) ? (
                  <span className="font-mono text-[10px] text-foreground/40" title="actions using this move">
                    ×{usage.get(m.id)}
                  </span>
                ) : null}
                <RowControls
                  index={i}
                  length={moves.length}
                  label={m.name}
                  disabled={disabled}
                  onMove={(d) => {
                    const ids = swapIds(moves.map((x) => x.id), i, d);
                    if (ids) run(() => reorderMoves(ids));
                  }}
                  onDelete={() => run(() => deleteMove(m.id))}
                />
              </div>
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        <div className="border-t border-foreground/10 pt-4">
          <p className="mb-2 text-xs uppercase tracking-wider text-foreground/50">New move</p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-foreground/50">name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Revise" disabled={disabled} className={`${INPUT} w-44`} aria-label="New move name" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-foreground/50">description (optional)</span>
              <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Change an existing…" disabled={disabled} className={`${INPUT} w-72`} aria-label="New move description" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-foreground/50">min objects</span>
              <input type="number" min={1} step={1} value={minObjects} onChange={(e) => setMinObjects(Math.max(1, Math.floor(Number(e.target.value) || 1)))} disabled={disabled} className={`${INPUT} w-20`} aria-label="New move minimum objects" />
            </label>
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                if (!name.trim()) return;
                run(async () => {
                  await createMove(codebookId, { name, description, minObjects });
                  setName('');
                  setDescription('');
                  setMinObjects(1);
                });
              }}
              className={BTN}
            >
              Add move
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

/**
 * Object vocabulary as a one-level tree: top-level objects with their
 * SUBCLASSES indented beneath (e.g. Scenario › Given scenario / User story).
 * A subclass is a full object — it is picked and counted like any other — the
 * parent only groups and labels it.
 */
function ObjectsPanel({ codebookId, schema, disabled, canEdit, run }: PanelProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [parentId, setParentId] = useState('');
  const objects = schema.objects;
  const groups = useMemo(() => groupObjects(objects), [objects]);
  const usage = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of schema.actions) for (const id of a.objectIds) m.set(id, (m.get(id) ?? 0) + 1);
    return m;
  }, [schema.actions]);
  const roots = groups.map((g) => g.root);

  return (
    <section>
      {objects.length === 0 ? (
        <p className="mb-6 text-sm text-foreground/50">No objects yet. Add one below.</p>
      ) : (
        <ul className="mb-6 divide-y divide-foreground/10 border border-foreground/15">
          <li className="grid grid-cols-[2rem_12rem_1fr_11rem_5rem] items-center gap-2 px-3 py-1 text-[11px] uppercase tracking-wider text-foreground/45">
            <span />
            <span>name</span>
            <span>description</span>
            <span title="A subclass sits under a top-level object">subclass of</span>
            <span />
          </li>
          {groups.map((g, gi) => (
            <li key={g.root.id} className="py-1">
              <ObjectRow
                object={g.root}
                index={gi}
                siblings={roots}
                numeral={`${gi + 1}.`}
                depth={0}
                roots={roots}
                hasChildren={g.children.length > 0}
                usage={usage.get(g.root.id)}
                disabled={disabled}
                run={run}
              />
              {g.children.map((c, ci) => (
                <ObjectRow
                  key={c.id}
                  object={c}
                  index={ci}
                  siblings={g.children}
                  numeral={`${gi + 1}.${ci + 1}`}
                  depth={1}
                  roots={roots}
                  hasChildren={false}
                  usage={usage.get(c.id)}
                  disabled={disabled}
                  run={run}
                />
              ))}
              {canEdit && (
                <SubclassAdder codebookId={codebookId} parent={g.root} disabled={disabled} run={run} />
              )}
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        <div className="border-t border-foreground/10 pt-4">
          <p className="mb-2 text-xs uppercase tracking-wider text-foreground/50">New object</p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-foreground/50">name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Entity" disabled={disabled} className={`${INPUT} w-44`} aria-label="New object name" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-foreground/50">description (optional)</span>
              <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="A thing in the domain…" disabled={disabled} className={`${INPUT} w-72`} aria-label="New object description" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-foreground/50">subclass of (optional)</span>
              <select value={parentId} onChange={(e) => setParentId(e.target.value)} disabled={disabled} className={INPUT} aria-label="New object parent">
                <option value="">— top-level —</option>
                {roots.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                if (!name.trim()) return;
                run(async () => {
                  await createObject(codebookId, { name, description, parentId: parentId || null });
                  setName('');
                  setDescription('');
                  setParentId('');
                });
              }}
              className={BTN}
            >
              Add object
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/** One object row (top-level or subclass): name, description, parent select, controls. */
function ObjectRow({
  object: o,
  index,
  siblings,
  numeral,
  depth,
  roots,
  hasChildren,
  usage,
  disabled,
  run,
}: {
  object: ActionObject;
  index: number;
  siblings: ActionObject[];
  numeral: string;
  depth: 0 | 1;
  roots: ActionObject[];
  hasChildren: boolean;
  usage: number | undefined;
  disabled: boolean;
  run: PanelProps['run'];
}) {
  const parentCandidates = roots.filter((r) => r.id !== o.id);
  return (
    <div className={`grid grid-cols-[2rem_12rem_1fr_11rem_5rem] items-center gap-2 px-3 py-1 ${depth === 1 ? 'pl-3' : ''}`}>
      <span className="font-mono text-xs text-foreground/40">{depth === 1 ? `› ${numeral}` : numeral}</span>
      <input
        defaultValue={o.name}
        disabled={disabled}
        onBlur={(e) => {
          const v = e.target.value.trim();
          if (v && v !== o.name) run(() => updateObject(o.id, { name: v }));
        }}
        className={`${INPUT} ${depth === 1 ? 'ml-3' : ''}`}
        aria-label={`Rename object ${o.name}`}
      />
      <input
        defaultValue={o.description ?? ''}
        placeholder="optional description"
        disabled={disabled}
        onBlur={(e) => {
          const v = e.target.value.trim();
          if (v !== (o.description ?? '')) run(() => updateObject(o.id, { description: v }));
        }}
        className={INPUT}
        aria-label={`Describe object ${o.name}`}
      />
      <select
        value={o.parentId ?? ''}
        disabled={disabled || hasChildren}
        title={hasChildren ? 'Has subclasses of its own, so it stays top-level' : 'Move under a top-level object, or promote to top level'}
        onChange={(e) => run(() => updateObject(o.id, { parentId: e.target.value || null }))}
        className={INPUT}
        aria-label={`Parent of object ${o.name}`}
      >
        <option value="">— top-level —</option>
        {parentCandidates.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </select>
      <div className="flex items-center justify-end gap-2">
        {usage ? (
          <span className="font-mono text-[10px] text-foreground/40" title="actions using this object">
            ×{usage}
          </span>
        ) : null}
        <RowControls
          index={index}
          length={siblings.length}
          label={hasChildren ? `${o.name} (its subclasses become top-level)` : o.name}
          disabled={disabled}
          onMove={(d) => {
            const ids = swapIds(siblings.map((x) => x.id), index, d);
            if (ids) run(() => reorderObjects(ids));
          }}
          onDelete={() => run(() => deleteObject(o.id))}
        />
      </div>
    </div>
  );
}

/** Inline "+ subclass" input under a top-level object. */
function SubclassAdder({
  codebookId,
  parent,
  disabled,
  run,
}: {
  codebookId: string;
  parent: ActionObject;
  disabled: boolean;
  run: PanelProps['run'];
}) {
  const [name, setName] = useState('');
  function submit() {
    if (!name.trim()) return;
    run(async () => {
      await createObject(codebookId, { name, parentId: parent.id });
      setName('');
    });
  }
  return (
    <div className="flex items-center gap-2 py-1 pl-[3.75rem]">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={`New subclass of ${parent.name}`}
        disabled={disabled}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
        }}
        className={`${INPUT} w-48 py-0.5 text-xs`}
        aria-label={`New subclass of ${parent.name}`}
      />
      <button type="button" disabled={disabled || !name.trim()} onClick={submit} className={`${BTN} py-0.5 text-xs`}>
        Add subclass
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

/**
 * The ROLE vocabulary as a plain bulleted list: one bullet per role, each with
 * a name and an optional description. This is only the list — which object
 * plays which role inside an action is assigned later. Enter in the add box
 * appends a bullet and keeps focus, so a list can be typed out in one go.
 */
function RolesPanel({ codebookId, schema, disabled, canEdit, run }: PanelProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const roles = schema.roles;

  function submit() {
    if (!name.trim()) return;
    run(async () => {
      await createRole(codebookId, { name, description });
      setName('');
      setDescription('');
    });
  }

  return (
    <section>
      {roles.length === 0 ? (
        <p className="mb-6 text-sm text-foreground/50">No roles yet. Add one below.</p>
      ) : (
        <ul className="mb-6 border border-foreground/15 px-3 py-2" aria-label="Roles">
          {roles.map((r, i) => (
            <li key={r.id} className="grid grid-cols-[1.25rem_12rem_1fr_5rem] items-center gap-2 py-1">
              <span aria-hidden className="text-center text-foreground/50">•</span>
              <input
                defaultValue={r.name}
                disabled={disabled}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v && v !== r.name) run(() => updateRole(r.id, { name: v }));
                  else if (!v) e.target.value = r.name;
                }}
                className={INPUT}
                aria-label={`Rename role ${r.name}`}
              />
              <input
                defaultValue={r.description ?? ''}
                placeholder="optional description"
                disabled={disabled}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v !== (r.description ?? '')) run(() => updateRole(r.id, { description: v }));
                }}
                className={INPUT}
                aria-label={`Describe role ${r.name}`}
              />
              <div className="flex items-center justify-end">
                <RowControls
                  index={i}
                  length={roles.length}
                  label={r.name}
                  disabled={disabled}
                  onMove={(d) => {
                    const ids = swapIds(roles.map((x) => x.id), i, d);
                    if (ids) run(() => reorderRoles(ids));
                  }}
                  onDelete={() => run(() => deleteRole(r.id))}
                />
              </div>
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        <div className="border-t border-foreground/10 pt-4">
          <p className="mb-2 text-xs uppercase tracking-wider text-foreground/50">New role</p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-foreground/50">name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Source"
                disabled={disabled}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    submit();
                  }
                }}
                className={`${INPUT} w-44`}
                aria-label="New role name"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-foreground/50">description (optional)</span>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="The object the move starts from…"
                disabled={disabled}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    submit();
                  }
                }}
                className={`${INPUT} w-72`}
                aria-label="New role description"
              />
            </label>
            <button type="button" disabled={disabled || !name.trim()} onClick={submit} className={BTN}>
              Add role
            </button>
            <span className="pb-1 text-xs text-foreground/45">Enter adds and keeps typing.</span>
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

function QuestionsPanel({ codebookId, schema, disabled, canEdit, run }: PanelProps) {
  const [prompt, setPrompt] = useState('');
  const [description, setDescription] = useState('');
  const [kind, setKind] = useState<QuestionKind>('free_text');
  const [required, setRequired] = useState(false);
  const questions = schema.questions;

  return (
    <section>
      {questions.length === 0 ? (
        <p className="mb-6 text-sm text-foreground/50">No questions yet. Add one below.</p>
      ) : (
        <ul className="mb-6 space-y-3">
          {questions.map((q, i) => (
            <li key={q.id} className="border border-foreground/15 px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="w-6 font-mono text-xs text-foreground/40">{i + 1}.</span>
                <input
                  defaultValue={q.prompt}
                  disabled={disabled}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v && v !== q.prompt) run(() => updateQuestion(q.id, { prompt: v }));
                  }}
                  className={`${INPUT} flex-1`}
                  aria-label={`Edit question ${q.prompt}`}
                />
                <select
                  value={q.kind}
                  disabled={disabled}
                  onChange={(e) => run(() => updateQuestion(q.id, { kind: e.target.value as QuestionKind }))}
                  className={INPUT}
                  aria-label={`Answer type for ${q.prompt}`}
                >
                  <option value="free_text">free text</option>
                  <option value="multiple_choice">multiple choice</option>
                </select>
                <label className="flex items-center gap-1 text-xs text-foreground/70" title="Must be answered when an action is created">
                  <input
                    type="checkbox"
                    checked={q.required}
                    disabled={disabled}
                    onChange={(e) => run(() => updateQuestion(q.id, { required: e.target.checked }))}
                  />
                  mandatory
                </label>
                <RowControls
                  index={i}
                  length={questions.length}
                  label={q.prompt}
                  disabled={disabled}
                  onMove={(d) => {
                    const ids = swapIds(questions.map((x) => x.id), i, d);
                    if (ids) run(() => reorderQuestions(ids));
                  }}
                  onDelete={() => run(() => deleteQuestion(q.id))}
                />
              </div>
              <div className="mt-1 pl-8">
                <input
                  defaultValue={q.description ?? ''}
                  placeholder="optional description / coder guidance"
                  disabled={disabled}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v !== (q.description ?? '')) run(() => updateQuestion(q.id, { description: v }));
                  }}
                  className={`${INPUT} w-full`}
                  aria-label={`Describe question ${q.prompt}`}
                />
              </div>
              {q.kind === 'multiple_choice' && (
                <OptionsEditor question={q} schema={schema} disabled={disabled} canEdit={canEdit} run={run} />
              )}
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        <div className="border-t border-foreground/10 pt-4">
          <p className="mb-2 text-xs uppercase tracking-wider text-foreground/50">New question</p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-foreground/50">prompt</span>
              <input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Did external factors play a role?" disabled={disabled} className={`${INPUT} w-72`} aria-label="New question prompt" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-foreground/50">description (optional)</span>
              <input value={description} onChange={(e) => setDescription(e.target.value)} disabled={disabled} className={`${INPUT} w-56`} aria-label="New question description" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-foreground/50">answer type</span>
              <select value={kind} onChange={(e) => setKind(e.target.value as QuestionKind)} disabled={disabled} className={INPUT} aria-label="New question answer type">
                <option value="free_text">free text</option>
                <option value="multiple_choice">multiple choice</option>
              </select>
            </label>
            <label className="flex items-center gap-1 self-center pb-1 text-xs text-foreground/70">
              <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} disabled={disabled} />
              mandatory
            </label>
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                if (!prompt.trim()) return;
                run(async () => {
                  await createQuestion(codebookId, { prompt, description, kind, required });
                  setPrompt('');
                  setDescription('');
                  setKind('free_text');
                  setRequired(false);
                });
              }}
              className={BTN}
            >
              Add question
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/** The choices of a multiple_choice question, each with "then → trigger / follow-up". */
function OptionsEditor({
  question,
  schema,
  disabled,
  canEdit,
  run,
}: {
  question: ActionQuestion;
  schema: ActionSchema;
  disabled: boolean;
  canEdit: boolean;
  run: PanelProps['run'];
}) {
  const [label, setLabel] = useState('');
  const options = question.options;
  const otherQuestions = schema.questions.filter((q) => q.id !== question.id);

  return (
    <div className="mt-2 pl-8">
      <p className="mb-1 text-[11px] uppercase tracking-wider text-foreground/45">
        choices · each may trigger an action, object, or move and/or ask a follow-up
      </p>
      {options.length === 0 && (
        <p className="mb-1 text-xs text-foreground/50">No choices yet — a multiple-choice question needs at least one.</p>
      )}
      <ul className="divide-y divide-foreground/10 border border-foreground/10">
        {options.map((o, i) => (
          <li key={o.id} className="flex flex-wrap items-center gap-2 px-2 py-1.5">
            <span className="font-mono text-[10px] text-foreground/40">{String.fromCharCode(97 + i)})</span>
            <input
              defaultValue={o.label}
              disabled={disabled}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && v !== o.label) run(() => updateQuestionOption(o.id, { label: v }));
              }}
              className={`${INPUT} w-40`}
              aria-label={`Edit choice ${o.label}`}
            />
            <span className="text-xs text-foreground/50">then →</span>
            <label className="flex items-center gap-1 text-xs text-foreground/70">
              triggers
              <select
                value={encodeTrigger(o.trigger)}
                disabled={disabled}
                onChange={(e) => run(() => updateQuestionOption(o.id, { trigger: parseTrigger(e.target.value) }))}
                className={INPUT}
                aria-label={`Triggered by ${o.label}`}
              >
                <option value="">— nothing —</option>
                <optgroup label={`Actions${schema.actions.length ? '' : ' (none yet)'}`}>
                  {schema.actions.map((a) => (
                    <option key={a.id} value={encodeTrigger({ kind: 'action', id: a.id })}>
                      {a.name}
                    </option>
                  ))}
                </optgroup>
                <optgroup label={`Objects${schema.objects.length ? '' : ' (none yet)'}`}>
                  {schema.objects.map((ob) => (
                    <option key={ob.id} value={encodeTrigger({ kind: 'object', id: ob.id })}>
                      {objectLabel(schema.objects, ob.id)}
                    </option>
                  ))}
                </optgroup>
                <optgroup label={`Moves${schema.moves.length ? '' : ' (none yet)'}`}>
                  {schema.moves.map((m) => (
                    <option key={m.id} value={encodeTrigger({ kind: 'move', id: m.id })}>
                      {m.name}
                    </option>
                  ))}
                </optgroup>
              </select>
            </label>
            <label className="flex items-center gap-1 text-xs text-foreground/70">
              follow-up
              <select
                value={o.followUpQuestionId ?? ''}
                disabled={disabled}
                onChange={(e) => run(() => updateQuestionOption(o.id, { followUpQuestionId: e.target.value || null }))}
                className={INPUT}
                aria-label={`Follow-up question for ${o.label}`}
              >
                <option value="">— none —</option>
                {otherQuestions.map((q) => (
                  <option key={q.id} value={q.id}>
                    {q.prompt}
                  </option>
                ))}
              </select>
            </label>
            <span className="ml-auto">
              <RowControls
                index={i}
                length={options.length}
                label={o.label}
                disabled={disabled}
                onMove={(d) => {
                  const ids = swapIds(options.map((x) => x.id), i, d);
                  if (ids) run(() => reorderQuestionOptions(ids));
                }}
                onDelete={() => run(() => deleteQuestionOption(o.id))}
              />
            </span>
          </li>
        ))}
      </ul>
      {canEdit && (
        <div className="mt-1.5 flex items-center gap-2">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="New choice (e.g. Yes)"
            disabled={disabled}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && label.trim()) {
                e.preventDefault();
                run(async () => {
                  await createQuestionOption(question.id, label);
                  setLabel('');
                });
              }
            }}
            className={`${INPUT} w-48`}
            aria-label={`New choice for ${question.prompt}`}
          />
          <button
            type="button"
            disabled={disabled || !label.trim()}
            onClick={() =>
              run(async () => {
                await createQuestionOption(question.id, label);
                setLabel('');
              })
            }
            className={`${BTN} py-0.5 text-xs`}
          >
            Add choice
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function ActionsPanel({ codebookId, schema, disabled, canEdit, run }: PanelProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const editing = editingId ? schema.actions.find((a) => a.id === editingId) ?? null : null;
  const byId = useMemo(() => {
    const questions = new Map(schema.questions.map((q) => [q.id, q]));
    return { questions };
  }, [schema]);

  const vocabReady = schema.moves.length > 0 && schema.objects.length > 0;

  return (
    <section>
      {!vocabReady && (
        <p className="mb-4 text-sm text-foreground/60">
          Define at least one move and one object before composing actions.
        </p>
      )}

      {schema.actions.length === 0 ? (
        <p className="mb-6 text-sm text-foreground/50">No actions yet.</p>
      ) : (
        <ul className="mb-6 divide-y divide-foreground/10 border border-foreground/15">
          {schema.actions.map((a, i) => (
            <li key={a.id} className="px-3 py-2">
              <div className="flex items-start gap-2">
                <span className="w-6 pt-0.5 font-mono text-xs text-foreground/40">{i + 1}.</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-sm font-medium">{a.name}</span>
                    <span className="text-xs text-foreground/60">{compositionLabel(a, schema)}</span>
                  </div>
                  {a.description && <p className="text-xs text-foreground/60">{a.description}</p>}
                  {a.answers.length > 0 && (
                    <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                      {a.answers.map((ans) => {
                        const q = byId.questions.get(ans.questionId);
                        if (!q) return null;
                        const opt = ans.optionId ? q.options.find((o) => o.id === ans.optionId) : null;
                        const trig = triggerLabel(opt?.trigger, schema);
                        return (
                          <div key={ans.questionId} className="contents">
                            <dt className="text-foreground/50">{q.prompt}</dt>
                            <dd>
                              {opt ? opt.label : ans.freeText}
                              {trig && <span className="text-foreground/50"> → triggers {trig}</span>}
                            </dd>
                          </div>
                        );
                      })}
                    </dl>
                  )}
                </div>
                {canEdit && (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      setComposing(false);
                      setEditingId(editingId === a.id ? null : a.id);
                    }}
                    className="text-xs text-foreground/60 hover:text-foreground disabled:opacity-50"
                  >
                    {editingId === a.id ? 'close' : 'edit'}
                  </button>
                )}
                <RowControls
                  index={i}
                  length={schema.actions.length}
                  label={a.name}
                  disabled={disabled}
                  onMove={(d) => {
                    const ids = swapIds(schema.actions.map((x) => x.id), i, d);
                    if (ids) run(() => reorderActions(ids));
                  }}
                  onDelete={() => {
                    if (editingId === a.id) setEditingId(null);
                    run(() => deleteAction(a.id));
                  }}
                />
              </div>
              {editing && editing.id === a.id && (
                <div className="mt-2 border-t border-foreground/10 pt-3">
                  <ActionForm
                    key={a.id}
                    schema={schema}
                    initial={editing}
                    disabled={disabled}
                    onCancel={() => setEditingId(null)}
                    onSubmit={(draft) =>
                      run(async () => {
                        await updateAction(a.id, codebookId, draft);
                        setEditingId(null);
                      })
                    }
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        <div className="border-t border-foreground/10 pt-4">
          {composing ? (
            <>
              <p className="mb-2 text-xs uppercase tracking-wider text-foreground/50">New action</p>
              <ActionForm
                key="new"
                schema={schema}
                initial={null}
                disabled={disabled}
                onCancel={() => setComposing(false)}
                onSubmit={(draft) =>
                  run(async () => {
                    await createAction(codebookId, draft);
                    setComposing(false);
                  })
                }
              />
            </>
          ) : (
            <button
              type="button"
              disabled={disabled || !vocabReady}
              onClick={() => {
                setEditingId(null);
                setComposing(true);
              }}
              className={BTN}
            >
              New action
            </button>
          )}
          <ImportActionsPanel codebookId={codebookId} disabled={disabled || !vocabReady} />
        </div>
      )}
    </section>
  );
}

/** Create/edit form for one action: name, description, move, objects (each
 *  with an optional role), answers. */
function ActionForm({
  schema,
  initial,
  disabled,
  onCancel,
  onSubmit,
}: {
  schema: ActionSchema;
  initial: ActionEntry | null;
  disabled: boolean;
  onCancel: () => void;
  onSubmit: (draft: ActionDraft) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [moveIds, setMoveIds] = useState<string[]>(initial?.moveIds ?? []);
  const [objectIds, setObjectIds] = useState<string[]>(initial?.objectIds ?? []);
  const [objectRoles, setObjectRoles] = useState<ObjectRoles>(initial?.objectRoles ?? {});
  const [answers, setAnswers] = useState<Record<string, AnswerDraft>>(() => {
    const out: Record<string, AnswerDraft> = {};
    for (const a of initial?.answers ?? []) out[a.questionId] = { optionId: a.optionId, text: a.freeText };
    return out;
  });
  const [touched, setTouched] = useState(false);

  const draft: ActionDraft = { name, description, moveIds, objectIds, objectRoles, answers };
  const moveLites = schema.moves.map((m) => ({ id: m.id, name: m.name, minObjects: m.minObjects }));
  const qLites = schema.questions.map((q) => ({
    id: q.id,
    prompt: q.prompt,
    kind: q.kind,
    required: q.required,
    options: q.options.map((o) => ({ id: o.id, label: o.label })),
  }));
  const problems = validateActionDraft(draft, moveLites, qLites, schema.roles);
  const need = requiredObjectCount(moveLites, moveIds);
  const byId = {
    questions: new Map(schema.questions.map((q) => [q.id, q])),
  };

  function toggle(list: string[], id: string): string[] {
    return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (problems.length === 0) onSubmit(draft);
      }}
    >
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-foreground/50">name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Create entity" disabled={disabled} className={`${INPUT} w-56`} aria-label="Action name" />
        </label>
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-[11px] text-foreground/50">description (optional)</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="When the participant…" disabled={disabled} className={`${INPUT} w-full`} aria-label="Action description" />
        </label>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <fieldset className="border border-foreground/15 p-3">
          <legend className="px-1 text-[11px] uppercase tracking-wider text-foreground/50">
            move <span className="normal-case tracking-normal text-foreground/40">· pick one; two moves at once = two actions</span>
          </legend>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Move">
            {schema.moves.map((m) => (
              <label key={m.id} className={`flex cursor-pointer items-center gap-1.5 border px-2 py-1 text-sm ${moveIds.includes(m.id) ? 'border-foreground bg-foreground/5' : 'border-foreground/15'}`} title={m.description ?? undefined}>
                <input type="radio" name="action-composer-move" checked={moveIds.includes(m.id)} disabled={disabled} onChange={() => setMoveIds([m.id])} className="sr-only" />
                {m.name}
                {m.minObjects > 1 && <span className="font-mono text-[10px] text-foreground/45">≥{m.minObjects}</span>}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="border border-foreground/15 p-3">
          <legend className="px-1 text-[11px] uppercase tracking-wider text-foreground/50">
            objects <span className="normal-case tracking-normal text-foreground/40">· need ≥ {need}, {objectIds.length} picked</span>
          </legend>
          <div className="flex flex-wrap gap-2">
            {groupObjects(schema.objects).map((g) => {
              const chip = (o: ActionObject, sub: boolean) => (
                <label key={o.id} className={`flex cursor-pointer items-center gap-1.5 border px-2 py-1 text-sm ${objectIds.includes(o.id) ? 'border-foreground bg-foreground/5' : 'border-foreground/15'}`} title={o.description ?? undefined}>
                  <input type="checkbox" checked={objectIds.includes(o.id)} disabled={disabled} onChange={() => setObjectIds((l) => toggle(l, o.id))} className="sr-only" />
                  {sub && <span className="text-foreground/40">›</span>}
                  {o.name}
                </label>
              );
              if (g.children.length === 0) return chip(g.root, false);
              return (
                <span key={g.root.id} className="flex flex-wrap items-center gap-1 border border-dashed border-foreground/15 p-1" title={`${g.root.name} and its subclasses`}>
                  {chip(g.root, false)}
                  {g.children.map((c) => chip(c, true))}
                </span>
              );
            })}
          </div>
        </fieldset>
      </div>

      <ObjectRolesPicker
        objectIds={objectIds}
        objects={schema.objects}
        roles={schema.roles}
        value={objectRoles}
        onChange={setObjectRoles}
        disabled={disabled}
      />

      {schema.questions.length > 0 && (
        <fieldset className="border border-foreground/15 p-3">
          <legend className="px-1 text-[11px] uppercase tracking-wider text-foreground/50">questions</legend>
          <div className="space-y-3">
            {schema.questions.map((q) => {
              const a = answers[q.id];
              const chosen = q.kind === 'multiple_choice' && a?.optionId ? q.options.find((o) => o.id === a.optionId) : null;
              const followUp = chosen?.followUpQuestionId ? byId.questions.get(chosen.followUpQuestionId) : null;
              const trig = triggerLabel(chosen?.trigger, schema);
              return (
                <div key={q.id}>
                  <label className="block text-sm">
                    {q.prompt}
                    {q.required && <span className="text-red-600" title="mandatory"> *</span>}
                    {q.description && <span className="block text-xs text-foreground/50">{q.description}</span>}
                    {q.kind === 'multiple_choice' ? (
                      <select
                        value={a?.optionId ?? ''}
                        disabled={disabled}
                        onChange={(e) => setAnswers((s) => ({ ...s, [q.id]: { optionId: e.target.value || null } }))}
                        className={`${INPUT} mt-1 block`}
                      >
                        <option value="">— unanswered —</option>
                        {q.options.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        value={a?.text ?? ''}
                        disabled={disabled}
                        onChange={(e) => setAnswers((s) => ({ ...s, [q.id]: { text: e.target.value } }))}
                        className={`${INPUT} mt-1 block w-full`}
                      />
                    )}
                  </label>
                  {(trig || followUp) && (
                    <p className="mt-0.5 text-xs text-foreground/50">
                      {trig && <>→ triggers <span className="text-foreground/80">{trig}</span></>}
                      {trig && followUp && ' · '}
                      {followUp && <>follow-up: <span className="text-foreground/80">{followUp.prompt}</span></>}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </fieldset>
      )}

      {touched && problems.length > 0 && (
        <ul className="text-xs text-red-700">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2">
        <button type="submit" disabled={disabled} className={BTN}>
          {initial ? 'Save action' : 'Create action'}
        </button>
        <button type="button" disabled={disabled} onClick={onCancel} className="px-2 text-sm text-foreground/60 hover:text-foreground">
          Cancel
        </button>
        {!touched && problems.length > 0 && (
          <span className="text-xs text-foreground/45">{problems[0]}</span>
        )}
      </div>
    </form>
  );
}
