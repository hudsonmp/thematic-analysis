// MIRRORED FROM spec-study-app @ 6b32007 — keep in sync; do not edit semantics.
// Source: spec-study-app/lib/types/study.ts
// Module-based project shape. A project (DB row in `studies`) has an ordered
// list of modules. Each module is one of three types: think-aloud warmup,
// task warmup, or task. Participants experience modules in order; the editor
// reorders/edits them.

export type ClauseType = 'Given' | 'And' | 'When' | 'Then';

// Per-clause evolution marker. Used in cumulative scenarios where each
// subsequent scenario is a copy of the previous with deltas: `new` chips
// highlight what this scenario adds, `superseded` strikes through clauses
// that are no longer valid. Absent on most clauses (the carried-over ones).
export type ClauseMarker = 'new' | 'superseded';

export type Clause = {
  id: string;
  type: ClauseType;
  text: string;
  marker?: ClauseMarker;
};

export type Requirement = {
  id: string;
  role: string;
  want: string;
  so: string;
};

export type SeededMarkerKind = 'vehicle' | 'person';
export type SeededVehicleColor = 'red' | 'blue' | 'green';
export type SeededPersonLetter = 'A' | 'B' | 'C';

// A marker placed by the researcher at a known landmark for this scenario.
// Position is referenced by landmark label so it survives map-template edits;
// if the landmark is deleted, the marker is rendered at the cityMap.origin.
export type SeededMarker =
  | {
      kind: 'vehicle';
      color: SeededVehicleColor; // label is derived: red=Vehicle 1, blue=Vehicle 2, green=Vehicle 3
      landmarkLabel: string;     // matches CityMapLandmark.label or origin.label
    }
  | {
      kind: 'person';
      letter: SeededPersonLetter; // label derived: Rider A/B/C
      personColor: string;        // hex or palette key, picked by researcher
      landmarkLabel: string;       // PICKUP landmark (rendered as a dot)
      dropoffLandmarkLabel?: string; // DROPOFF landmark (rendered as an X)
    };

export const VEHICLE_COLOR_TO_NUMBER: Record<SeededVehicleColor, 1 | 2 | 3> = {
  red: 1,
  blue: 2,
  green: 3,
};

export const VEHICLE_HEX: Record<SeededVehicleColor, string> = {
  red: '#c44',
  blue: '#36a',
  green: '#3a6',
};

export const PERSON_PALETTE: string[] = ['#d97a3a', '#7d50b8', '#2f9b9b'];

export type Scenario = {
  id: string;
  title: string;
  facilitatorNote: string;
  clauses: Clause[];
  seededMarkers?: SeededMarker[];
};

export type CityMapLandmark = {
  label: string;
  x: number;
  y: number;
  labelDX?: number;
  labelDY?: number;
  labelAnchor?: 'start' | 'middle' | 'end';
};

export type CityMapStreet = {
  name: string;
  from: [number, number];
  to: [number, number];
};

export type CityMap = {
  gridSize: number;
  streets: CityMapStreet[];
  landmarks: CityMapLandmark[];
  origin: CityMapLandmark;
};

export type SpecSubsection = {
  id: string;
  prompt: string;
  boxHeight: number;
};

export type RetrospectiveItem = {
  id: string;
  text: string;
  boxHeight: number;
};

// =========================== Modules ===========================

export type ModuleType =
  | 'instructions'
  | 'think_aloud_warmup'
  | 'think_aloud_example'
  | 'task_warmup'
  | 'task_example'
  | 'task'
  | 'retrospective_report';

// Generic instruction screen — a title + body + Continue. Used for the
// "general instructions" and "task instructions" interstitials in the flow.
// Display-only; collects no participant data.
export type InstructionsModule = {
  id: string;
  type: 'instructions';
  title: string;
  body: string;
  copy?: { continueLabel?: string };
};

// LEGACY shape — was an optional `example` sub-field on warmup/task modules.
// Kept only so migrateContent can read old authored_data and split it into a
// standalone `think_aloud_example` module. Not used by any current module.
export type ThinkAloudExample = {
  altTaskDescription: string;
  altBody: string;
  altRevealedTask: string;
  walkthroughText: string;
};

// Researcher-customizable on-screen copy for the warmup screens. Every field
// is optional; renderers fall back to DEFAULT_WARMUP_COPY when a field is
// absent or empty. Add new keys here when surfacing more strings as editable.
export type ThinkAloudWarmupCopy = {
  introTitle?: string;
  introBody?: string;
  revealButtonLabel?: string;
  postRevealCallout?: string;
  answerInputLabel?: string;
};

export const DEFAULT_WARMUP_COPY: Required<ThinkAloudWarmupCopy> = {
  introTitle: 'Think-Aloud Instructions',
  introBody: 'Please do not move on until directed by the researcher.',
  revealButtonLabel: 'Reveal Task',
  postRevealCallout: 'Remember to think aloud while you solve this.',
  answerInputLabel: 'Your answer',
};

export type ThinkAloudWarmupModule = {
  id: string;
  type: 'think_aloud_warmup';
  title: string;
  taskDescription: string;
  body: string;
  // `revealedTask` is the scrambled prompt shown to the participant (e.g.
  // "DUYTS"). `revealedAnswer` is the unscrambled target ("STUDY") — used
  // only to display an answer-key on the researcher console and to log
  // exact-match for analysis; not required for the runner to function.
  revealedTask: string;
  revealedAnswer: string;
  includeScratchPaper: boolean; // ignored — scratchpad removed; kept for back-compat
  mandatory: boolean;
  copy?: ThinkAloudWarmupCopy;
};

// Worked example of thinking aloud — a FIRST-CLASS module (not a sub-field).
// Structurally identical to a warmup but rendered display-only: the researcher
// narrates while the participant watches. The answer is shown pre-filled
// rather than typed. `walkthroughText` is the researcher's narration.
export type ThinkAloudExampleModule = {
  id: string;
  type: 'think_aloud_example';
  title: string;
  taskDescription: string;
  body: string;
  revealedTask: string;
  revealedAnswer: string;
  walkthroughText: string;
  copy?: ThinkAloudWarmupCopy;
};

// Researcher-customizable on-screen copy for task screens. Every field is
// optional; renderers fall back to DEFAULT_TASK_COPY when a field is absent
// or empty. Per-scenario `ponderCopy` already lives on Scenario.
export type TaskCopy = {
  ponderDefault?: string;
  ponderHoldNote?: string;
  reviseCallout?: string;
  warmupAnnotation?: string;
  realAnnotation?: string;
  // The grey italic caption above the spec textarea. Empty string (set via the
  // editor's clear button) hides the caption entirely.
  specPlaceholder?: string;
  // The "you're done with this task" outro screen shown after the last
  // scenario. Both empty → no outro screen.
  outroTitle?: string;
  outroBody?: string;
};

export const DEFAULT_TASK_COPY: Required<TaskCopy> = {
  // PROSPECTIVE, not retrospective: a forward-looking gap-location prompt is
  // a Level-1/2 (non-reactive) verbalization, whereas "tell me what you
  // remember/were thinking" is a Type-3 retrospective probe that is reactive
  // and fabrication-prone (Fox/Ericsson/Best 2011; Ericsson & Simon 1993).
  ponderDefault:
    'Before you change anything: what does the current specification not yet handle for this scenario, and where would you change it?',
  ponderHoldNote: 'Please do not click Continue until your researcher tells you to.',
  reviseCallout:
    'Your specifications are editable. Continue thinking aloud as you revise them.',
  warmupAnnotation:
    'This is a warmup task. Your responses are not saved or analyzed; they are practice only.',
  realAnnotation:
    'Your responses for this task will be saved and included in the study analysis.',
  specPlaceholder:
    'Specify the rules, types of information, behavior, features, and implementation of the system however feels natural to you. This may include inputs/outputs, data types, pseudocode, prompts to an LLM coding agent, or anything else that feels natural.',
  outroTitle: 'You’ve finished this task',
  outroBody: 'Thank you. The researcher will tell you what comes next.',
};

// Shared task-shaped content. Used by Task, TaskWarmup, and TaskExample.
// `perScenarioRetrospective` is an optional set of reflection questions shown
// AFTER each scenario's revise step (the same questions repeat for every
// scenario). Distinct from the standalone retrospective_report module which
// runs once at the end.
export type TaskContent = {
  title: string;
  studyContext: string;
  requirements: Requirement[];
  cityMap?: CityMap;
  initialSpec: SpecSubsection[];
  scenarios: Scenario[]; // 1-3 enforced by the editor
  perScenarioRetrospective?: RetrospectiveItem[];
  // When true, each scenario inserts a retrospective "pause and recall" screen
  // between reading and revising. Default OFF: this is a Type-3 retrospective
  // probe (reactive — Fox/Ericsson/Best 2011) that contaminates the revised-
  // spec process measure, so it stays off unless the run's DV is learning
  // gains rather than process fidelity. Off → scenarios are a single
  // read-and-revise screen.
  enableRecallProbe?: boolean;
  copy?: TaskCopy;
};

// =========================== Entity / Element table ===========================
// Embedded under the spec textarea on every spec-bearing screen. Researcher
// does not author these for real tasks; the participant fills them in as they
// reason about the system's data model. Persisted alongside the spec. For
// EXAMPLE tasks the researcher authors them as part of the prefilled snapshot.

export type Element = {
  id: string;
  name: string;
};

export type Entity = {
  id: string;
  name: string;
  elements: Element[];
};

// Researcher-authored prefilled snapshot for a single example moment.
// `spec` is the textarea contents shown read-only; `entities` is the table
// shown beside it. Empty arrays / empty strings render as "nothing recorded".
export type PrefilledMoment = {
  spec: string;
  entities: Entity[];
};

// Researcher-authored prefilled state shown at each major moment of the
// example task. Snapshots are display-only — the participant cannot edit on
// example screens. perScenario length must equal example.scenarios.length.
// `ponderCopy` overrides the default ponder text on this scenario's pause;
// undefined / empty means use the default copy with an "(Example — researcher
// narrates)" note.
export type TaskExamplePrefilled = {
  initial: PrefilledMoment;
  perScenario: {
    read: PrefilledMoment;
    revise: PrefilledMoment;
    ponderCopy?: string;
  }[];
};

// TaskContent + researcher-authored prefilled snapshots. Used as the body of
// a TaskExampleModule (a first-class module), and historically as the legacy
// `example` sub-field (migrated away by migrateContent).
export type TaskExample = TaskContent & {
  prefilled: TaskExamplePrefilled;
};

// Worked example task — a FIRST-CLASS module. Renders the task screens
// display-only with prefilled spec/entities at each moment; the researcher
// narrates via `walkthroughText`. When `singleScreen` is true, the demo is
// shown as ONE consolidated screen (requirements + first scenario + prefilled
// spec together) rather than the multi-screen walkthrough.
export type TaskExampleModule = TaskExample & {
  id: string;
  type: 'task_example';
  walkthroughText?: string;
  singleScreen?: boolean;
};

export type RetrospectiveReportModule = {
  id: string;
  type: 'retrospective_report';
  title: string;
  questions: RetrospectiveItem[];
};

export type TaskWarmupModule = {
  id: string;
  type: 'task_warmup';
} & TaskContent;

export type TaskModule = {
  id: string;
  type: 'task';
} & TaskContent;

export type Module =
  | InstructionsModule
  | ThinkAloudWarmupModule
  | ThinkAloudExampleModule
  | TaskWarmupModule
  | TaskExampleModule
  | TaskModule
  | RetrospectiveReportModule;

// =========================== Project ===========================

export type ProjectVisibility = 'shown' | 'hidden' | 'archived';

export type ProjectContent = {
  modules: Module[];
};

// Server-side project record (matches studies row + parsed authored_data)
export type LoadedProject = {
  id: string;
  slug: string;
  name: string;
  visibility: ProjectVisibility;
  content: ProjectContent;
  updated_at: string;
};

// =========================== Helpers ===========================

export const uid = () => Math.random().toString(36).slice(2, 10);

export function emptyContent(): ProjectContent {
  return { modules: [] };
}

export function newInstructionsModule(): InstructionsModule {
  return {
    id: uid(),
    type: 'instructions',
    title: 'Instructions',
    body: '',
  };
}

export function newThinkAloudWarmup(): ThinkAloudWarmupModule {
  return {
    id: uid(),
    type: 'think_aloud_warmup',
    title: 'Think-aloud warmup',
    taskDescription: '',
    body: '',
    // Default anagram: DUYTS → STUDY. Researcher edits in the editor.
    revealedTask: 'DUYTS',
    revealedAnswer: 'STUDY',
    includeScratchPaper: false,
    mandatory: false,
  };
}

function newTaskContent(): TaskContent {
  return {
    title: 'New task',
    studyContext: '',
    requirements: [],
    scenarios: [
      {
        id: uid(),
        title: 'Scenario 1',
        facilitatorNote: '',
        clauses: [
          { id: uid(), type: 'Given', text: '' },
          { id: uid(), type: 'When', text: '' },
          { id: uid(), type: 'Then', text: '' },
        ],
      },
    ],
    initialSpec: [
      {
        id: uid(),
        prompt:
          'Write the rules you believe the system must follow, based on the requirements alone.',
        boxHeight: 2.5,
      },
    ],
  };
}

export function newThinkAloudExampleModule(): ThinkAloudExampleModule {
  return {
    id: uid(),
    type: 'think_aloud_example',
    title: 'Worked example',
    taskDescription: '',
    body: '',
    revealedTask: 'DUYTS',
    revealedAnswer: 'STUDY',
    walkthroughText: '',
  };
}

export function newPrefilledMoment(): PrefilledMoment {
  return { spec: '', entities: [] };
}

export function newPrefilledPerScenario(): TaskExamplePrefilled['perScenario'][number] {
  return {
    read: newPrefilledMoment(),
    revise: newPrefilledMoment(),
    ponderCopy: undefined,
  };
}

export function newTaskExample(scenariosLen = 1): TaskExample {
  const base = newTaskContent();
  // Ensure the example carries `scenariosLen` scenarios so prefilled.perScenario
  // can be authored 1:1 against them. If 0 is passed, force 1.
  const n = Math.max(1, scenariosLen);
  while (base.scenarios.length < n) {
    base.scenarios.push({
      id: uid(),
      title: `Scenario ${base.scenarios.length + 1}`,
      facilitatorNote: '',
      clauses: [
        { id: uid(), type: 'Given', text: '' },
        { id: uid(), type: 'When', text: '' },
        { id: uid(), type: 'Then', text: '' },
      ],
    });
  }
  return {
    ...base,
    prefilled: {
      initial: newPrefilledMoment(),
      perScenario: Array.from({ length: n }, () => newPrefilledPerScenario()),
    },
  };
}

export function newTaskExampleModule(): TaskExampleModule {
  return {
    ...newTaskExample(1),
    id: uid(),
    type: 'task_example',
    title: 'Worked example task',
    walkthroughText: '',
  };
}

export function newRetrospectiveReport(): RetrospectiveReportModule {
  return {
    id: uid(),
    type: 'retrospective_report',
    title: 'Retrospective report',
    questions: [
      {
        id: uid(),
        text: 'Which scenario was hardest to translate into specification rules, and why?',
        boxHeight: 1.1,
      },
    ],
  };
}

export function newTaskWarmup(): TaskWarmupModule {
  return { id: uid(), type: 'task_warmup', ...newTaskContent() };
}

export function newTask(): TaskModule {
  return { id: uid(), type: 'task', ...newTaskContent() };
}

export function newModuleOfType(type: ModuleType): Module {
  switch (type) {
    case 'instructions':
      return newInstructionsModule();
    case 'think_aloud_warmup':
      return newThinkAloudWarmup();
    case 'think_aloud_example':
      return newThinkAloudExampleModule();
    case 'task_warmup':
      return newTaskWarmup();
    case 'task_example':
      return newTaskExampleModule();
    case 'task':
      return newTask();
    case 'retrospective_report':
      return newRetrospectiveReport();
  }
}

// Order here drives the "Add module" dropdown order. Worked examples sit
// next to their non-example counterparts.
export const MODULE_TYPE_LABEL: Record<ModuleType, string> = {
  instructions: 'Instructions screen',
  think_aloud_warmup: 'Think-aloud warmup',
  think_aloud_example: 'Think-aloud worked example',
  task_example: 'Worked example task',
  task_warmup: 'Warmup task',
  task: 'Task',
  retrospective_report: 'Retrospective report',
};

// Whether the participant's responses on this module are saved to the
// long-term DB (study_responses). Task warmups are practice-only and never
// persisted; everything else is. UI-only for V1 (the actual /study route
// will enforce on submit in V2). Worked-example modules are display-only
// walkthroughs and never collect participant data, so they don't persist.
export function isPersistedToDb(type: ModuleType): boolean {
  return (
    type !== 'task_warmup' &&
    type !== 'task_example' &&
    type !== 'think_aloud_example' &&
    type !== 'instructions'
  );
}
