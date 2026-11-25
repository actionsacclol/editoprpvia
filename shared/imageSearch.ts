/**
 * Finding pictures on the web for a video: the part with no I/O (addresses,
 * reading what the services answer, credit lines). electron/system/images.ts
 * does the fetching; src/editor/images.ts is the editor's side.
 *
 * Three places are read, each through the door it publishes for programs:
 * - Wikimedia Commons (its API): everything there is free to reuse.
 * - Openverse (its API): Creative Commons and public-domain pictures from
 *   Flickr, museums and others. Only licences that allow use in a video one
 *   earns from, and changes (a crop is a change), are asked for.
 * - Pinterest: a public board or profile through its RSS feed, a single pin
 *   through oEmbed. Pinterest's search has no such door, so it is not read.
 *   Pins belong to whoever made them: they carry no licence here.
 */

export type ImageSourceId = 'commons' | 'openverse' | 'pinterest';
export type ImageShape = 'wide' | 'tall' | 'square';

export interface FoundImage {
  /** "c34243", "o3ed0f7a0…", "p424605071146408770": the same picture gets the same id every time. */
  id: string;
  source: ImageSourceId;
  title: string;
  /** Who made it, when the source says. */
  creator?: string;
  creatorUrl?: string;
  /** Pinterest: whose board or profile it was found on (the person who saved it, not always who made it). */
  via?: string;
  /** The page the picture lives on: a Commons file page, a Flickr page, a pin. */
  page: string;
  /** "CC BY 4.0", "CC0", "Public domain". Absent: no licence is known and the rights are with whoever made it. */
  license?: string;
  licenseUrl?: string;
  /** Share-alike: what is made with it is asked to be shared under the same licence. */
  shareAlike?: boolean;
  /** The picture to download, and a second address to try if that one fails. */
  url: string;
  fallback?: string;
  thumb: string;
  width?: number;
  height?: number;
}

export interface ImageQuery {
  /** Words to search for (Commons, Openverse). */
  query?: string;
  /** A Pinterest board, profile or pin link. */
  pinterest?: string;
  source?: ImageSourceId;
  count?: number;
  shape?: ImageShape;
  /** 1 = the first results, 2 = the next… */
  page?: number;
}

export interface ImageSearchResult {
  images: FoundImage[];
  /** Where they came from, in words: "Wikimedia Commons", "the Pinterest board Travel (by @name)". */
  from: string;
  source: ImageSourceId;
  /** There may be more: ask for the next page. */
  more: boolean;
}

/** A picture kept on this computer, with the credit that goes with it. */
export interface SavedImage {
  id: string;
  path: string;
  credit: string;
  image: FoundImage;
}

/** What is written next to a saved picture (<name>.credit.json), so the credit survives the session. */
export interface ImageCredit {
  v: 1;
  credit: string;
  source: ImageSourceId;
  title: string;
  creator?: string;
  via?: string;
  page: string;
  license?: string;
  licenseUrl?: string;
  shareAlike?: boolean;
}

export const IMAGE_SOURCES: Array<{ id: ImageSourceId; name: string; rights: string }> = [
  { id: 'commons', name: 'Wikimedia Commons', rights: 'Free to use, also in videos you earn from. Most ask for a credit: each picture is saved with its credit line.' },
  { id: 'openverse', name: 'Openverse', rights: 'Creative Commons and public-domain pictures, free to use in videos you earn from. Most ask for a credit: each picture is saved with its credit line.' },
  { id: 'pinterest', name: 'Pinterest', rights: 'Pictures on Pinterest belong to the people who made them. Use the ones you made or have permission to use; each is saved with a link to its pin.' },
];

export const MAX_IMAGE_COUNT = 20;

export const cleanQuery = (q: unknown): string =>
  String(q ?? '')
    .replace(/[\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);

const clampCount = (n: unknown, d = 12): number => Math.min(MAX_IMAGE_COUNT, Math.max(1, Math.round(typeof n === 'number' && Number.isFinite(n) ? n : d)));
const pageOf = (n: unknown): number => Math.min(50, Math.max(1, Math.round(typeof n === 'number' && Number.isFinite(n) ? n : 1)));

export function shapeOf(width?: number, height?: number): ImageShape | undefined {
  if (!width || !height) return undefined;
  const r = width / height;
  return r > 1.15 ? 'wide' : r < 0.87 ? 'tall' : 'square';
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Text out of a scrap of HTML or XML: tags off, entities read. */
export function plainText(html: unknown, max = 200): string {
  const s = String(html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, k: string) => {
      if (k[0] !== '#') return ENTITIES[k.toLowerCase()] ?? all;
      const code = k[1].toLowerCase() === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return Number.isFinite(code) && code > 31 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
    })
    .replace(/[\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

const httpsUrl = (raw: unknown): string | undefined => {
  let s = String(raw ?? '').trim();
  if (s.startsWith('//')) s = `https:${s}`;
  if (s.startsWith('http://')) s = `https://${s.slice(7)}`;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
};

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const numOf = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);

// ── Wikimedia Commons ──────────────────────────────────────────────────────
const COMMONS_THUMB = 500;
const BIG = 1920;

export function commonsSearchUrl(q: ImageQuery): string {
  const count = clampCount(q.count);
  const p = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    generator: 'search',
    // Photographs and drawings as pixels: no PDFs, sound or video.
    gsrsearch: `${cleanQuery(q.query)} filetype:bitmap`,
    gsrnamespace: '6',
    // A few extra: the small and the animated ones are left out afterwards.
    gsrlimit: String(Math.min(50, count + 8)),
    gsroffset: String((pageOf(q.page) - 1) * (count + 8)),
    prop: 'imageinfo',
    iiprop: 'url|size|mime|extmetadata',
    iiurlwidth: String(COMMONS_THUMB),
    iiextmetadatafilter: 'LicenseShortName|LicenseUrl|Artist|ObjectName',
  });
  return `https://commons.wikimedia.org/w/api.php?${p.toString()}`;
}

const bare = (u: string): string => u.split('?')[0];

/** A maker's name as Commons writes it, without the wiki signature around it ("jeanne ( talk )", "Walter Isack ( isiwal )"). */
function wikiName(html: string): string | undefined {
  const s = plainText(html, 200)
    .replace(/\(\s*(?:talk|contribs|talk\s*[·|]\s*contribs)\s*\)/gi, '')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\s+/g, ' ')
    .trim();
  return (s.length > 80 ? `${s.slice(0, 79).trimEnd()}…` : s) || undefined;
}

export function parseCommons(json: unknown, q: ImageQuery = {}): FoundImage[] {
  const pages = rec(rec(json).query).pages;
  const list = (Array.isArray(pages) ? pages : []).map(rec).sort((a, b) => (numOf(a.index) ?? 1e9) - (numOf(b.index) ?? 1e9));
  const out: FoundImage[] = [];
  for (const p of list) {
    const info = rec((Array.isArray(p.imageinfo) ? p.imageinfo : [])[0]);
    const meta = rec(info.extmetadata);
    const value = (k: string): string => String(rec(meta[k]).value ?? '');
    const width = numOf(info.width);
    const height = numOf(info.height);
    const original = httpsUrl(info.url);
    const thumb = httpsUrl(info.thumburl);
    const page = httpsUrl(info.descriptionurl);
    if (!original || !thumb || !page || !width || !height || !p.pageid) continue;
    if (!/^image\/(jpeg|png|webp)$/.test(String(info.mime))) continue;
    // Smaller than this is soft on a 1080p frame.
    if (Math.max(width, height) < 1000) continue;
    if (q.shape && shapeOf(width, height) !== q.shape) continue;
    // A copy 1920 wide is plenty for a video and a fraction of a 6000-pixel original.
    const sized = bare(thumb).includes(`/${COMMONS_THUMB}px-`) ? bare(thumb).replace(`/${COMMONS_THUMB}px-`, `/${BIG}px-`) : undefined;
    const useSized = width > 2600 && sized !== undefined;
    const artist = value('Artist');
    const license = plainText(value('LicenseShortName'), 40) || undefined;
    const name = plainText(value('ObjectName'), 90) || plainText(String(p.title ?? '').replace(/^File:/i, '').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/_/g, ' '), 90);
    out.push({
      id: `c${String(p.pageid)}`,
      source: 'commons',
      title: name || 'Untitled',
      creator: wikiName(artist),
      creatorUrl: httpsUrl(/href="([^"]+)"/.exec(artist)?.[1]?.replace(/&amp;/g, '&')),
      page,
      license,
      licenseUrl: httpsUrl(value('LicenseUrl')),
      shareAlike: /\bSA\b|share.?alike/i.test(license ?? '') || undefined,
      url: useSized ? sized! : bare(original),
      fallback: useSized ? bare(original) : undefined,
      thumb: bare(thumb),
      width: useSized ? BIG : width,
      height: useSized ? Math.round((height * BIG) / width) : height,
    });
    if (out.length >= clampCount(q.count)) break;
  }
  return out;
}

// ── Openverse ──────────────────────────────────────────────────────────────
/** Licences that allow a video one earns from and changes to the picture. */
const OPENVERSE_LICENSES = 'cc0,pdm,by,by-sa';

export function openverseSearchUrl(q: ImageQuery): string {
  const p = new URLSearchParams({ q: cleanQuery(q.query), page_size: String(clampCount(q.count)), page: String(pageOf(q.page)), license: OPENVERSE_LICENSES, mature: 'false' });
  if (q.shape) p.set('aspect_ratio', q.shape);
  return `https://api.openverse.org/v1/images/?${p.toString()}`;
}

function openverseLicense(license: string, version: string): string {
  const l = license.toLowerCase();
  if (l === 'cc0') return 'CC0';
  if (l === 'pdm') return 'Public domain';
  return `CC ${l.toUpperCase()}${version ? ` ${version}` : ''}`;
}

export function parseOpenverse(json: unknown): FoundImage[] {
  const results = rec(json).results;
  const out: FoundImage[] = [];
  for (const r of (Array.isArray(results) ? results : []).map(rec)) {
    const url = httpsUrl(r.url);
    const page = httpsUrl(r.foreign_landing_url);
    const thumb = httpsUrl(r.thumbnail);
    const id = String(r.id ?? '');
    const license = String(r.license ?? '').toLowerCase();
    if (!url || !page || !thumb || !/^[0-9a-f-]{8,40}$/i.test(id)) continue;
    // Asked for by licence, checked again here: nothing else is kept.
    if (!OPENVERSE_LICENSES.split(',').includes(license)) continue;
    if (r.mature === true) continue;
    const width = numOf(r.width);
    const height = numOf(r.height);
    if (width && height && Math.max(width, height) < 1000) continue;
    out.push({
      id: `o${id}`,
      source: 'openverse',
      title: plainText(r.title, 90) || 'Untitled',
      creator: plainText(r.creator, 80) || undefined,
      creatorUrl: httpsUrl(r.creator_url),
      page,
      license: openverseLicense(license, String(r.license_version ?? '')),
      licenseUrl: httpsUrl(r.license_url),
      shareAlike: license.endsWith('-sa') || undefined,
      url,
      thumb,
      width,
      height,
    });
  }
  return out;
}

// ── Pinterest ──────────────────────────────────────────────────────────────
export type PinterestTarget =
  | { kind: 'pin'; id: string }
  | { kind: 'board'; user: string; board: string }
  | { kind: 'profile'; user: string }
  /** A pin.it share link: where it leads is only known by following it. */
  | { kind: 'short'; url: string }
  /** A search or ideas page: nothing a program is offered. */
  | { kind: 'search' };

/** First path parts that are Pinterest's own pages, not somebody's name. */
const PINTEREST_PAGES = new Set(['pin', 'search', 'ideas', 'today', 'explore', 'topics', 'discover', 'videos', 'shopping', 'business', 'login', 'signup', 'settings', 'resource', 'oembed.json', 'about', 'careers', 'categories', 'homefeed', 'following', 'password', 'email', 'notifications', 'messages', '_', 'static', 'ext', 'pin-builder', 'idea-pin-builder', 'creator-hub', 'news_hub', 'pin-creation-tool', 'collage-creation-tool', 'board']);
const PINTEREST_TABS = new Set(['_saved', '_created', '_shop', 'pins', 'boards', 'followers', 'following', 'feed.rss', '_profile', 'more_ideas']);

/** What a Pinterest link points at, or null when it is not a Pinterest link. */
export function pinterestTarget(link: unknown): PinterestTarget | null {
  let s = String(link ?? '').trim();
  if (!s || /\s/.test(s)) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);
  if (host === 'pin.it') return parts.length === 1 && /^[A-Za-z0-9]{4,20}$/.test(parts[0]) ? { kind: 'short', url: `https://pin.it/${parts[0]}` } : null;
  // pinterest.com, www.pinterest.com, br.pinterest.com, pinterest.co.uk, www.pinterest.de …
  if (!/^(?:[a-z]{2,3}\.|www\.)?pinterest\.(?:com|[a-z]{2,3}|co\.[a-z]{2}|com\.[a-z]{2})$/.test(host)) return null;
  if (parts.length === 0) return null;
  const first = decodeURIComponent(parts[0]).toLowerCase();
  if (first === 'pin') {
    // /pin/424605071146408770/ and /pin/a-title-in-words--424605071146408770/
    const id = /(\d{6,25})$/.exec(parts[1] ?? '')?.[1];
    return id ? { kind: 'pin', id } : null;
  }
  if (first === 'search' || first === 'ideas' || first === 'explore' || first === 'today') return { kind: 'search' };
  if (PINTEREST_PAGES.has(first) || !/^[a-z0-9_]{1,60}$/.test(first)) return null;
  const second = parts[1] ? decodeURIComponent(parts[1]).replace(/\.rss$/i, '') : '';
  if (!second || PINTEREST_TABS.has(second.toLowerCase()) || second.toLowerCase() === 'feed') return { kind: 'profile', user: first };
  if (/[\\?#<>"]/.test(second) || second.length > 120) return null;
  return { kind: 'board', user: first, board: second };
}

/** The public feed of a board or a profile. */
export function pinterestFeedUrl(t: { kind: 'board'; user: string; board: string } | { kind: 'profile'; user: string }): string {
  return t.kind === 'board' ? `https://www.pinterest.com/${t.user}/${encodeURIComponent(t.board)}.rss` : `https://www.pinterest.com/${t.user}/feed.rss`;
}

export const pinterestPinUrl = (id: string): string => `https://www.pinterest.com/pin/${id}/`;
export const pinterestOembedUrl = (id: string): string => `https://www.pinterest.com/oembed.json?url=${encodeURIComponent(pinterestPinUrl(id))}`;

/** The sizes Pinterest keeps of one picture, from any of them. */
export function pinSizes(image: unknown): { thumb: string; url: string; fallback: string } | null {
  const m = /^https:\/\/i\.pinimg\.com\/(?:\d{2,4}x(?:\d{2,4})?(?:_RS)?|originals)\/((?:[0-9a-f]{2}\/){3}[0-9a-f]{16,64}\.(?:jpg|jpeg|png|webp))$/i.exec(String(image ?? '').trim());
  if (!m) return null;
  const at = (size: string): string => `https://i.pinimg.com/${size}/${m[1]}`;
  return { thumb: at('236x'), url: at('1200x'), fallback: at('736x') };
}

/** A board's or profile's feed: its newest pins (Pinterest gives 25). */
export function parsePinterestFeed(xml: string, via?: string): { title: string; images: FoundImage[] } {
  const src = String(xml ?? '');
  const head = src.split(/<item[\s>]/i)[0];
  const title = plainText(/<title>([\s\S]*?)<\/title>/i.exec(head)?.[1], 80);
  const images: FoundImage[] = [];
  const seen = new Set<string>();
  for (const m of src.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
    const item = m[0];
    const tag = (name: string): string => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i').exec(item)?.[1] ?? '';
    const target = pinterestTarget(plainText(tag('link'), 300));
    // The description is HTML written as text: read the entities once, then look for the picture in it.
    const body = tag('description').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    const sizes = pinSizes(/<img[^>]+src="([^"]+)"/i.exec(body)?.[1]);
    if (!target || target.kind !== 'pin' || !sizes || seen.has(target.id)) continue;
    seen.add(target.id);
    images.push({ id: `p${target.id}`, source: 'pinterest', title: plainText(tag('title'), 90) || plainText(body, 90) || 'A pin', via, page: pinterestPinUrl(target.id), ...sizes });
  }
  return { title, images };
}

/** One pin, as oEmbed describes it. */
export function parsePinterestOembed(json: unknown, id: string): FoundImage | null {
  const j = rec(json);
  const sizes = pinSizes(j.thumbnail_url);
  if (!sizes) return null;
  const name = plainText(j.author_name, 60);
  const user = /pinterest\.com\/([A-Za-z0-9_]{1,60})\/?$/.exec(String(j.author_url ?? ''))?.[1];
  return { id: `p${id}`, source: 'pinterest', title: plainText(j.title, 90) || 'A pin', via: user ? `@${user}` : name || undefined, page: pinterestPinUrl(id), ...sizes };
}

// ── Credits and names ──────────────────────────────────────────────────────
/** The line that goes under a video for one picture. */
export function creditLine(i: Pick<FoundImage, 'source' | 'title' | 'creator' | 'via' | 'page' | 'license'>): string {
  const title = i.title && i.title !== 'Untitled' && i.title !== 'A pin' ? `"${i.title}"` : 'Picture';
  if (i.source === 'pinterest') return `${title}${i.via ? ` via ${i.via}` : ''} on Pinterest: ${i.page}`;
  return `${title}${i.creator ? ` by ${i.creator}` : ''}${i.license ? `, ${i.license}` : ''}: ${i.page}`;
}

export function creditOf(i: FoundImage): ImageCredit {
  return { v: 1, credit: creditLine(i), source: i.source, title: i.title, creator: i.creator, via: i.via, page: i.page, license: i.license, licenseUrl: i.licenseUrl, shareAlike: i.shareAlike };
}

/** A credit file as read back from disk, or null when it is not one. */
export function readCredit(json: unknown): ImageCredit | null {
  const j = rec(json);
  if (j.v !== 1 || typeof j.credit !== 'string' || !j.credit.trim() || typeof j.page !== 'string') return null;
  const source = IMAGE_SOURCES.find((s) => s.id === j.source)?.id;
  if (!source || !httpsUrl(j.page)) return null;
  const text = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? plainText(v, max) : undefined);
  return { v: 1, credit: plainText(j.credit, 400), source, title: text(j.title, 90) ?? '', creator: text(j.creator, 80), via: text(j.via, 80), page: httpsUrl(j.page)!, license: text(j.license, 40), licenseUrl: httpsUrl(j.licenseUrl), shareAlike: j.shareAlike === true || undefined };
}

/** A file name for a saved picture, without its extension: readable, and the same for the same picture. */
export function imageFileBase(i: Pick<FoundImage, 'id' | 'title'>): string {
  const slug = i.title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  const id = i.id.replace(/[^a-z0-9]/gi, '').slice(0, 40);
  return `${slug || 'picture'}-${id}`;
}

/** The extension for a picture by what the server says it is. */
export function imageExt(contentType: unknown): 'jpg' | 'png' | 'webp' | null {
  const t = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  return t === 'image/jpeg' || t === 'image/jpg' ? 'jpg' : t === 'image/png' ? 'png' : t === 'image/webp' ? 'webp' : null;
}

/** The credits of a video's pictures as a block to paste under it. One line per picture, none twice. */
export function creditsText(credits: string[]): string {
  const lines = [...new Set(credits.map((c) => c.trim()).filter(Boolean))];
  return lines.length ? `Pictures:\n${lines.join('\n')}` : '';
}
