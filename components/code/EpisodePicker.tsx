'use client';

import { useMemo } from 'react';
import type { ProtocolEpisode } from '@/app/actions/protocol';
import type { EpisodeRefT } from '@/lib/types/contracts';

/**
 * Compact Module → Scenario → Phase selector that produces an `EpisodeRef`
 * (`{module_id, scenario_idx, phase}`) pinning an exemplar to a moment in the
 * study protocol. Optional: the picker carries an explicit "(none)" state so an
 * exemplar can be free-floating (verbatim quote with no protocol anchor).
 *
 * Options are the flat `ProtocolEpisode[]` from `getProtocolEpisodes()`, passed
 * down as props (the page fetches them server-side; clients never call actions
 * during render). We re-derive the dependent dropdowns from that flat list:
 * modules are the distinct module_ids; scenarios/phases are filtered to the
 * current selection so the user can only build a coordinate that actually
 * exists in the protocol.
 */
export default function EpisodePicker({
  episodes,
  value,
  onChange,
  disabled = false,
}: {
  episodes: ProtocolEpisode[];
  value: EpisodeRefT | undefined;
  onChange: (next: EpisodeRefT | undefined) => void;
  disabled?: boolean;
}) {
  // Distinct modules, in first-seen (protocol) order.
  const modules = useMemo(() => {
    const seen = new Map<string, string>();
    for (const e of episodes) if (!seen.has(e.module_id)) seen.set(e.module_id, e.module_label);
    return [...seen.entries()].map(([id, label]) => ({ id, label }));
  }, [episodes]);

  const moduleId = value?.module_id ?? '';
  // Hoisted so the memo below depends on the scalar, not the whole `value`
  // object — keeps the React Compiler's inferred deps aligned with ours.
  const scenarioIdx = value?.scenario_idx ?? null;

  // Scenarios available within the selected module (distinct idx, sorted).
  const scenarios = useMemo(() => {
    if (!moduleId) return [];
    const set = new Set<number>();
    for (const e of episodes) if (e.module_id === moduleId) set.add(e.scenario_idx);
    return [...set].sort((a, b) => a - b);
  }, [episodes, moduleId]);

  // Phases available for the selected (module, scenario).
  const phases = useMemo(() => {
    if (!moduleId || scenarioIdx == null) return [];
    const set = new Set<EpisodeRefT['phase']>();
    for (const e of episodes)
      if (e.module_id === moduleId && e.scenario_idx === scenarioIdx) set.add(e.phase);
    return [...set];
  }, [episodes, moduleId, scenarioIdx]);

  function pickModule(id: string) {
    if (!id) return onChange(undefined);
    const inMod = episodes.filter((e) => e.module_id === id);
    const first = inMod[0];
    if (!first) return onChange(undefined);
    onChange({ module_id: id, scenario_idx: first.scenario_idx, phase: first.phase });
  }
  function pickScenario(idx: number) {
    if (!moduleId) return;
    const inScn = episodes.filter((e) => e.module_id === moduleId && e.scenario_idx === idx);
    const first = inScn[0];
    if (!first) return;
    onChange({ module_id: moduleId, scenario_idx: idx, phase: first.phase });
  }
  function pickPhase(phase: EpisodeRefT['phase']) {
    if (!moduleId || value?.scenario_idx == null) return;
    onChange({ module_id: moduleId, scenario_idx: value.scenario_idx, phase });
  }

  if (episodes.length === 0) {
    return (
      <p className="text-xs text-foreground/30">
        No taggable protocol episodes (the shown study has no task scenarios).
      </p>
    );
  }

  return (
    <div className="flex items-center gap-1.5 flex-wrap text-xs">
      <span className="text-foreground/40">episode:</span>
      <select
        value={moduleId}
        disabled={disabled}
        onChange={(e) => pickModule(e.target.value)}
        className="border border-foreground/15 px-1.5 py-0.5 bg-background"
        aria-label="Episode module"
      >
        <option value="">(none)</option>
        {modules.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
      {moduleId && (
        <>
          <select
            value={value?.scenario_idx ?? ''}
            disabled={disabled}
            onChange={(e) => pickScenario(Number(e.target.value))}
            className="border border-foreground/15 px-1.5 py-0.5 bg-background"
            aria-label="Episode scenario"
          >
            {scenarios.map((idx) => (
              <option key={idx} value={idx}>
                scenario {idx + 1}
              </option>
            ))}
          </select>
          <select
            value={value?.phase ?? ''}
            disabled={disabled}
            onChange={(e) => pickPhase(e.target.value as EpisodeRefT['phase'])}
            className="border border-foreground/15 px-1.5 py-0.5 bg-background"
            aria-label="Episode phase"
          >
            {phases.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange(undefined)}
            className="text-foreground/40 hover:text-foreground"
            aria-label="Clear episode"
            title="Clear episode"
          >
            ×
          </button>
        </>
      )}
    </div>
  );
}
