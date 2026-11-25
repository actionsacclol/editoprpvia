// A YouTube channel as an example, in the editor: asks main for its public feed, looks at the small
// thumbnails for the colours that come back, and remembers the last few channels looked at.
// The counting is in shared/channelStudy.ts; the fetching in electron/system/channel.ts.
import { describeStudy, paletteOf, studyChannel, type ChannelFeed, type ChannelStudy } from '@shared/channelStudy';

export interface ChannelLook {
  feed: ChannelFeed;
  study: ChannelStudy;
  /** Small thumbnails by video id, as data: addresses (the ones that loaded). */
  thumbs: Map<string, string>;
  /** The colours its thumbnails lean on, strongest first. */
  palette: string[];
}

function picture(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('preview failed'));
    img.src = src;
  });
}

/** The colours a set of thumbnails leans on. */
async function paletteFrom(sources: string[]): Promise<string[]> {
  const el = document.createElement('canvas');
  const W = 48;
  const H = 27;
  el.width = W;
  el.height = H;
  const g = el.getContext('2d', { willReadFrequently: true });
  if (!g) return [];
  const all: number[] = [];
  for (const src of sources) {
    try {
      g.drawImage(await picture(src), 0, 0, W, H);
      const px = g.getImageData(0, 0, W, H).data;
      for (let i = 0; i < px.length; i++) all.push(px[i]);
    } catch {
      /* one preview less */
    }
  }
  return paletteOf(all, 5);
}

/** Read a channel and look at its thumbnails. `onStep` is told what is happening. */
export async function lookAtChannel(link: string, onStep: (label: string) => void = () => undefined): Promise<ChannelLook> {
  onStep('Reading the channel…');
  const r = await window.krypt.channel.read(link);
  if (!r.ok || !r.data) throw new Error(r.message ?? 'The channel could not be read.');
  const feed = r.data;
  const study = studyChannel(feed);
  onStep('Looking at its thumbnails…');
  const thumbs = new Map<string, string>();
  // A few at a time: fifteen small pictures, no hurry.
  const ids = feed.videos.map((v) => v.id);
  for (let i = 0; i < ids.length; i += 5) {
    await Promise.all(
      ids.slice(i, i + 5).map(async (id) => {
        const t = await window.krypt.channel.thumb(id).catch(() => null);
        if (t?.ok && t.data) thumbs.set(id, t.data);
      }),
    );
  }
  // Shorts have no designed thumbnail: their colours are whatever the video was.
  const designed = feed.videos.filter((v) => !v.short && thumbs.has(v.id));
  const palette = await paletteFrom((designed.length >= 3 ? designed : feed.videos.filter((v) => thumbs.has(v.id))).map((v) => thumbs.get(v.id)!));
  const look = { feed, study, thumbs, palette };
  rememberChannel(look);
  return look;
}

/** The study in words, with the titles and the colours. */
export const describeLook = (look: ChannelLook): string => describeStudy(look.study, { titles: look.feed.videos.map((v) => `${v.title}${v.short ? ' (Short)' : ''}`), palette: look.palette });

/** The thumbnails on one numbered sheet (JPEG, base64), in the order of the titles; null when none loaded. */
export async function channelSheet(look: ChannelLook): Promise<string | null> {
  const vids = look.feed.videos.filter((v) => look.thumbs.has(v.id));
  if (vids.length === 0) return null;
  const cols = vids.length <= 4 ? vids.length : vids.length <= 9 ? 3 : 4;
  const rows = Math.ceil(vids.length / cols);
  const W = 320;
  const H = 180;
  const gap = 8;
  const canvas = document.createElement('canvas');
  canvas.width = cols * W + (cols + 1) * gap;
  canvas.height = rows * H + (rows + 1) * gap;
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#111318';
  g.fillRect(0, 0, canvas.width, canvas.height);
  const loaded = await Promise.all(vids.map((v) => picture(look.thumbs.get(v.id)!).catch(() => null)));
  vids.forEach((v, n) => {
    const x = gap + (n % cols) * (W + gap);
    const y = gap + Math.floor(n / cols) * (H + gap);
    const img = loaded[n];
    if (img) g.drawImage(img, x, y, W, H);
    // The number it has in the list of titles.
    const label = String(look.feed.videos.indexOf(v) + 1);
    g.font = 'bold 20px sans-serif';
    const w = g.measureText(label).width + 14;
    g.fillStyle = 'rgba(0, 0, 0, 0.78)';
    g.fillRect(x, y, w, 28);
    g.fillStyle = '#ffffff';
    g.textBaseline = 'middle';
    g.fillText(label, x + 7, y + 15);
  });
  return canvas.toDataURL('image/jpeg', 0.82).split(',')[1] ?? null;
}

// ── The last few channels looked at ────────────────────────────────────────
export interface KnownChannel {
  name: string;
  url: string;
  palette: string[];
}

const KEY = 'krypt.channels';

export function knownChannels(): KnownChannel[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((x): x is KnownChannel => !!x && typeof x === 'object' && typeof (x as KnownChannel).name === 'string' && typeof (x as KnownChannel).url === 'string' && Array.isArray((x as KnownChannel).palette))
      .map((x) => ({ name: x.name.slice(0, 120), url: x.url.slice(0, 200), palette: x.palette.filter((c) => /^#[0-9A-F]{6}$/i.test(String(c))).slice(0, 5) }))
      .slice(0, 6);
  } catch {
    return [];
  }
}

function rememberChannel(look: ChannelLook): void {
  try {
    const next = [{ name: look.feed.name, url: look.feed.url, palette: look.palette }, ...knownChannels().filter((c) => c.url !== look.feed.url)].slice(0, 6);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* not remembered */
  }
}
