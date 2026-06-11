'use client';

import type { SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Resumable (TUS) upload to Supabase Storage.
//
// WHY this exists instead of `storage.from(bucket).upload(path, file)`:
// the standard `upload()` POSTs to the `/object/...` endpoint, which is capped
// by the project's *global* file-size limit (50 MB on the Free plan; see
// `docs/migrations`/the task notes). Videos here are 48–262 MB, so for media we
// MUST use the TUS resumable endpoint `…/storage/v1/upload/resumable`, which is
// the only path that (a) chunks the upload, (b) emits progress, and (c) — on a
// PAID project — lifts the per-request cap up to the raised global limit.
//
// The installed `@supabase/storage-js` exposes NO resumable/TUS method and
// `tus-js-client` is not a dependency, so this is a minimal, dependency-free
// TUS 1.0.0 client implemented over `fetch`: a `POST` creation request followed
// by 6 MB `PATCH` chunks (6 MB is required by Supabase's TUS implementation).
//
// IMPORTANT (Free-plan ceiling): TUS does NOT bypass the *global* 50 MB limit on
// a Free project — the creation `POST` is rejected with 413 when `upload-length`
// exceeds it. We surface that as a clear, actionable error (see `FileTooLargeError`)
// rather than a generic failure, so the operator knows the fix is a plan upgrade
// + a raised global limit, not a code change.
// ---------------------------------------------------------------------------

/** Supabase's TUS implementation pins the chunk size to exactly 6 MiB. */
const CHUNK_SIZE = 6 * 1024 * 1024;

/** Thrown when the storage server rejects the upload-length (project size cap). */
export class FileTooLargeError extends Error {
  constructor(
    readonly fileName: string,
    readonly sizeBytes: number,
  ) {
    super(
      `"${fileName}" (${(sizeBytes / 1024 / 1024).toFixed(1)} MB) exceeds the project's ` +
        `Storage file-size limit. Raise the global limit in Storage settings ` +
        `(requires a paid plan above 50 MB).`,
    );
    this.name = 'FileTooLargeError';
  }
}

function b64(s: string): string {
  // btoa needs Latin-1; metadata values here are ASCII (paths, mime types).
  return btoa(unescape(encodeURIComponent(s)));
}

/** Derive the TUS resumable endpoint from the public Supabase URL. */
function resumableEndpoint(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set.');
  return `${url.replace(/\/$/, '')}/storage/v1/upload/resumable`;
}

export type ResumableProgress = (bytesUploaded: number, bytesTotal: number) => void;

/**
 * Upload a single `File` to `recordings/<objectPath>` via TUS resumable upload,
 * bound to the signed-in researcher's session (so RLS admits the write).
 *
 * @param supabase  An authenticated browser client (`createBrowser()`).
 * @param bucket    Bucket id (e.g. `'recordings'`).
 * @param objectPath  Key within the bucket (e.g. `'<sessionId>/video.mp4'`).
 * @param file      The `File` to upload.
 * @param onProgress  Called after each chunk with (uploaded, total) bytes.
 *
 * Resolves when the object is fully written. Throws `FileTooLargeError` on a
 * size-cap rejection, or a generic `Error` on any other TUS failure.
 */
export async function resumableUpload(
  supabase: SupabaseClient,
  bucket: string,
  objectPath: string,
  file: File,
  onProgress?: ResumableProgress,
): Promise<void> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const accessToken = session?.access_token;
  if (!accessToken) {
    throw new Error('resumableUpload: no authenticated session (cannot get access token).');
  }
  const apikey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';

  const total = file.size;
  const contentType = file.type || 'application/octet-stream';

  const metadata = [
    `bucketName ${b64(bucket)}`,
    `objectName ${b64(objectPath)}`,
    `contentType ${b64(contentType)}`,
    `cacheControl ${b64('3600')}`,
  ].join(',');

  // --- 1. Creation request: declares the object + total length. -------------
  const createRes = await fetch(resumableEndpoint(), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      apikey,
      'tus-resumable': '1.0.0',
      'upload-length': String(total),
      'upload-metadata': metadata,
      'x-upsert': 'true',
    },
  });

  if (createRes.status === 413) {
    // Project/global file-size limit. The actionable failure mode.
    throw new FileTooLargeError(file.name, total);
  }
  if (createRes.status !== 201) {
    const body = await createRes.text().catch(() => '');
    throw new Error(
      `resumableUpload: creation failed (${createRes.status} ${createRes.statusText}) ${body}`,
    );
  }
  const uploadUrl = createRes.headers.get('location');
  if (!uploadUrl) {
    throw new Error('resumableUpload: creation response had no Location header.');
  }

  // --- 2. PATCH the file in 6 MiB chunks, tracking the server's offset. ------
  let offset = 0;
  onProgress?.(0, total);
  while (offset < total) {
    const end = Math.min(offset + CHUNK_SIZE, total);
    const chunk = file.slice(offset, end);
    const patchRes = await fetch(uploadUrl, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${accessToken}`,
        apikey,
        'tus-resumable': '1.0.0',
        'content-type': 'application/offset+octet-stream',
        'upload-offset': String(offset),
      },
      body: chunk,
    });

    if (patchRes.status === 413) {
      throw new FileTooLargeError(file.name, total);
    }
    if (patchRes.status !== 204) {
      const body = await patchRes.text().catch(() => '');
      throw new Error(
        `resumableUpload: chunk PATCH failed at offset ${offset} (${patchRes.status} ${patchRes.statusText}) ${body}`,
      );
    }

    const newOffset = Number(patchRes.headers.get('upload-offset'));
    offset = Number.isFinite(newOffset) && newOffset > offset ? newOffset : end;
    onProgress?.(offset, total);
  }
}
