import 'server-only';

// ---------------------------------------------------------------------------
// Google Drive v3 helpers — server-only video storage.
//
// WHY Drive at all: Supabase's free-plan Storage caps a single upload at 50MB,
// and screen-recording video routinely exceeds that. So video bytes live in
// Drive (free 15GB, no per-file upload cap on the resumable path) while audio,
// transcript, and codings stay in Supabase. Drive is never exposed to the
// browser as a public link: we stream it back THROUGH our server via the Drive
// `files.get?alt=media` endpoint, which honours HTTP Range, so the `<video>`
// element seeks for free against our `/api/media/.../video` proxy.
//
// AUTH: a single installed-app OAuth client (the `auth/drive` scope) with a
// long-lived refresh token. We exchange it for short-lived access tokens at the
// token endpoint and cache the access token in a module variable until ~1min
// before expiry. This file is `server-only`; the client id/secret/refresh token
// never reach the browser.
// ---------------------------------------------------------------------------

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

/** The folder all uploaded session videos are filed under in Drive. */
const RECORDINGS_FOLDER_NAME = 'thematic-analysis-recordings';

const FOLDER_MIME = 'application/vnd.google-apps.folder';

// --- access-token cache (module-scoped) ------------------------------------
let cachedToken: { value: string; expiresAtMs: number } | null = null;

/** Refresh ~60s early to avoid races against expiry mid-request. */
const EXPIRY_SKEW_MS = 60_000;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`google/drive: missing env ${name}`);
  return v;
}

/**
 * Return a valid Drive bearer access token, refreshing via the OAuth
 * refresh-token grant when the cached one is absent or within the skew window.
 */
export async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < cachedToken.expiresAtMs - EXPIRY_SKEW_MS) {
    return cachedToken.value;
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: requireEnv('GOOGLE_OAUTH_CLIENT_ID'),
    client_secret: requireEnv('GOOGLE_OAUTH_CLIENT_SECRET'),
    refresh_token: requireEnv('GOOGLE_OAUTH_REFRESH_TOKEN'),
  });

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    cache: 'no-store',
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`google/drive: token refresh failed (${res.status}) ${detail}`);
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) {
    throw new Error('google/drive: token refresh returned no access_token');
  }

  const expiresInMs = (json.expires_in ?? 3600) * 1000;
  cachedToken = { value: json.access_token, expiresAtMs: now + expiresInMs };
  return cachedToken.value;
}

/**
 * Stream a Drive file's bytes. Pass the incoming `Range` header through and
 * return the upstream `Response` unchanged: Drive serves `206` + `Content-Range`
 * for a Range request and `200` otherwise. The caller proxies `response.body`,
 * status, and the `Content-Range`/`Content-Length`/`Content-Type` headers.
 *
 * `supportsAllDrives=true` so the same call works for files in shared drives.
 */
export async function streamDriveFile(
  fileId: string,
  rangeHeader?: string,
): Promise<Response> {
  const token = await getAccessToken();
  const url = `${DRIVE_FILES}/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
  return fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...(rangeHeader ? { Range: rangeHeader } : {}),
    },
    cache: 'no-store',
  });
}

/**
 * Initiate a Drive resumable upload session and return its `Location` (the
 * resumable session URL). The BROWSER then PUTs the big video bytes directly to
 * this URL — the file never transits our server. `parentFolderId` files the new
 * object under a given folder (typically `ensureRecordingsFolder()`).
 *
 * Returns the session URL string. A single PUT of the whole file body to this
 * URL completes the upload; Drive replies with the created file JSON (`{id,…}`).
 */
export async function createDriveResumableUpload(
  name: string,
  mimeType: string,
  parentFolderId?: string,
): Promise<string> {
  const token = await getAccessToken();

  const metadata: { name: string; mimeType: string; parents?: string[] } = {
    name,
    mimeType,
  };
  if (parentFolderId) metadata.parents = [parentFolderId];

  const res = await fetch(`${DRIVE_UPLOAD}?uploadType=resumable&supportsAllDrives=true`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      // Advertise the upload's content type so Drive tags the final object.
      'X-Upload-Content-Type': mimeType,
    },
    body: JSON.stringify(metadata),
    cache: 'no-store',
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `google/drive: failed to start resumable upload (${res.status}) ${detail}`,
    );
  }

  const location = res.headers.get('location');
  if (!location) {
    throw new Error('google/drive: resumable upload init returned no Location header');
  }
  return location;
}

/**
 * Find-or-create the `thematic-analysis-recordings` Drive folder and return its
 * id. Searched by exact name among non-trashed folders the OAuth principal owns;
 * created if absent. Idempotent enough for our single-tenant use (a benign race
 * could create two folders named the same — Drive permits that — but in practice
 * one researcher account uploads serially).
 */
export async function ensureRecordingsFolder(): Promise<string> {
  const token = await getAccessToken();

  const q = [
    `name = '${RECORDINGS_FOLDER_NAME.replace(/'/g, "\\'")}'`,
    `mimeType = '${FOLDER_MIME}'`,
    'trashed = false',
  ].join(' and ');

  const searchUrl =
    `${DRIVE_FILES}?` +
    new URLSearchParams({
      q,
      fields: 'files(id,name)',
      spaces: 'drive',
      pageSize: '1',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    }).toString();

  const found = await fetch(searchUrl, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (found.ok) {
    const json = (await found.json()) as { files?: { id: string }[] };
    const existing = json.files?.[0]?.id;
    if (existing) return existing;
  }

  // Not found → create it.
  const created = await fetch(`${DRIVE_FILES}?supportsAllDrives=true`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify({ name: RECORDINGS_FOLDER_NAME, mimeType: FOLDER_MIME }),
    cache: 'no-store',
  });
  if (!created.ok) {
    const detail = await created.text().catch(() => '');
    throw new Error(
      `google/drive: failed to create recordings folder (${created.status}) ${detail}`,
    );
  }
  const json = (await created.json()) as { id?: string };
  if (!json.id) {
    throw new Error('google/drive: folder create returned no id');
  }
  return json.id;
}
