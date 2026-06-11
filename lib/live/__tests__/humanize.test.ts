import { describe, it, expect } from 'vitest';
import { humanizeEvent, type ModuleMeta } from '@/lib/live/humanize';

// Payload shapes below mirror the real study_events rows (verified against the
// VT study DB): step_advance `{from,to}`, module_start `{moduleType,...}`,
// retro_submit `{questionCount}`, etc.

describe('humanizeEvent', () => {
  describe('module_start', () => {
    const meta: ModuleMeta[] = [
      { id: '3g7lg4if', type: 'task', title: 'Rideshare Matching Platform' },
    ];

    it('uses the authored module title when modulesMeta resolves it', () => {
      const label = humanizeEvent(
        { eventType: 'module_start', moduleId: '3g7lg4if', payload: { moduleType: 'task' } },
        meta,
      );
      expect(label).toBe('entered Rideshare Matching Platform');
    });

    it('falls back to the payload moduleType when meta is absent', () => {
      const label = humanizeEvent({
        eventType: 'module_start',
        moduleId: 'unknown',
        payload: { moduleType: 'think_aloud_warmup' },
      });
      expect(label).toBe('entered Think aloud warmup');
    });

    it('falls back to a generic label when neither title nor moduleType exist', () => {
      const label = humanizeEvent({
        eventType: 'module_start',
        moduleId: 'x',
        payload: {},
      });
      expect(label).toBe('entered a module');
    });
  });

  describe('step_advance', () => {
    it('humanizes a scenario phase step (read/ponder/revise)', () => {
      expect(
        humanizeEvent({
          eventType: 'step_advance',
          moduleId: '3g7lg4if',
          payload: { from: 'scenario_2_read', to: 'scenario_2_revise' },
        }),
      ).toBe('Scenario 2 · revise');
    });

    it('humanizes a scenario retro step with a 1-based index', () => {
      expect(
        humanizeEvent({
          eventType: 'step_advance',
          moduleId: '3g7lg4if',
          payload: { from: 'scenario_3_revise', to: 'scenario_3_retro_0' },
        }),
      ).toBe('Scenario 3 · retro 1');
    });

    it('humanizes a standalone retrospective step with a 1-based index', () => {
      expect(
        humanizeEvent({
          eventType: 'step_advance',
          moduleId: 'itnq9unp',
          payload: { from: 'retro_0', to: 'retro_1' },
        }),
      ).toBe('Retrospective 2');
    });

    it('degrades gracefully when the payload has no `to`', () => {
      expect(
        humanizeEvent({
          eventType: 'step_advance',
          moduleId: 'x',
          payload: { from: 'a' },
        }),
      ).toBe('advanced a step');
    });
  });

  describe('edit + map + terminal events', () => {
    const cases: Array<[string, string]> = [
      ['spec_edit', 'editing specification'],
      ['entities_edit', 'editing entities'],
      ['map_vehicle_move', 'moved a vehicle'],
      ['map_marker_add', 'map marker'],
      ['map_marker_relabel', 'map marker'],
      ['retro_submit', 'submitted retrospective'],
      ['study_complete', 'finished'],
    ];

    for (const [eventType, expected] of cases) {
      it(`maps ${eventType} → "${expected}"`, () => {
        expect(
          humanizeEvent({ eventType, moduleId: '3g7lg4if', payload: {} }),
        ).toBe(expected);
      });
    }
  });

  describe('robustness', () => {
    it('falls back to a readable label for an unknown event type', () => {
      expect(
        humanizeEvent({
          eventType: 'some_new_event',
          moduleId: 'x',
          payload: { foo: 1 },
        }),
      ).toBe('some new event');
    });

    it('never throws on a malformed (non-object) payload', () => {
      expect(
        humanizeEvent({ eventType: 'step_advance', moduleId: 'x', payload: null }),
      ).toBe('advanced a step');
      expect(
        humanizeEvent({ eventType: 'module_start', moduleId: 'x', payload: 'oops' }),
      ).toBe('entered a module');
    });
  });
});
