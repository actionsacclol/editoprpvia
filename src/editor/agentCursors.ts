import type { McpToolCall } from '@shared/types';
import { useMediaStore } from './mediaStore';
import { useTimelineStore } from './timelineStore';
import { CREW, deal, diffClips, planStage, type CrewMember, type Role, type Target } from './agentCursorPlan';

/**
 * The AI cursors: while an agent edits over MCP, a crew of coloured cursors
 * acts each tool call out on screen. A call's cursor flies to the button or
 * clip a person would use and clicks; the call runs when it lands; then the
 * crew spreads over what changed (new clips stay hidden until a cursor drops
 * them in, cut points and restyled clips light up).
 *
 * Plain DOM on its own fixed layer, moved by one requestAnimationFrame loop:
 * React never re-renders for it and it cannot take a click. Targets are found
 * by data attributes (data-agent, data-clip-id, data-media-id). Looks are in
 * index.css; what each tool does is in agentCursorPlan.ts.
 */

const PREF_KEY = 'krypt.ai.cursors';
/** Longest a call waits for its cursor to arrive before it runs anyway (ms). */
const PRE_MAX = 600;
/** The crew stays on screen this long after the last call. */
const LINGER = 30_000;
/** A new clip hidden for its entrance shows by then, whatever the cursors are doing. */
const REVEAL_MAX = 4200;
/** Places one cursor stops at when a call touches many clips. */
const STOPS = 9;
/** After a call the crew goes over the work at full pace for this long, then eases off (ms). */
const RUSH = 9000;
/** An agent that called a moment ago is working out its next step: the lead says so for this long (ms). */
const THINK = 14_000;
/** How many of the agent's latest edits the crew keeps going back over. */
const RECENT_MAX = 90;
const RULER_H = 28;

/** What a cursor's tag says while it goes back over its own kind of work. */
const CHECKING: Record<Role, string | null> = { lead: null, cuts: 'Checking the cuts', look: 'Checking the look', sound: 'Checking the sound', text: 'Checking the text' };

interface Pt {
  x: number;
  y: number;
}

interface Step {
  /** Where to go, looked up again every frame so a scrolling target is followed. null = nowhere to go. */
  at: () => Pt | null;
  click?: boolean;
  /** Sparks with the click. */
  burst?: boolean;
  /** Pause after landing (ms). */
  hold?: number;
  /** Pause before setting off (ms). */
  wait?: number;
  /** Tag text from when it sets off (null clears it). */
  label?: string | null;
  quick?: boolean;
  slow?: boolean;
  /** Runs on landing, or straight away if the step is skipped: never lost. */
  arrive?: () => void;
  /** Between-jobs movement: dropped the moment there is real work. */
  idle?: boolean;
  /** The clip this step is for, so two cursors don't pick the same one. */
  goal?: string;
}

/** Something the agent really changed: what the crew goes back over between calls. */
interface Done {
  id: string;
  role: Role;
  /** A cut point inside the clip (timeline seconds). */
  t?: number;
}

interface Move {
  step: Step;
  fx: number;
  fy: number;
  tx: number;
  ty: number;
  bow: number;
  t0: number;
  dur: number;
}

interface Hand {
  who: CrewMember;
  el: HTMLDivElement;
  nameEl: HTMLElement;
  actEl: HTMLElement;
  carryEl: HTMLElement;
  x: number;
  y: number;
  /** Idle drift, added to x/y on screen. */
  ox: number;
  oy: number;
  queue: Step[];
  move: Move | null;
  restUntil: number;
  landedAt: number;
  clearActAt: number;
  /** Where it is in its round of things to go over. */
  beat: number;
  goal: string | null;
  phase: number;
  working: boolean;
  sweptAt: number;
  /** Where it has just been, for its trail. */
  tail: Array<{ x: number; y: number; t: number }>;
}

export interface AgentStage {
  progress(fraction: number, message: string): void;
  end(ok: boolean): void;
}
const NO_STAGE: AgentStage = { progress() {}, end() {} };

let layer: HTMLDivElement | null = null;
let hands: Hand[] = [];
let raf = 0;
let live = false;
let lastCall = 0;
let running = 0;
let userScrolledAt = -1e9;
let recent: Done[] = [];
// Light trails behind moving cursors, on one canvas under them.
let trail: HTMLCanvasElement | null = null;
let ink: CanvasRenderingContext2D | null = null;
let inked = false;
/** How long a trail lasts behind a moving cursor (ms). */
const TAIL = 380;

// ── Setting ────────────────────────────────────────────────────────────────
export function cursorsEnabled(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const v = localStorage.getItem(PREF_KEY);
    if (v === '1') return true;
    if (v === '0') return false;
  } catch {
    /* no storage: fall through to the default */
  }
  // On unless the system asks for less motion (the switch in the AI panel overrides either way).
  return !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

export function setCursorsEnabled(on: boolean): void {
  try {
    localStorage.setItem(PREF_KEY, on ? '1' : '0');
  } catch {
    /* not saved; still applies now */
  }
  if (!on) dismiss();
}

const canShow = (): boolean => typeof document !== 'undefined' && document.visibilityState === 'visible' && cursorsEnabled();

// ── Clip effects: a stylesheet of our own, so React's clip blocks are never touched ──
let sheet: CSSStyleSheet | null = null;
const hidden = new Set<string>();
const fx = new Map<string, string>();

const quote = (id: string): string => id.replace(/["\\]/g, '\\$&');
const clipSel = (id: string): string => `[data-clip-id="${quote(id)}"]`;
const mediaSel = (id: string): string => `[data-media-id="${quote(id)}"]`;

function writeSheet(): void {
  if (!sheet) {
    sheet = new CSSStyleSheet();
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  }
  let css = '';
  if (hidden.size) css += `${[...hidden].map(clipSel).join(',')}{opacity:0!important}`;
  for (const [sel, body] of fx) css += `${sel}{${body}}`;
  sheet.replaceSync(css);
}

/** Play an entrance (pop) or a highlight (flash) on elements, in a cursor's colour. */
function effect(sels: string[], kind: 'pop' | 'flash', color: string): void {
  if (sels.length === 0) return;
  const ms = kind === 'pop' ? 460 : 820;
  const body = `--agent-c:${color};animation:agent-${kind} ${ms}ms ${kind === 'pop' ? 'cubic-bezier(.2,1.4,.4,1)' : 'ease-out'} both`;
  for (const s of sels) fx.set(s, body);
  writeSheet();
  window.setTimeout(() => {
    let dirty = false;
    for (const s of sels)
      if (fx.get(s) === body) {
        fx.delete(s);
        dirty = true;
      }
    if (dirty) writeSheet();
  }, ms + 80);
}

function unhide(ids: Iterable<string>): void {
  let dirty = false;
  for (const id of ids) dirty = hidden.delete(id) || dirty;
  if (dirty) writeSheet();
}

// ── Finding things on screen ───────────────────────────────────────────────
const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), Math.max(lo, hi));
const q = (sel: string): HTMLElement | null => document.querySelector<HTMLElement>(sel);
const anchorEl = (name: string): HTMLElement | null => q(`[data-agent="${name}"]`);
const onScreen = (r: DOMRect): boolean => r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < window.innerWidth && r.top < window.innerHeight;
const lanesBox = (): DOMRect | null => anchorEl('lanes')?.getBoundingClientRect() ?? null;
const clipRect = (id: string): DOMRect | null => q(clipSel(id))?.getBoundingClientRect() ?? null;

function clipVisible(id: string): boolean {
  const r = clipRect(id);
  const v = lanesBox();
  return !!r && !!v && r.right > v.left + 4 && r.left < v.right - 4 && r.bottom > v.top + RULER_H && r.top < v.bottom;
}

/** A point on a clip block, kept inside the visible lanes. t = a timeline time inside the clip. */
function clipPoint(id: string, t?: number): Pt | null {
  const r = clipRect(id);
  const v = lanesBox();
  if (!r || !v) return null;
  let x = NaN;
  if (t !== undefined) {
    const s = useTimelineStore.getState();
    const c = s.clips.find((k) => k.id === id);
    if (c) x = r.left + (t - c.start) * s.pxPerSec;
  }
  // No time asked for, or that moment is scrolled out of view: the part of the clip that shows.
  if (!(x >= v.left && x <= v.right)) {
    const l = Math.max(r.left, v.left);
    const rt = Math.min(r.right, v.right);
    x = rt > l ? l + Math.min((rt - l) / 2, 34) : r.left;
  }
  return { x: clamp(x, v.left + 6, v.right - 6), y: clamp(r.top + r.height * 0.6, v.top + RULER_H + 4, v.bottom - 6) };
}

function resolve(t: Target): Pt | null {
  switch (t.kind) {
    case 'anchor': {
      const r = anchorEl(t.name)?.getBoundingClientRect();
      if (!r || !onScreen(r)) return null;
      if (t.spot) return { x: t.spot === 'left' ? r.left + Math.min(110, r.width * 0.15) : r.right - Math.min(110, r.width * 0.15), y: r.top + r.height / 2 };
      // A button: its middle. A whole panel: a little way down from its top.
      return { x: r.left + r.width / 2, y: r.top + (r.height > 120 ? Math.min(r.height * 0.35, 140) : r.height / 2) };
    }
    case 'media': {
      const r = q(mediaSel(t.id))?.getBoundingClientRect();
      return r && onScreen(r) ? { x: r.left + 30, y: r.top + r.height / 2 } : resolve({ kind: 'anchor', name: 'library' });
    }
    case 'clip':
      return clipPoint(t.id, t.t);
    case 'time': {
      const sc = anchorEl('lanes');
      if (!sc) return null;
      const v = sc.getBoundingClientRect();
      const x = v.left - sc.scrollLeft + t.t * useTimelineStore.getState().pxPerSec;
      return { x: clamp(x, v.left + 6, v.right - 6), y: clamp(v.top + RULER_H + 28, v.top, v.bottom - 6) };
    }
  }
}

function targetVisible(t: Target): boolean {
  if (t.kind === 'clip') return clipVisible(t.id);
  if (t.kind !== 'time') return resolve(t) !== null;
  const sc = anchorEl('lanes');
  if (!sc) return false;
  const x = t.t * useTimelineStore.getState().pxPerSec - sc.scrollLeft;
  return x >= 0 && x <= sc.clientWidth;
}

/** Scroll the timeline to a clip the agent is working on, unless the user has just been scrolling it themselves. */
function bringIntoView(id: string): void {
  const sc = anchorEl('lanes');
  const r = clipRect(id);
  if (!sc || !r || performance.now() - userScrolledAt < 4000) return;
  const v = sc.getBoundingClientRect();
  const opts: ScrollToOptions = { behavior: 'smooth' };
  if (r.right < v.left + 30 || r.left > v.right - 30) opts.left = Math.max(0, sc.scrollLeft + (r.left - v.left) - v.width * 0.25);
  if (r.top < v.top + RULER_H || r.bottom > v.bottom) opts.top = Math.max(0, sc.scrollTop + (r.top - v.top) - RULER_H - 8);
  if (opts.left !== undefined || opts.top !== undefined) sc.scrollTo(opts);
}

// ── The layer and the cursors ──────────────────────────────────────────────
function ensureLayer(): void {
  if (layer?.isConnected) return;
  layer = document.createElement('div');
  layer.id = 'krypt-agent-cursors';
  layer.setAttribute('aria-hidden', 'true');
  document.body.appendChild(layer);
  trail = document.createElement('canvas');
  trail.className = 'agent-trail';
  layer.appendChild(trail);
  ink = trail.getContext('2d');
  sizeTrail();
  window.addEventListener('resize', sizeTrail);
  hands = CREW.map((who, i) => makeHand(who, i));
  const mark = (e: Event): void => {
    if ((e.target as Element | null)?.closest?.('[data-agent="lanes"]')) userScrolledAt = performance.now();
  };
  window.addEventListener('wheel', mark, { capture: true, passive: true });
  window.addEventListener('pointerdown', mark, true);
}

function sizeTrail(): void {
  if (!trail || !ink) return;
  const d = Math.min(2, window.devicePixelRatio || 1);
  trail.width = Math.round(window.innerWidth * d);
  trail.height = Math.round(window.innerHeight * d);
  ink.setTransform(d, 0, 0, d, 0, 0);
  ink.lineCap = 'round';
  inked = false;
}

/**
 * Draw every cursor's trail afresh: the path of its last TAIL ms, fading and
 * thinning towards the old end. (Redrawn whole each frame; fading the canvas
 * in place leaves a grey smear that never quite goes.)
 */
function paintTrails(now: number): void {
  if (!ink) return;
  let any = false;
  for (const h of hands) {
    while (h.tail.length > 0 && now - h.tail[0].t > TAIL) h.tail.shift();
    if (h.tail.length > 1) any = true;
  }
  if (!any && !inked) return;
  ink.clearRect(0, 0, window.innerWidth, window.innerHeight);
  inked = any;
  for (const h of hands) {
    if (h.tail.length < 2) continue;
    ink.strokeStyle = h.who.color;
    ink.shadowColor = h.who.color;
    ink.shadowBlur = 9;
    for (let k = 1; k < h.tail.length; k++) {
      const a = h.tail[k - 1];
      const b = h.tail[k];
      const young = 1 - (now - b.t) / TAIL;
      ink.globalAlpha = 0.9 * young;
      ink.lineWidth = 1 + 4 * young;
      ink.beginPath();
      ink.moveTo(a.x, a.y);
      ink.lineTo(b.x, b.y);
      ink.stroke();
    }
  }
}

function makeHand(who: CrewMember, i: number): Hand {
  const el = document.createElement('div');
  el.className = 'agent-cursor';
  el.style.setProperty('--agent-c', who.color);
  el.innerHTML =
    '<svg class="agent-cursor-arrow" width="22" height="22" viewBox="0 0 22 22"><path d="M3 2.5 19 9.6l-7.2 2.2L9.4 19z"/></svg>' +
    '<div class="agent-cursor-tag"><span class="agent-cursor-name"></span><span class="agent-cursor-act"></span></div>' +
    '<div class="agent-cursor-carry"></div>';
  const nameEl = el.querySelector<HTMLElement>('.agent-cursor-name')!;
  nameEl.textContent = who.name;
  layer!.appendChild(el);
  return {
    who,
    el,
    nameEl,
    actEl: el.querySelector<HTMLElement>('.agent-cursor-act')!,
    carryEl: el.querySelector<HTMLElement>('.agent-cursor-carry')!,
    x: 0,
    y: 0,
    ox: 0,
    oy: 0,
    queue: [],
    move: null,
    restUntil: 0,
    landedAt: 0,
    clearActAt: 0,
    beat: i * 2,
    goal: null,
    phase: i * 1.7,
    working: false,
    sweptAt: 0,
    tail: [],
  };
}

const handFor = (role: Role): Hand => hands.find((h) => h.who.role === role) ?? hands[0];

function setAct(h: Hand, text: string | null): void {
  const t = text ? (text.length > 44 ? `${text.slice(0, 43)}…` : text) : '';
  if (h.actEl.textContent !== t) h.actEl.textContent = t;
  h.clearActAt = 0;
}

function setCarry(h: Hand, name: string | null): void {
  if (name) h.carryEl.textContent = name.length > 26 ? `${name.slice(0, 25)}…` : name;
  h.el.classList.toggle('is-carrying', !!name);
}

function ripple(p: Pt, color: string, burst: boolean, soft = false): void {
  if (!layer) return;
  const ring = document.createElement('div');
  ring.className = soft ? 'agent-ripple is-soft' : 'agent-ripple';
  ring.style.cssText = `left:${p.x}px;top:${p.y}px;--agent-c:${color}`;
  layer.appendChild(ring);
  window.setTimeout(() => ring.remove(), 720);
  if (!burst) return;
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + Math.random() * 0.7;
    const d = 16 + Math.random() * 24;
    const s = document.createElement('div');
    s.className = 'agent-spark';
    s.style.cssText = `left:${p.x}px;top:${p.y}px;--agent-c:${color};--dx:${(Math.cos(a) * d).toFixed(1)}px;--dy:${(Math.sin(a) * d).toFixed(1)}px`;
    layer.appendChild(s);
    window.setTimeout(() => s.remove(), 620);
  }
}

/** Where each cursor waits between jobs: near the part of the editor it works on. */
function station(role: Role, i: number, origin: Pt): Pt {
  const at = (name: string, fx: number, fy: number): Pt | null => {
    const r = anchorEl(name)?.getBoundingClientRect();
    return r && onScreen(r) ? { x: r.left + r.width * fx, y: r.top + r.height * fy } : null;
  };
  const spot =
    role === 'lead' ? at('preview', 0.5, 0.42) : role === 'cuts' ? at('lanes', 0.3, 0.45) : role === 'look' ? at('inspector', 0.45, 0.3) : role === 'sound' ? at('lanes', 0.62, 0.8) : at('library', 0.5, 0.45);
  return spot ?? { x: clamp(origin.x - 150 + i * 64, 20, window.innerWidth - 20), y: origin.y + 70 + (i % 2) * 34 };
}

/** Remember what a call changed, newest last, so the crew can go back over it. */
function remember(done: Done[]): void {
  if (done.length === 0) return;
  const again = new Set(done.map((d) => d.id));
  recent = [...recent.filter((d) => !again.has(d.id)), ...done].slice(-RECENT_MAX);
}

/**
 * What a cursor does between jobs. It never sits still, and it never makes
 * anything up: it goes back over what the agent really changed (its own kind
 * of work first; the lead goes over everyone's), one edit after the next.
 * With nothing of its own yet it looks along the clips of its kind without
 * clicking, and with an empty timeline it stays around its part of the editor.
 */
function patrol(h: Hand, i: number, now: number): Step {
  const role = h.who.role;
  const rush = running > 0 || now - lastCall < RUSH;
  const hold = rush ? 70 + Math.random() * 240 : 420 + Math.random() * 900;
  // The label of the job it has just done stays up for a moment first.
  const keep = h.clearActAt > 0 && now < h.clearActAt;
  const thinking = role === 'lead' && running === 0 && now - lastCall < THINK;
  const taken = new Set<string>();
  for (const o of hands) if (o !== h && o.goal) taken.add(o.goal);
  const free = (id: string): boolean => id !== h.goal && !taken.has(id) && clipVisible(id);
  const beat = h.beat++;

  // The lead looks up at the picture every few stops, as someone checking their work would.
  if (!(role === 'lead' && beat % 4 === 3)) {
    const mine = recent.filter((d) => (role === 'lead' || d.role === role) && free(d.id));
    if (mine.length > 0) {
      const d = mine[beat % mine.length];
      return { at: () => clipPoint(d.id, d.t), click: rush, quick: true, hold, idle: true, goal: d.id, label: keep ? undefined : thinking ? 'Thinking' : CHECKING[role] };
    }
    const s = useTimelineStore.getState();
    const audio = new Set(s.tracks.filter((t) => t.kind === 'audio').map((t) => t.id));
    const kin = s.clips.filter((c) => (role === 'text' ? c.type !== 'media' : role === 'sound' ? audio.has(c.trackId) : role === 'lead' ? true : c.type === 'media' && !audio.has(c.trackId)) && free(c.id));
    if (kin.length > 0) {
      const c = kin[beat % kin.length];
      // Cuts looks at the joins between clips; the others at the clips themselves.
      return { at: () => clipPoint(c.id, role === 'cuts' ? c.start : undefined), quick: true, hold, idle: true, goal: c.id, label: keep ? undefined : thinking ? 'Thinking' : null };
    }
  }
  const st = station(role, i, { x: h.x, y: h.y });
  const p = { x: st.x + (Math.random() - 0.5) * 150, y: st.y + (Math.random() - 0.5) * 80 };
  return { at: () => p, quick: true, hold, idle: true, label: keep ? undefined : thinking ? 'Thinking' : null };
}

/** Real work has come up: stop the between-jobs movement where it is. */
function enlist(h: Hand): void {
  if (h.move?.step.idle) h.move = null;
  if (h.queue.some((s) => s.idle)) h.queue = h.queue.filter((s) => !s.idle);
  h.restUntil = 0;
}

/** Finish whatever a cursor still had queued, without the travel (the next call has started). */
function flush(h: Hand): void {
  const pending = h.move ? [h.move.step, ...h.queue] : h.queue;
  if (h.move) {
    h.x += h.ox;
    h.y += h.oy;
    h.ox = h.oy = 0;
  }
  h.move = null;
  h.queue = [];
  h.goal = null;
  for (const s of pending) s.arrive?.();
  setCarry(h, null);
}

/** Bring the crew on screen (out of the AI agents button) if it isn't already. */
function wake(client: string, busy: Role): void {
  ensureLayer();
  const now = performance.now();
  lastCall = now;
  const lead = handFor('lead');
  const name = client.trim() || 'AI';
  lead.nameEl.textContent = name.length > 22 ? `${name.slice(0, 21)}…` : name;
  if (live) return;
  live = true;
  recent = [];
  const origin = resolve({ kind: 'anchor', name: 'ai-button' }) ?? { x: window.innerWidth - 240, y: 26 };
  hands.forEach((h, i) => {
    h.x = origin.x;
    h.y = origin.y;
    h.ox = h.oy = 0;
    h.queue = [];
    h.move = null;
    h.restUntil = 0;
    h.landedAt = now;
    h.working = false;
    h.goal = null;
    h.tail = [];
    setAct(h, null);
    setCarry(h, null);
    place(h);
    h.el.classList.add('is-on');
    // Looked up as it flies: the first call may be what brings the editor's panels on screen.
    if (h.who.role !== busy) h.queue.push({ at: () => station(h.who.role, i, origin), wait: 60 + i * 70 });
  });
  if (!raf) raf = requestAnimationFrame(tick);
}

function sleepCrew(): void {
  live = false;
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  for (const h of hands) {
    flush(h);
    h.working = false;
    h.el.classList.remove('is-on', 'is-working', 'is-thinking', 'is-press');
  }
  if (hidden.size) unhide([...hidden]);
  for (const h of hands) h.tail = [];
  if (ink) ink.clearRect(0, 0, window.innerWidth, window.innerHeight);
  inked = false;
}

/** Take the cursors off screen now (the setting was turned off). */
export function dismiss(): void {
  if (layer) sleepCrew();
}

// ── Motion ─────────────────────────────────────────────────────────────────
const ease = (p: number): number => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

function place(h: Hand): void {
  const x = h.x + h.ox;
  const y = h.y + h.oy;
  h.el.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0)`;
  // Keep the tag on screen at the right and bottom edges.
  h.el.classList.toggle('is-flip', x > window.innerWidth - 230);
  h.el.classList.toggle('is-up', y > window.innerHeight - 52);
}

function depart(h: Hand, now: number): void {
  while (h.queue.length > 0) {
    const s = h.queue[0];
    if (s.wait) {
      h.restUntil = now + s.wait;
      s.wait = 0;
      return;
    }
    h.queue.shift();
    const to = s.at();
    if (!to) {
      s.arrive?.();
      continue;
    }
    if (s.label !== undefined) setAct(h, s.label);
    h.goal = s.goal ?? null;
    const fx0 = h.x + h.ox;
    const fy0 = h.y + h.oy;
    const dist = Math.hypot(to.x - fx0, to.y - fy0);
    const dur = clamp(120 + dist * 0.36, 150, s.quick ? 290 : 470) * (s.slow ? 1.9 : 1);
    h.x = fx0;
    h.y = fy0;
    h.ox = h.oy = 0;
    h.move = { step: s, fx: fx0, fy: fy0, tx: to.x, ty: to.y, bow: (Math.random() < 0.5 ? -1 : 1) * Math.min(46, dist * 0.14), t0: now, dur };
    return;
  }
}

function land(h: Hand, s: Step, now: number): void {
  h.move = null;
  h.landedAt = now;
  h.restUntil = now + (s.hold ?? 70);
  if (s.click) {
    // A real edit is a full click; going back over one is only a small ring.
    if (!s.idle) {
      h.el.classList.add('is-press');
      window.setTimeout(() => h.el.classList.remove('is-press'), 150);
    }
    ripple({ x: h.x, y: h.y }, h.who.color, !!s.burst, !!s.idle);
  }
  s.arrive?.();
  // A job's label stays up a moment after its last stop (between-jobs stops set their own).
  if (!s.idle && h.queue.length === 0 && !h.working) h.clearActAt = now + 1500;
}

function tick(now: number): void {
  raf = 0;
  if (!live) return;
  let busy = running > 0;
  hands.forEach((h, i) => {
    const m = h.move;
    if (h.who.role === 'lead') h.el.classList.toggle('is-thinking', running === 0 && now - lastCall < THINK);
    if (m) {
      const to = m.step.at();
      if (to) {
        m.tx = to.x;
        m.ty = to.y;
      }
      const p = Math.min(1, (now - m.t0) / m.dur);
      const e = ease(p);
      const dx = m.tx - m.fx;
      const dy = m.ty - m.fy;
      const len = Math.hypot(dx, dy) || 1;
      const arc = Math.sin(Math.PI * e) * m.bow;
      h.x = m.fx + dx * e + (-dy / len) * arc;
      h.y = m.fy + dy * e + (dx / len) * arc;
      h.tail.push({ x: h.x, y: h.y, t: now });
      if (p >= 1) land(h, m.step, now);
    } else if (h.queue.length > 0) {
      if (now >= h.restUntil) depart(h, now);
    } else {
      // Between stops: a little drift, then on to the next thing to go over.
      const amp = Math.min(1, (now - h.landedAt) / 500);
      h.ox = Math.sin(now / 420 + h.phase) * 4 * amp;
      h.oy = Math.cos(now / 530 + h.phase * 1.3) * 3 * amp;
      if (h.clearActAt && now > h.clearActAt && !h.working) setAct(h, null);
      if (!h.working && now >= h.restUntil) {
        h.queue.push(patrol(h, i, now));
        depart(h, now);
      }
    }
    if ((h.move && !h.move.step.idle) || h.queue.some((s) => !s.idle)) busy = true;
    place(h);
  });
  paintTrails(now);
  if (!busy && now - lastCall > LINGER) {
    sleepCrew();
    return;
  }
  raf = requestAnimationFrame(tick);
}

// ── One tool call ──────────────────────────────────────────────────────────
const sleep = (ms: number): Promise<void> => new Promise((r) => window.setTimeout(r, ms));

/**
 * Act out one tool call. Await this before running the tool (it resolves once
 * the call's cursor has reached what it is about to change, in at most PRE_MAX
 * ms, or at once when cursors are off or the window is hidden); call end()
 * when the tool has finished. Never throws: an edit must not fail over this.
 */
export async function beginAgentStage(call: Pick<McpToolCall, 'tool' | 'args' | 'client'>): Promise<AgentStage> {
  if (!canShow()) return NO_STAGE;
  try {
    return await openStage(call);
  } catch (e) {
    console.warn('[agent cursors]', e);
    if (hidden.size) unhide([...hidden]);
    return NO_STAGE;
  }
}

async function openStage(call: Pick<McpToolCall, 'tool' | 'args' | 'client'>): Promise<AgentStage> {
  const before = useTimelineStore.getState().clips;
  const mediaBefore = useMediaStore.getState().media;
  const plan = planStage(call.tool, call.args, before, mediaBefore);

  // Anything left over from the call before this one settles at once.
  for (const h of hands) flush(h);
  wake(call.client, plan.role);
  const owner = handFor(plan.role);
  const mates = hands.filter((h) => h !== owner);
  const color = owner.who.color;
  for (const h of mates) setAct(h, null);
  owner.working = true;
  setAct(owner, plan.label);
  running++;

  // Before: the tool's cursor goes to the control and the clip it is about to change.
  const firstClip = plan.lead.find((t) => t.kind === 'clip');
  if (firstClip && firstClip.kind === 'clip' && !clipVisible(firstClip.id)) bringIntoView(firstClip.id);
  let arrived: () => void = () => {};
  const there = new Promise<void>((r) => (arrived = r));
  const steps = plan.lead.map((t): Step => {
    const grab = plan.carry && t.kind === 'media' ? plan.carry : null;
    return { at: () => resolve(t), click: true, label: plan.label, hold: 90, quick: plan.lead.length > 1, arrive: grab ? () => setCarry(owner, grab) : undefined };
  });
  if (steps.length > 0) {
    const last = steps[steps.length - 1];
    const inner = last.arrive;
    last.arrive = () => {
      inner?.();
      arrived();
    };
    owner.queue.push(...steps);
  }
  // The rest of the crew takes the other places this call touches.
  const spots = plan.others
    .filter(targetVisible)
    .map((t) => ({ t, x: resolve(t)?.x ?? 0 }))
    .sort((a, b) => a.x - b.x)
    .map((o) => o.t);
  deal(spots, mates.length, 3).forEach((groups, i) => {
    for (const g of groups) mates[i].queue.push({ at: () => resolve(g[0]), click: true, quick: true });
  });

  // New clips of an "add" stay out of sight until a cursor drops them in (see end()).
  const known = new Set(before.map((c) => c.id));
  const mine = new Set<string>();
  const unsub =
    plan.after === 'reveal'
      ? useTimelineStore.subscribe((s, prev) => {
          if (s.clips === prev.clips) return;
          let dirty = false;
          for (const c of s.clips)
            if (!known.has(c.id) && !mine.has(c.id)) {
              mine.add(c.id);
              hidden.add(c.id);
              dirty = true;
            }
          if (dirty) writeSheet();
        })
      : (): void => {};

  // A long job reports how far along it is: its cursor runs along the timeline ruler with it.
  const sweep = (f: number): Pt | null => {
    const v = lanesBox();
    return v ? { x: v.left + 8 + f * (v.width - 16), y: v.top + RULER_H / 2 } : null;
  };

  const waits = steps.length > 0 && (plan.after !== 'none' || plan.lead.some((t) => t.kind !== 'anchor'));
  if (waits) await Promise.race([there, sleep(PRE_MAX)]);

  let done = false;
  return {
    progress(fraction, message) {
      if (done) return;
      const pct = fraction > 0 && fraction < 1 ? ` ${Math.round(fraction * 100)}%` : '';
      setAct(owner, `${message || plan.label}${pct}`);
      owner.el.classList.add('is-working');
      const now = performance.now();
      if (pct && !owner.move && owner.queue.length === 0 && now - owner.sweptAt > 240) {
        owner.sweptAt = now;
        owner.queue.push({ at: () => sweep(fraction), quick: true, hold: 0 });
      }
    },
    end(ok) {
      if (done) return;
      done = true;
      unsub();
      running = Math.max(0, running - 1);
      lastCall = performance.now();
      owner.working = false;
      owner.el.classList.remove('is-working');
      setAct(owner, plan.label);
      owner.clearActAt = lastCall + 1800;
      const showAll = (): void => unhide(mine);
      // Whatever happens below, nothing the agent made stays hidden.
      window.setTimeout(showAll, REVEAL_MAX);
      if (!ok || !live) {
        showAll();
        setCarry(owner, null);
        return;
      }
      const after = useTimelineStore.getState().clips;
      const d = diffClips(before, after);
      const had = new Set(mediaBefore.map((m) => m.id));
      const newMedia = useMediaStore
        .getState()
        .media.filter((m) => !had.has(m.id))
        .map((m) => m.id);

      let ids: string[] = [];
      let kind: 'pop' | 'flash' = 'flash';
      let seams = false;
      if (plan.after === 'reveal' && d.added.length > 0) {
        ids = d.added;
        kind = 'pop';
      } else if (plan.after === 'seams' && d.added.length > 0) {
        ids = d.added;
        seams = true;
      } else if (plan.after !== 'none') {
        const focus = new Set(plan.focus);
        const named = d.changed.filter((id) => focus.has(id));
        ids = named.length > 0 ? named : [...d.added, ...d.changed];
      }
      const shown = new Set(ids);
      unhide([...mine].filter((id) => !shown.has(id)));
      const starts = new Map(after.map((c) => [c.id, c.start]));
      remember(ids.map((id) => ({ id, role: plan.role, t: seams ? starts.get(id) : undefined })));
      if (ids.length === 0 && newMedia.length === 0) {
        setCarry(owner, null);
        return;
      }

      const go = (): void => {
        if (!live) return showAll();
        if (newMedia.length > 0) {
          enlist(owner);
          const first = newMedia[0];
          owner.queue.push({ at: () => resolve({ kind: 'media', id: first }), click: true, burst: true, arrive: () => effect(newMedia.slice(0, 24).map(mediaSel), 'flash', color) });
        }
        const v = lanesBox();
        const on: Array<{ id: string; x: number; y: number }> = [];
        const off: string[] = [];
        for (const id of ids) {
          const r = clipRect(id);
          if (r && v && clipVisible(id)) on.push({ id, x: Math.max(r.left, v.left), y: r.top });
          else off.push(id);
        }
        unhide(off); // out of sight: nothing to act out
        on.sort((a, b) => a.x - b.x || a.y - b.y);
        const crew = on.length > 2 ? [owner, ...mates] : [owner];
        for (const h of crew) enlist(h);
        deal(
          on.map((o) => o.id),
          crew.length,
          STOPS,
        ).forEach((groups, i) => {
          const h = crew[i];
          groups.forEach((g, j) => {
            h.queue.push({
              at: () => clipPoint(g[0], seams ? starts.get(g[0]) : undefined),
              click: true,
              burst: kind === 'pop' || seams,
              quick: j > 0 || h !== owner,
              wait: j === 0 && h !== owner ? 40 * i : 0,
              label: h === owner ? plan.label : undefined,
              arrive: () => {
                if (kind === 'pop') unhide(g);
                effect(g.map(clipSel), kind, h.who.color);
                if (h === owner) setCarry(owner, null);
              },
            });
          });
        });
        if (on.length === 0) setCarry(owner, null);
      };
      // Let React draw the change first; if it all landed off screen, follow it there.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          try {
            if (ids.length === 0 || ids.some(clipVisible)) go();
            else {
              bringIntoView(ids[0]);
              window.setTimeout(() => {
                try {
                  go();
                } catch {
                  showAll();
                }
              }, 420);
            }
          } catch {
            showAll();
          }
        }),
      );
    },
  };
}
