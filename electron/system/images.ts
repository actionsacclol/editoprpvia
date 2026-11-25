/**
 * Pictures from the web for a video (the Find pictures dialog and the
 * find_images / save_images tools). What is read and how it is understood is
 * in shared/imageSearch.ts; this module does the fetching and the files.
 *
 * - Only the addresses those services publish for programs are asked: the
 *   Commons and Openverse APIs, and for Pinterest a board's or profile's RSS
 *   feed and a pin's oEmbed. No page is scraped and nothing is signed in.
 * - Requests go out in a session of their own that keeps nothing, says who it
 *   is (the app's name and version), and carries no cookies.
 * - A picture is only downloaded if a search here returned it: the editor
 *   passes ids back, never addresses.
 * - A saved picture has a <name>.credit.json next to it (who made it, the
 *   licence, where it lives), which the media library reads on import.
 */

import { app, session, type Session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {
  IMAGE_SOURCES,
  cleanQuery,
  commonsSearchUrl,
  creditOf,
  imageExt,
  imageFileBase,
  openverseSearchUrl,
  parseCommons,
  parseOpenverse,
  parsePinterestFeed,
  parsePinterestOembed,
  pinterestFeedUrl,
  pinterestOembedUrl,
  pinterestTarget,
  readCredit,
  type FoundImage,
  type ImageCredit,
  type ImageQuery,
  type ImageSearchResult,
  type SavedImage,
} from '../../shared/imageSearch';
import { logger } from './logger';
import * as store from './settings-store';

const TIMEOUT = 20_000;
const SEARCH_TIMEOUT = 12_000;
const MAX_PICTURE = 25 * 1024 * 1024;
const MAX_THUMB = 1024 * 1024;
const MAX_TEXT = 4 * 1024 * 1024;
const MAX_SAVE = 30;

/** What searches returned this session: the only pictures that can be saved. */
const found = new Map<string, FoundImage>();
const thumbs = new Map<string, string>();

let ses: Session | null = null;
function net(): Session {
  if (!ses) {
    ses = session.fromPartition('krypt-images', { cache: false });
    ses.setPermissionRequestHandler((_wc, _permission, done) => done(false));
    ses.setPermissionCheckHandler(() => false);
    ses.on('will-download', (e) => e.preventDefault());
    // The services ask programs to say who they are.
    ses.setUserAgent(`KryptEditor/${app.getVersion()} (+https://krypt.cc/tools/editor)`);
  }
  return ses;
}

export function imagesDir(): string {
  // Beside Recordings, in the folder projects are kept in (files.ts defaultWorkingDir).
  return path.join(store.load().workingDirectory ?? path.join(app.getPath('userData'), 'Projects'), 'Images');
}

/** A public https address on the open internet: never this computer or the local network. */
export function outside(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('That is not a web address.');
  }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || u.username || u.password || !host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':') || host.startsWith('[') || /(^|\.)(localhost|local|internal|lan|home|test|invalid)$/.test(host)) throw new Error('That address cannot be read.');
  return u;
}

async function get(raw: string, o: { accept: string; max: number; label: string; timeout?: number }): Promise<{ bytes: Buffer; type: string; url: string }> {
  const url = outside(raw);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.timeout ?? TIMEOUT);
  try {
    let res: Response;
    try {
      res = await net().fetch(url.toString(), { signal: ctl.signal, redirect: 'follow', credentials: 'omit', headers: { Accept: o.accept } });
    } catch (e) {
      throw new Error(ctl.signal.aborted ? `${o.label} took too long to answer. Try again shortly, or another source.` : `${o.label} could not be reached (${(e as Error).message}). Check the internet connection.`);
    }
    outside(res.url || url.toString());
    if (!res.ok) throw Object.assign(new Error(res.status === 429 ? `${o.label} is asking for a pause: too many searches in a short time. Try again in a minute.` : res.status >= 500 ? `${o.label} is busy right now (${res.status}). Try again shortly, or another source.` : `${o.label} answered ${res.status}.`), { status: res.status });
    if (Number(res.headers.get('content-length') ?? 0) > o.max) throw new Error(`${o.label} sent something too large to keep.`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > o.max) throw new Error(`${o.label} sent something too large to keep.`);
    return { bytes, type: res.headers.get('content-type') ?? '', url: res.url || url.toString() };
  } finally {
    clearTimeout(timer);
  }
}

/** A search answer. A busy service ("over capacity", a gateway timeout) is asked once more after a moment. */
async function getJson(url: string, label: string): Promise<unknown> {
  const ask = (): ReturnType<typeof get> => get(url, { accept: 'application/json', max: MAX_TEXT, label, timeout: SEARCH_TIMEOUT });
  const r = await ask().catch(async (e: Error & { status?: number }) => {
    if (e.status !== 502 && e.status !== 503 && e.status !== 504) throw e;
    await new Promise((go) => setTimeout(go, 1500));
    return ask();
  });
  try {
    return JSON.parse(r.bytes.toString('utf8')) as unknown;
  } catch {
    throw new Error(`${label} sent an answer that could not be read. Try again shortly.`);
  }
}

function remember(images: FoundImage[]): void {
  for (const i of images) {
    found.delete(i.id);
    found.set(i.id, i);
  }
  // The oldest go first once there are many.
  for (const id of found.keys()) {
    if (found.size <= 800) break;
    found.delete(id);
    thumbs.delete(id);
  }
}

const NO_SEARCH = 'Pinterest does not let programs read its search results. Paste the link of a board, a profile or a single pin instead (a board of pictures you collected works well), or search the free libraries.';

async function pinterest(link: string, count: number): Promise<ImageSearchResult> {
  let target = pinterestTarget(link);
  // Words, not an address: someone hoping to search.
  if (!target && !/[./]/.test(link)) throw new Error(NO_SEARCH);
  if (!target) throw new Error('That is not a Pinterest link. Paste the address of a board (pinterest.com/name/board), a profile (pinterest.com/name) or a pin (pinterest.com/pin/…).');
  if (target.kind === 'short') {
    // A share link from the phone app: follow it to see what it is.
    const r = await get(target.url, { accept: 'text/html', max: MAX_TEXT, label: 'Pinterest' });
    target = pinterestTarget(r.url);
    if (!target || target.kind === 'short') throw new Error('That short link does not lead to a pin, a board or a profile.');
  }
  if (target.kind === 'search') throw new Error(NO_SEARCH);
  if (target.kind === 'pin') {
    const one = parsePinterestOembed(await getJson(pinterestOembedUrl(target.id), 'Pinterest').catch((e: Error & { status?: number }) => {
      throw e.status === 404 ? new Error('No public pin at that address.') : e;
    }), target.id);
    if (!one) throw new Error('That pin has no picture that can be read (it may be private or removed).');
    return { images: [one], from: `a pin on Pinterest${one.via ? ` (${one.via})` : ''}`, source: 'pinterest', more: false };
  }
  const where = target;
  const feed = await get(pinterestFeedUrl(where), { accept: 'application/rss+xml, application/xml, text/xml', max: MAX_TEXT, label: 'Pinterest' }).catch((e: Error & { status?: number }) => {
    throw e.status === 404 ? new Error(where.kind === 'board' ? 'No public board at that address. A secret board cannot be read; check the link or make the board public.' : 'No public profile at that address.') : e;
  });
  const parsed = parsePinterestFeed(feed.bytes.toString('utf8'), `@${where.user}`);
  if (parsed.images.length === 0) throw new Error(where.kind === 'board' ? 'That board has no pictures that can be read.' : 'That profile has no public pins that can be read.');
  return { images: parsed.images.slice(0, count), from: where.kind === 'board' ? `the Pinterest board "${parsed.title || where.board}" (@${where.user})` : `@${where.user} on Pinterest`, source: 'pinterest', more: false };
}

/** Look for pictures. Nothing is downloaded but the list. */
export async function search(q: ImageQuery): Promise<ImageSearchResult> {
  const count = Math.min(20, Math.max(1, Math.round(Number(q?.count) || 12)));
  const shape = q?.shape === 'wide' || q?.shape === 'tall' || q?.shape === 'square' ? q.shape : undefined;
  const page = Math.min(50, Math.max(1, Math.round(Number(q?.page) || 1)));
  const link = typeof q?.pinterest === 'string' ? q.pinterest.trim() : '';
  const words = cleanQuery(q?.query);
  // A Pinterest link typed into the search box is a Pinterest link.
  const asLink = link || (pinterestTarget(words) ? words : '');
  let out: ImageSearchResult;
  if (asLink || q?.source === 'pinterest') {
    if (!asLink) throw new Error(words ? NO_SEARCH : 'Paste a Pinterest board, profile or pin link.');
    out = await pinterest(asLink, count);
  } else {
    if (!words) throw new Error('Type what to look for.');
    const ask: ImageQuery = { query: words, count, shape, page };
    if (q?.source === 'openverse') {
      const images = parseOpenverse(await getJson(openverseSearchUrl(ask), 'Openverse'));
      out = { images, from: 'Openverse', source: 'openverse', more: images.length >= count };
    } else {
      const images = parseCommons(await getJson(commonsSearchUrl(ask), 'Wikimedia Commons'), ask);
      out = { images, from: 'Wikimedia Commons', source: 'commons', more: images.length >= count };
    }
  }
  remember(out.images);
  return out;
}

/** A small copy of a found picture, as a data: address the editor can show. */
export async function thumb(id: string): Promise<string> {
  const have = thumbs.get(id);
  if (have) return have;
  const i = found.get(String(id)) ?? fail('That picture is not among the last results: search again.');
  const r = await get(i.thumb, { accept: 'image/jpeg, image/png, image/webp', max: MAX_THUMB, label: sourceName(i) });
  const ext = imageExt(r.type) ?? fail('The preview is not a picture.');
  const data = `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${r.bytes.toString('base64')}`;
  thumbs.set(id, data);
  return data;
}

const sourceName = (i: FoundImage): string => IMAGE_SOURCES.find((s) => s.id === i.source)?.name ?? 'The picture site';
const fail = (message: string): never => {
  throw new Error(message);
};

/** What the bytes are, whatever the server called them. */
export function sniff(b: Buffer): 'jpg' | 'png' | 'webp' | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length > 8 && b.readUInt32BE(0) === 0x89504e47) return 'png';
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/** Download found pictures into the Images folder, each with its credit next to it. */
export async function save(ids: string[]): Promise<{ saved: SavedImage[]; failed: Array<{ id: string; message: string }> }> {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(String))].slice(0, MAX_SAVE);
  const dir = imagesDir();
  fs.mkdirSync(dir, { recursive: true });
  const saved: SavedImage[] = [];
  const failed: Array<{ id: string; message: string }> = [];
  for (const id of list) {
    const i = found.get(id);
    if (!i) {
      failed.push({ id, message: 'not among the results of a search here' });
      continue;
    }
    try {
      const base = imageFileBase(i);
      const credit = creditOf(i);
      // Kept before: the same picture is not downloaded twice.
      const kept = ['jpg', 'png', 'webp'].map((e) => path.join(dir, `${base}.${e}`)).find((p) => fs.existsSync(p));
      let file = kept;
      if (!file) {
        let r: Awaited<ReturnType<typeof get>> | null = null;
        let why = '';
        for (const url of [i.url, ...(i.fallback ? [i.fallback] : [])]) {
          try {
            r = await get(url, { accept: 'image/jpeg, image/png, image/webp', max: MAX_PICTURE, label: sourceName(i) });
            break;
          } catch (e) {
            why = (e as Error).message;
          }
        }
        if (!r) throw new Error(why || 'could not be downloaded');
        const ext = sniff(r.bytes) ?? fail('what came back is not a JPEG, PNG or WebP picture');
        file = path.join(dir, `${base}.${ext}`);
        const part = `${file}.part`;
        fs.writeFileSync(part, r.bytes);
        fs.renameSync(part, file);
      }
      fs.writeFileSync(path.join(dir, `${base}.credit.json`), JSON.stringify(credit, null, 1));
      saved.push({ id, path: file, credit: credit.credit, image: i });
    } catch (e) {
      failed.push({ id, message: (e as Error).message });
      logger.warn(`images: ${id} was not saved: ${(e as Error).message}`);
    }
  }
  return { saved, failed };
}

/** The credit kept next to a picture file, when it has one. */
export function creditFor(filePath: string): ImageCredit | null {
  try {
    const p = path.join(path.dirname(filePath), `${path.basename(filePath, path.extname(filePath))}.credit.json`);
    if (!fs.existsSync(p) || fs.statSync(p).size > 8192) return null;
    return readCredit(JSON.parse(fs.readFileSync(p, 'utf8')));
  } catch {
    return null;
  }
}
