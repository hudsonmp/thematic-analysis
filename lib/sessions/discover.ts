import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { getShownStudy } from '@/app/actions/codebook';
import { parseSrt, type Segment } from '@/lib/transcript/srt';

// ---------------------------------------------------------------------------
// Session discovery over on-disk Zoom recordings.
//
// A "session" is a numeric participant-id (PID) folder under RECORDINGS_DIR
// that contains `<pid>_transcript.srt`. Only PID folders are numeric; anything
// else (e.g. a timestamped personal-meeting-room folder) is ignored. Media
// filenames come from `recording.conf` (items[0].video/.audio), falling back to
// the first `video*.mp4` / `audio*.m4a` on disk.
//
// READ-ONLY w.r.t. study data. Resolving userId/firstName from the `users`
// table is a `.select()` through the service-role client; NEVER a write.
// ---------------------------------------------------------------------------

const PID_RE = /^[0-9]+$/;

export type SessionMeta = {
  pid: string;
  dir: string;
  srtPath: string;
  txtPath: string | null;
  videoFile: string | null;
  audioFile: string | null;
  magicNumber: string | null;
};

export type SessionDetail = {
  meta: SessionMeta;
  segments: Segment[];
  userId: string | null;
  studyId: string | null;
  firstName: string | null;
  durationMs: number;
  /** Filled by SP2 (clock alignment between SRT and media). null for now. */
  clockOffsetMs: number | null;
};

/** Resolve and validate the recordings root from the environment. */
function recordingsDir(): string {
  const dir = process.env.RECORDINGS_DIR;
  if (!dir || dir.trim() === '') {
    throw new Error(
      'RECORDINGS_DIR is not set. Point it at the Zoom Recordings folder in .env.local.',
    );
  }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`RECORDINGS_DIR does not exist or is not a directory: ${dir}`);
  }
  return dir;
}

/** First filename in `dir` matching `re`, or null. Deterministic (sorted). */
function firstMatch(dir: string, re: RegExp): string | null {
  const hit = fs
    .readdirSync(dir)
    .filter((f) => re.test(f))
    .sort()
    .find(() => true);
  return hit ?? null;
}

/**
 * Resolve media filenames for a PID folder. Prefers `recording.conf`
 * (items[0].video / .audio); falls back to the first matching glob on disk.
 * Returns filenames only (basenames), not absolute paths.
 */
function resolveMedia(dir: string): {
  videoFile: string | null;
  audioFile: string | null;
  magicNumber: string | null;
} {
  let videoFile: string | null = null;
  let audioFile: string | null = null;
  let magicNumber: string | null = null;

  const confPath = path.join(dir, 'recording.conf');
  if (fs.existsSync(confPath)) {
    try {
      const conf = JSON.parse(fs.readFileSync(confPath, 'utf8')) as {
        magic_number?: string;
        items?: Array<{ audio?: string; video?: string }>;
      };
      magicNumber = conf.magic_number ?? null;
      const item = conf.items?.[0];
      if (item?.video) videoFile = item.video;
      if (item?.audio) audioFile = item.audio;
    } catch {
      // Malformed conf: fall through to disk glob below.
    }
  }

  // Validate conf-named files actually exist; otherwise fall back to a glob.
  if (videoFile && !fs.existsSync(path.join(dir, videoFile))) videoFile = null;
  if (audioFile && !fs.existsSync(path.join(dir, audioFile))) audioFile = null;
  if (!videoFile) videoFile = firstMatch(dir, /^video.*\.mp4$/i);
  if (!audioFile) audioFile = firstMatch(dir, /^audio.*\.m4a$/i);

  return { videoFile, audioFile, magicNumber };
}

/**
 * Enumerate on-disk sessions. Each numeric subfolder of RECORDINGS_DIR that
 * contains `<pid>_transcript.srt` becomes a `SessionMeta`. Non-numeric folders
 * and folders without that SRT are skipped. Throws if RECORDINGS_DIR is unset
 * or missing.
 */
export function listSessions(): SessionMeta[] {
  const root = recordingsDir();
  const sessions: SessionMeta[] = [];

  for (const name of fs.readdirSync(root).sort()) {
    if (!PID_RE.test(name)) continue;
    const dir = path.join(root, name);
    if (!fs.statSync(dir).isDirectory()) continue;

    const srtPath = path.join(dir, `${name}_transcript.srt`);
    if (!fs.existsSync(srtPath)) continue;

    const txtCandidate = path.join(dir, `${name}_transcript.txt`);
    const txtPath = fs.existsSync(txtCandidate) ? txtCandidate : null;

    const { videoFile, audioFile, magicNumber } = resolveMedia(dir);

    sessions.push({
      pid: name,
      dir,
      srtPath,
      txtPath,
      videoFile,
      audioFile,
      magicNumber,
    });
  }

  return sessions;
}

/**
 * Load a single session by PID: parse its SRT and resolve study/user context.
 *
 * Throws if `pid` is non-numeric or unknown. READ-ONLY: `userId`/`firstName`
 * are read from `users` (service-role `.select()`, NOT cbFrom — that guard is
 * for cb_ writes); `studyId` reuses `getShownStudy()`. Study tables are never
 * written. `clockOffsetMs` is null until SP2 fills it.
 */
export async function getSession(pid: string): Promise<SessionDetail> {
  if (!PID_RE.test(pid)) {
    throw new Error(`Invalid pid (must be numeric): ${pid}`);
  }

  const meta = listSessions().find((s) => s.pid === pid);
  if (!meta) {
    throw new Error(`Unknown session pid: ${pid}`);
  }

  const srt = fs.readFileSync(meta.srtPath, 'utf8');
  const segments = parseSrt(srt);
  const durationMs = segments.length ? segments[segments.length - 1].endMs : 0;

  // Resolve the participant. READ-ONLY select on the users table.
  let userId: string | null = null;
  let firstName: string | null = null;
  const supabase = createServiceRoleClient();
  const { data: userRow, error: userErr } = await supabase
    .from('users')
    .select('id, first_name')
    .eq('pid', pid)
    .maybeSingle();
  if (userErr) {
    console.error(`[sessions] getSession(${pid}) user lookup failed:`, userErr.message);
  } else if (userRow) {
    userId = userRow.id;
    firstName = userRow.first_name;
  }

  const study = await getShownStudy();
  const studyId = study?.id ?? null;

  return {
    meta,
    segments,
    userId,
    studyId,
    firstName,
    durationMs,
    clockOffsetMs: null,
  };
}
