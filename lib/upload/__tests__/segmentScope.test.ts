import { describe, it, expect } from 'vitest';
import {
  sessionVideoSuffix,
  scopeAudioTracks,
  pickPlaybackAudio,
} from '@/lib/upload/folderGrouping';
import type { FolderMember } from '@/lib/upload/folderGrouping';

// A minimal File stand-in. The scoping logic only ever reads `.name`/`.leaf`, so
// a plain object cast to File keeps the tests Node-only (no DOM).
function file(name: string): File {
  return { name } as unknown as File;
}
const member = (relPath: string): FolderMember => {
  const leaf = relPath.split('/').pop()!;
  return { file: file(leaf), relPath, leaf };
};

describe('sessionVideoSuffix — Zoom segment suffix from a video filename', () => {
  it('strips the leading "video" prefix and ".mp4", returning the trailing digits', () => {
    expect(sessionVideoSuffix('video2639780501.mp4')).toBe('2639780501');
  });
  it('returns the consent segment suffix (segment 1)', () => {
    expect(sessionVideoSuffix('video1639780501.mp4')).toBe('1639780501');
  });
  it('returns the fragment segment suffix (segment 3)', () => {
    expect(sessionVideoSuffix('video3639780501.mp4')).toBe('3639780501');
  });
  it('handles a full relative path by using the basename', () => {
    expect(sessionVideoSuffix('Zoom/742/video2639780501.mp4')).toBe('2639780501');
  });
  it('takes ONLY the trailing run of digits (ignores leading non-digit chars)', () => {
    // A name with digits in the middle but a trailing digit run still yields the
    // trailing run.
    expect(sessionVideoSuffix('video_session_2639780501.mp4')).toBe('2639780501');
  });
  it('returns null when there are no trailing digits before the extension', () => {
    expect(sessionVideoSuffix('video_session.mp4')).toBeNull();
  });
  it('returns null for an empty / nonsense name', () => {
    expect(sessionVideoSuffix('')).toBeNull();
    expect(sessionVideoSuffix('video.mp4')).toBeNull();
  });
  it('works without the .mp4 extension (defensive)', () => {
    expect(sessionVideoSuffix('video2639780501')).toBe('2639780501');
  });
});

describe('scopeAudioTracks — keep only the SESSION segment tracks (real folder 742)', () => {
  // The real 742 set: 6 per-speaker tracks across 3 segments.
  const tracks: FolderMember[] = [
    // segment 1 (consent), suffix 1639780501
    member('Zoom/742/Audio Record/audioHudsonMitchell-P31639780501.m4a'),
    member('Zoom/742/Audio Record/audioVolodymyrSofishc41639780501.m4a'),
    // segment 2 (TASK / session), suffix 2639780501
    member('Zoom/742/Audio Record/audioHudsonMitchell-P32639780501.m4a'),
    member('Zoom/742/Audio Record/audioVolodymyrSofishc42639780501.m4a'),
    // segment 3 (fragment), suffix 3639780501
    member('Zoom/742/Audio Record/audioHudsonMitchell-P33639780501.m4a'),
    member('Zoom/742/Audio Record/audioVolodymyrSofishc43639780501.m4a'),
  ];

  it('keeps exactly the 2 segment-2 tracks for session video2639780501.mp4', () => {
    const scoped = scopeAudioTracks('video2639780501.mp4', tracks);
    expect(scoped.map((t) => t.leaf).sort()).toEqual([
      'audioHudsonMitchell-P32639780501.m4a',
      'audioVolodymyrSofishc42639780501.m4a',
    ]);
  });

  it('keeps the consent-segment tracks when the session IS the consent video', () => {
    const scoped = scopeAudioTracks('video1639780501.mp4', tracks);
    expect(scoped.map((t) => t.leaf).sort()).toEqual([
      'audioHudsonMitchell-P31639780501.m4a',
      'audioVolodymyrSofishc41639780501.m4a',
    ]);
  });
});

describe('scopeAudioTracks — single-segment folder (all tracks match)', () => {
  const tracks: FolderMember[] = [
    member('067/Audio Record/audioAlice2639780501.m4a'),
    member('067/Audio Record/audioBob2639780501.m4a'),
  ];
  it('returns every track when they all share the session suffix', () => {
    const scoped = scopeAudioTracks('video2639780501.mp4', tracks);
    expect(scoped).toHaveLength(2);
  });
});

describe('scopeAudioTracks — real long suffix with ZERO matches → [] (other-segment tracks dropped)', () => {
  const segment2 = [
    member('067/Audio Record/audioAlice2639780501.m4a'),
    member('067/Audio Record/audioBob2639780501.m4a'),
  ];

  it('returns [] when ZERO tracks match a real (long) session suffix', () => {
    // Session is segment 3, but every track is segment 2 → no match. The suffix
    // IS a reliable join key, so the misses are genuine other-segment tracks and
    // dropping them is correct (route transcribes the session video's own audio).
    const scoped = scopeAudioTracks('video3639780501.mp4', segment2);
    expect(scoped).toEqual([]);
  });

  it('returns [] for an empty track list', () => {
    expect(scopeAudioTracks('video2639780501.mp4', [])).toEqual([]);
  });
});

describe('scopeAudioTracks — degenerate suffix → over-include ALL (never silently drop a speaker)', () => {
  // A degenerate short-suffix folder: video1.mp4 → suffix "1" is too short to be a
  // reliable join key. endsWith("1") would keep ONLY audioAlice1 and DROP audioBob2
  // (a genuine co-segment speaker). FIX 2: over-include both instead.
  const degenerate: FolderMember[] = [
    member('123/Audio Record/audioAlice1.m4a'),
    member('123/Audio Record/audioBob2.m4a'),
  ];

  it('includes BOTH speakers for a short numeric suffix (no silent drop)', () => {
    const scoped = scopeAudioTracks('video1.mp4', degenerate);
    expect(scoped.map((t) => t.leaf).sort()).toEqual([
      'audioAlice1.m4a',
      'audioBob2.m4a',
    ]);
  });

  it('over-includes ALL tracks when the session suffix is null (un-suffixed video)', () => {
    const tracks: FolderMember[] = [
      member('067/Audio Record/audioAlice2639780501.m4a'),
      member('067/Audio Record/audioBob2639780501.m4a'),
    ];
    const scoped = scopeAudioTracks('video_session.mp4', tracks);
    expect(scoped.map((t) => t.leaf).sort()).toEqual([
      'audioAlice2639780501.m4a',
      'audioBob2639780501.m4a',
    ]);
  });

  it('still scopes correctly for a NORMAL long suffix (regression)', () => {
    const tracks: FolderMember[] = [
      member('742/Audio Record/audioAlice1639780501.m4a'), // seg 1
      member('742/Audio Record/audioBob1639780501.m4a'), // seg 1
      member('742/Audio Record/audioAlice2639780501.m4a'), // seg 2 (session)
      member('742/Audio Record/audioBob2639780501.m4a'), // seg 2 (session)
    ];
    const scoped = scopeAudioTracks('video2639780501.mp4', tracks);
    expect(scoped.map((t) => t.leaf).sort()).toEqual([
      'audioAlice2639780501.m4a',
      'audioBob2639780501.m4a',
    ]);
  });
});

describe('pickPlaybackAudio — stored playback clip follows the SCOPED segment (FIX 1)', () => {
  it('742-style: picks the SCOPED (session) track, not the first unscoped consent track', () => {
    // The 742 consent-first folder: the FIRST unscoped track is a segment-1
    // consent clip; the session is segment 2. The old code stored audioTracks[0]
    // (consent) against a segment-2 transcript — the mis-scope this test guards.
    const allTracks: FolderMember[] = [
      member('742/Audio Record/audioHudson1639780501.m4a'), // seg 1 consent (first!)
      member('742/Audio Record/audioVolodymyr1639780501.m4a'), // seg 1 consent
      member('742/Audio Record/audioHudson2639780501.m4a'), // seg 2 session
      member('742/Audio Record/audioVolodymyr2639780501.m4a'), // seg 2 session
    ];
    const scopedTracks = scopeAudioTracks('video2639780501.mp4', allTracks);
    const playback = pickPlaybackAudio(scopedTracks, allTracks);
    // Must be a SESSION-segment track (ends in 2639780501), NOT the consent one.
    expect((playback as unknown as { name: string }).name).toBe(
      'audioHudson2639780501.m4a',
    );
  });

  it('falls back to the first unscoped track when scoping produced nothing', () => {
    // Legacy single top-level track (no scoped match) → use the unscoped first.
    const allTracks: FolderMember[] = [member('067/audioMixed.m4a')];
    const scopedTracks: FolderMember[] = [];
    const playback = pickPlaybackAudio(scopedTracks, allTracks);
    expect((playback as unknown as { name: string }).name).toBe('audioMixed.m4a');
  });

  it('returns null when there are no tracks at all', () => {
    expect(pickPlaybackAudio([], [])).toBeNull();
  });
});

describe('scopeAudioTracks — suffix match is ANCHORED at end (no false positives)', () => {
  it('a speaker name ending in OTHER segment digits must not match the session', () => {
    // `…c21639780501.m4a` ENDS WITH 1639780501 (segment 1), NOT 2639780501.
    // Naive substring/contains would wrongly match the session suffix 2639780501.
    const tracks: FolderMember[] = [
      member('742/Audio Record/audioVolodymyrSofishc21639780501.m4a'), // seg 1
      member('742/Audio Record/audioHudsonMitchell-P32639780501.m4a'), // seg 2
    ];
    const scoped = scopeAudioTracks('video2639780501.mp4', tracks);
    expect(scoped.map((t) => t.leaf)).toEqual([
      'audioHudsonMitchell-P32639780501.m4a',
    ]);
  });

  it('matches on basename without the .m4a extension, anchored at the end', () => {
    const tracks: FolderMember[] = [
      member('742/Audio Record/audioA2639780501.m4a'),
      member('742/Audio Record/audioB2639780501.m4a'),
    ];
    // A session suffix that is a SUFFIX of a longer number must still anchor on
    // the track basename's own trailing run — `780501` is NOT how Zoom names them,
    // but if a session video were `video780501.mp4`, the tracks ending in the FULL
    // `2639780501` do end with `780501`, so they WOULD match by the end-anchored
    // rule. This documents that the contract is "basename endsWith suffix".
    const scoped = scopeAudioTracks('video780501.mp4', tracks);
    expect(scoped).toHaveLength(2);
  });
});
