import { NextResponse } from 'next/server';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import {
  resolveTranscribeConfig,
  findProducedSrt,
  buildTranscribeArgs,
  classifyTrackMode,
} from '@/lib/upload/transcribeRunner';

// LOCAL-ONLY transcription. This route runs the researcher's EXISTING transcribe.sh
// (→ whisper.cpp) on an uploaded Zoom session recording and returns the SRT. It
// only works on the researcher's Mac, where the script + whisper binary live; on
// any other host (a cloud deploy) the local-tooling guard makes it NO-OP with a
// clean JSON error instead of crashing.
//
// Node runtime: we spawn a child process and touch the filesystem (neither is
// possible on edge). `force-dynamic` keeps it request-time (never prerendered).
// whisper on a ~90-min recording is slow — allow a generous wall-clock budget;
// the spawn has its own hard timeout below as the real cap.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 3600; // seconds (1h) — whisper on a long session is slow

// Hard cap on the child process. Defaults to 1h; override with TRANSCRIBE_TIMEOUT_MS.
const SPAWN_TIMEOUT_MS = Number(process.env.TRANSCRIBE_TIMEOUT_MS) || 60 * 60 * 1000;

// Reserved field name carrying the chosen SESSION video file.
const SESSION_FIELD = 'session';

type RunResult = { stdout: string; stderr: string };

/**
 * Sanitize a caller-supplied relative path into a safe, folder-relative path.
 * Strips drive/leading separators and drops any `.`/`..` segments so a malicious
 * field name can never escape the temp dir. Returns null if nothing safe remains.
 */
function safeRelPath(raw: string): string | null {
  const segments = raw
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== '.' && s !== '..');
  if (segments.length === 0) return null;
  return path.join(...segments);
}

/** Spawn the script (no shell) with a hard timeout; resolve stdio or reject. */
function runScript(
  scriptPath: string,
  folder: string,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      '/bin/bash',
      [scriptPath, ...buildTranscribeArgs(folder)],
      { timeout: SPAWN_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          // Attach stdio so the caller can surface a useful error.
          (err as Error & { stdout?: string; stderr?: string }).stdout = stdout;
          (err as Error & { stdout?: string; stderr?: string }).stderr = stderr;
          reject(err);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

export async function POST(req: Request): Promise<Response> {
  // 1) Local-only guard. If the script or whisper binary is absent (e.g. a cloud
  //    deploy), no-op cleanly — never throw, never spawn.
  const cfg = resolveTranscribeConfig(process.env, existsSync);
  if (!cfg.available) {
    return NextResponse.json(
      {
        ok: false,
        error: 'transcription tooling not available on this host',
        missing: cfg.missing,
      },
      { status: 501 },
    );
  }

  // 2) Parse the multipart body.
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { ok: false, error: 'expected multipart/form-data body' },
      { status: 400 },
    );
  }

  const sessionFile = form.get(SESSION_FIELD);
  if (!(sessionFile instanceof File)) {
    return NextResponse.json(
      { ok: false, error: `missing "${SESSION_FIELD}" video file field` },
      { status: 400 },
    );
  }

  // 3) Materialize a fresh, unique temp folder and reconstruct the Zoom layout:
  //    the session video at the root, and any per-speaker tracks under their
  //    intended relative path (the field NAME, e.g. "Audio Record/audioAlice1.m4a")
  //    so the script's multi-track detection fires.
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'ta-transcribe-'));
  // Name the working folder so the script's "<foldername>_transcript.srt" is
  // predictable and isolated from tmpRoot bookkeeping.
  const folder = path.join(tmpRoot, 'session');
  await mkdir(folder, { recursive: true });

  // Track the relative layout so we can classify single vs multi (mirrors the
  // script's own decision) for the response.
  const relFiles: string[] = [];

  try {
    // Session video → folder root, under its own filename (fallback if absent).
    const sessionName = safeRelPath(sessionFile.name) ?? 'session.mp4';
    const sessionRel = path.basename(sessionName); // force to root, no subdirs
    await writeFile(
      path.join(folder, sessionRel),
      Buffer.from(await sessionFile.arrayBuffer()),
    );
    relFiles.push(sessionRel);

    // Every OTHER File entry: written at the relative path given by its field name.
    for (const [field, value] of form.entries()) {
      if (field === SESSION_FIELD) continue;
      if (!(value instanceof File)) continue;
      const rel = safeRelPath(field);
      if (!rel) continue; // unsafe/empty field name → skip
      const dest = path.join(folder, rel);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, Buffer.from(await value.arrayBuffer()));
      relFiles.push(rel);
    }

    const trackMode = classifyTrackMode(relFiles);

    // 4) Run the existing script on the temp folder (args array; no shell interp).
    try {
      await runScript(cfg.scriptPath, folder);
    } catch (e) {
      const err = e as Error & {
        stderr?: string;
        killed?: boolean;
        signal?: string;
      };
      const timedOut = err.killed || err.signal === 'SIGTERM';
      const detail = (err.stderr || err.message || 'transcription failed').trim();
      return NextResponse.json(
        {
          ok: false,
          error: timedOut
            ? `transcription timed out after ${SPAWN_TIMEOUT_MS} ms`
            : `transcription failed: ${detail.slice(0, 1000)}`,
        },
        { status: timedOut ? 504 : 500 },
      );
    }

    // 5) Read the produced SRT back out of the folder.
    const produced = findProducedSrt(await readdir(folder));
    if (!produced) {
      return NextResponse.json(
        { ok: false, error: 'script produced no *_transcript.srt' },
        { status: 500 },
      );
    }
    const srt = await readFile(path.join(folder, produced), 'utf-8');

    return NextResponse.json({ ok: true, srt, trackMode });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'transcription failed' },
      { status: 500 },
    );
  } finally {
    // 6) Always clean up the temp dir (the uploaded media + any outputs).
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}
