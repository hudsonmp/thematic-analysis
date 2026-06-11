import 'server-only';
import { requireAuthUser } from '@/lib/auth/supabase-auth';
import { createServiceRoleClient } from '@/lib/supabase/service';

// Stream a cloud session's video/audio to an authenticated researcher.
//
// The media objects live in the private Storage bucket `recordings` at the
// `video_path` / `audio_path` stored on `cb_sessions`. Rather than proxy the
// bytes through this server (which would mean re-implementing Range/seek over a
// Storage download stream), we mint a short-lived SIGNED URL and 302-redirect
// to it: Supabase signed URLs serve HTTP Range natively, so the browser
// `<video>` element seeks for free directly against Storage.
//
// SECURITY: researcher-gated via `requireAuthUser` (the path is resolved only
// from the `cb_sessions` row keyed by the uuid `id`, never from the URL — no
// path-traversal surface). The signed URL is minted with the service-role
// client so it works regardless of the caller's storage RLS; the auth gate
// already restricts this route to signed-in researchers, and the URL expires
// in 60s.

export const dynamic = 'force-dynamic';

type Kind = 'video' | 'audio';

function isKind(v: string): v is Kind {
  return v === 'video' || v === 'audio';
}

export async function GET(
  _req: Request,
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
    .select('video_path, audio_path')
    .eq('id', id)
    .maybeSingle();
  if (error || !session) {
    return new Response('not found', { status: 404 });
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
