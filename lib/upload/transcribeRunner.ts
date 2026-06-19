/**
 * transcribeRunner — the PURE, I/O-free policy for the LOCAL transcription route.
 *
 * Context: the researcher already has a working transcription pipeline on her Mac
 * (`scripts/transcribe.sh` → whisper.cpp). The `/api/transcribe` route REUSES that
 * script verbatim rather than reimplementing whisper. This module holds only the
 * decisions around that spawn — path resolution, availability gating, output-file
 * selection, the spawn arg vector, and single-vs-multi track classification — so
 * each is trivially unit-testable WITHOUT touching the filesystem or child_process.
 *
 * Everything here is pure: no `fs`, no `child_process`, no `server-only`, no Next
 * API. Existence checks are INJECTED (see `resolveTranscribeConfig`) so the route
 * supplies a real `fs.existsSync`-backed predicate while tests pass a stub. The
 * spawn itself and multipart parsing live in the route and are integration-only.
 */

import os from 'node:os';
import path from 'node:path';

/**
 * Env keys that override the default local tooling paths (each independent).
 * The index signature keeps it assignable from Node's `process.env` (ProcessEnv)
 * while the named keys document the overrides this module actually reads.
 */
export type TranscribeEnv = {
  TRANSCRIBE_SCRIPT?: string;
  WHISPER_CLI_BIN?: string;
  WHISPER_MODEL?: string;
  [key: string]: string | undefined;
};

/** The three local-tooling paths the route depends on. */
export type TranscribePaths = {
  /** The researcher's existing transcribe.sh (REUSED, not reimplemented). */
  scriptPath: string;
  /** whisper.cpp CLI binary — its presence is the core local-only signal. */
  whisperBin: string;
  /** whisper ggml model file. */
  model: string;
};

/**
 * The known-good locations on the researcher's Mac. These are the same paths the
 * script itself hardcodes (`$HOME/whisper.cpp/...`), resolved here against the
 * server process's home dir so the route's availability check matches the script.
 */
const HOME = os.homedir();

export const DEFAULT_TRANSCRIBE_PATHS: TranscribePaths = {
  // Vendored into the repo (scripts/transcribe.sh), NOT the original under
  // ~/Desktop: macOS TCC denies the dev-server process execution of files in
  // protected folders (Desktop/Documents/Downloads) → EPERM "Operation not
  // permitted". The repo dir is unprotected, so the script runs there. The
  // script is location-independent (operates on its folder arg + absolute
  // whisper.cpp paths). Override with TRANSCRIBE_SCRIPT if the repo lives elsewhere.
  scriptPath: path.join(HOME, 'thematic-analysis', 'scripts', 'transcribe.sh'),
  whisperBin: path.join(HOME, 'whisper.cpp', 'build', 'bin', 'whisper-cli'),
  model: path.join(HOME, 'whisper.cpp', 'models', 'ggml-large-v3-turbo.bin'),
};

/** The Zoom "separate audio file per participant" subfolder name. */
export const AUDIO_RECORD_DIR = 'Audio Record';

/** Treat empty / whitespace-only env values as unset, and trim real ones. */
function cleanEnv(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve the three tooling paths from env (each override independent), falling
 * back to {@link DEFAULT_TRANSCRIBE_PATHS}. Pure: reads only the passed-in env.
 */
export function resolveTranscribePaths(env: TranscribeEnv): TranscribePaths {
  return {
    scriptPath: cleanEnv(env.TRANSCRIBE_SCRIPT) ?? DEFAULT_TRANSCRIBE_PATHS.scriptPath,
    whisperBin: cleanEnv(env.WHISPER_CLI_BIN) ?? DEFAULT_TRANSCRIBE_PATHS.whisperBin,
    model: cleanEnv(env.WHISPER_MODEL) ?? DEFAULT_TRANSCRIBE_PATHS.model,
  };
}

/** Resolved config plus a computed availability verdict for the local-only guard. */
export type TranscribeConfig = TranscribePaths & {
  /** True only when the local tooling (script + whisper binary) is present. */
  available: boolean;
  /** Which core tools are missing — drives the clean error message. */
  missing: Array<'script' | 'whisper-cli'>;
};

/** Predicate that reports whether a path exists. Injected to keep this pure. */
export type ExistsFn = (p: string) => boolean;

/**
 * Decide whether transcription tooling is available on THIS host.
 *
 * The local-only guard: a cloud deploy has neither the script nor whisper, so
 * `exists` returns false for both → `available:false`. The route then no-ops with
 * a clean JSON error instead of crashing. The model is NOT part of the gate (the
 * script itself errors clearly if the model is absent); the gate is the two pieces
 * the route directly invokes/depends on: the script and the whisper binary.
 *
 * Pure: existence is the injected `exists` predicate (route → fs.existsSync; tests
 * → a stub). No filesystem access here.
 */
export function resolveTranscribeConfig(
  env: TranscribeEnv,
  exists: ExistsFn,
): TranscribeConfig {
  const paths = resolveTranscribePaths(env);
  const missing: TranscribeConfig['missing'] = [];
  if (!exists(paths.scriptPath)) missing.push('script');
  if (!exists(paths.whisperBin)) missing.push('whisper-cli');
  return { ...paths, available: missing.length === 0, missing };
}

/**
 * Select the SRT the script produced. The script writes `<foldername>_transcript.srt`
 * into the working folder; this picks it out of a directory listing by the
 * `_transcript.srt` suffix (so a stray pre-existing `.srt` is never returned).
 * Deterministic: if several somehow match, the name-ascending first is chosen.
 * Returns the filename (not a full path) or null when none was produced.
 */
export function findProducedSrt(files: string[]): string | null {
  const matches = files
    .filter((f) => f.endsWith('_transcript.srt'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return matches[0] ?? null;
}

/**
 * Build the argv for spawning the script. The folder is passed as a SINGLE
 * positional arg — never interpolated into a shell string — so a folder name
 * containing spaces or shell metacharacters cannot inject a command. The route
 * spawns with execFile/spawn (no shell), so this array is the entire user-derived
 * surface and it is always exactly one element.
 */
export function buildTranscribeArgs(folder: string): string[] {
  return [folder];
}

/** Whether the produced SRT will be speaker-labeled ('multi') or not ('single'). */
export type TrackMode = 'single' | 'multi';

/** Normalize a relative path's separators so Windows-style inputs classify too. */
function toPosix(rel: string): string {
  return rel.replace(/\\/g, '/');
}

/**
 * Classify the run from the reconstructed relative file layout, mirroring the
 * script's own decision: 2+ `audio*.m4a` files inside `Audio Record/` → speaker-
 * labeled merge ('multi'); otherwise a single stream ('single'). One Audio Record
 * track is still 'single' (the script labels it, but it is one speaker stream and
 * not a timestamp-merge of multiple tracks). Top-level audio files are ignored —
 * only tracks under `Audio Record/` count, exactly as the script's `find` scopes.
 */
export function classifyTrackMode(relFiles: string[]): TrackMode {
  const prefix = `${AUDIO_RECORD_DIR}/`;
  const tracks = relFiles
    .map(toPosix)
    .filter(
      (f) =>
        f.startsWith(prefix) &&
        // exactly one level under Audio Record/, an audio*.m4a track
        !f.slice(prefix.length).includes('/') &&
        /(^|\/)audio[^/]*\.m4a$/i.test(f),
    );
  return tracks.length >= 2 ? 'multi' : 'single';
}
