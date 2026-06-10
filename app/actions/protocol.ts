'use server';

import { getShownStudy } from '@/app/actions/codebook';
import { enumerateScreens, type ScreenKind } from '@/lib/study/screens';
import type { ProjectContent } from '@/lib/study/study';
import type { EpisodeRefT } from '@/lib/types/contracts';

/**
 * One taggable protocol moment: a (module, scenario, phase) coordinate a coder
 * can attach an exemplar to. `module_id`/`scenario_idx`/`phase` are exactly the
 * fields of an `EpisodeRef` (minus the optional char span); `module_label` is
 * carried for display so the picker doesn't have to re-derive titles.
 */
export type ProtocolEpisode = {
  module_id: string;
  module_label: string;
  scenario_idx: number;
  phase: EpisodeRefT['phase'];
};

/**
 * Map a study `ScreenKind` to the `EpisodeRef` phase enum, or null for kinds
 * that are NOT taggable task moments (intros, instructions, warmup think-aloud,
 * questionnaire, etc.). Both the real-task kinds (`task_*`) and the worked-
 * example kinds (`task_example_*`) collapse onto the same six phases — a coder
 * tags the cognitive beat (read / ponder / revise / retrospect), independent of
 * whether the screen is a live task or a prefilled demo.
 *
 * `initial`  ← *_initial_spec      (the first spec write, no scenario yet)
 * `read`     ← *_scenario_read      (locate-the-gap beat, spec read-only)
 * `ponder`   ← *_scenario_ponder    (prospective pause; only if recall probe on)
 * `revise`   ← *_scenario_revise    (spec editable)
 * `retro`    ← task_scenario_retro  (per-scenario retrospective question)
 * `final`    ← task_outro           (done-with-task screen)
 */
function phaseForKind(kind: ScreenKind): EpisodeRefT['phase'] | null {
  switch (kind) {
    case 'task_initial_spec':
    case 'task_example_initial_spec':
      return 'initial';
    case 'task_scenario_read':
    case 'task_example_scenario_read':
      return 'read';
    case 'task_scenario_ponder':
    case 'task_example_scenario_ponder':
      return 'ponder';
    case 'task_scenario_revise':
    case 'task_example_scenario_revise':
      return 'revise';
    case 'task_scenario_retro':
      return 'retro';
    case 'task_outro':
      return 'final';
    default:
      return null;
  }
}

/**
 * The taggable episodes of the SHOWN study, for the exemplar episode picker.
 *
 * Reads the shown study's `authored_data` (which IS the `ProjectContent` — its
 * top-level key is `modules`, confirmed against the live row — NOT wrapped in a
 * `.content` field), enumerates its screens, drops the 3 global pre-study
 * screens and every non-task screen (only kinds that map to a phase survive),
 * and collapses each surviving screen to a compact `{module_id, module_label,
 * scenario_idx, phase}`.
 *
 * `scenario_idx` is the screen's `idx` for per-scenario beats; module-level
 * beats (the initial spec, the outro) have no scenario, so they get `0`. The
 * `EpisodeRef` schema requires an integer `scenario_idx`, and 0 is the natural
 * "module, not a specific scenario" sentinel.
 *
 * Per-scenario retrospective screens repeat one row per question (`subIdx`);
 * those collapse to the same `(module, scenario, retro)` triple, so we de-dupe
 * by the full coordinate to keep the picker one-row-per-moment.
 *
 * Returns `[]` if there is no shown study.
 */
export async function getProtocolEpisodes(): Promise<ProtocolEpisode[]> {
  const study = await getShownStudy();
  if (!study) return [];

  // authored_data IS the ProjectContent (top-level `modules`). Cast through the
  // Json type the action returns; enumerateScreens only reads `.modules`.
  const content = study.authored_data as unknown as ProjectContent;
  if (!content || !Array.isArray(content.modules)) return [];

  const screens = enumerateScreens(content);

  const seen = new Set<string>();
  const out: ProtocolEpisode[] = [];
  for (const s of screens) {
    if (s.moduleType === 'global') continue; // drop the 3 pre-study globals
    const phase = phaseForKind(s.kind);
    if (!phase) continue; // non-task / non-taggable screen
    const scenario_idx = s.idx ?? 0; // module-level beats have no scenario
    const dedupeKey = `${s.moduleId}:${scenario_idx}:${phase}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({
      module_id: s.moduleId,
      module_label: s.moduleLabel,
      scenario_idx,
      phase,
    });
  }
  return out;
}
