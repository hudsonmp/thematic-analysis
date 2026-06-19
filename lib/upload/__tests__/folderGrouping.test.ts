import { describe, it, expect } from 'vitest';
import {
  groupFolderFiles,
  type FolderFile,
} from '@/lib/upload/folderGrouping';

// A minimal File stand-in. The grouping logic only ever reads `.name`, so a
// plain object cast to File is enough and keeps the tests Node-only (no DOM).
function file(name: string): File {
  return { name } as unknown as File;
}
const pathed = (relPath: string): FolderFile => ({ file: file(relPath.split('/').pop()!), relPath });

describe('groupFolderFiles — basic legacy layout (SRT + one video + one audio)', () => {
  const items: FolderFile[] = [
    pathed('Zoom/067/067_transcript.srt'),
    pathed('Zoom/067/video1234.mp4'),
    pathed('Zoom/067/audio1234.m4a'),
  ];
  const g = groupFolderFiles('067', items);

  it('keeps the PID', () => {
    expect(g.pid).toBe('067');
  });
  it('captures the SRT', () => {
    expect(g.srt).not.toBeNull();
    expect(g.srt?.name).toBe('067_transcript.srt');
  });
  it('captures the single video as a candidate', () => {
    expect(g.videos).toHaveLength(1);
    expect(g.videos[0].leaf).toBe('video1234.mp4');
  });
  it('captures a top-level audio file as a track', () => {
    expect(g.audioTracks).toHaveLength(1);
    expect(g.audioTracks[0].leaf).toBe('audio1234.m4a');
  });
});

describe('groupFolderFiles — multiple videos are ALL kept (no longer "last wins")', () => {
  const items: FolderFile[] = [
    pathed('Zoom/067/067_transcript.srt'),
    pathed('Zoom/067/video_consent.mp4'),
    pathed('Zoom/067/video_session.mp4'),
  ];
  const g = groupFolderFiles('067', items);

  it('returns both videos so a duration probe + picker can choose', () => {
    expect(g.videos.map((v) => v.leaf).sort()).toEqual([
      'video_consent.mp4',
      'video_session.mp4',
    ]);
  });
});

describe('groupFolderFiles — folder with NO srt is still grouped (no longer dropped)', () => {
  const items: FolderFile[] = [
    pathed('Zoom/067/video_session.mp4'),
    pathed('Zoom/067/Audio Record/audioAlice.m4a'),
    pathed('Zoom/067/Audio Record/audioBob.m4a'),
  ];
  const g = groupFolderFiles('067', items);

  it('has a null SRT but still surfaces the media', () => {
    expect(g.srt).toBeNull();
    expect(g.videos).toHaveLength(1);
  });
  it('captures per-speaker tracks under "Audio Record/"', () => {
    expect(g.audioTracks.map((a) => a.leaf).sort()).toEqual([
      'audioAlice.m4a',
      'audioBob.m4a',
    ]);
  });
  it('records the relative path of each track (used for the field name)', () => {
    const rels = g.audioTracks.map((a) => a.relPath).sort();
    expect(rels).toEqual([
      'Zoom/067/Audio Record/audioAlice.m4a',
      'Zoom/067/Audio Record/audioBob.m4a',
    ]);
  });
});

describe('groupFolderFiles — only video*.mp4 / audio*.m4a / *_transcript.srt count', () => {
  const items: FolderFile[] = [
    pathed('Zoom/067/067_transcript.srt'),
    pathed('Zoom/067/video1.mp4'),
    pathed('Zoom/067/playback.m3u'), // ignored
    pathed('Zoom/067/chat.txt'), // ignored
    pathed('Zoom/067/notvideo.mp4'), // not video*.mp4 → ignored
    pathed('Zoom/067/Audio Record/audioX.m4a'),
  ];
  const g = groupFolderFiles('067', items);

  it('ignores non-matching files', () => {
    expect(g.videos.map((v) => v.leaf)).toEqual(['video1.mp4']);
    expect(g.audioTracks.map((a) => a.leaf)).toEqual(['audioX.m4a']);
  });
});

describe('groupFolderFiles — only includes files in THIS pid folder', () => {
  const items: FolderFile[] = [
    pathed('Zoom/067/067_transcript.srt'),
    pathed('Zoom/067/video1.mp4'),
    pathed('Zoom/528/528_transcript.srt'), // different pid
    pathed('Zoom/528/video9.mp4'), // different pid
  ];
  const g = groupFolderFiles('067', items);

  it('excludes another PID folder', () => {
    expect(g.videos.map((v) => v.leaf)).toEqual(['video1.mp4']);
    expect(g.srt?.name).toBe('067_transcript.srt');
  });
});

describe('groupFolderFiles — flat <pid>/<file> layout (drag-drop where dropped folder IS the pid)', () => {
  const items: FolderFile[] = [
    pathed('067/video1.mp4'),
    pathed('067/Audio Record/audioA.m4a'),
    pathed('067/Audio Record/audioB.m4a'),
  ];
  const g = groupFolderFiles('067', items);

  it('still groups by the pid segment above the leaf', () => {
    expect(g.videos).toHaveLength(1);
    expect(g.audioTracks).toHaveLength(2);
  });
});
