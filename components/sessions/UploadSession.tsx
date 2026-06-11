'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { createBrowser } from '@/lib/supabase/browser';
import { resumableUpload, FileTooLargeError } from '@/lib/storage/resumable-upload';
import {
  createSessionFromUpload,
  startDriveVideoUpload,
} from '@/app/actions/sessions';

// ---------------------------------------------------------------------------
// Zoom-folder upload UI.
//
// The researcher points a `<input webkitdirectory>` at the local "Zoom
// Recordings" folder. We read `file.webkitRelativePath` (`<root>/<pid>/<file>`),
// group files by the PID folder (the second path segment), and for each PID
// find its `<pid>_transcript.srt`, `video*.mp4`, and `audio*.m4a`.
//
// On submit, PER PID: mint a `crypto.randomUUID()` sessionId, then upload media:
//   - VIDEO → Google Drive (Supabase's free plan caps a single upload at 50MB).
//     We ask the server for a Drive resumable-session URL and PUT the file body
//     directly to Drive from the browser (XHR → progress), keeping the large
//     video off our server. Drive returns the created file's `id`.
//   - AUDIO → Supabase Storage via the TUS resumable path (progress).
//   - SRT   → Supabase Storage via the standard upload (small).
// Then read the SRT text client-side and call `createSessionFromUpload` (a
// server action) to insert the cb_ rows, passing the Drive file id for video.
// Audio/SRT land at `recordings/<id>/…`.
// ---------------------------------------------------------------------------

/**
 * PUT a file body directly to a Google Drive resumable-session URL and resolve
 * the created file's id. A single PUT of the whole body completes a resumable
 * session; Drive replies `200`/`201` with the file JSON (`{ id, … }`). Progress
 * is reported via the XHR upload progress event.
 */
function putToDriveResumable(
  uploadUrl: string,
  file: File,
  onProgress: (uploaded: number, total: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl, true);
    xhr.setRequestHeader('Content-Type', file.type || 'video/mp4');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const json = JSON.parse(xhr.responseText) as { id?: string };
          if (json.id) resolve(json.id);
          else reject(new Error('Drive upload returned no file id'));
        } catch {
          reject(new Error('Drive upload returned an unparseable response'));
        }
      } else {
        reject(new Error(`Drive upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () =>
      reject(new Error('Drive upload network error (possible CORS block)'));
    xhr.send(file);
  });
}

const SRT_RE = /_transcript\.srt$/i;
const VIDEO_RE = /^video.*\.mp4$/i;
const AUDIO_RE = /^audio.*\.m4a$/i;

/** A PID folder's resolved file set (any member may be absent). */
type PidGroup = {
  pid: string;
  srt: File | null;
  video: File | null;
  audio: File | null;
};

type Phase = 'idle' | 'uploading' | 'done';

/** Per-file upload progress, 0–100, keyed `${pid}:${kind}`. */
type ProgressMap = Record<string, number>;

/** Terminal per-session outcome shown in the results list. */
type Result =
  | { pid: string; ok: true; sessionId: string; segmentCount: number }
  | { pid: string; ok: false; error: string };

/** The leaf filename from a `webkitRelativePath` (`a/b/c.srt` → `c.srt`). */
function leafName(relPath: string): string {
  const parts = relPath.split('/');
  return parts[parts.length - 1] ?? relPath;
}

/** The PID folder for a file: the path segment immediately above the leaf. */
function pidOf(relPath: string): string | null {
  const parts = relPath.split('/').filter(Boolean);
  // `<root>/<pid>/<file>` → pid is parts[len-2]. Tolerate a flat `<pid>/<file>`.
  if (parts.length < 2) return null;
  return parts[parts.length - 2];
}

/** Group a flat `File[]` (from webkitdirectory) into per-PID file sets. */
function groupByPid(files: File[]): PidGroup[] {
  const byPid = new Map<string, PidGroup>();
  for (const file of files) {
    const rel = file.webkitRelativePath || file.name;
    const pid = pidOf(rel);
    if (!pid) continue;
    const leaf = leafName(rel);

    let group = byPid.get(pid);
    if (!group) {
      group = { pid, srt: null, video: null, audio: null };
      byPid.set(pid, group);
    }
    if (SRT_RE.test(leaf)) group.srt = file;
    else if (VIDEO_RE.test(leaf)) group.video = file;
    else if (AUDIO_RE.test(leaf)) group.audio = file;
  }
  // Only PID folders that carry an SRT are ingestable (the action requires it).
  return [...byPid.values()]
    .filter((g) => g.srt !== null)
    .sort((a, b) => a.pid.localeCompare(b.pid, undefined, { numeric: true }));
}

export default function UploadSession() {
  const [groups, setGroups] = useState<PidGroup[]>([]);
  const [collection, setCollection] = useState('study');
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<ProgressMap>({});
  const [results, setResults] = useState<Result[]>([]);
  const [activePid, setActivePid] = useState<string | null>(null);

  const supabase = useMemo(() => createBrowser(), []);

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    setGroups(groupByPid(files));
    setResults([]);
    setProgress({});
    setPhase('idle');
  }

  function setPct(pid: string, kind: string, pct: number) {
    setProgress((p) => ({ ...p, [`${pid}:${kind}`]: pct }));
  }

  async function uploadOne(group: PidGroup): Promise<Result> {
    const { pid, srt, video, audio } = group;
    if (!srt) return { pid, ok: false, error: 'no transcript .srt in folder' };

    const sessionId = crypto.randomUUID();
    const base = sessionId;
    const videoPath: string | null = null;
    let audioPath: string | null = null;
    let driveFileId: string | null = null;
    let videoSource: 'supabase' | 'drive' = 'supabase';
    const srtPath = `${base}/transcript.srt`;

    try {
      // VIDEO → Google Drive (off-server, bypasses Supabase's 50MB cap). Open a
      // resumable session server-side, then PUT the bytes browser-direct.
      if (video) {
        const { uploadUrl } = await startDriveVideoUpload({ filename: video.name });
        driveFileId = await putToDriveResumable(uploadUrl, video, (u, t) =>
          setPct(pid, 'video', Math.round((u / t) * 100)),
        );
        videoSource = 'drive';
      }

      // AUDIO → Supabase Storage via TUS resumable (large; progress).
      if (audio) {
        audioPath = `${base}/audio.m4a`;
        await resumableUpload(supabase, 'recordings', audioPath, audio, (u, t) =>
          setPct(pid, 'audio', Math.round((u / t) * 100)),
        );
      }

      // SRT: small → the standard upload endpoint is fine (and gives us the
      // text in one read below). upsert so a retried PID overwrites cleanly.
      const srtUp = await supabase.storage
        .from('recordings')
        .upload(srtPath, srt, { contentType: 'text/plain', upsert: true });
      if (srtUp.error) {
        throw new Error(`srt upload failed: ${srtUp.error.message}`);
      }
      setPct(pid, 'srt', 100);

      const srtText = await srt.text();

      const { sessionId: id, segmentCount } = await createSessionFromUpload({
        sessionId,
        pidLabel: pid,
        collection,
        srtText,
        videoPath,
        audioPath,
        srtPath,
        driveFileId,
        videoSource,
      });

      return { pid, ok: true, sessionId: id, segmentCount };
    } catch (err) {
      const error =
        err instanceof FileTooLargeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      return { pid, ok: false, error };
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (groups.length === 0 || phase === 'uploading') return;

    setPhase('uploading');
    setResults([]);
    const out: Result[] = [];
    // Sequential: each session is a multi-file resumable upload; serializing
    // keeps bandwidth predictable and per-file progress legible.
    for (const group of groups) {
      setActivePid(group.pid);
      const result = await uploadOne(group);
      out.push(result);
      setResults([...out]);
    }
    setActivePid(null);
    setPhase('done');
  }

  return (
    <main className="px-6 py-6">
      <header className="mb-4">
        <h1 className="text-lg font-medium tracking-tight">Upload sessions</h1>
        <p className="text-sm text-foreground/60 max-w-2xl">
          Point at your local Zoom Recordings folder. Each numeric participant
          subfolder (with a <code>_transcript.srt</code>) becomes a session: its
          video, audio, and transcript upload to cloud Storage and its segments
          are ingested into the database.
        </p>
      </header>

      <form onSubmit={onSubmit} className="max-w-2xl space-y-4">
        <div className="space-y-1">
          <label className="block text-xs uppercase tracking-wider text-foreground/50">
            Recordings folder
          </label>
          {/* webkitdirectory is non-standard, so it isn't in React's typed JSX
              attributes — set via a spread of string-keyed props. */}
          <input
            type="file"
            multiple
            onChange={onPick}
            disabled={phase === 'uploading'}
            {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
            className="block text-sm file:mr-3 file:rounded file:border file:border-foreground/20 file:bg-transparent file:px-3 file:py-1.5 file:text-sm"
          />
        </div>

        <div className="space-y-1">
          <label
            htmlFor="collection"
            className="block text-xs uppercase tracking-wider text-foreground/50"
          >
            Collection
          </label>
          <input
            id="collection"
            type="text"
            value={collection}
            onChange={(e) => setCollection(e.target.value)}
            disabled={phase === 'uploading'}
            placeholder="study"
            className="w-48 rounded border border-foreground/20 bg-transparent px-2 py-1 text-sm"
          />
        </div>

        {groups.length > 0 && (
          <div className="rounded border border-foreground/15">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-foreground/50 border-b border-foreground/15">
                  <th className="py-2 px-3 font-medium">PID</th>
                  <th className="py-2 px-3 font-medium">Files</th>
                  <th className="py-2 px-3 font-medium">Progress</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const parts: string[] = [];
                  if (g.video) parts.push('video');
                  if (g.audio) parts.push('audio');
                  if (g.srt) parts.push('srt');
                  const vp = progress[`${g.pid}:video`];
                  const ap = progress[`${g.pid}:audio`];
                  return (
                    <tr key={g.pid} className="border-b border-foreground/10">
                      <td className="py-2 px-3 font-mono">{g.pid}</td>
                      <td className="py-2 px-3 text-foreground/70">
                        {parts.join(', ')}
                      </td>
                      <td className="py-2 px-3 font-mono text-xs text-foreground/60">
                        {g.video !== null && (
                          <span className="mr-3">video {vp ?? 0}%</span>
                        )}
                        {g.audio !== null && <span>audio {ap ?? 0}%</span>}
                        {activePid === g.pid && (
                          <span className="ml-2 text-foreground/40">…</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <button
          type="submit"
          disabled={groups.length === 0 || phase === 'uploading'}
          className="rounded border border-foreground/25 px-4 py-1.5 text-sm transition hover:bg-foreground/5 disabled:opacity-40"
        >
          {phase === 'uploading'
            ? 'Uploading…'
            : `Upload ${groups.length || ''} session${groups.length === 1 ? '' : 's'}`}
        </button>
      </form>

      {results.length > 0 && (
        <section className="mt-6 max-w-2xl">
          <h2 className="mb-2 text-sm font-medium">Results</h2>
          <ul className="space-y-1.5 text-sm">
            {results.map((r) => (
              <li key={r.pid} className="flex items-baseline gap-3">
                <span className="font-mono">{r.pid}</span>
                {r.ok ? (
                  <span className="text-foreground/70">
                    {r.segmentCount} segments —{' '}
                    <Link
                      href={`/sessions/${r.sessionId}`}
                      className="underline underline-offset-2 hover:text-foreground"
                    >
                      {r.sessionId}
                    </Link>
                  </span>
                ) : (
                  <span className="text-red-600/80">failed: {r.error}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
