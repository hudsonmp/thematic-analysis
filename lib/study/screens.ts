// MIRRORED FROM spec-study-app @ 6b32007 — keep in sync; do not edit semantics.
// Source: spec-study-app/lib/study/screens.ts
import type { Module, ProjectContent } from '@/lib/study/study';

export type ScreenKind =
  | 'pre_system'
  | 'login'
  | 'questionnaire'
  // Generic instruction interstitial
  | 'instructions'
  // Think-aloud worked-example module (display-only)
  | 'warmup_example_intro'
  | 'warmup_example_body'
  | 'warmup_example_revealed'
  // Think-aloud warmup (real)
  | 'warmup_intro'
  | 'warmup_body'
  | 'warmup_revealed'
  // Worked-example task module (display-only, prefilled)
  | 'task_example_intro'
  | 'task_example_initial_spec'
  | 'task_example_scenario_read'
  | 'task_example_scenario_ponder'
  | 'task_example_scenario_revise'
  | 'task_example_single' // consolidated single-screen demo
  // Task / task_warmup (real)
  | 'task_intro'
  | 'task_context'
  | 'task_initial_spec'
  | 'task_scenario_read'
  | 'task_scenario_ponder'
  | 'task_scenario_revise'
  | 'task_scenario_retro' // per-scenario retrospective question (repeats each scenario)
  | 'task_outro' // "done with this task" screen
  // Standalone retrospective report: one screen per question
  | 'retrospective_question';

// Globals: not tied to any module. moduleId is a sentinel '_global', moduleType
// widened with 'global' to keep the Screen shape uniform.
const GLOBAL_KINDS = ['pre_system', 'login', 'questionnaire'] as const;
type GlobalKind = (typeof GLOBAL_KINDS)[number];

export type Screen = {
  key: string;
  moduleId: string;
  moduleType: Module['type'] | 'global';
  moduleNumber: number; // 0 for globals
  moduleLabel: string;
  kind: ScreenKind;
  idx?: number; // scenario index (or question index for retrospective_question)
  subIdx?: number; // per-scenario retrospective question index
  label: string;
  summary: string;
};

// Requirements are shown ONCE, on the initial-spec screen (no separate
// requirements-only screen). `task_context` is retained in the union for
// back-compat but no longer enumerated.
const TASK_STEPS_BASE: ScreenKind[] = ['task_intro', 'task_initial_spec'];

// Worked-example task mirrors the real task's default flow: read → revise,
// no pause-and-ponder screen.
const TASK_EXAMPLE_STEPS_PER_SCENARIO: ScreenKind[] = [
  'task_example_scenario_read',
  'task_example_scenario_revise',
];

function snippet(s: string, max = 80): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

// Short, human kind labels. The participant-facing screen always shows the
// module's own title; these are just the within-module step names used in the
// preview/jump dropdown and the script rail.
export function labelFor(kind: ScreenKind): string {
  switch (kind) {
    case 'pre_system':
      return 'Pre-system';
    case 'login':
      return 'Login / Register';
    case 'questionnaire':
      return 'Questionnaire';
    case 'instructions':
      return 'Instructions';
    case 'warmup_example_intro':
      return 'Intro';
    case 'warmup_example_body':
      return 'Body';
    case 'warmup_example_revealed':
      return 'Reveal';
    case 'warmup_intro':
      return 'Intro';
    case 'warmup_body':
      return 'Body';
    case 'warmup_revealed':
      return 'Reveal';
    case 'task_example_intro':
      return 'Intro';
    case 'task_example_initial_spec':
      return 'Initial spec';
    case 'task_example_scenario_read':
      return 'Scenario read';
    case 'task_example_scenario_ponder':
      return 'Scenario ponder';
    case 'task_example_scenario_revise':
      return 'Scenario revise';
    case 'task_example_single':
      return 'Demo';
    case 'task_intro':
      return 'Intro';
    case 'task_context':
      return 'Context';
    case 'task_initial_spec':
      return 'Requirements & spec';
    case 'task_scenario_read':
      return 'Scenario — read';
    case 'task_scenario_ponder':
      return 'Scenario ponder';
    case 'task_scenario_revise':
      return 'Scenario — revise';
    case 'task_scenario_retro':
      return 'Scenario retrospective';
    case 'task_outro':
      return 'Done';
    case 'retrospective_question':
      return 'Retrospective';
  }
}

const GLOBAL_SUMMARIES: Record<GlobalKind, string> = {
  pre_system: 'Before the participant has joined or logged in — consent, setup, expectations.',
  login: 'Participant is on the / register/login screen.',
  questionnaire: 'Participant is filling out the /onboard questionnaire.',
};

export function enumerateScreens(content: ProjectContent): Screen[] {
  const out: Screen[] = [];

  GLOBAL_KINDS.forEach((kind) => {
    out.push({
      key: `_global:${kind}`,
      moduleId: '_global',
      moduleType: 'global',
      moduleNumber: 0,
      moduleLabel: 'Pre-study',
      kind,
      label: `Pre-study · ${labelFor(kind)}`,
      summary: GLOBAL_SUMMARIES[kind],
    });
  });

  content.modules.forEach((m, mi) => {
    const moduleNumber = mi + 1;
    // The module's own (editable) title is the primary label. Falls back to
    // the type label only when the researcher left the title blank.
    const title = 'title' in m && m.title ? m.title : labelForModuleType(m.type);
    const push = (kind: ScreenKind, extra: Partial<Screen> = {}) =>
      out.push({
        key: `${m.id}:${kind}${extra.idx != null ? ':' + extra.idx : ''}${
          extra.subIdx != null ? ':' + extra.subIdx : ''
        }`,
        moduleId: m.id,
        moduleType: m.type,
        moduleNumber,
        moduleLabel: title,
        kind,
        label: `${title} · ${labelFor(kind)}`,
        summary: title,
        ...extra,
      });

    if (m.type === 'instructions') {
      push('instructions', { summary: snippet(m.body || m.title) });
      return;
    }

    if (m.type === 'think_aloud_example') {
      // Two screens: intro, then a single body screen that shows the task +
      // an open answer box together (no separate reveal step).
      push('warmup_example_intro');
      push('warmup_example_body', {
        summary: snippet(m.body || m.taskDescription || m.revealedTask || ''),
      });
      return;
    }

    if (m.type === 'think_aloud_warmup') {
      push('warmup_intro');
      push('warmup_body', {
        summary: snippet(m.body || m.taskDescription || ''),
      });
      push('warmup_revealed', {
        summary: m.revealedTask || '(no revealed task)',
      });
      return;
    }

    if (m.type === 'task_example') {
      // Single-screen demo: one consolidated screen (requirements + first
      // scenario + prefilled spec). Otherwise the multi-screen walkthrough.
      if (m.singleScreen) {
        push('task_example_single', {
          summary: snippet(
            m.scenarios[0]?.clauses.map((c) => `${c.type} ${c.text}`).join('; ') ||
              m.prefilled.initial.spec ||
              '',
          ),
        });
        return;
      }
      push('task_example_intro');
      push('task_example_initial_spec', {
        summary: snippet(m.prefilled.initial.spec || m.initialSpec[0]?.prompt || ''),
      });
      m.scenarios.forEach((sc, idx) => {
        TASK_EXAMPLE_STEPS_PER_SCENARIO.forEach((kind) => {
          push(kind, {
            idx,
            label: `${title} · ${labelFor(kind)} (${sc.title})`,
            summary: snippet(sc.clauses.map((c) => `${c.type} ${c.text}`).join('; ')),
          });
        });
      });
      return;
    }

    if (m.type === 'task' || m.type === 'task_warmup') {
      TASK_STEPS_BASE.forEach((kind) => {
        push(kind, {
          summary:
            kind === 'task_initial_spec'
              ? snippet(m.initialSpec[0]?.prompt ?? '')
              : title,
        });
      });
      // Per-scenario retrospective is a REAL-task feature only (not warmups).
      const retro = m.type === 'task' ? m.perScenarioRetrospective ?? [] : [];
      // Per-scenario screens: a read beat (spec read-only — locate the gap)
      // then a revise beat (spec editable). Separating "decide" from "write"
      // keeps think-aloud on requirement reasoning rather than transcription
      // (VanLehn impasse; Kapur productive failure; Fox/Ericsson/Best 2011).
      // The recall probe, when enabled, inserts a prospective pause between.
      const perScenario: ScreenKind[] = m.enableRecallProbe
        ? ['task_scenario_read', 'task_scenario_ponder', 'task_scenario_revise']
        : ['task_scenario_read', 'task_scenario_revise'];
      m.scenarios.forEach((sc, idx) => {
        perScenario.forEach((kind) => {
          push(kind, {
            idx,
            label: `${title} · ${labelFor(kind)} (${sc.title})`,
            summary: snippet(sc.clauses.map((c) => `${c.type} ${c.text}`).join('; ')),
          });
        });
        // Per-scenario retrospective questions repeat after every scenario.
        retro.forEach((q, qIdx) => {
          push('task_scenario_retro', {
            idx,
            subIdx: qIdx,
            label: `${title} · ${labelFor('task_scenario_retro')} (${sc.title} · Q${qIdx + 1})`,
            summary: snippet(q.text),
          });
        });
      });
      // Optional "done with this task" outro.
      const c = m.copy;
      if (c?.outroTitle?.trim() || c?.outroBody?.trim()) {
        push('task_outro', { summary: snippet(c.outroTitle || c.outroBody || '') });
      }
      return;
    }

    if (m.type === 'retrospective_report') {
      m.questions.forEach((q, idx) => {
        push('retrospective_question', {
          idx,
          label: `${title} · Q${idx + 1}: ${snippet(q.text, 32)}`,
          summary: q.text,
        });
      });
    }
  });
  return out;
}

// Plain-English fallback when a module's title is blank. Kept local so
// screens.ts doesn't depend on MODULE_TYPE_LABEL's exact wording.
function labelForModuleType(type: Module['type']): string {
  switch (type) {
    case 'instructions':
      return 'Instructions';
    case 'think_aloud_warmup':
      return 'Think-aloud warmup';
    case 'think_aloud_example':
      return 'Think-aloud worked example';
    case 'task_warmup':
      return 'Warmup task';
    case 'task_example':
      return 'Worked example task';
    case 'task':
      return 'Task';
    case 'retrospective_report':
      return 'Retrospective';
  }
}
