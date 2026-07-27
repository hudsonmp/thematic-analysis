import { describe, it, expect } from 'vitest';
import {
  speakerKey,
  inferResearcherKeys,
  anonymizeSpeaker,
  seededResearcherKeys,
  SEEDED_RESEARCHER_ALIASES,
  RESEARCHER_LABEL,
} from '../anonymize';

describe('speakerKey', () => {
  it('trims surrounding whitespace and lowercases', () => {
    expect(speakerKey('  Hudson Mitchell-Pullman ')).toBe(
      speakerKey('hudson mitchell-pullman'),
    );
    expect(speakerKey('  Hudson Mitchell-Pullman ')).toBe('hudson mitchell-pullman');
  });

  it('preserves internal whitespace (does not collapse it)', () => {
    expect(speakerKey('Hudson Mitchell Pullman')).not.toBe(
      speakerKey('HudsonMitchellPullman'),
    );
  });
});

describe('anonymizeSpeaker', () => {
  it('maps a seeded interviewer alias to "Researcher"', () => {
    expect(anonymizeSpeaker('HudsonMitchell-P', '067', seededResearcherKeys())).toBe(
      'Researcher',
    );
    expect(RESEARCHER_LABEL).toBe('Researcher');
  });

  it('is case-insensitive when matching researchers', () => {
    expect(anonymizeSpeaker('hudsonmitchell-p', '067', seededResearcherKeys())).toBe(
      'Researcher',
    );
  });

  it('maps a non-researcher speaker to the PID label', () => {
    expect(anonymizeSpeaker('DavidBarron', '067', seededResearcherKeys())).toBe('067');
  });

  it('returns null for a null speaker (single-track transcript)', () => {
    expect(anonymizeSpeaker(null, '067', seededResearcherKeys())).toBeNull();
  });

  it('returns null for a whitespace-only speaker (no label)', () => {
    expect(anonymizeSpeaker('  ', '067', seededResearcherKeys())).toBeNull();
  });

  it('returns null for an empty-string speaker', () => {
    expect(anonymizeSpeaker('', '067', seededResearcherKeys())).toBeNull();
  });

  it('anonymizes a cross-session-recurrence researcher key supplied by the caller', () => {
    // Simulates sessions.ts unioning an extra interviewer alias discovered via
    // cross-session recurrence into the researcher set.
    const keys = seededResearcherKeys();
    keys.add(speakerKey('JaneInterviewer'));
    expect(anonymizeSpeaker('JaneInterviewer', '067', keys)).toBe('Researcher');
    // Exactness preserved: a participant is still mapped to the PID.
    expect(anonymizeSpeaker('DavidBarron', '067', keys)).toBe('067');
  });

  it('does exact-label (not substring) matching', () => {
    // "DavidSmith" is a researcher; the participant "DavidBarron" must NOT match.
    const keys = new Set([speakerKey('DavidSmith')]);
    expect(anonymizeSpeaker('DavidSmith', '067', keys)).toBe('Researcher');
    expect(anonymizeSpeaker('DavidBarron', '067', keys)).toBe('067');
    // And a substring of a researcher alias must not match either.
    expect(anonymizeSpeaker('David', '067', keys)).toBe('067');
  });
});

describe('seededResearcherKeys / SEEDED_RESEARCHER_ALIASES', () => {
  it('exposes the raw aliases and normalizes every one into the key set', () => {
    expect(SEEDED_RESEARCHER_ALIASES).toContain('HudsonMitchell-P');
    const keys = seededResearcherKeys();
    for (const alias of SEEDED_RESEARCHER_ALIASES) {
      expect(keys.has(speakerKey(alias))).toBe(true);
    }
    expect(keys.size).toBe(SEEDED_RESEARCHER_ALIASES.length);
  });
});

describe('inferResearcherKeys', () => {
  const seeded = new Set(['hudsonmitchell-p']);
  const sessions = (sets: Record<string, string[]>) =>
    new Map(Object.entries(sets).map(([id, keys]) => [id, new Set(keys)]));

  it('vetoes a recurring placeholder that co-occurs with a seeded alias (the "Speaker" bug)', () => {
    // The exact production shape: every session has the interviewer's real
    // name, the participant's name, and Zoom's placeholder "speaker" track.
    const out = inferResearcherKeys(
      sessions({
        s1: ['hudsonmitchell-p', 'paulmanning', 'speaker'],
        s2: ['hudsonmitchell-p', 'jaydenvinson', 'speaker'],
        s3: ['hudsonmitchell-p', 'varun', 'speaker'],
      }),
      seeded,
    );
    expect(out.has('speaker')).toBe(false);
    expect(out.has('paulmanning')).toBe(false);
    expect(out.has('hudsonmitchell-p')).toBe(true);
  });

  it('still promotes a genuine display-name variant recurring where no seeded alias is present', () => {
    const out = inferResearcherKeys(
      sessions({
        s1: ['hudson m.', 'participanta'],
        s2: ['hudson m.', 'participantb'],
      }),
      seeded,
    );
    expect(out.has('hudson m.')).toBe(true);
    expect(out.has('participanta')).toBe(false);
  });

  it('vetoes a cross-session participant-name collision when the interviewer is present', () => {
    const out = inferResearcherKeys(
      sessions({
        s1: ['hudsonmitchell-p', 'varun'],
        s2: ['hudsonmitchell-p', 'varun'],
      }),
      seeded,
    );
    expect(out.has('varun')).toBe(false);
  });

  it('one veto anywhere kills the key even if it also recurs in seeded-free sessions', () => {
    const out = inferResearcherKeys(
      sessions({
        s1: ['alias-x', 'participanta'],
        s2: ['alias-x', 'participantb'],
        s3: ['hudsonmitchell-p', 'alias-x'],
      }),
      seeded,
    );
    expect(out.has('alias-x')).toBe(false);
  });

  it('single-session names never promote; seeded keys always pass through', () => {
    const out = inferResearcherKeys(sessions({ s1: ['onlyonce'] }), seeded);
    expect(out.has('onlyonce')).toBe(false);
    expect(out.has('hudsonmitchell-p')).toBe(true);
  });
});
