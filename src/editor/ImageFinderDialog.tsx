import { useEffect, useMemo, useState } from 'react';
import { Check, Copy, ExternalLink, ImageOff, Images, Loader2, Search, Sparkles } from 'lucide-react';
import { IMAGE_SOURCES, creditLine, creditsText, pinterestTarget, type FoundImage, type ImageShape, type ImageSourceId } from '@shared/imageSearch';
import { GhostButton, PrimaryButton } from '../components/common';
import { useToast } from '../state/ToastProvider';
import { creditsInUse, findImages, keepImages, thumbOf } from './images';
import { MakePicturesPane } from './MakePicturesPane';

const PREFS_KEY = 'krypt.imageFinder';

function loadPrefs(): { source: ImageSourceId; text: string } {
  try {
    const j = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as { source?: string; text?: string };
    return { source: IMAGE_SOURCES.find((s) => s.id === j.source)?.id ?? 'commons', text: typeof j.text === 'string' ? j.text.slice(0, 300) : '' };
  } catch {
    return { source: 'commons', text: '' };
  }
}

/** One result: its preview loads on its own, and a click picks it. */
function Tile({ image, picked, onPick }: { image: FoundImage; picked: boolean; onPick: () => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    thumbOf(image.id)
      .then((d) => live && setSrc(d))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [image.id]);
  const rights = image.source === 'pinterest' ? (image.via ? `saved by ${image.via}` : 'Pinterest') : [image.license, image.creator].filter(Boolean).join(' · ');
  return (
    <div
      data-image={image.id}
      role="button"
      tabIndex={0}
      aria-pressed={picked}
      onClick={onPick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onPick();
        }
      }}
      title={creditLine(image)}
      // Pins are mostly tall, photographs mostly wide: the tile follows, so less of the picture is hidden.
      className={`group relative ${image.source === 'pinterest' ? 'aspect-[3/4]' : 'aspect-[3/2]'} cursor-pointer overflow-hidden rounded-lg border bg-black/50 outline-none transition focus-visible:ring-2 focus-visible:ring-krypt-purple ${picked ? 'border-krypt-purple ring-2 ring-krypt-purple/70' : 'border-white/10 hover:border-white/30'}`}
    >
      {src ? (
        <img src={src} alt={image.title} draggable={false} className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-krypt-muted">{failed ? <ImageOff className="h-5 w-5" /> : <Loader2 className="h-5 w-5 animate-spin" />}</div>
      )}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/60 to-transparent px-2 pb-1.5 pt-5">
        <div className="truncate text-[11px] font-semibold text-white">{image.title}</div>
        <div className="truncate text-[10px] text-white/70">
          {rights}
          {image.width && image.height ? ` · ${image.width}×${image.height}` : ''}
        </div>
      </div>
      {picked && (
        <div className="absolute left-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-krypt-purple text-white shadow">
          <Check className="h-3.5 w-3.5" />
        </div>
      )}
      <button
        type="button"
        title="Open the page it comes from"
        onClick={(e) => {
          e.stopPropagation();
          void window.krypt.app.openExternal(image.page);
        }}
        className="absolute right-1.5 top-1.5 hidden h-6 w-6 items-center justify-center rounded-md bg-black/70 text-white/90 hover:bg-black group-hover:flex"
      >
        <ExternalLink className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/**
 * Find pictures: photographs for a video from Wikimedia Commons and Openverse
 * (free to use), or from a Pinterest board, profile or pin the user points at.
 * Picked ones are downloaded into the media library with their credit; with
 * `onUse` they are also handed back (the Longform script puts them under the
 * section being written). Agents do the same with find_images / save_images.
 * The last tab makes pictures from words instead (MakePicturesPane); `make`
 * opens the dialog on it.
 */
export function ImageFinderDialog({ onClose, onUse, useLabel, make: startMaking }: { onClose: () => void; onUse?: (paths: string[]) => void; useLabel?: string; make?: boolean }) {
  const toast = useToast();
  const prefs = useMemo(loadPrefs, []);
  const [source, setSource] = useState<ImageSourceId>(prefs.source);
  const [text, setText] = useState(prefs.text);
  const [shape, setShape] = useState<ImageShape | ''>('');
  const [busy, setBusy] = useState<'search' | 'more' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<{ images: FoundImage[]; from: string; more: boolean; page: number; asked: string } | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [make, setMake] = useState(startMaking === true);
  const owed = useMemo(() => creditsInUse(), []);

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ source, text }));
    } catch {
      /* not remembered, nothing else */
    }
  }, [source, text]);

  const info = IMAGE_SOURCES.find((s) => s.id === source)!;
  const asked = text.trim();
  // A Pinterest link pasted on another tab is still a Pinterest link.
  const isLink = pinterestTarget(asked) !== null;
  const ready = asked.length > 1 && !busy;

  const search = async (page: number): Promise<void> => {
    if (!asked) return;
    setBusy(page > 1 ? 'more' : 'search');
    setError(null);
    try {
      const link = source === 'pinterest' || isLink;
      const r = await findImages(link ? { pinterest: asked, source: 'pinterest', count: 20 } : { query: asked, source, count: 20, shape: shape || undefined, page });
      if (link && source !== 'pinterest') setSource('pinterest');
      setFound((was) => {
        const before = page > 1 && was ? was.images : [];
        const fresh = r.images.filter((i) => !before.some((b) => b.id === i.id));
        return { images: [...before, ...fresh], from: r.from, more: r.more && fresh.length > 0, page, asked };
      });
      if (page === 1) setPicked([]);
      if (r.images.length === 0 && page === 1) setError(`Nothing found for "${asked}". Try the name of the thing in two or three plain words${source === 'commons' ? ', or look on Openverse' : source === 'openverse' ? ', or look on Wikimedia Commons' : ''}.`);
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(null);
  };

  const toggle = (id: string): void => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const save = async (): Promise<void> => {
    if (picked.length === 0) return;
    setBusy('save');
    setError(null);
    try {
      const r = await keepImages(picked);
      if (r.kept.length === 0) throw new Error(`None of them could be saved. ${r.failed.join('; ')}`);
      const n = r.kept.length;
      toast.success(`${n} picture${n === 1 ? '' : 's'} ${onUse ? 'added to the script and the media library' : 'added to the media library'}, with ${n === 1 ? 'its credit' : 'their credits'}.${r.failed.length ? ` ${r.failed.length} could not be saved.` : ''}`);
      onUse?.(r.kept.map((k) => k.media.filePath));
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  const copyCredits = async (): Promise<void> => {
    await window.krypt.app.copyText(creditsText(owed));
    toast.success(`Credits for ${owed.length} picture${owed.length === 1 ? '' : 's'} on the timeline copied. Paste them under your video.`);
  };

  const field = 'rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-krypt-purple/60 disabled:opacity-50';
  return (
    <div data-dialog="image-finder" className="absolute inset-0 z-50 flex items-center justify-center rounded-2xl bg-krypt-void/85 backdrop-blur-sm animate-fade-in">
      <div className="flex max-h-[94%] w-[860px] max-w-[96%] flex-col rounded-2xl border border-white/10 bg-krypt-panel/95 p-6 shadow-krypt-card">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl border border-white/10 bg-krypt-purple/15">
            <Images className="h-5 w-5 text-krypt-purple" />
          </div>
          <div>
            <div className="text-sm font-bold text-white">Find pictures</div>
            <div className="text-xs text-krypt-muted">Photographs for your video from free libraries, or from a Pinterest board you point at, each saved with its credit ready to paste under the video. Or pictures made from a description.</div>
          </div>
        </div>

        <div className="mb-2 flex gap-1.5">
          {IMAGE_SOURCES.map((s) => (
            <button
              key={s.id}
              type="button"
              data-image-source={s.id}
              disabled={busy !== null}
              onClick={() => {
                setSource(s.id);
                setMake(false);
                setError(null);
              }}
              className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition disabled:opacity-50 ${!make && s.id === source ? 'border-krypt-purple/60 bg-krypt-purple/20 text-white' : 'border-white/10 bg-white/5 text-white/80 hover:bg-white/10'}`}
            >
              {s.name}
            </button>
          ))}
          <button
            type="button"
            data-image-source="make"
            disabled={busy !== null}
            onClick={() => setMake(true)}
            title="Have pictures made from a description: on this computer, or by a picture service with your own key"
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition disabled:opacity-50 ${make ? 'border-krypt-purple/60 bg-krypt-purple/20 text-white' : 'border-white/10 bg-white/5 text-white/80 hover:bg-white/10'}`}
          >
            <Sparkles className="h-3.5 w-3.5" />
            Make from words
          </button>
        </div>

        {make ? (
          <MakePicturesPane onClose={onClose} onUse={onUse} useLabel={useLabel} />
        ) : (
          <>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) void search(1);
          }}
        >
          <input
            autoFocus
            data-image-query
            value={text}
            disabled={busy !== null}
            onChange={(e) => setText(e.target.value)}
            placeholder={source === 'pinterest' ? 'Paste a board, profile or pin link: pinterest.com/name/board' : 'What should the picture show? e.g. Mount Etna eruption'}
            className={`${field} min-w-0 flex-1`}
          />
          {source !== 'pinterest' && !isLink && (
            <select value={shape} disabled={busy !== null} onChange={(e) => setShape(e.target.value as ImageShape | '')} className={field} title="Wide suits a 16:9 video, tall a 9:16 one">
              <option value="">Any shape</option>
              <option value="wide">Wide</option>
              <option value="tall">Tall</option>
              <option value="square">Square</option>
            </select>
          )}
          <PrimaryButton type="submit" disabled={!ready}>
            {busy === 'search' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            {source === 'pinterest' || isLink ? 'Read' : 'Search'}
          </PrimaryButton>
        </form>
        <div className="mt-1.5 text-[11px] leading-snug text-krypt-muted">
          {info.rights}
          {source === 'pinterest' ? ' Pinterest cannot be searched by words from here: it reads the newest 25 pins of the board or profile you paste.' : ''}
        </div>

        <div className="mt-3 min-h-[220px] flex-1 overflow-y-auto pr-1">
          {found && found.images.length > 0 ? (
            <>
              <div className="mb-2 text-[11px] text-krypt-muted">
                {found.images.length} from {found.from}. Click the ones you want.
              </div>
              <div className="grid grid-cols-4 gap-2">
                {found.images.map((i) => (
                  <Tile key={i.id} image={i} picked={picked.includes(i.id)} onPick={() => busy === null && toggle(i.id)} />
                ))}
              </div>
              {found.more && found.asked === asked && (
                <div className="mt-3 flex justify-center">
                  <GhostButton onClick={() => void search(found.page + 1)} disabled={busy !== null}>
                    {busy === 'more' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    More
                  </GhostButton>
                </div>
              )}
            </>
          ) : (
            !error && (
              <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-2 text-center text-xs text-krypt-muted">
                {busy === 'search' ? <Loader2 className="h-6 w-6 animate-spin" /> : <Images className="h-6 w-6 opacity-60" />}
                <div className="max-w-sm">{busy === 'search' ? 'Looking…' : source === 'pinterest' ? 'Paste the link of a public board with the pictures you collected for this video.' : 'Search for the thing itself: a place, an animal, a person, an object, an event.'}</div>
              </div>
            )
          )}
          {error && <div className="mt-3 whitespace-pre-wrap rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>}
        </div>

        <div className="mt-4 flex items-center justify-between gap-2">
          <div>
            {owed.length > 0 && (
              <button type="button" className="flex items-center gap-1 text-xs font-semibold text-krypt-purple hover:underline" onClick={() => void copyCredits()} title={creditsText(owed)}>
                <Copy className="h-3.5 w-3.5" />
                Copy the credits of the {owed.length} on the timeline
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <GhostButton onClick={onClose}>Close</GhostButton>
            <PrimaryButton onClick={() => void save()} disabled={picked.length === 0 || busy !== null}>
              {busy === 'save' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Images className="h-4 w-4" />}
              {picked.length === 0 ? (useLabel ?? 'Add to the library') : `${useLabel ?? 'Add to the library'} (${picked.length})`}
            </PrimaryButton>
          </div>
        </div>
          </>
        )}
      </div>
    </div>
  );
}
