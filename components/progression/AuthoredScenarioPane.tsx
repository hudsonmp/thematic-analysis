'use client';

import type { Requirement, Scenario } from '@/lib/study/study';

// ---------------------------------------------------------------------------
// The right-hand comparison pane: WHAT THE PARTICIPANT WAS RESPONDING TO at the
// selected step. Requirement step → the authored user stories (role/want/so).
// Scenario step → the authored Gherkin clauses in order; clauses marked `new`
// (added in this scenario — scenarios are cumulative) carry an accent bar +
// "new" chip so the delta the participant saw is visible at a glance. Text
// only by design (spec §1): no map, no seeded markers.
// ---------------------------------------------------------------------------

export function RequirementsPane({ requirements }: { requirements: Requirement[] }) {
  if (requirements.length === 0) {
    return <p className="text-sm italic text-[var(--muted)]">(no authored requirements found)</p>;
  }
  return (
    <ul className="space-y-2">
      {requirements.map((r) => (
        <li key={r.id} className="border border-[var(--rule)] bg-[var(--background)] p-2 text-sm leading-relaxed">
          <span className="font-medium">As a {r.role}</span>
          <span>, I want {r.want}</span>
          <span className="text-foreground/70"> so that {r.so}.</span>
        </li>
      ))}
    </ul>
  );
}

export function ScenarioPane({ scenario }: { scenario: Scenario | null }) {
  if (!scenario) {
    return <p className="text-sm italic text-[var(--muted)]">(no authored scenario at this index)</p>;
  }
  return (
    <div className="space-y-1">
      <h4 className="text-sm font-medium">{scenario.title}</h4>
      <ul className="space-y-1">
        {scenario.clauses.map((c) => (
          <li
            key={c.id}
            className={`flex gap-2 border-l-2 py-0.5 pl-2 text-sm leading-relaxed ${
              c.marker === 'new' ? 'border-emerald-600/70' : 'border-transparent'
            }`}
          >
            <span className="w-12 shrink-0 font-mono text-xs uppercase tracking-wide text-foreground/50 pt-0.5">
              {c.type}
            </span>
            <span className={c.marker === 'superseded' ? 'line-through text-foreground/40' : ''}>
              {c.text}
            </span>
            {c.marker === 'new' && (
              <span className="ml-auto shrink-0 self-start border border-emerald-600/40 px-1 text-[10px] uppercase tracking-wider text-emerald-700">
                new
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
