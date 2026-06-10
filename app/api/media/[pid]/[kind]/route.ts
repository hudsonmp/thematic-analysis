import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { getResearcherSession } from '@/lib/auth/researcher';
import { getSession } from '@/lib/sessions/discover';

// Stream a session's video/audio to an authenticated researcher.
//
// SECURITY: the file path is resolved ONLY via `getSession(pid)` (which
// validates the pid and reads the media filename from disk/recording.conf) —
// the raw URL never builds a filesystem path, so there is no path-traversal
// surface. Researcher-gated; 401 otherwise.
//
// HTTP Range is supported so the browser <video> element can seek without
// downloading the whole file. Bodies stream from disk via
// `Readable.toWeb(createReadStream(...))` — files are 48–119 MB and must NOT be
// buffered into memory.

export const dynamic = 'force-dynamic';

type Kind = 'video' | 'audio';

function isKind(v: string): v is Kind {
  return v === 'video' || v === 'audio';
}

/** Web-stream a byte range (or the whole file) from disk. */
function fileStream(filePath: string, start: number, end: number): ReadableStream<Uint8Array> {
  const nodeStream = fs.createReadStream(filePath, { start, end });
  return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ pid: string; kind: string }> },
): Promise<Response> {
  const s = await getResearcherSession();
  if (!s.ok) return new Response('unauthorized', { status: 401 });

  const { pid, kind } = await ctx.params;
  if (!isKind(kind)) {
    return new Response('bad kind', { status: 400 });
  }

  // Resolve the file via session discovery (validates pid; no path from URL).
  let session;
  try {
    session = await getSession(pid);
  } catch {
    return new Response('not found', { status: 404 });
  }

  const { meta } = session;
  const fileName = kind === 'video' ? meta.videoFile : meta.audioFile;
  if (!fileName) {
    return new Response('media not found', { status: 404 });
  }
  const filePath = path.join(meta.dir, fileName);
  if (!fs.existsSync(filePath)) {
    return new Response('media not found', { status: 404 });
  }

  const size = fs.statSync(filePath).size;
  const contentType = kind === 'video' ? 'video/mp4' : 'audio/mp4';

  const rangeHeader = req.headers.get('range');
  if (rangeHeader) {
    // Parse `bytes=start-end`. end may be omitted (means "to EOF").
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (m) {
      const startStr = m[1];
      const endStr = m[2];
      let start = startStr === '' ? 0 : Number.parseInt(startStr, 10);
      let end = endStr === '' ? size - 1 : Number.parseInt(endStr, 10);

      // Clamp and validate. An unsatisfiable range gets a 416.
      if (Number.isNaN(start) || start < 0) start = 0;
      if (Number.isNaN(end) || end > size - 1) end = size - 1;
      if (start > end || start >= size) {
        return new Response('range not satisfiable', {
          status: 416,
          headers: {
            'Content-Range': `bytes */${size}`,
            'Accept-Ranges': 'bytes',
          },
        });
      }

      const chunkSize = end - start + 1;
      return new Response(fileStream(filePath, start, end), {
        status: 206,
        headers: {
          'Content-Type': contentType,
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Content-Length': String(chunkSize),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'private, no-store',
        },
      });
    }
    // Malformed Range header → fall through to a full 200 response.
  }

  return new Response(fileStream(filePath, 0, size - 1), {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(size),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-store',
    },
  });
}
