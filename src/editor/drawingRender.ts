// Reads a drawing (SVG an agent wrote), makes it safe, and turns it into pixels: a still, or a few seconds of it moving.
//
// The drawing is only ever shown through an <img>, where a browser runs no script and loads nothing from outside,
// and it is cleaned first all the same: the saved copy may be opened elsewhere one day.
import { BufferTarget, CanvasSource, Mp4OutputFormat, Output, QUALITY_HIGH, canEncodeVideo } from 'mediabunny';
import {
  boilSeed,
  combineMoves,
  DRAWING_ELEMENTS,
  DRAWING_MAX_ELEMENTS,
  DRAWING_MAX_MOVES,
  DRAWING_MOVES,
  drawingAttributeOk,
  drawingPivot,
  drawingPixels,
  drawingProblem,
  drawingStyleText,
  isDrawingMove,
  moveAt,
  movePhase,
  moveStyle,
  withNamespaces,
} from './drawing';

const SVG = 'http://www.w3.org/2000/svg';
const BOIL_ID = 'krypt-boil';
/** Inside these an element is a definition, not something on the page: it is not wrapped or moved. */
const DEFINITIONS = 'defs, clipPath, mask, pattern, marker, symbol, filter, linearGradient, radialGradient';

interface MovingPart {
  wrap: Element;
  kinds: string[];
  amount: number;
  speed: number;
  phase: number;
  pivot: [number, number];
}

export interface Drawing {
  root: Element;
  /** The drawing's own size (its viewBox). */
  width: number;
  height: number;
  /** One 1920th of its longer side. */
  unit: number;
  moves: MovingPart[];
  /** The noise that wobbles the lines; null when the drawing is kept steady. */
  noise: Element | null;
  /** What was changed or left out, for whoever drew it. */
  notes: string[];
}

const num = (v: string | null): number => (v === null ? NaN : Number.parseFloat(v));

/** Reads and cleans a drawing. Throws, in words its author can act on, when it cannot be used. */
export function readDrawing(text: string): Drawing {
  const problem = drawingProblem(text);
  if (problem) throw new Error(problem);
  const notes: string[] = [];
  const strict = (s: string): { doc: Document; wrong: string | null } => {
    const parsed = new DOMParser().parseFromString(s, 'image/svg+xml');
    const broken = parsed.querySelector('parsererror');
    if (!broken) return { doc: parsed, wrong: null };
    const said = (broken.textContent ?? '').split('Below is a rendering')[0];
    return { doc: parsed, wrong: (/error on line \d+ at column \d+: .*/s.exec(said)?.[0] ?? 'it does not parse').trim().replace(/\s+/g, ' ').slice(0, 160) };
  };
  let { doc, wrong } = strict(withNamespaces(text.trim()));
  if (wrong) {
    // Written loosely (an attribute given twice, a tag left open, a bare &): read the way a web page reads inline
    // SVG, which forgives all of that, and carry on with the repaired drawing. Nothing runs in a parsed document.
    const loose = new DOMParser().parseFromString(text, 'text/html').querySelector('svg');
    const again = loose ? strict(new XMLSerializer().serializeToString(loose)) : null;
    if (!again || again.wrong) throw new Error(`it is not well-formed SVG (${wrong}). Check that every tag is closed, no attribute is given twice and every & is written &amp;`);
    notes.push(`it was not well-formed (${wrong}) and was repaired by guessing: check it on the sheet.`);
    doc = again.doc;
  }
  const root = doc.documentElement;
  if (root.localName !== 'svg' || root.namespaceURI !== SVG) throw new Error('its outermost element is not <svg>');
  for (const n of Array.from(doc.childNodes)) if (n !== root) doc.removeChild(n);

  const dropped = new Set<string>();
  let count = 0;
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    if (el !== root && !root.contains(el)) continue;
    if (el.namespaceURI !== SVG || !DRAWING_ELEMENTS.has(el.localName)) {
      dropped.add(el.localName);
      el.remove();
      continue;
    }
    if (++count > DRAWING_MAX_ELEMENTS) throw new Error(`it has more than ${DRAWING_MAX_ELEMENTS} elements. Draw with fewer, simpler shapes`);
    for (const a of Array.from(el.attributes)) if (!drawingAttributeOk(a.name, a.value)) el.removeAttribute(a.name);
    if (el.localName === 'style') el.textContent = drawingStyleText(el.textContent ?? '');
  }
  if (dropped.size) notes.push(`left out (not drawn): <${[...dropped].slice(0, 6).join('>, <')}>.`);

  // Its size: the viewBox, or the width and height it was given.
  const box = (root.getAttribute('viewBox') ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  let [x, y, width, height] = box.length === 4 && box.every(Number.isFinite) ? box : [0, 0, num(root.getAttribute('width')), num(root.getAttribute('height'))];
  if (!(width > 0) || !(height > 0)) throw new Error('it needs a size: viewBox="0 0 1920 1080" on the <svg>');
  if (width / height > 4 || height / width > 4) throw new Error('it is more than four times as long as it is tall (or the other way round), which is not a video shape');
  x = Number.isFinite(x) ? x : 0;
  y = Number.isFinite(y) ? y : 0;
  root.setAttribute('viewBox', `${x} ${y} ${width} ${height}`);
  const unit = Math.max(width, height) / 1920;

  // The wobble of the lines: everything but the background (and what asked to be left steady) goes through a
  // displacement that is redrawn a few times a second.
  let noise: Element | null = null;
  if (root.getAttribute('data-boil') !== 'off') {
    const make = (name: string, attrs: Record<string, string | number>): Element => {
      const el = doc.createElementNS(SVG, name);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
      return el;
    };
    let run: Element | null = null;
    let anything = false;
    for (const child of Array.from(root.children)) {
      const steady =
        ['defs', 'style', 'title', 'desc'].includes(child.localName) ||
        child.getAttribute('data-boil') === 'off' ||
        // The background: a rectangle over the whole drawing, before anything else is drawn.
        (!anything && child.localName === 'rect' && !child.hasAttribute('data-move') && covers(child.getAttribute('width'), width) && covers(child.getAttribute('height'), height));
      if (steady) {
        run = null;
        continue;
      }
      if (!run) {
        run = make('g', { filter: `url(#${BOIL_ID})` });
        root.insertBefore(run, child);
      }
      run.appendChild(child);
      anything = true;
    }
    if (anything) {
      const defs = make('defs', {});
      const filter = make('filter', { id: BOIL_ID, filterUnits: 'userSpaceOnUse', x: x - width * 0.03, y: y - height * 0.03, width: width * 1.06, height: height * 1.06, 'color-interpolation-filters': 'sRGB' });
      noise = make('feTurbulence', { type: 'fractalNoise', baseFrequency: 0.018 / unit, numOctaves: 1, seed: 1, result: 'n' });
      filter.appendChild(noise);
      filter.appendChild(make('feDisplacementMap', { in: 'SourceGraphic', in2: 'n', scale: 6 * unit, xChannelSelector: 'R', yChannelSelector: 'G' }));
      defs.appendChild(filter);
      root.insertBefore(defs, root.firstChild);
    }
  }

  // The parts that move: each goes in a wrapper of its own, so its own transform stays as it was drawn.
  const moves: MovingPart[] = [];
  const unknown = new Set<string>();
  const badPivot: string[] = [];
  let tooMany = 0;
  for (const el of Array.from(root.querySelectorAll('[data-move]'))) {
    if (el.closest(DEFINITIONS)) continue;
    const asked = (el.getAttribute('data-move') ?? '').toLowerCase().split(/[\s,]+/).filter(Boolean);
    const kinds = asked.filter(isDrawingMove).slice(0, 2);
    asked.filter((k) => !isDrawingMove(k)).forEach((k) => unknown.add(k));
    if (kinds.length === 0) continue;
    if (moves.length >= DRAWING_MAX_MOVES) {
      tooMany++;
      continue;
    }
    const usual = DRAWING_MOVES.find((m) => m.id === kinds[0])!.pivot;
    let pivot = drawingPivot(el.getAttribute('data-pivot'), usual);
    if (!pivot) {
      badPivot.push(el.getAttribute('data-pivot') ?? '');
      pivot = drawingPivot('', usual)!;
    }
    const wrap = doc.createElementNS(SVG, 'g');
    el.parentNode!.replaceChild(wrap, el);
    wrap.appendChild(el);
    const amount = num(el.getAttribute('data-amount'));
    const speed = num(el.getAttribute('data-speed'));
    moves.push({ wrap, kinds, amount: Number.isFinite(amount) ? amount : 1, speed: Number.isFinite(speed) && speed !== 0 ? speed : 1, phase: movePhase(moves.length), pivot });
  }
  if (unknown.size) notes.push(`no such move: ${[...unknown].slice(0, 6).join(', ')} (there are: ${DRAWING_MOVES.map((m) => m.id).join(', ')}).`);
  if (badPivot.length) notes.push(`data-pivot "${badPivot[0]}" is not a place (use top, bottom, left, right, center, "top left" or "30% 80%"): the usual one was used.`);
  if (tooMany) notes.push(`only the first ${DRAWING_MAX_MOVES} moving parts move.`);
  return { root, width, height, unit, moves, noise, notes };
}

function covers(attr: string | null, full: number): boolean {
  if (!attr) return false;
  const v = attr.trim();
  return v.endsWith('%') ? Number.parseFloat(v) >= 98 : Number.parseFloat(v) >= full * 0.98;
}

/** The drawing as SVG text at `t` seconds (null: as it was drawn, at rest), `w` by `h` pixels. */
export function drawingText(d: Drawing, t: number | null, w: number, h: number): string {
  d.root.setAttribute('width', String(w));
  d.root.setAttribute('height', String(h));
  for (const m of d.moves) {
    const css = t === null ? '' : moveStyle(combineMoves(m.kinds.map((k) => moveAt(k, t, { amount: m.amount, speed: m.speed, phase: m.phase, unit: d.unit }))), m.pivot);
    if (css) m.wrap.setAttribute('style', css);
    else m.wrap.removeAttribute('style');
  }
  d.noise?.setAttribute('seed', String(boilSeed(t)));
  return new XMLSerializer().serializeToString(d.root);
}

/** Paints SVG text over the whole of a canvas, on white. */
async function paint(ctx: CanvasRenderingContext2D, text: string, w: number, h: number): Promise<void> {
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
  try {
    await img.decode();
  } catch {
    throw new Error('it could not be drawn (a browser would not show it either). Check the path data and the attribute values');
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
}

/** The drawing as a PNG, at rest. */
export async function drawingStill(d: Drawing): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const { w, h } = drawingPixels(d.width, d.height);
  const el = document.createElement('canvas');
  el.width = w;
  el.height = h;
  await paint(el.getContext('2d', { alpha: false })!, drawingText(d, null, w, h), w, h);
  const blob = await new Promise<Blob | null>((done) => el.toBlob(done, 'image/png'));
  if (!blob) throw new Error('it could not be turned into a picture');
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width: w, height: h };
}

/**
 * `seconds` of the drawing moving, as an MP4 (H.264, no sound): its tagged parts move and its lines wobble.
 * `onFrame` is told how far along it is, 0..1.
 */
export async function bakeDrawing(d: Drawing, seconds: number, fps: number, signal: AbortSignal, onFrame: (done: number) => void): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const { w, h } = drawingPixels(d.width, d.height);
  if (!(await canEncodeVideo('avc', { width: w, height: h }).catch(() => false))) throw new Error('This computer cannot encode H.264 video, which a moving drawing needs.');
  const el = document.createElement('canvas');
  el.width = w;
  el.height = h;
  const ctx = el.getContext('2d', { alpha: false })!;
  const out = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const source = new CanvasSource(el, { codec: 'avc', bitrate: QUALITY_HIGH });
  out.addVideoTrack(source, { frameRate: fps });
  await out.start();
  try {
    const frames = Math.max(1, Math.ceil(seconds * fps));
    let shown = '';
    for (let n = 0; n < frames; n++) {
      if (signal.aborted) throw new Error('Cancelled.');
      const text = drawingText(d, n / fps, w, h);
      // A drawing with nothing tagged only changes when its lines are redrawn.
      if (text !== shown) {
        await paint(ctx, text, w, h);
        shown = text;
      }
      await source.add(n / fps, 1 / fps);
      if (n % 15 === 0) {
        onFrame(n / frames);
        // Let the window breathe: the progress bar and the Cancel button live on this thread.
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    await out.finalize();
  } catch (e) {
    await out.cancel().catch(() => undefined);
    throw e;
  }
  const buf = (out.target as BufferTarget).buffer;
  if (!buf) throw new Error('The moving drawing could not be encoded.');
  return { bytes: new Uint8Array(buf), width: w, height: h };
}
