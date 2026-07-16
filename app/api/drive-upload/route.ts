import { type NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth/supabase-auth';
import {
  createDriveResumableUpload,
  ensureRecordingsFolder,
} from '@/lib/google/drive';

// Node runtime (the Drive SDK + a large request body need it), uncached,
// request-time. The browser uploaded the video DIRECTLY to Google's resumable
// session URL before — but that cross-origin PUT is CORS-blocked from the app
// origin (esp. localhost). Instead the browser POSTs the bytes here (same
// origin → no CORS) and THIS server PUTs them to Drive (server→Google → no
// CORS). The file transits our local server; fine in a local researcher tool.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300; // Vercel serverless ceiling (was 600 — over the plan limit)

export async function POST(req: NextRequest): Promise<Response> {
  const user = await getAuthUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const filename = req.headers.get('x-filename')?.trim() || 'video.mp4';
  const mime = req.headers.get('x-content-type')?.trim() || 'video/mp4';

  const buf = Buffer.from(await req.arrayBuffer());
  if (buf.length === 0) {
    return NextResponse.json({ error: 'empty body' }, { status: 400 });
  }

  try {
    const folderId = await ensureRecordingsFolder();
    const uploadUrl = await createDriveResumableUpload(filename, mime, folderId);

    // Server-side PUT of the whole body completes the resumable session. No
    // CORS server→Google; Drive returns the created file JSON.
    const put = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': mime, 'Content-Length': String(buf.length) },
      body: buf,
    });
    if (!put.ok) {
      const detail = await put.text().catch(() => '');
      return NextResponse.json(
        { error: `drive put failed (${put.status}) ${detail.slice(0, 500)}` },
        { status: 502 },
      );
    }
    const json = (await put.json()) as { id?: string };
    if (!json.id) {
      return NextResponse.json(
        { error: 'drive upload returned no file id' },
        { status: 502 },
      );
    }
    return NextResponse.json({ driveFileId: json.id });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'drive upload failed' },
      { status: 500 },
    );
  }
}
