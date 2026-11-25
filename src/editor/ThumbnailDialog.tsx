import { useEffect, useMemo, useRef, useState } from 'react';
import { FolderOpen, ImagePlus, Loader2 } from 'lucide-react';
import { useToast } from '../state/ToastProvider';
import { ART_STYLES, cuePose } from './art/art';
import { ACTIONS } from './art/mascotVocab';
import { STICK_POSES } from './art/stickVocab';
import { knownChannels } from './channel';
import { useMediaStore } from './mediaStore';
import { DEFAULT_THUMB_COLORS, DEFAULT_THUMB_FONT, THUMB, THUMB_LAYOUTS, THUMB_WORDS, drawThumbnail, hexColor, inkOn, thumbColorsFor, thumbVariants, thumbWords, type ThumbLayout, type ThumbPicture, type ThumbPlate, type ThumbSpec } from './thumbnail';
import { layoutFor, makeThumbnail, saveThumbnail, thumbPicture, type ThumbFrom } from './thumbnailSource';
import { timelineDuration, useTimelineStore } from './timelineStore';

type Kind = ThumbFrom['kind'];

const PREFS_KEY = 'krypt.thumbnail';
interface Prefs {
  text: string;
  kind: Kind;
  style: string;
  pose: string;
  props: string;
  layout: ThumbLayout;
  plate: ThumbPlate;
  badge: string;
}

function loadPrefs(): Partial<Prefs> {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>;
    return p && typeof p === 'object' ? p : {};
  } catch {
    return {};
  }
}

/**
 * A canvas on the page takes its font features from the page, and the app turns on ligatures that make Impact
 * stack "TH" and "ED". The saved file is drawn off the page without them, so the preview must be too.
 */
const PLAIN_TYPE = { fontFeatureSettings: 'normal', fontVariantLigatures: 'none' } as const;

const KINDS: Array<{ id: Kind; name: string; title: string }> = [
  { id: 'scene', name: 'A drawing', title: 'A figure drawn in one of the visual styles, with room left for the words' },
  { id: 'frame', name: 'A frame of the video', title: 'A moment of what is on the timeline' },
  { id: 'image', name: 'A picture', title: 'A picture from the media library' },
  { id: 'plain', name: 'Plain', title: 'Only the words, on a colour' },
];

/**
 * The video's thumbnail: a few big words over a drawing, a frame of the video or a picture.
 * What is shown is what is saved (1280×720, in the Thumbnails folder).
 */
export function ThumbnailDialog({ onClose, palette, onChannel }: { onClose: () => void; palette?: string[]; onChannel?: () => void }) {
  const toast = useToast();
  const prefs = useMemo(loadPrefs, []);
  const duration = useTimelineStore((s) => timelineDuration(s.clips));
  const playhead = useTimelineStore((s) => s.playhead);
  const pictures = useMediaStore((s) => s.media).filter((m) => m.kind === 'image');
  const has = duration > 0;

  const [text, setText] = useState(prefs.text ?? 'Why *nobody* does this');
  const [kind, setKind] = useState<Kind>(() => (prefs.kind === 'frame' && !has ? 'scene' : (prefs.kind ?? (has ? 'frame' : 'scene'))));
  const [styleId, setStyleId] = useState(() => (ART_STYLES.some((s) => s.id === prefs.style) ? prefs.style! : 'stickman'));
  const [pose, setPose] = useState(prefs.pose ?? 'shock');
  const [props, setProps] = useState(prefs.props ?? '');
  const [layout, setLayout] = useState<ThumbLayout>(prefs.layout ?? 'left');
  const [plate, setPlate] = useState<ThumbPlate>(prefs.plate === 'box' ? 'box' : 'none');
  const [badge, setBadge] = useState(prefs.badge ?? '');
  const [accent, setAccent] = useState<string | null>(null);
  const [time, setTime] = useState(() => Math.min(Math.max(0, duration - 0.05), playhead > 0.05 ? playhead : Math.min(duration * 0.25, 30)));
  const [mediaId, setMediaId] = useState(() => pictures[0]?.id ?? '');
  const [picture, setPicture] = useState<ThumbPicture | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const main = useRef<HTMLCanvasElement>(null);
  const takes = useRef<Array<HTMLCanvasElement | null>>([]);

  const style = ART_STYLES.find((s) => s.id === styleId) ?? ART_STYLES[0];
  const poses: readonly string[] = style.engine === 'stick' ? STICK_POSES : ACTIONS;
  const from: ThumbFrom = useMemo(
    () => (kind === 'scene' ? { kind, style, pose: cuePose(style.engine, pose) || 'shock', props } : kind === 'frame' ? { kind, time } : kind === 'image' ? { kind, mediaId } : { kind: 'plain' }),
    [kind, style, pose, props, time, mediaId],
  );
  const shown = layoutFor(from, layout);
  const colors = useMemo(() => {
    const base = kind === 'scene' ? thumbColorsFor(style) : DEFAULT_THUMB_COLORS;
    return accent ? { ...base, accent } : base;
  }, [kind, style, accent]);
  const spec: ThumbSpec = useMemo(() => ({ text, layout: shown, plate, colors, font: DEFAULT_THUMB_FONT, upper: true, badge, shade: 0.7 }), [text, shown, plate, colors, badge]);
  const variants = useMemo(() => thumbVariants(spec, 3).map((v) => ({ ...v, layout: layoutFor(from, v.layout) })), [spec, from]);
  const words = thumbWords(text).flat().length;
  // Colours to take after: the ones handed in, then the channels looked at before.
  const swatches = useMemo(() => {
    const known = knownChannels();
    const list = [...(palette ?? []).map((c) => ({ c, of: 'the channel you just looked at' })), ...known.flatMap((k) => k.palette.map((c) => ({ c, of: k.name })))];
    return list.filter((x, i) => hexColor(x.c) && list.findIndex((y) => y.c === x.c) === i).slice(0, 10);
  }, [palette]);

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ text, kind, style: styleId, pose, props, layout, plate, badge } satisfies Prefs));
    } catch {
      /* not remembered */
    }
  }, [text, kind, styleId, pose, props, layout, plate, badge]);

  // The picture behind the words: drawn or fetched a moment after the last change.
  const leftRoom = shown === 'left';
  useEffect(() => {
    let live = true;
    setBusy(true);
    const timer = window.setTimeout(() => {
      thumbPicture(from, leftRoom ? 'left' : 'bottom')
        .then((p) => {
          if (!live) return;
          setPicture(p);
          setError(null);
        })
        .catch((e: Error) => {
          if (!live) return;
          setPicture(null);
          setError(e.message);
        })
        .finally(() => live && setBusy(false));
    }, 220);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [from, leftRoom]);

  useEffect(() => {
    const el = main.current;
    if (el) drawThumbnail(el.getContext('2d')!, spec, picture);
    variants.forEach((v, i) => {
      const c = takes.current[i];
      if (c) drawThumbnail(c.getContext('2d')!, v, picture);
    });
    setSaved(null);
  }, [spec, variants, picture]);

  const save = async (): Promise<void> => {
    setError(null);
    try {
      const canvas = await makeThumbnail(spec, from, picture);
      const path = await saveThumbnail(canvas, text.replace(/\*/g, '').trim() || 'thumbnail');
      setSaved(path);
      toast.success('Thumbnail saved. Upload it with the video.');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const field = 'rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 text-sm text-white outline-none focus:border-krypt-purple/60 disabled:opacity-50';
  const label = 'mb-1 block text-[11px] font-semibold uppercase tracking-wide text-krypt-muted';
  const chip = (on: boolean): string => `rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition ${on ? 'border-krypt-purple/60 bg-krypt-purple/20 text-white' : 'border-white/10 bg-white/5 text-white/80 hover:bg-white/10'}`;

  return (
    <div data-dialog="thumbnail" className="absolute inset-0 z-50 flex items-center justify-center rounded-2xl bg-krypt-void/85 backdrop-blur-sm animate-fade-in">
      <div className="flex max-h-[96%] w-[980px] max-w-[97%] flex-col rounded-2xl border border-white/10 bg-krypt-panel/95 p-6 shadow-krypt-card">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl border border-white/10 bg-krypt-purple/15">
            <ImagePlus className="h-5 w-5 text-krypt-purple" />
          </div>
          <div>
            <div className="text-sm font-bold text-white">Thumbnail</div>
            <div className="text-xs text-krypt-muted">A few big words over a drawing, a frame of your video or a picture. Saved at 1280×720, the size video sites ask for.</div>
          </div>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-5 overflow-y-auto md:grid-cols-[1fr_300px]">
          <div className="min-w-0">
            <div className="relative overflow-hidden rounded-xl border border-white/10 bg-black">
              <canvas ref={main} data-thumb-preview width={THUMB.width} height={THUMB.height} style={PLAIN_TYPE} className="block h-auto w-full" />
              {busy && (
                <div className="absolute right-2 top-2 rounded-md bg-black/70 p-1.5">
                  <Loader2 className="h-4 w-4 animate-spin text-white" />
                </div>
              )}
            </div>
            <div className="mt-3">
              <div className={label}>Three takes: click one to use it</div>
              <div className="grid grid-cols-3 gap-2">
                {variants.map((v, i) => (
                  <button
                    key={i}
                    type="button"
                    data-thumb-take={i}
                    title={`Words ${v.layout}${v.plate === 'box' ? ', on blocks of colour' : ', outlined'}`}
                    onClick={() => {
                      setLayout(v.layout);
                      setPlate(v.plate);
                    }}
                    className={`overflow-hidden rounded-lg border transition ${i === 0 ? 'border-krypt-purple/60' : 'border-white/10 hover:border-white/40'}`}
                  >
                    <canvas
                      ref={(el) => {
                        takes.current[i] = el;
                      }}
                      width={320}
                      height={180}
                      style={PLAIN_TYPE}
                      className="block h-auto w-full"
                    />
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-3">
            <div>
              <label className={label}>The words</label>
              <textarea data-thumb-text autoFocus rows={2} value={text} onChange={(e) => setText(e.target.value.slice(0, 120))} placeholder="I tried it for *30 days*" className={`${field} w-full resize-none`} />
              <div className={`mt-1 text-[11px] ${words > THUMB_WORDS ? 'text-amber-300' : 'text-krypt-muted'}`}>
                {words > THUMB_WORDS ? `${words} words: ${THUMB_WORDS} or fewer read at a glance.` : 'Put *stars* around the words to colour. Say what the title does not.'}
              </div>
            </div>

            <div>
              <div className={label}>Behind the words</div>
              <div className="flex flex-wrap gap-1.5">
                {KINDS.map((k) => (
                  <button key={k.id} type="button" data-thumb-kind={k.id} title={k.id === 'frame' && !has ? 'The timeline is empty' : k.title} disabled={(k.id === 'frame' && !has) || (k.id === 'image' && pictures.length === 0)} onClick={() => setKind(k.id)} className={`${chip(kind === k.id)} disabled:opacity-40`}>
                    {k.name}
                  </button>
                ))}
              </div>
            </div>

            {kind === 'scene' && (
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={label}>Style</label>
                  <select
                    data-thumb-style
                    value={styleId}
                    onChange={(e) => {
                      setStyleId(e.target.value);
                      setAccent(null);
                    }}
                    className={`${field} w-full`}
                  >
                    {ART_STYLES.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={label}>Pose</label>
                  <select data-thumb-pose value={poses.includes(pose) ? pose : 'shock'} onChange={(e) => setPose(e.target.value)} className={`${field} w-full`}>
                    {poses.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </div>
                {style.engine === 'stick' && (
                  <div className="col-span-2">
                    <label className={label}>Props (optional)</label>
                    <input value={props} onChange={(e) => setProps(e.target.value.slice(0, 80))} placeholder="desk;laptop  or  chart=down  or  bubble=No way" className={`${field} w-full`} />
                  </div>
                )}
              </div>
            )}
            {kind === 'frame' && (
              <div>
                <label className={label}>The moment: {time.toFixed(1)}s</label>
                <input type="range" min={0} max={Math.max(0.1, duration - 0.05)} step={0.1} value={time} onChange={(e) => setTime(Number(e.target.value))} className="w-full" />
              </div>
            )}
            {kind === 'image' && (
              <div>
                <label className={label}>The picture</label>
                <select value={mediaId} onChange={(e) => setMediaId(e.target.value)} className={`${field} w-full`}>
                  {pictures.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={label}>Where the words go</label>
                <select data-thumb-layout value={shown} onChange={(e) => setLayout(e.target.value as ThumbLayout)} className={`${field} w-full`}>
                  {THUMB_LAYOUTS.filter((l) => kind !== 'scene' || l.id === 'left' || l.id === 'bottom').map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={label}>Letters</label>
                <select value={plate} onChange={(e) => setPlate(e.target.value as ThumbPlate)} className={`${field} w-full`}>
                  <option value="none">Outlined</option>
                  <option value="box">On blocks of colour</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-[auto_1fr] items-end gap-3">
              <div>
                <label className={label}>Colour</label>
                <input type="color" data-thumb-accent value={colors.accent} onChange={(e) => setAccent(hexColor(e.target.value))} className="h-9 w-14 cursor-pointer rounded-lg border border-white/10 bg-black/40" title="The colour of the starred words" />
              </div>
              <div>
                <label className={label}>Corner label (optional)</label>
                <input value={badge} onChange={(e) => setBadge(e.target.value.slice(0, 18))} placeholder="NEW" className={`${field} w-full`} />
              </div>
            </div>

            <div>
              <div className={label}>Colours of a channel you like</div>
              <div className="flex flex-wrap items-center gap-1.5">
                {swatches.map((s) => (
                  <button key={s.c} type="button" data-thumb-swatch={s.c} title={`${s.c}, from ${s.of}`} onClick={() => setAccent(hexColor(s.c))} className={`h-6 w-6 rounded-md border ${colors.accent === s.c ? 'border-white' : 'border-white/20'}`} style={{ background: s.c }}>
                    <span className="sr-only" style={{ color: inkOn(s.c) }}>
                      {s.c}
                    </span>
                  </button>
                ))}
                {onChannel && (
                  <button type="button" onClick={onChannel} className="text-xs font-medium text-krypt-purple transition hover:text-white">
                    {swatches.length ? 'Look at another channel' : 'Look at a channel…'}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {error && <div className="mt-3 text-xs text-red-300">{error}</div>}
        {saved && (
          <div data-thumb-saved className="mt-3 flex items-center gap-2 text-xs text-emerald-300">
            <span className="min-w-0 truncate">Saved: {saved}</span>
            <button type="button" onClick={() => void window.krypt.app.showItemInFolder(saved)} className="flex flex-shrink-0 items-center gap-1 font-semibold text-white/90 hover:text-white">
              <FolderOpen className="h-3.5 w-3.5" />
              Show in folder
            </button>
          </div>
        )}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm font-semibold text-white/90 transition hover:bg-white/10">
            Close
          </button>
          <button type="button" data-thumb-save disabled={busy || !text.trim()} onClick={() => void save()} className="rounded-lg bg-krypt-gradient px-4 py-2 text-sm font-semibold text-white shadow-krypt-glow transition hover:brightness-110 disabled:opacity-50">
            Save the thumbnail
          </button>
        </div>
      </div>
    </div>
  );
}
