/**
 * A YouTube channel as an example to take after (the study_channel tool and the
 * "Take after a channel" dialog), and where finished thumbnails are kept.
 * What is read and how it is counted is in shared/channelStudy.ts.
 *
 * - Only what YouTube publishes for programs is asked: a channel's video feed,
 *   the feed link a channel page announces in its head (to turn an @handle into
 *   that feed), a video's oEmbed, and the small thumbnails of the videos the
 *   feed listed. No video is downloaded and nothing is signed in.
 * - Requests go to www.youtube.com and i.ytimg.com only, in a session of their
 *   own that keeps nothing and carries no cookies.
 * - A thumbnail is only fetched for a video a feed read here listed: the editor
 *   passes video ids back, never addresses.
 */

import { app, session, type Session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { channelFeedUrl, channelIdIn, channelTarget, isChannelId, isVideoId, parseChannelFeed, videoOembedUrl, videoThumbUrl, type ChannelFeed } from '../../shared/channelStudy';
import { defaultWorkingDir } from './files';
import { logger } from './logger';
import * as store from './settings-store';

const TIMEOUT = 15_000;
const MAX_PAGE = 6 * 1024 * 1024;
const MAX_FEED = 2 * 1024 * 1024;
const MAX_THUMB = 400 * 1024;
const MAX_FILE = 12 * 1024 * 1024;
const HOSTS = new Set(['www.youtube.com', 'i.ytimg.com']);

/** Videos the feeds read this session listed: the only thumbnails that can be asked for. */
const listed = new Set<string>();
const thumbs = new Map<string, string>();
const feeds = new Map<string, { at: number; feed: ChannelFeed }>();

let ses: Session | null = null;
function net(): Session {
  if (!ses) {
    ses = session.fromPartition('krypt-channel', { cache: false });
    ses.setPermissionRequestHandler((_wc, _permission, done) => done(false));
    ses.setPermissionCheckHandler(() => false);
    ses.on('will-download', (e) => e.preventDefault());
    ses.setUserAgent(`KryptEditor/${app.getVersion()} (+https://krypt.cc/tools/editor)`);
  }
  return ses;
}

const fail = (message: string): never => {
  throw new Error(message);
};

const CONSENT = 'YouTube asked for a cookie choice instead of showing that page, so the channel could not be found from its name. Paste the channel\'s own link instead: youtube.com/channel/UC… (on the channel: About, Share, Copy channel ID).';

async function get(raw: string, o: { accept: string; max: number }): Promise<{ bytes: Buffer; type: string; url: string; status: number }> {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname)) fail('That address is not read.');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    let res: Response;
    try {
      res = await net().fetch(url.toString(), { signal: ctl.signal, redirect: 'follow', credentials: 'omit', headers: { Accept: o.accept, 'Accept-Language': 'en' } });
    } catch (e) {
      throw new Error(ctl.signal.aborted ? 'YouTube took too long to answer. Try again shortly.' : `YouTube could not be reached (${(e as Error).message}). Check the internet connection.`);
    }
    const landed = new URL(res.url || url.toString());
    if (landed.hostname === 'consent.youtube.com' || landed.hostname === 'consent.google.com') fail(CONSENT);
    if (landed.protocol !== 'https:' || !HOSTS.has(landed.hostname)) fail('YouTube sent the request somewhere else.');
    if (Number(res.headers.get('content-length') ?? 0) > o.max) fail('YouTube sent something too large to read.');
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > o.max) fail('YouTube sent something too large to read.');
    return { bytes, type: res.headers.get('content-type') ?? '', url: landed.toString(), status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

const NOT_YOUTUBE = 'That is not a YouTube channel. Paste a channel link (youtube.com/@name or youtube.com/channel/UC…), an @handle, or a link to one of its videos.';

/** The channel a page (an @handle, /c/ or /user/ address) announces. */
async function channelOfPage(url: string): Promise<string> {
  const r = await get(url, { accept: 'text/html', max: MAX_PAGE });
  if (r.status === 404) fail('There is no channel at that address. Check the spelling of the name.');
  if (r.status === 429) fail('YouTube is asking for a pause. Try again in a few minutes.');
  if (r.status >= 400) fail(`YouTube answered ${r.status} for that channel.`);
  return channelIdIn(r.bytes.toString('utf8')) ?? fail("That page does not name a channel's feed. Paste the channel's own link: youtube.com/channel/UC…");
}

/** A channel's newest uploads, from a channel link, an @handle or a link to one of its videos. */
export async function read(link: string): Promise<ChannelFeed> {
  const target = channelTarget(link) ?? fail(NOT_YOUTUBE);
  let id: string;
  if (target.kind === 'id') id = target.id;
  else if (target.kind === 'page') id = await channelOfPage(target.url);
  else {
    const r = await get(videoOembedUrl(target.url), { accept: 'application/json', max: 200_000 });
    if (r.status === 401 || r.status === 403 || r.status === 404) fail('That video is private or gone, so its channel could not be found. Paste the channel link instead.');
    if (r.status >= 400) fail(`YouTube answered ${r.status} for that video.`);
    let author: unknown;
    try {
      author = (JSON.parse(r.bytes.toString('utf8')) as { author_url?: unknown }).author_url;
    } catch {
      author = null;
    }
    const page = channelTarget(author) ?? fail('YouTube did not say whose video that is. Paste the channel link instead.');
    id = page.kind === 'id' ? page.id : page.kind === 'page' ? await channelOfPage(page.url) : fail(NOT_YOUTUBE);
  }
  if (!isChannelId(id)) fail(NOT_YOUTUBE);

  // The same channel asked again within a few minutes is not asked of YouTube again.
  const had = feeds.get(id);
  if (had && Date.now() - had.at < 5 * 60_000) return had.feed;
  const r = await get(channelFeedUrl(id), { accept: 'application/atom+xml, text/xml', max: MAX_FEED });
  if (r.status === 404) fail('That channel has no public feed: it is gone, or it has no public uploads.');
  if (r.status === 429) fail('YouTube is asking for a pause. Try again in a few minutes.');
  if (r.status >= 400) fail(`YouTube answered ${r.status} for that channel's feed.`);
  const feed = parseChannelFeed(r.bytes.toString('utf8'));
  for (const v of feed.videos) listed.add(v.id);
  feeds.set(id, { at: Date.now(), feed });
  if (feeds.size > 30) feeds.delete(feeds.keys().next().value as string);
  logger.info(`channel: read ${feed.videos.length} uploads of one channel`);
  return feed;
}

/** A listed video's thumbnail (320×180), as a data: address: for looking at, not for keeping. */
export async function thumb(videoId: string): Promise<string> {
  const id = String(videoId);
  if (!isVideoId(id) || !listed.has(id)) fail('That video is not among the ones just read: read the channel again.');
  const have = thumbs.get(id);
  if (have) return have;
  const r = await get(videoThumbUrl(id), { accept: 'image/jpeg', max: MAX_THUMB });
  if (r.status >= 400) fail('That thumbnail could not be read.');
  const b = r.bytes;
  if (!(b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)) fail('That thumbnail is not a picture.');
  const data = `data:image/jpeg;base64,${b.toString('base64')}`;
  thumbs.set(id, data);
  if (thumbs.size > 400) thumbs.delete(thumbs.keys().next().value as string);
  return data;
}

// ── Finished thumbnails ────────────────────────────────────────────────────
export function thumbnailsDir(): string {
  return path.join(store.load().workingDirectory ?? defaultWorkingDir(), 'Thumbnails');
}

/** Keep a thumbnail the editor drew (JPEG or PNG) in the Thumbnails folder; returns where. */
export function saveThumbnail(data: Uint8Array, name: string): string {
  const b = Buffer.from(data);
  const jpg = b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  const png = b.length > 8 && b.readUInt32BE(0) === 0x89504e47;
  if (!jpg && !png) fail('That is not a picture.');
  if (b.length > MAX_FILE) fail('That picture is too large for a thumbnail.');
  const dir = thumbnailsDir();
  fs.mkdirSync(dir, { recursive: true });
  const base =
    path
      .basename(String(name))
      .replace(/\.[a-z0-9]{1,5}$/i, '')
      .replace(/[^\w-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'thumbnail';
  const ext = jpg ? 'jpg' : 'png';
  let p = path.join(dir, `${base}.${ext}`);
  for (let n = 2; fs.existsSync(p) && n < 1000; n++) p = path.join(dir, `${base}-${n}.${ext}`);
  fs.writeFileSync(p, b);
  return p;
}
