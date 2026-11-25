// A scene with the 3D mascot: the backdrop, the character acting the line out, and the big word beside it.
// The character itself is char3d.ts (ported from Krypt Marketo); this is the frame around it, for any frame shape.
import { FONT, clamp01, easeBack, fit, font, lerp, mouthAt, prog, scaled, withAlpha, type Ctx } from './kit';
import { isAction, type Action, type Art } from './mascotVocab';
import { renderCharacter } from './char3d';

export interface MascotBeat {
  start: number;
  dur: number;
  action: string;
  word: string;
  say: string;
  voStart: number;
  voDur: number;
  camera?: 'wide' | 'close';
}

export interface MascotScene {
  art: Art;
  /** Body colour and the glow on its chest. */
  color: string;
  accent: string;
  /** Which scene of the video this is: backdrops and camera sides change from one to the next. */
  index: number;
  beats: MascotBeat[];
  /** A wide frame: this share of its width is kept clear on the left (a panel of key points lies there). */
  inset?: number;
}

const CARTOON_BG = ['#FFC83D', '#4CC9F0', '#FF6B9A', '#8BE07A', '#B79CFF'];
const SIDES = [0, -0.55, 0.55, -0.3, 0.3];
const ZOOM: Record<Action, number> = { talk: 0.45, point: 0.1, present: 0.2, shrug: 0.3, shock: 0.65, cheer: 0, think: 0.6, wave: 0.2, facepalm: 0.55, sad: 0.45, laugh: 0.4 };

function backdrop(ctx: Ctx, w: number, h: number, art: Art, i: number, t: number, cx: number): void {
  if (art === 'cartoon') {
    ctx.fillStyle = CARTOON_BG[i % CARTOON_BG.length];
    ctx.fillRect(0, 0, w, h);
    // Sunburst turning slowly behind the mascot.
    const cy = h * 0.56;
    const far = Math.hypot(w, h);
    const rays = 18;
    const rot = t * 0.12;
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    for (let k = 0; k < rays; k++) {
      const a0 = rot + (k / rays) * Math.PI * 2;
      const a1 = a0 + Math.PI / rays;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a0) * far, cy + Math.sin(a0) * far);
      ctx.lineTo(cx + Math.cos(a1) * far, cy + Math.sin(a1) * far);
      ctx.closePath();
      ctx.fill();
    }
    // Halftone dots fading in from two corners.
    ctx.fillStyle = 'rgba(0,0,0,0.09)';
    const step = Math.round(Math.min(w, h) / 32);
    const reach = Math.min(w, h) * 0.85;
    for (let y = 0; y < h; y += step)
      for (let x = Math.round(y / step) % 2 ? step / 2 : 0; x < w; x += step) {
        const d = Math.min(Math.hypot(x, y), Math.hypot(w - x, h - y)) / reach;
        const r = (1 - Math.min(1, d)) * step * 0.27;
        if (r < 0.8) continue;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    ctx.restore();
    return;
  }
  if (art === '3d') {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#F6F3FF');
    g.addColorStop(0.62, '#E4DDF7');
    g.addColorStop(1, '#CFC5EE');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    // Studio floor: a soft pool of light under the mascot.
    const r = Math.max(w, h) * 0.38;
    const f = ctx.createRadialGradient(cx, h * 0.8, 40, cx, h * 0.8, r);
    f.addColorStop(0, 'rgba(255,255,255,0.75)');
    f.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = f;
    ctx.fillRect(0, 0, w, h);
    return;
  }
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
}

function word(ctx: Ctx, art: Art, text: string, local: number, x: number, y: number, maxW: number, maxH: number, unit: number, accent: string): void {
  const s = text.trim();
  if (!s) return;
  const p = prog(local, 0.35, 0.3);
  if (p <= 0) return;
  const family = art === 'ps2' ? FONT.pixel : FONT.meme;
  const weight = art === 'ps2' ? 400 : 900;
  const c = fit(ctx, art === 'ps2' ? s.toUpperCase() : s, { maxW, maxH, max: (art === 'ps2' ? 96 : 170) * unit, min: 40 * unit, maxLines: 2, weight, family, lh: art === 'ps2' ? 1.3 : 1.02 });
  const hgt = c.lines.length * c.lh;
  withAlpha(ctx, clamp01(p * 2.5), () =>
    scaled(ctx, art === 'ps2' ? 1 : lerp(0.55, 1, easeBack(p)), x, y, () => {
      ctx.save();
      ctx.translate(x, y);
      if (art === 'cartoon') ctx.rotate(-0.04);
      font(ctx, c.size, weight, family);
      ctx.textAlign = 'center';
      ctx.lineJoin = 'round';
      c.lines.forEach((l, i) => {
        const yy = -hgt / 2 + c.lh * (i + 0.82);
        if (art === 'cartoon') {
          ctx.lineWidth = c.size * 0.18;
          ctx.strokeStyle = '#161514';
          ctx.strokeText(l, 0, yy);
          ctx.fillStyle = '#FFFFFF';
        } else if (art === 'ps2') {
          ctx.fillStyle = '#12091F';
          ctx.fillText(l, c.size * 0.08, yy + c.size * 0.08);
          ctx.fillStyle = '#FFD53D';
        } else {
          ctx.shadowColor = 'rgba(70,50,140,0.25)';
          ctx.shadowBlur = c.size * 0.2;
          ctx.shadowOffsetY = c.size * 0.06;
          ctx.fillStyle = accent;
        }
        ctx.fillText(l, 0, yy);
      });
      ctx.restore();
    }),
  );
}

export function drawMascotScene(ctx: Ctx, size: { w: number; h: number }, scene: MascotScene, time: number): void {
  const { w, h } = size;
  const beats = scene.beats;
  if (!beats.length) return;
  const last = beats[beats.length - 1];
  const t = Math.max(0, Math.min(time, last.start + last.dur - 0.001));
  let i = 0;
  for (let k = 0; k < beats.length; k++) if (beats[k].start <= t) i = k;
  const b = beats[i];
  const local = t - b.start;
  const wide = w > h;
  const act: Action = isAction(b.action) ? b.action : 'talk';
  const has = !!b.word.trim();
  // On a wide frame the mascot steps aside for the word; on a tall one the word goes above it.
  const inset = wide ? Math.min(0.5, Math.max(0, scene.inset ?? 0)) : 0;
  const fx = (wide && has ? 0.34 : 0.5) + inset / 2;
  backdrop(ctx, w, h, scene.art, scene.index + i, t, fx * w);
  const natural = ZOOM[act];
  const zoom = b.camera === 'close' ? Math.max(natural, 0.6) : b.camera === 'wide' ? Math.min(natural, 0.15) : natural;
  const out = renderCharacter({
    art: scene.art,
    action: act,
    local,
    t,
    talk: mouthAt(b.say, local, b.voStart, b.voDur),
    place: 'stage',
    side: SIDES[(scene.index + i) % SIDES.length],
    zoom: has ? Math.min(zoom, 0.2) : zoom,
    low: has && !wide,
    accent: scene.accent,
    color: scene.color,
    wide,
    focus: wide ? { x: fx, y: 0.64 } : undefined,
  });
  // The stage is 16:9 or 9:16; any other frame shape shows the middle of it.
  const src = out.canvas as HTMLCanvasElement;
  const k = Math.max(w / src.width, h / src.height);
  ctx.save();
  if (scene.art === 'ps2') ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, (w - src.width * k) / 2, (h - src.height * k) / 2, src.width * k, src.height * k);
  ctx.restore();
  if (scene.art === 'ps2') {
    // CRT-ish scanlines.
    const step = Math.max(4, Math.round(h / 320));
    ctx.fillStyle = 'rgba(0,0,0,0.13)';
    for (let y = 0; y < h; y += step) ctx.fillRect(0, y, w, Math.max(1, Math.round(step / 3)));
  }
  if (!has) return;
  const unit = Math.min(w, h) / 1080;
  if (wide) word(ctx, scene.art, b.word, local, w * (0.71 + inset * 0.22), h * 0.4, w * (0.46 - inset * 0.3), h * 0.42, unit, scene.accent);
  else word(ctx, scene.art, b.word, local, w / 2, h * 0.2, w * 0.84, h * 0.16, unit, scene.accent);
}
