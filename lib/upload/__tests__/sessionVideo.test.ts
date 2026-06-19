import { describe, it, expect } from 'vitest';
import {
  CONSENT_MAX_MS,
  pickSessionVideo,
  type CandidateVideo,
} from '@/lib/upload/sessionVideo';

// Helpers for readable, intention-revealing durations.
const MIN = 60 * 1000;
const v = (name: string, durationMs: number): CandidateVideo => ({ name, durationMs });

describe('CONSENT_MAX_MS', () => {
  it('is exactly 10 minutes in ms', () => {
    expect(CONSENT_MAX_MS).toBe(10 * 60 * 1000);
  });
});

describe('pickSessionVideo — empty input', () => {
  it('returns no session, no consent, not ambiguous', () => {
    const pick = pickSessionVideo([]);
    expect(pick.session).toBeNull();
    expect(pick.consent).toEqual([]);
    expect(pick.ambiguous).toBe(false);
    expect(pick.reason).toBe('no videos');
  });
});

describe('pickSessionVideo — single video (never drop the only video)', () => {
  it('one LONG video is the session', () => {
    const only = v('GMT-session.mp4', 45 * MIN);
    const pick = pickSessionVideo([only]);
    expect(pick.session).toEqual(only);
    expect(pick.consent).toEqual([]);
    expect(pick.ambiguous).toBe(false);
    expect(pick.reason).toContain('single video');
  });

  it('one SHORT (consent-length) video is STILL the session, not dropped', () => {
    const only = v('GMT-consent.mp4', 4 * MIN); // under CONSENT_MAX_MS
    const pick = pickSessionVideo([only]);
    expect(pick.session).toEqual(only);
    expect(pick.consent).toEqual([]); // not classified as skippable consent
    expect(pick.ambiguous).toBe(false);
    expect(pick.reason).toContain('single video');
  });
});

describe('pickSessionVideo — two videos: short consent + long session', () => {
  it('longest is session, the short one is consent (skipped), unambiguous', () => {
    const consent = v('GMT-consent.mp4', 5 * MIN);
    const session = v('GMT-session.mp4', 50 * MIN);
    const pick = pickSessionVideo([consent, session]);
    expect(pick.session).toEqual(session);
    expect(pick.consent).toEqual([consent]);
    expect(pick.ambiguous).toBe(false);
  });
});

describe('pickSessionVideo — two shorts only (no clear session)', () => {
  it('picks the longest but flags ambiguous; the shorter is consent', () => {
    const shorter = v('GMT-a.mp4', 3 * MIN);
    const longer = v('GMT-b.mp4', 7 * MIN); // still <= CONSENT_MAX_MS
    const pick = pickSessionVideo([shorter, longer]);
    expect(pick.session).toEqual(longer);
    expect(pick.consent).toEqual([shorter]); // the non-session short is consent
    expect(pick.ambiguous).toBe(true);
    expect(pick.reason).toContain('all videos under consent threshold');
  });
});

describe('pickSessionVideo — three videos: consent + session + short fragment', () => {
  it('session = longest, the two short ones are both consent', () => {
    const consent = v('GMT-consent.mp4', 5 * MIN);
    const fragment = v('GMT-fragment.mp4', 1 * MIN);
    const session = v('GMT-session.mp4', 55 * MIN);
    const pick = pickSessionVideo([consent, session, fragment]);
    expect(pick.session).toEqual(session);
    // Order-independent membership check: both shorts classified as consent.
    expect(pick.consent).toHaveLength(2);
    expect(pick.consent).toContainEqual(consent);
    expect(pick.consent).toContainEqual(fragment);
    expect(pick.ambiguous).toBe(false);
  });
});

describe('pickSessionVideo — two long + one consent (>=2 real recordings)', () => {
  it('longest is session, ambiguous=true, the OTHER long is neither session nor consent', () => {
    const consent = v('GMT-consent.mp4', 6 * MIN);
    const longA = v('GMT-recordingA.mp4', 40 * MIN);
    const longB = v('GMT-recordingB.mp4', 52 * MIN); // longest
    const pick = pickSessionVideo([consent, longA, longB]);

    expect(pick.session).toEqual(longB); // longest still chosen
    expect(pick.ambiguous).toBe(true);
    expect(pick.reason).toContain('2'); // names the count of long videos

    // The short one IS consent.
    expect(pick.consent).toContainEqual(consent);
    // The second long video is NEITHER session NOR consent — surfaced only via ambiguous.
    expect(pick.consent).not.toContainEqual(longA);
    expect(pick.session).not.toEqual(longA);
  });
});

describe('pickSessionVideo — deterministic tie-break by name ascending', () => {
  it('when the two longest tie in duration, the alphabetically-first name wins the session', () => {
    const tieB = v('GMT-b.mp4', 50 * MIN);
    const tieA = v('GMT-a.mp4', 50 * MIN); // same duration, name sorts first
    // Feed in non-sorted order to prove the tie-break is by name, not input order.
    const pick = pickSessionVideo([tieB, tieA]);
    expect(pick.session).toEqual(tieA);
    expect(pick.session?.name).toBe('GMT-a.mp4');
  });

  it('tie-break is stable regardless of input order (reverse order yields same session)', () => {
    const tieA = v('GMT-a.mp4', 50 * MIN);
    const tieB = v('GMT-b.mp4', 50 * MIN);
    expect(pickSessionVideo([tieA, tieB]).session?.name).toBe('GMT-a.mp4');
    expect(pickSessionVideo([tieB, tieA]).session?.name).toBe('GMT-a.mp4');
  });
});

describe('pickSessionVideo — boundary at exactly CONSENT_MAX_MS', () => {
  it('a non-session video AT the threshold counts as consent (<=)', () => {
    const atThreshold = v('GMT-consent.mp4', CONSENT_MAX_MS); // exactly 10 min
    const session = v('GMT-session.mp4', 30 * MIN);
    const pick = pickSessionVideo([atThreshold, session]);
    expect(pick.session).toEqual(session);
    expect(pick.consent).toContainEqual(atThreshold);
    expect(pick.ambiguous).toBe(false);
  });

  it('a non-session video ONE ms over the threshold is a long video (ambiguous, not consent)', () => {
    const overThreshold = v('GMT-other.mp4', CONSENT_MAX_MS + 1);
    const session = v('GMT-session.mp4', 30 * MIN);
    const pick = pickSessionVideo([overThreshold, session]);
    expect(pick.session).toEqual(session);
    expect(pick.consent).not.toContainEqual(overThreshold);
    expect(pick.ambiguous).toBe(true);
  });
});

describe('pickSessionVideo — does not mutate input', () => {
  it('leaves the caller array order untouched', () => {
    const consent = v('GMT-consent.mp4', 5 * MIN);
    const session = v('GMT-session.mp4', 50 * MIN);
    const input = [session, consent];
    pickSessionVideo(input);
    expect(input).toEqual([session, consent]);
  });
});
