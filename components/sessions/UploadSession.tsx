'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { createBrowser } from '@/lib/supabase/browser';
import { resumableUpload, FileTooLargeError } from '@/lib/storage/resumable-upload';
import { createSessionFromUpload } from '@/app/actions/sessions';
import {
  SESSION_COLLECTIONS,
  DEFAULT_SESSION_COLLECTION,
} from '@/lib/sessions/collections';
import {
  groupFolderFiles,
  pidsInPool,
  scopeAudioTracks,
  type FolderFile,
  type FolderGroup,
  type FolderMember,
} from '@/lib/upload/folderGrouping';
import { pickSessionVideo, type SessionPick } from '@/lib/upload/sessionVideo';
import {
  buildTranscribeEntries,
  toFormData,
} from '@/lib/upload/transcribeFormData';

// ---------------------------------------------------------------------------
// Zoom-folder upload UI (C3: session-picker + transcribe wiring).
//
// The researcher points a `<input webkitdirectory>` at (or drops) local Zoom PID
// folders. We read `webkitRelativePath`, group files PER PID into { videos[],
// audioTracks[], srt } via `groupFolderFiles`, then for each folder:
//
//   1. MEASURE every video's duration in the browser (hidden <video> element),
//      and run `pickSessionVideo` to choose the ONE session recording and skip
//      consent clips. If the duration signal is ambiguous (≥2 long recordings, or
//      no clear session), surface a per-folder WARNING the researcher must
//      CONFIRM before that folder will upload — never silently proceed.
//   2. TRANSCRIPT: if the folder has a pre-made `<pid>_transcript.srt`, use it
//      (legacy path, unchanged). If NOT, POST the chosen session video (+ any
//      per-speaker `Audio Record/*.m4a` tracks) to `/api/transcribe` and use the
//      returned SRT. If transcription tooling is absent (501) or fails, show a
//      clear per-folder error and SKIP that folder — never crash the batch.
//   3. INGEST: upload the chosen session video → Drive, audio → Supabase, and
//      feed the SRT (pre-made or generated) into `createSessionFromUpload`
//      exactly as before. Consent videos are skipped entirely.
//
// Both ingest routes ACCUMULATE into one pool (drop several folders, or pick
// folders in succession), deduped by PID.
// ---------------------------------------------------------------------------

/**
 * POST a video to OUR server (same origin → no CORS); the server PUTs it to
 * Drive. Progress is the browser→server leg. Resolves the Drive file id.
 */
function uploadVideoViaServer(
  file: File,
  onProgress: (uploaded: number, total: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/drive-upload', true);
    xhr.setRequestHeader('Content-Type', file.type || 'video/mp4');
    xhr.setRequestHeader('x-content-type', file.type || 'video/mp4');
    xhr.setRequestHeader('x-filename', file.name);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const json = JSON.parse(xhr.responseText) as {
            driveFileId?: string;
            error?: string;
          };
          if (json.driveFileId) resolve(json.driveFileId);
          else reject(new Error(json.error || 'Drive upload returned no file id'));
        } catch {
          reject(new Error('Drive upload returned an unparseable response'));
        }
      } else {
        let msg = `Drive upload failed (${xhr.status})`;
        try {
          const j = JSON.parse(xhr.responseText) as { error?: string };
          if (j.error) msg = j.error;
        } catch {
          /* keep the status message */
        }
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error('Drive upload network error'));
    xhr.send(file);
  });
}

/**
 * Measure a video File's duration (ms) in the browser by loading it into a
 * detached <video> and reading `duration` on `loadedmetadata`. The object URL is
 * always revoked. Resolves 0 on any failure (unreadable codec / metadata) so the
 * picker still runs — a 0-duration candidate just sorts last.
 */
function probeDurationMs(file: File): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    const done = (ms: number) => {
      URL.revokeObjectURL(url);
      video.removeAttribute('src');
      video.load();
      resolve(ms);
    };
    video.onloadedmetadata = () => {
      const d = video.duration;
      done(Number.isFinite(d) && d > 0 ? Math.round(d * 1000) : 0);
    };
    video.onerror = () => done(0);
    video.src = url;
  });
}

// ----------------------------- types ---------------------------------------

type Phase = 'idle' | 'probing' | 'uploading' | 'done';

/** Per-file upload progress, 0–100, keyed `${pid}:${kind}`. */
type ProgressMap = Record<string, number>;

/** Terminal per-session outcome shown in the results list. */
type Result =
  | { pid: string; ok: true; sessionId: string; segmentCount: number }
  | { pid: string; ok: false; error: string };

/**
 * A file paired with its explicit relative path. The two ingest routes derive it
 * differently and `File.webkitRelativePath` is read-only:
 *   - `<input webkitdirectory>` → `file.webkitRelativePath` = `<root>/<pid>/<file>`.
 *   - drag-and-drop of folders   → synthesized as `<pid>/<…>/<file>`.
 */
type PathedFile = FolderFile;

/**
 * The resolved plan for one PID folder after the browser duration probe: the
 * grouped media, the picker verdict, and what the upload will do.
 */
type FolderPlan = {
  pid: string;
  group: FolderGroup;
  pick: SessionPick;
  /**
   * Per-speaker tracks SCOPED to the chosen session video's Zoom segment (via
   * `scopeAudioTracks`). Zoom writes a new numbered recording each stop/start, so
   * a folder can hold tracks from consent + task + fragment segments; only the
   * session segment's tracks may be transcribed. Drives BOTH the transcribe POST
   * and the displayed "N speaker tracks" count. `[]` when the session has no
   * matching tracks → the route transcribes the session video's own audio.
   */
  scopedTracks: FolderMember[];
  /** Pre-made SRT present → legacy path; else we will generate via /api/transcribe. */
  willGenerate: boolean;
  /** A blocking issue computed up front (no video at all). */
  blockedReason: string | null;
};

/**
 * Whether a folder is ready to upload: it must have a session video and, when the
 * picker flagged ambiguity, the researcher must have confirmed it. Pure so the
 * `readyPlans` memo's deps stay honest.
 */
function planIsReady(plan: FolderPlan, confirmed: Set<string>): boolean {
  if (plan.blockedReason) return false;
  if (plan.pick.ambiguous && !confirmed.has(plan.pid)) return false;
  return true;
}

/**
 * Recursively read a dropped `FileSystemEntry` into `{file, relPath}` pairs.
 * `prefix` is the accumulated parent path (`''` at top level → a dropped folder's
 * own name becomes the first path segment = the PID).
 */
function readEntry(
  entry: FileSystemEntry,
  prefix: string,
): Promise<PathedFile[]> {
  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry;
    return new Promise<PathedFile[]>((resolve, reject) => {
      fileEntry.file(
        (file) => resolve([{ file, relPath: prefix + entry.name }]),
        (err) => reject(err),
      );
    });
  }

  if (entry.isDirectory) {
    const dirEntry = entry as FileSystemDirectoryEntry;
    const reader = dirEntry.createReader();
    const childPrefix = prefix + entry.name + '/';

    return new Promise<PathedFile[]>((resolve, reject) => {
      const all: FileSystemEntry[] = [];
      const readBatch = () => {
        reader.readEntries((batch) => {
          if (batch.length === 0) {
            Promise.all(all.map((child) => readEntry(child, childPrefix)))
              .then((nested) => resolve(nested.flat()))
              .catch(reject);
            return;
          }
          all.push(...batch);
          readBatch();
        }, reject);
      };
      readBatch();
    });
  }

  return Promise.resolve([]);
}

// ----------------------------- component -----------------------------------

export default function UploadSession() {
  // The accumulated `{file, relPath}` pool. Both the directory `<input>` and the
  // drag-and-drop dropzone MERGE into this list (dedupe by PID), so the
  // researcher can stack several folders before uploading.
  const [items, setItems] = useState<PathedFile[]>([]);
  const [collection, setCollection] = useState<string>(DEFAULT_SESSION_COLLECTION);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<ProgressMap>({});
  const [results, setResults] = useState<Result[]>([]);
  const [activePid, setActivePid] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  // Per-folder plans, computed by the async duration probe whenever `items`
  // changes. null while a probe is in flight / before the first selection.
  const [plans, setPlans] = useState<FolderPlan[]>([]);
  // PIDs whose ambiguous warning the researcher has explicitly confirmed.
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());

  const supabase = useMemo(() => createBrowser(), []);

  /** Reset the run state whenever the selection changes. */
  const clearRun = useCallback(() => {
    setResults([]);
    setProgress({});
    setPhase('idle');
  }, []);

  /**
   * Merge a fresh batch into the pool, deduping by PID: any PID present in
   * `incoming` replaces its previously-collected files entirely (a re-dropped
   * folder wins). This is what makes BOTH the picker and the drop accumulate.
   */
  const mergeItems = useCallback(
    (incoming: PathedFile[]) => {
      setItems((prev) => {
        const incomingPids = new Set(pidsInPool(incoming));
        const kept = prev.filter((it) => {
          const pid = pidsInPool([it])[0];
          return pid !== undefined && !incomingPids.has(pid);
        });
        return [...kept, ...incoming];
      });
      clearRun();
    },
    [clearRun],
  );

  // --- Duration probe: rebuild the per-folder plans whenever `items` changes. --
  // Browser-only (probeDurationMs needs the DOM), so it lives in an effect, not a
  // derived memo. Each PID folder's videos are measured, then pickSessionVideo
  // decides the session + flags ambiguity.
  useEffect(() => {
    let cancelled = false;
    const pids = pidsInPool(items);
    // Empty selection is handled in the async body too (it just yields an empty
    // plan list) so we never call setState SYNCHRONOUSLY inside the effect body.
    (async () => {
      if (pids.length > 0) setPhase('probing');
      const next: FolderPlan[] = [];
      for (const pid of pids) {
        const group = groupFolderFiles(pid, items);
        const candidates = await Promise.all(
          group.videos.map(async (v) => ({
            name: v.leaf,
            durationMs: await probeDurationMs(v.file),
          })),
        );
        const pick = pickSessionVideo(candidates);
        // Scope the per-speaker tracks to the chosen session's Zoom segment so we
        // never transcribe consent/fragment audio. `[]` (no session, or no
        // matching tracks) → the route transcribes the session video's own audio.
        const scopedTracks = pick.session
          ? scopeAudioTracks(pick.session.name, group.audioTracks)
          : [];
        next.push({
          pid,
          group,
          pick,
          scopedTracks,
          willGenerate: group.srt === null,
          blockedReason: pick.session === null ? 'no video file in folder' : null,
        });
      }
      if (cancelled) return;
      setPlans(next);
      // Drop confirmations for PIDs that are no longer present / no longer ambiguous.
      setConfirmed((prev) => {
        const stillAmbiguous = new Set(
          next.filter((p) => p.pick.ambiguous).map((p) => p.pid),
        );
        return new Set([...prev].filter((pid) => stillAmbiguous.has(pid)));
      });
      setPhase('idle');
    })();
    return () => {
      cancelled = true;
    };
  }, [items]);

  /** Map a plan's leaf back to the FolderMember so we can upload its File. */
  function sessionMember(plan: FolderPlan) {
    return plan.group.videos.find((v) => v.leaf === plan.pick.session?.name) ?? null;
  }

  const readyPlans = useMemo(
    () => plans.filter((p) => planIsReady(p, confirmed)),
    [plans, confirmed],
  );
  const blockedAmbiguous = useMemo(
    () => plans.filter((p) => p.pick.ambiguous && !confirmed.has(p.pid)),
    [plans, confirmed],
  );

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    // The directory input gives `webkitRelativePath` = `<root>/<pid>/<file>`.
    // MERGE (not replace) so successive folder picks accumulate, matching drop.
    const incoming: PathedFile[] = Array.from(e.target.files ?? []).map((file) => ({
      file,
      relPath: file.webkitRelativePath || file.name,
    }));
    mergeItems(incoming);
    // Let the same folder be re-picked later (onChange won't fire on same value).
    e.target.value = '';
  }

  function onDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }
  function onDragEnter(e: React.DragEvent) {
    e.preventDefault();
    if (phase !== 'uploading') setDragging(true);
  }
  function onDragLeave(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (phase === 'uploading') return;

    const entries = Array.from(e.dataTransfer.items)
      .map((it) => it.webkitGetAsEntry())
      .filter((entry): entry is FileSystemEntry => entry !== null);

    const dirs = entries.filter((entry) => entry.isDirectory);
    if (dirs.length === 0) return;

    const nested = await Promise.all(dirs.map((dir) => readEntry(dir, '')));
    mergeItems(nested.flat());
  }

  function setPct(pid: string, kind: string, pct: number) {
    setProgress((p) => ({ ...p, [`${pid}:${kind}`]: pct }));
  }

  /**
   * Resolve the SRT text for a folder: the pre-made SRT (legacy), or one
   * generated by POSTing the session video (+ Audio Record tracks) to
   * `/api/transcribe`. Returns { srtText } or { error } (never throws).
   */
  async function resolveSrtText(
    plan: FolderPlan,
    sessionFile: File,
  ): Promise<{ srtText: string } | { error: string }> {
    // Legacy path: a pre-made transcript exists → use it verbatim, unchanged.
    if (plan.group.srt) {
      try {
        return { srtText: await plan.group.srt.text() };
      } catch (e) {
        return { error: e instanceof Error ? e.message : 'failed to read SRT file' };
      }
    }

    // Generate path: send the chosen session video + ONLY the per-speaker tracks
    // that belong to its Zoom segment (`plan.scopedTracks`). Sending every
    // `Audio Record/*.m4a` would splice consent/fragment audio into the transcript;
    // the top-level mixed `audio*.m4a` is likewise never sent to /api/transcribe.
    const entries = buildTranscribeEntries(sessionFile, plan.scopedTracks);
    let res: Response;
    try {
      res = await fetch('/api/transcribe', { method: 'POST', body: toFormData(entries) });
    } catch (e) {
      return { error: e instanceof Error ? e.message : 'transcribe request failed' };
    }
    let json: { ok?: boolean; srt?: string; error?: string } = {};
    try {
      json = (await res.json()) as typeof json;
    } catch {
      return { error: `transcription failed (HTTP ${res.status})` };
    }
    if (!res.ok || !json.ok || typeof json.srt !== 'string') {
      if (res.status === 501) {
        return {
          error:
            'local whisper not available — run the coding tool on the machine with whisper.cpp',
        };
      }
      return { error: json.error || `transcription failed (HTTP ${res.status})` };
    }
    return { srtText: json.srt };
  }

  async function uploadOne(plan: FolderPlan): Promise<Result> {
    const { pid } = plan;
    const member = sessionMember(plan);
    if (!member) return { pid, ok: false, error: plan.blockedReason ?? 'no session video' };
    const sessionFile = member.file;

    const sessionId = crypto.randomUUID();
    const base = sessionId;
    let audioPath: string | null = null;
    let driveFileId: string | null = null;
    let videoSource: 'supabase' | 'drive' = 'supabase';
    const srtPath = `${base}/transcript.srt`;

    try {
      // 1) SRT first: if generation fails (e.g. 501), skip BEFORE any upload.
      const srt = await resolveSrtText(plan, sessionFile);
      if ('error' in srt) return { pid, ok: false, error: srt.error };
      setPct(pid, 'srt', 50);

      // 2) SESSION VIDEO → Google Drive (consent videos are never uploaded).
      driveFileId = await uploadVideoViaServer(sessionFile, (u, t) =>
        setPct(pid, 'video', Math.round((u / t) * 100)),
      );
      videoSource = 'drive';

      // 3) AUDIO → Supabase Storage (the first track; schema holds one audio_path).
      const audioFile = plan.group.audioTracks[0]?.file ?? null;
      if (audioFile) {
        audioPath = `${base}/audio.m4a`;
        await resumableUpload(supabase, 'recordings', audioPath, audioFile, (u, t) =>
          setPct(pid, 'audio', Math.round((u / t) * 100)),
        );
      }

      // 4) SRT text → Supabase Storage (small; upsert so a retry overwrites).
      const srtUp = await supabase.storage
        .from('recordings')
        .upload(srtPath, srt.srtText, { contentType: 'text/plain', upsert: true });
      if (srtUp.error) throw new Error(`srt upload failed: ${srtUp.error.message}`);
      setPct(pid, 'srt', 100);

      // 5) Ingest. track_mode is derived inside the action from the SRT's speaker
      //    labels — a speaker-labeled (multi-track) generated SRT yields 'multi'.
      const { sessionId: id, segmentCount } = await createSessionFromUpload({
        sessionId,
        pidLabel: pid,
        collection,
        srtText: srt.srtText,
        videoPath: null,
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
    if (readyPlans.length === 0 || phase === 'uploading' || phase === 'probing') return;

    setPhase('uploading');
    setResults([]);
    const out: Result[] = [];
    // Sequential: each session is a multi-file resumable upload; serializing keeps
    // bandwidth predictable and per-file progress legible. Only READY plans run;
    // ambiguous-unconfirmed and blocked folders are skipped.
    for (const plan of readyPlans) {
      setActivePid(plan.pid);
      const result = await uploadOne(plan);
      out.push(result);
      setResults([...out]);
    }
    setActivePid(null);
    setPhase('done');
  }

  function toggleConfirm(pid: string) {
    setConfirmed((prev) => {
      const next = new Set(prev);
      if (next.has(pid)) next.delete(pid);
      else next.add(pid);
      return next;
    });
    clearRun();
  }

  const busy = phase === 'uploading' || phase === 'probing';

  return (
    <main className="px-6 py-6">
      <header className="mb-4">
        <h1 className="text-lg font-medium tracking-tight">Upload sessions</h1>
        <p className="text-sm text-foreground/60 max-w-2xl">
          Drop one or more numeric PID folders (or point the picker at your local
          Zoom Recordings folder). For each folder we measure every video&apos;s
          duration to pick the SESSION recording (skipping the short consent clip),
          use the folder&apos;s <code>_transcript.srt</code> if present or otherwise
          generate one locally, then upload the session video, audio, and transcript
          and ingest its segments. Every folder lands under the one study /
          collection below.
        </p>
        <p className="mt-1 text-xs text-foreground/45 max-w-2xl">
          Tip: you can drop several folders at once, pick folders one after another
          (they accumulate), or point the picker at the umbrella Recordings folder.
        </p>
      </header>

      <form onSubmit={onSubmit} className="max-w-2xl space-y-4">
        <div className="space-y-1">
          <label className="block text-xs uppercase tracking-wider text-foreground/50">
            Drop PID folders
          </label>
          <div
            onDragOver={onDragOver}
            onDragEnter={onDragEnter}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            aria-disabled={phase === 'uploading'}
            className={`rounded border border-dashed px-4 py-6 text-center text-sm transition ${
              dragging
                ? 'border-foreground/50 bg-foreground/5'
                : 'border-foreground/25'
            } ${phase === 'uploading' ? 'opacity-40' : ''}`}
          >
            <span className="text-foreground/70">
              Drag one or more numeric PID folders here
            </span>
            <span className="mt-1 block text-xs text-foreground/45">
              Drop several at once — all of them upload under the study/collection
              named below.
            </span>
          </div>
        </div>

        <div className="space-y-1">
          <label className="block text-xs uppercase tracking-wider text-foreground/50">
            …or pick a Recordings folder
          </label>
          {/* webkitdirectory is non-standard, so set via a spread of string props. */}
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
          <select
            id="collection"
            value={collection}
            onChange={(e) => setCollection(e.target.value)}
            disabled={phase === 'uploading'}
            className="w-48 rounded border border-foreground/20 bg-background px-2 py-1 text-sm"
          >
            {SESSION_COLLECTIONS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>

        {phase === 'probing' && (
          <p className="text-xs text-foreground/55">Measuring video durations…</p>
        )}

        {plans.length > 0 && (
          <div className="rounded border border-foreground/15">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-foreground/50 border-b border-foreground/15">
                  <th className="py-2 px-3 font-medium">PID</th>
                  <th className="py-2 px-3 font-medium">Session</th>
                  <th className="py-2 px-3 font-medium">Transcript</th>
                  <th className="py-2 px-3 font-medium">Progress</th>
                </tr>
              </thead>
              <tbody>
                {plans.map((p) => {
                  const vp = progress[`${p.pid}:video`];
                  const ap = progress[`${p.pid}:audio`];
                  const sessionName = p.pick.session?.name ?? '—';
                  const consentCount = p.pick.consent.length;
                  // Tracks that will actually be TRANSCRIBED: the session segment's
                  // tracks only (so 742 shows 2, not all 9 across segments).
                  const trackCount = p.scopedTracks.length;
                  // Whether ANY audio is uploaded for playback (separate concern:
                  // the first available track → audio_path, unchanged by scoping).
                  const hasPlaybackAudio = p.group.audioTracks.length > 0;
                  return (
                    <tr key={p.pid} className="border-b border-foreground/10 align-top">
                      <td className="py-2 px-3 font-mono">{p.pid}</td>
                      <td className="py-2 px-3 text-foreground/70">
                        <div className="font-mono text-xs">{sessionName}</div>
                        {consentCount > 0 && (
                          <div className="text-xs text-foreground/45">
                            skipping {consentCount} consent clip
                            {consentCount === 1 ? '' : 's'}
                          </div>
                        )}
                        {p.blockedReason && (
                          <div className="text-xs text-red-600/80">
                            {p.blockedReason}
                          </div>
                        )}
                        {p.pick.ambiguous && (
                          <div className="mt-1 text-xs text-amber-600">
                            <span className="font-medium">⚠ {p.pick.reason}.</span>{' '}
                            <label className="inline-flex items-center gap-1">
                              <input
                                type="checkbox"
                                checked={confirmed.has(p.pid)}
                                onChange={() => toggleConfirm(p.pid)}
                                disabled={phase === 'uploading'}
                              />
                              <span>confirm &amp; upload</span>
                            </label>
                          </div>
                        )}
                      </td>
                      <td className="py-2 px-3 text-foreground/70 text-xs">
                        {p.willGenerate ? (
                          <span>
                            will generate
                            {trackCount >= 2
                              ? ` (${trackCount} speaker tracks)`
                              : ''}
                          </span>
                        ) : (
                          <span>pre-made .srt</span>
                        )}
                      </td>
                      <td className="py-2 px-3 font-mono text-xs text-foreground/60">
                        {p.pick.session && (
                          <span className="mr-3">video {vp ?? 0}%</span>
                        )}
                        {hasPlaybackAudio && <span>audio {ap ?? 0}%</span>}
                        {activePid === p.pid && (
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

        {blockedAmbiguous.length > 0 && (
          <p className="text-xs text-amber-600">
            {blockedAmbiguous.length} folder
            {blockedAmbiguous.length === 1 ? '' : 's'} need confirmation before
            upload (ambiguous session pick).
          </p>
        )}

        <button
          type="submit"
          disabled={readyPlans.length === 0 || busy}
          className="rounded border border-foreground/25 px-4 py-1.5 text-sm transition hover:bg-foreground/5 disabled:opacity-40"
        >
          {phase === 'uploading'
            ? 'Uploading…'
            : phase === 'probing'
              ? 'Measuring…'
              : `Upload ${readyPlans.length || ''} session${readyPlans.length === 1 ? '' : 's'}`}
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
