import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TRANSCRIBE_PATHS,
  resolveTranscribePaths,
  resolveTranscribeConfig,
  findProducedSrt,
  buildTranscribeArgs,
  classifyTrackMode,
  AUDIO_RECORD_DIR,
} from '@/lib/upload/transcribeRunner';

// A small env subset so tests never read process.env.
type Env = Record<string, string | undefined>;

describe('resolveTranscribePaths', () => {
  it('falls back to the known default paths when env is empty', () => {
    const p = resolveTranscribePaths({});
    expect(p.scriptPath).toBe(DEFAULT_TRANSCRIBE_PATHS.scriptPath);
    expect(p.whisperBin).toBe(DEFAULT_TRANSCRIBE_PATHS.whisperBin);
    expect(p.model).toBe(DEFAULT_TRANSCRIBE_PATHS.model);
  });

  it('lets each path be overridden independently via env', () => {
    const env: Env = {
      TRANSCRIBE_SCRIPT: '/custom/transcribe.sh',
      WHISPER_CLI_BIN: '/custom/whisper-cli',
      WHISPER_MODEL: '/custom/model.bin',
    };
    const p = resolveTranscribePaths(env);
    expect(p.scriptPath).toBe('/custom/transcribe.sh');
    expect(p.whisperBin).toBe('/custom/whisper-cli');
    expect(p.model).toBe('/custom/model.bin');
  });

  it('overrides only the keys present, defaulting the rest', () => {
    const p = resolveTranscribePaths({ WHISPER_MODEL: '/only/model.bin' });
    expect(p.model).toBe('/only/model.bin');
    expect(p.scriptPath).toBe(DEFAULT_TRANSCRIBE_PATHS.scriptPath);
    expect(p.whisperBin).toBe(DEFAULT_TRANSCRIBE_PATHS.whisperBin);
  });

  it('treats blank/whitespace env values as unset (uses defaults)', () => {
    const p = resolveTranscribePaths({
      TRANSCRIBE_SCRIPT: '',
      WHISPER_CLI_BIN: '   ',
    });
    expect(p.scriptPath).toBe(DEFAULT_TRANSCRIBE_PATHS.scriptPath);
    expect(p.whisperBin).toBe(DEFAULT_TRANSCRIBE_PATHS.whisperBin);
  });

  it('trims surrounding whitespace from env overrides', () => {
    const p = resolveTranscribePaths({ TRANSCRIBE_SCRIPT: '  /x/t.sh  ' });
    expect(p.scriptPath).toBe('/x/t.sh');
  });
});

describe('resolveTranscribeConfig (available flag)', () => {
  // The existence check is injected so this stays pure (no fs).
  const present = () => true;
  const absent = () => false;

  it('available:true only when BOTH script and whisper binary exist', () => {
    const cfg = resolveTranscribeConfig({}, present);
    expect(cfg.available).toBe(true);
    expect(cfg.missing).toEqual([]);
  });

  it('available:false when the script is missing, naming it', () => {
    const exists = (p: string) =>
      p !== resolveTranscribePaths({}).scriptPath; // script gone, rest present
    const cfg = resolveTranscribeConfig({}, exists);
    expect(cfg.available).toBe(false);
    expect(cfg.missing).toContain('script');
  });

  it('available:false when the whisper binary is missing, naming it', () => {
    const exists = (p: string) =>
      p !== resolveTranscribePaths({}).whisperBin; // binary gone, rest present
    const cfg = resolveTranscribeConfig({}, exists);
    expect(cfg.available).toBe(false);
    expect(cfg.missing).toContain('whisper-cli');
  });

  it('available:false on a cloud host where nothing exists (the local-only guard)', () => {
    const cfg = resolveTranscribeConfig({}, absent);
    expect(cfg.available).toBe(false);
    // both core tools missing
    expect(cfg.missing).toContain('script');
    expect(cfg.missing).toContain('whisper-cli');
  });

  it('surfaces the resolved paths alongside availability', () => {
    const env: Env = { TRANSCRIBE_SCRIPT: '/s.sh' };
    const cfg = resolveTranscribeConfig(env, present);
    expect(cfg.scriptPath).toBe('/s.sh');
    expect(cfg.whisperBin).toBe(DEFAULT_TRANSCRIBE_PATHS.whisperBin);
    expect(cfg.model).toBe(DEFAULT_TRANSCRIBE_PATHS.model);
  });
});

describe('findProducedSrt', () => {
  it('returns the single *_transcript.srt produced by the script', () => {
    const files = [
      'video.mp4',
      'mysession_transcript.srt',
      'mysession_transcript.txt',
    ];
    expect(findProducedSrt(files)).toBe('mysession_transcript.srt');
  });

  it('matches by the *_transcript.srt suffix, not just any .srt', () => {
    // A stray .srt that is NOT the produced output must be ignored.
    const files = ['leftover.srt', 'foo_transcript.srt'];
    expect(findProducedSrt(files)).toBe('foo_transcript.srt');
  });

  it('returns null when no transcript srt was produced', () => {
    expect(findProducedSrt(['video.mp4', 'notes.txt'])).toBeNull();
    expect(findProducedSrt([])).toBeNull();
  });

  it('ignores the _transcript.txt sibling (only the .srt is selected)', () => {
    expect(findProducedSrt(['s_transcript.txt'])).toBeNull();
  });

  it('is case-sensitive on the .srt extension by suffix rule', () => {
    // Whisper writes lowercase .srt; an uppercase .SRT is not the produced file.
    expect(findProducedSrt(['s_transcript.SRT'])).toBeNull();
  });

  it('deterministically picks the first by name when (unexpectedly) several exist', () => {
    const files = ['b_transcript.srt', 'a_transcript.srt'];
    expect(findProducedSrt(files)).toBe('a_transcript.srt');
  });
});

describe('buildTranscribeArgs', () => {
  it('passes ONLY the folder as a positional arg (no shell interpolation)', () => {
    const args = buildTranscribeArgs('/tmp/xyz/SessionFolder');
    expect(args).toEqual(['/tmp/xyz/SessionFolder']);
  });

  it('does not split a folder path containing spaces (array arg, not a string)', () => {
    const args = buildTranscribeArgs('/tmp/x y z/My Session');
    expect(args).toEqual(['/tmp/x y z/My Session']);
    expect(args).toHaveLength(1);
  });

  it('preserves shell-metachar folder names verbatim (passed as one argv element)', () => {
    const evil = '/tmp/x; rm -rf ~ #';
    expect(buildTranscribeArgs(evil)).toEqual([evil]);
  });
});

describe('classifyTrackMode', () => {
  it("is 'multi' with >=2 per-speaker tracks in Audio Record/", () => {
    const rel = [
      'session.mp4',
      `${AUDIO_RECORD_DIR}/audioAlice1.m4a`,
      `${AUDIO_RECORD_DIR}/audioBob2.m4a`,
    ];
    expect(classifyTrackMode(rel)).toBe('multi');
  });

  it("is 'single' with one mixed video and no per-speaker tracks", () => {
    expect(classifyTrackMode(['session.mp4'])).toBe('single');
  });

  it("is 'single' with exactly ONE Audio Record track (script labels but it's one stream)", () => {
    const rel = ['session.mp4', `${AUDIO_RECORD_DIR}/audioAlice1.m4a`];
    expect(classifyTrackMode(rel)).toBe('single');
  });

  it('only counts m4a tracks inside Audio Record/ (ignores a top-level audio file)', () => {
    const rel = ['session.mp4', 'audioStray1.m4a'];
    expect(classifyTrackMode(rel)).toBe('single');
  });

  it('counts only Audio Record .m4a tracks, ignoring other files in that dir', () => {
    const rel = [
      'session.mp4',
      `${AUDIO_RECORD_DIR}/audioAlice1.m4a`,
      `${AUDIO_RECORD_DIR}/audioBob2.m4a`,
      `${AUDIO_RECORD_DIR}/readme.txt`,
    ];
    expect(classifyTrackMode(rel)).toBe('multi');
  });

  it('handles Windows-style separators in the relative path', () => {
    const rel = [
      'session.mp4',
      `${AUDIO_RECORD_DIR}\\audioAlice1.m4a`,
      `${AUDIO_RECORD_DIR}\\audioBob2.m4a`,
    ];
    expect(classifyTrackMode(rel)).toBe('multi');
  });
});
