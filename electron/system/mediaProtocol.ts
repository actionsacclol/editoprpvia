/**
 * A privileged `krypteditor://media/<encoded-path>` protocol that streams a
 * local media file to the renderer. This lets the editor play imported clips
 * (video in a <video>, audio in <audio>, images in <img>) without inlining
 * megabytes of base64, and it works the same in dev (http://localhost) and
 * prod (file://) where a raw file:// URL would be blocked or cross-origin.
 *
 * The path is carried URL-encoded in the pathname; we serve the bytes with a
 * sensible content type so media elements can buffer and seek client-side.
 *
 * `krypteditor://models/<encoded url>` is the speech models' download cache
 * (GET a file, PUT one). transformers.js would use the browser Cache API, but
 * Chromium (Electron 45) rejects every Cache.put() from a file:// page, so the
 * models would be downloaded again on every launch.
 *
 * `krypteditor://guides/<file>` is a video guide (or its picture) that ships
 * with the app in resources/guides: only plain names ending .mp4 or .jpg.
 *
 * registerScheme() must run BEFORE app 'ready'; installHandler() after.
 */

import { app, protocol } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { logger } from './logger';
import { isAllowed } from './allowlist';

export const SCHEME = 'krypteditor';

function mimeFor(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'mp4':
    case 'm4v':
      return 'video/mp4';
    case 'webm':
      return 'video/webm';
    case 'mov':
      return 'video/quicktime';
    case 'mkv':
      return 'video/x-matroska';
    case 'avi':
      return 'video/x-msvideo';
    case 'mp3':
      return 'audio/mpeg';
    case 'wav':
      return 'audio/wav';
    case 'ogg':
      return 'audio/ogg';
    case 'm4a':
    case 'aac':
      return 'audio/aac';
    case 'flac':
      return 'audio/flac';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'bmp':
      return 'image/bmp';
    default:
      return 'application/octet-stream';
  }
}

export function registerScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      // corsEnabled: Chromium (Electron 45) applies CORS to fetch() from the
      // file:// page, and only lets CORS-enabled schemes through.
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true, corsEnabled: true },
    },
  ]);
}

/**
 * Parse a single-range `Range: bytes=start-end` header against a known file
 * size. Returns the resolved inclusive byte bounds, or null when the header is
 * absent/unsatisfiable (the caller then serves the whole file with 200).
 * Supports open-ended (`bytes=500-`) and suffix (`bytes=-500`) forms; we only
 * honour the first range — media elements never ask for multipart ranges.
 */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return null;

  let start: number;
  let end: number;
  if (rawStart === '') {
    // Suffix range: the final N bytes.
    const n = parseInt(rawEnd, 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = parseInt(rawStart, 10);
    end = rawEnd === '' ? size - 1 : parseInt(rawEnd, 10);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size) return null; // unsatisfiable → fall back to 200
  return { start, end: Math.min(end, size - 1) };
}

/**
 * CORS for the renderer's fetch()es (mediabunny, audio decode): the page is
 * file://, a different origin. Only this app's renderer can reach the scheme,
 * and the allowlist still decides which files are served; mediabunny reads
 * Content-Range/Length to seek, so they're exposed.
 */
const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Content-Type',
  'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges, Content-Type',
};

export function installHandler(): void {
  protocol.handle(SCHEME, async (request) => {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const res = new URL(request.url).hostname === 'models' ? await serveModel(request) : await serve(request);
    for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
    return res;
  });
}

const modelDir = (): string => path.join(app.getPath('userData'), 'models', 'speech');
/** Only model files from Hugging Face are cached. */
const MODEL_ORIGIN = 'https://huggingface.co/';

/** The speech-model cache: one file per download URL, named by its hash. */
async function serveModel(request: Request): Promise<Response> {
  try {
    const key = decodeURIComponent(new URL(request.url).pathname.replace(/^\//, ''));
    if (!key.startsWith(MODEL_ORIGIN)) return new Response('not found', { status: 404 });
    const file = path.join(modelDir(), crypto.createHash('sha256').update(key).digest('hex'));
    if (request.method === 'PUT') {
      if (!request.body) return new Response('bad request', { status: 400 });
      await fs.promises.mkdir(modelDir(), { recursive: true });
      // Write beside it and rename, so a half-written file is never served.
      const part = `${file}.${process.pid}-${Date.now()}.part`;
      try {
        await fs.promises.writeFile(part, Readable.fromWeb(request.body as import('node:stream/web').ReadableStream<Uint8Array>));
        await fs.promises.rename(part, file);
      } catch (err) {
        await fs.promises.rm(part, { force: true });
        throw err;
      }
      return new Response(null, { status: 201 });
    }
    let size: number;
    try {
      size = (await fs.promises.stat(file)).size;
    } catch {
      return new Response('not found', { status: 404 });
    }
    const body = Readable.toWeb(fs.createReadStream(file)) as ReadableStream<Uint8Array>;
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) } });
  } catch (err) {
    logger.warn(`[media] model cache failed: ${(err as Error).message}`);
    return new Response('error', { status: 500 });
  }
}

/** The guides that ship with the app (see src/utils/guides.ts for the same rule on names). */
const guideDir = (): string => (app.isPackaged ? path.join(process.resourcesPath, 'resources', 'guides') : path.join(__dirname, '..', 'resources', 'guides'));
const GUIDE_FILE = /^[a-z0-9-]+\.(mp4|jpg)$/;

async function serve(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const guide = url.hostname === 'guides';
    if (url.hostname !== 'media' && !guide) return new Response('not found', { status: 404 });
    const asked = decodeURIComponent(url.pathname.replace(/^\//, ''));
    if (!asked) return new Response('bad request', { status: 400 });
    // A guide is a plain file name in the app's own folder: no path can be made from it.
    if (guide && !GUIDE_FILE.test(asked)) return new Response('not found', { status: 404 });
    const filePath = guide ? path.join(guideDir(), asked) : asked;
    // Only serve files the user actually imported/opened — never arbitrary paths.
    if (!guide && !isAllowed(filePath)) {
      logger.warn(`[media] blocked non-allowlisted path: ${filePath}`);
      return new Response('forbidden', { status: 403 });
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return new Response('not found', { status: 404 });
    }
    if (!stat.isFile()) return new Response('not found', { status: 404 });

    const size = stat.size;
    const mime = mimeFor(path.extname(filePath).slice(1));
    const range = parseRange(request.headers.get('range'), size);

    // Range support is what lets <video>/<audio> seek and lets Chromium's
    // media stack probe/play correctly — without it audio (esp. mp3) often
    // loads but never plays. A range request gets a 206 with the slice; a
    // plain request gets the whole file but still advertises Accept-Ranges.
    if (range) {
      const { start, end } = range;
      const body = Readable.toWeb(fs.createReadStream(filePath, { start, end })) as ReadableStream<Uint8Array>;
      return new Response(body, {
        status: 206,
        headers: {
          'Content-Type': mime,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-cache',
        },
      });
    }

    const body = Readable.toWeb(fs.createReadStream(filePath)) as ReadableStream<Uint8Array>;
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': mime,
        'Content-Length': String(size),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
      },
    });
  } catch (err) {
    logger.warn(`[media] protocol handler failed: ${(err as Error).message}`);
    return new Response('error', { status: 500 });
  }
}

/** Build a stream URL for an absolute local file path. */
export function mediaUrl(filePath: string): string {
  return `${SCHEME}://media/${encodeURIComponent(filePath)}`;
}
