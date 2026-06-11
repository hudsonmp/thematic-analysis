import 'server-only';
import { requireAuthUser } from '@/lib/auth/supabase-auth';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { streamDriveFile } from '@/lib/google/drive';

// Stream a cloud session's video/audio to an authenticated researcher.
//
// AUDIO (and Supabase-backed VIDEO): the objects live in the private Storage
// bucket `recordings` at the `audio_path` / `video_path` on `cb_sessions`.
// Rather than proxy the bytes through this server, we mint a short-lived SIGNED
// URL and 302-redirect to it: Supabase signed URLs serve HTTP Range natively,
// so the browser `<video>`/`<audio>` element seeks for free against Storage.
//
// DRIVE-backed VIDEO (`video_source = 'drive'`): the large video lives in Google
// Drive (Supabase's free plan caps a single upload at 50MB). Drive isn't a
// public link, so we PROXY it: we fetch `files.get?alt=media` with the caller's
// `Range` header and stream the upstream `Response` body straight back, mirroring
// status (206/200) and the `Content-Range`/`Content-Length`/`Content-Type`
// headers — the `<video>` element seeks against THIS route, which relays Range to
// Drive. The Drive bearer token never leaves the server.
//
// SECURITY: researcher-gated via `requireAuthUser` (the path / Drive file id is
// resolved only from the `cb_sessions` row keyed by the uuid `id`, never from the
// URL — no path-traversal surface).

export const dynamic = 'force-dynamic';

type Kind = 'video' | 'audio';

function isKind(v: string): v is Kind {
  return v === 'video' || v === 'audio';
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string; kind: string }> },
): Promise<Response> {
  // Auth gate. `requireAuthUser` redirects unauthenticated callers to login.
  await requireAuthUser();

  const { id, kind } = await ctx.params;
  if (!isKind(kind)) {
    return new Response('bad kind', { status: 400 });
  }

  const sb = createServiceRoleClient();

  // Load the session row to resolve the media object path for this `kind`.
  const { data: session, error } = await sb
    .from('cb_sessions')
    .select('video_path, audio_path, video_source, drive_file_id')
    .eq('id', id)
    .maybeSingle();
  if (error || !session) {
    return new Response('not found', { status: 404 });
  }

  // Drive-backed video → proxy the bytes through this server with Range relayed
  // to Drive. Audio is never Drive-backed; it falls through to the signed URL.
  if (kind === 'video' && session.video_source === 'drive') {
    if (!session.drive_file_id) {
      return new Response('media not found', { status: 404 });
    }
    const up = await streamDriveFile(
      session.drive_file_id,
      req.headers.get('range') ?? undefined,
    );
    if (!up.ok && up.status !== 206) {
      // Drive returned an error (e.g. 404 deleted, 401 token) — surface 404.
      return new Response('media not found', { status: 404 });
    }
    const headers: Record<string, string> = {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
    };
    const contentRange = up.headers.get('content-range');
    if (contentRange) headers['Content-Range'] = contentRange;
    const contentLength = up.headers.get('content-length');
    if (contentLength) headers['Content-Length'] = contentLength;
    return new Response(up.body, { status: up.status, headers });
  }

  const path = kind === 'video' ? session.video_path : session.audio_path;
  if (!path) {
    return new Response('media not found', { status: 404 });
  }

  // Mint a short-lived signed URL. Supabase signed URLs serve Range natively,
  // so redirecting the browser to it gives seek-without-proxy.
  const { data: signed, error: signErr } = await sb.storage
    .from('recordings')
    .createSignedUrl(path, 60);
  if (signErr || !signed?.signedUrl) {
    return new Response('media not found', { status: 404 });
  }

  // 302 → the signed URL. `Response.redirect` defaults to 307; pass 302
  // explicitly so the browser issues a plain GET against Storage.
  return Response.redirect(signed.signedUrl, 302);
}
