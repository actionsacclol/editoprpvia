import { useEffect, useRef } from 'react';
import { Images } from 'lucide-react';
import { ART_STYLES, directBeats, type ArtStyle } from './art/art';
import { releaseScenes, sceneDrawer, type SceneDraw } from './art/bake';

/**
 * The Longform dialog's choice of visuals, as pictures: each drawn style is a
 * card showing a frame of itself, drawn here by the same renderer that makes
 * the video, and it plays while the pointer is on it. Nothing ships as an
 * image file, so a card can never show something the build would not make.
 */

const SIZE = { w: 320, h: 180 };
/** What the cards act out: a question, a figure and a win, so each shows a pose change, the big word and its highlight colour. */
const LINES = [
  { start: 0, end: 2.3, text: 'Why do we put things off?' },
  { start: 2.5, end: 5.3, text: 'Forty percent of plans stop right here.' },
  { start: 5.5, end: 7.4, text: 'Then one day, it works!' },
];
const LENGTH = 7.9;
/** The frame a card rests on: the figure with the big word out. */
const STILL_AT = 4;

// Kept for the session: a style's drawer, and its resting frame so reopening the dialog paints at once.
const drawers = new Map<string, Promise<SceneDraw>>();
const stills = new Map<string, HTMLCanvasElement>();

function drawerOf(style: ArtStyle): Promise<SceneDraw> {
  let d = drawers.get(style.id);
  if (!d) {
    d = sceneDrawer({ style, beats: directBeats(LINES, LENGTH, [], style.engine), duration: LENGTH, index: 0 });
    // A failed load (no WebGL, say) is tried again the next time it is asked for.
    d.catch(() => drawers.delete(style.id));
    drawers.set(style.id, d);
  }
  return d;
}

function paint(el: HTMLCanvasElement | null, draw: SceneDraw | HTMLCanvasElement, t = 0): boolean {
  const ctx = el?.getContext('2d');
  if (!ctx) return false;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  try {
    if (typeof draw === 'function') draw(ctx, SIZE, t);
    else ctx.drawImage(draw, 0, 0);
    return true;
  } catch {
    return false;
  } finally {
    ctx.restore();
  }
}

function ArtCard({ style, selected, disabled, onPick }: { style: ArtStyle; selected: boolean; disabled: boolean; onPick: () => void }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const playing = useRef<(() => void) | null>(null);

  useEffect(() => {
    let alive = true;
    const el = ref.current;
    const kept = stills.get(style.id);
    if (kept) {
      paint(el, kept);
      return;
    }
    // Until the drawing is ready (the 3D styles load their renderer first): the style's own background.
    const ctx = el?.getContext('2d');
    if (ctx) {
      ctx.fillStyle = style.card.background;
      ctx.fillRect(0, 0, SIZE.w, SIZE.h);
    }
    drawerOf(style)
      .then((draw) => {
        if (!alive || !el || !paint(el, draw, STILL_AT)) return;
        const keep = document.createElement('canvas');
        keep.width = SIZE.w;
        keep.height = SIZE.h;
        keep.getContext('2d')?.drawImage(el, 0, 0);
        stills.set(style.id, keep);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [style]);

  const stop = (): void => {
    if (!playing.current) return;
    playing.current();
    playing.current = null;
    const kept = stills.get(style.id);
    if (kept) paint(ref.current, kept);
  };
  const play = (): void => {
    if (disabled || playing.current) return;
    let on = true;
    let raf = 0;
    playing.current = () => {
      on = false;
      cancelAnimationFrame(raf);
    };
    drawerOf(style)
      .then((draw) => {
        const from = performance.now();
        const tick = (): void => {
          if (!on) return;
          if (!paint(ref.current, draw, ((performance.now() - from) / 1000) % LENGTH)) return;
          raf = requestAnimationFrame(tick);
        };
        tick();
      })
      .catch(() => undefined);
  };
  useEffect(() => {
    if (disabled) stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled]);
  useEffect(() => () => playing.current?.(), []);

  return (
    <button
      type="button"
      data-art={style.id}
      disabled={disabled}
      aria-pressed={selected}
      title={style.about}
      onClick={onPick}
      onMouseEnter={play}
      onMouseLeave={stop}
      onFocus={play}
      onBlur={stop}
      className={`overflow-hidden rounded-lg border text-left transition disabled:opacity-50 ${selected ? 'border-krypt-purple ring-1 ring-krypt-purple/70' : 'border-white/10 hover:border-white/35'}`}
    >
      <canvas ref={ref} width={SIZE.w} height={SIZE.h} className="block aspect-video w-full" />
      <div className={`truncate px-2 py-1 text-[11px] font-semibold ${selected ? 'bg-krypt-purple/30 text-white' : 'bg-white/5 text-white/85'}`}>{style.name}</div>
    </button>
  );
}

/** `value` is a style id, or '' for the user's own pictures. */
export function ArtPicker({ value, disabled, onChange }: { value: string; disabled: boolean; onChange: (id: string) => void }) {
  // The 3D cards hold WebGL stages while the dialog is open; a build that is still running lets them go itself.
  useEffect(() => () => void releaseScenes(), []);
  const mine = value === '';
  return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
      <button
        type="button"
        data-art=""
        disabled={disabled}
        aria-pressed={mine}
        title="The pictures and clips named in the script. A section without any shows its sentences as designed text"
        onClick={() => onChange('')}
        className={`overflow-hidden rounded-lg border text-left transition disabled:opacity-50 ${mine ? 'border-krypt-purple ring-1 ring-krypt-purple/70' : 'border-white/10 hover:border-white/35'}`}
      >
        <div className="flex aspect-video w-full flex-col items-center justify-center gap-1 bg-gradient-to-br from-white/10 to-black/30 px-2 text-center">
          <Images className="h-5 w-5 text-white/70" />
          <span className="text-[10px] leading-tight text-krypt-muted">Your photos and clips</span>
        </div>
        <div className={`truncate px-2 py-1 text-[11px] font-semibold ${mine ? 'bg-krypt-purple/30 text-white' : 'bg-white/5 text-white/85'}`}>My pictures</div>
      </button>
      {ART_STYLES.map((s) => (
        <ArtCard key={s.id} style={s} selected={s.id === value} disabled={disabled} onPick={() => onChange(s.id)} />
      ))}
    </div>
  );
}
