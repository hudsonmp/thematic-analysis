import { describe, it, expect } from 'vitest';
import {
  buildTranscribeEntries,
  SESSION_FIELD,
  AUDIO_RECORD_DIR,
  type FolderFile,
} from '@/lib/upload/transcribeFormData';

function file(name: string): File {
  return { name } as unknown as File;
}
const track = (relPath: string): FolderFile => ({
  file: file(relPath.split('/').pop()!),
  relPath,
});

describe('buildTranscribeEntries — C2 multipart contract', () => {
  const sessionVideo = file('video_session.mp4');

  it('puts the session video under the reserved "session" field', () => {
    const entries = buildTranscribeEntries(sessionVideo, []);
    expect(SESSION_FIELD).toBe('session');
    const sessionEntry = entries.find((e) => e.field === SESSION_FIELD);
    expect(sessionEntry?.file).toBe(sessionVideo);
  });

  it('names each per-speaker track field "Audio Record/<leaf>" (the route writes it at that relpath)', () => {
    const tracks: FolderFile[] = [
      track('Zoom/067/Audio Record/audioAlice.m4a'),
      track('Zoom/067/Audio Record/audioBob.m4a'),
    ];
    const entries = buildTranscribeEntries(sessionVideo, tracks);
    const audioFields = entries
      .filter((e) => e.field !== SESSION_FIELD)
      .map((e) => e.field)
      .sort();
    expect(audioFields).toEqual([
      `${AUDIO_RECORD_DIR}/audioAlice.m4a`,
      `${AUDIO_RECORD_DIR}/audioBob.m4a`,
    ]);
  });

  it('AUDIO_RECORD_DIR matches the route/runner constant "Audio Record"', () => {
    expect(AUDIO_RECORD_DIR).toBe('Audio Record');
  });

  it('emits exactly one entry per track plus the session entry', () => {
    const tracks: FolderFile[] = [
      track('067/Audio Record/audioA.m4a'),
      track('067/Audio Record/audioB.m4a'),
    ];
    const entries = buildTranscribeEntries(sessionVideo, tracks);
    expect(entries).toHaveLength(3); // 1 session + 2 tracks
  });

  it('uses ONLY the track leaf name under Audio Record/, never the deep relpath', () => {
    // The field name is the relative path the route reconstructs INSIDE the temp
    // folder; it must be "Audio Record/<leaf>", not the browser's deep path, so
    // the script's `find` (scoped to Audio Record/) detects the tracks.
    const entries = buildTranscribeEntries(sessionVideo, [
      track('Zoom Recordings/2026/067/Audio Record/audioAlice1.m4a'),
    ]);
    const audio = entries.find((e) => e.field !== SESSION_FIELD);
    expect(audio?.field).toBe('Audio Record/audioAlice1.m4a');
  });

  it('with no tracks, emits just the session entry (single-track path)', () => {
    const entries = buildTranscribeEntries(sessionVideo, []);
    expect(entries).toHaveLength(1);
    expect(entries[0].field).toBe(SESSION_FIELD);
  });

  it('pairs each entry field with the right File object', () => {
    const a = file('audioA.m4a');
    const entries = buildTranscribeEntries(sessionVideo, [
      { file: a, relPath: '067/Audio Record/audioA.m4a' },
    ]);
    const audio = entries.find((e) => e.field !== SESSION_FIELD);
    expect(audio?.file).toBe(a);
  });
});
