/**
 * Web capture: a web page opened in a window of its own, walked through step
 * by step (click, type, scroll…) and filmed, so an agent or the Web capture
 * dialog can make a product demo of a site without anyone holding the mouse.
 *
 * - The page runs in an offscreen window that is never shown, in a throwaway
 *   session: no cookies or logins of the user's, nothing kept afterwards. It
 *   may not download, open windows, or use the camera, microphone, location…
 * - Frames come from the page's own painting, not from the screen, so nothing
 *   else on the computer can end up in the recording, and no screen-recording
 *   permission is involved.
 * - Clicks are made here, so where and when they happened is known exactly:
 *   they are returned as a pointer track (the same shape pointer.ts writes)
 *   for Product demo. The pointer seen in the video is drawn into the page.
 *
 * The frames are encoded by the editor window (src/editor/webCapture.ts): it
 * has the encoder. This module only produces them.
 */

import { BrowserWindow, screen, session, type WebContents } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { WebLook, WebOpenOptions, WebRunResult, WebStep } from '../../shared/types';
import * as files from './files';
import { logger } from './logger';

const FPS = 30;
const LOAD_TIMEOUT = 30_000;
const KEYS: Record<string, string> = {
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  escape: 'Escape',
  esc: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  space: 'Space',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  home: 'Home',
  end: 'End',
};

interface Live {
  win: BrowserWindow;
  /** The editor window the frames go to. */
  to: WebContents;
  opts: WebOpenOptions;
  /**
   * The window's own size. A window cannot be larger than the screen it is on,
   * so it is made smaller than the picture and asked to paint more densely
   * (`density` picture pixels per window pixel). Input events and the pointer
   * are in these units.
   */
  size: { w: number; h: number };
  density: number;
  /** Window pixels per page (CSS) pixel. */
  zoom: number;
  /** The size frames really arrive at (an older Electron paints at density 1; the encoder scales those up). */
  painted: { w: number; h: number } | null;
  /** Where the drawn pointer is, in window pixels. */
  at: { x: number; y: number };
  recording: boolean;
  startedAt: number;
  lastFrameAt: number;
  moves: Array<[number, number, number]>;
  clicks: Array<[number, number, number, number]>;
  cancelled: boolean;
}

let live: Live | null = null;

/**
 * Runs in the page: turns blocking dialogs into no-ops, draws the pointer, and
 * finds things the way a person names them ("Pricing", "Search"). Kept as text
 * because it is evaluated in the page, not here.
 */
const PAGE_JS = String.raw`(() => {
  if (window.__krypt) return true;
  const K = (window.__krypt = {});
  window.alert = () => {};
  window.confirm = () => true;
  window.prompt = () => null;
  window.print = () => {};
  const NS = 'http://www.w3.org/2000/svg';
  let cur = null;
  K.cursor = (x, y) => {
    if (!cur && document.documentElement) {
      cur = document.createElement('div');
      cur.id = '__krypt_cursor';
      cur.setAttribute('aria-hidden', 'true');
      cur.style.cssText = 'position:fixed;left:0;top:0;width:28px;height:28px;z-index:2147483647;pointer-events:none;will-change:transform;margin:0;padding:0;border:0;background:none;';
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('width', '28');
      svg.setAttribute('height', '28');
      svg.setAttribute('viewBox', '0 0 28 28');
      svg.style.cssText = 'display:block;overflow:visible;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35));';
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', 'M3 2 L3 21 L8.2 16.4 L11.6 24.2 L14.8 22.8 L11.5 15.2 L18.4 15.2 Z');
      p.setAttribute('fill', '#111111');
      p.setAttribute('stroke', '#ffffff');
      p.setAttribute('stroke-width', '1.6');
      p.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(p);
      cur.appendChild(svg);
      document.documentElement.appendChild(cur);
    }
    if (cur) cur.style.transform = 'translate(' + (x - 3) + 'px,' + (y - 2) + 'px)';
  };
  K.follow = false;
  addEventListener('mousemove', (e) => { if (K.follow) K.cursor(e.clientX, e.clientY); }, true);

  const shown = (el) => {
    if (!el || !el.getBoundingClientRect || el.closest('#__krypt_cursor')) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return null;
    return r;
  };
  const inView = (r) => r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  const label = (el) => {
    let t = el.innerText || el.value || '';
    if (!t.trim()) t = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || '';
    if (!t.trim() && el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) t = l.innerText || ''; }
    if (!t.trim()) { const img = el.querySelector && el.querySelector('img[alt], svg[aria-label]'); if (img) t = img.getAttribute('alt') || img.getAttribute('aria-label') || ''; }
    return t.replace(/\s+/g, ' ').trim();
  };
  const CLICKABLE = 'a[href], button, input:not([type=hidden]), select, textarea, summary, label, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=radio], [role=switch], [role=option], [onclick], [contenteditable=""], [contenteditable=true]';
  const kind = (el) => {
    const t = el.tagName.toLowerCase();
    if (t === 'a') return 'link';
    if (t === 'input') return el.type === 'checkbox' || el.type === 'radio' ? el.type : el.type === 'submit' || el.type === 'button' ? 'button' : 'field';
    if (t === 'textarea' || el.isContentEditable) return 'field';
    if (t === 'select') return 'menu';
    return el.getAttribute('role') || (t === 'label' || t === 'summary' ? t : 'button');
  };
  K.list = () => {
    const out = [];
    const seen = new Set();
    for (const el of document.querySelectorAll(CLICKABLE)) {
      const r = shown(el);
      if (!r || !inView(r)) continue;
      const text = label(el).slice(0, 80);
      if (!text) continue;
      const key = text + '|' + Math.round(r.left / 8) + '|' + Math.round(r.top / 8);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ text, kind: kind(el), x: (r.left + r.width / 2) / innerWidth, y: (r.top + r.height / 2) / innerHeight });
      if (out.length >= 120) break;
    }
    return out;
  };
  const pick = (target) => {
    const t = String(target).trim();
    if (t.slice(0, 4) === 'css=') { try { return document.querySelector(t.slice(4)); } catch (e) { return null; } }
    const want = t.toLowerCase();
    let el = null;
    let best = 0;
    for (const e of document.querySelectorAll(CLICKABLE)) {
      const r = shown(e);
      if (!r) continue;
      const l = label(e).toLowerCase();
      if (!l) continue;
      let s = l === want ? 8 : l.startsWith(want) ? 6 : l.includes(want) ? (l.length <= want.length * 3 ? 4 : 2) : 0;
      if (!s) continue;
      if (inView(r)) s += 1;
      if (s > best) { best = s; el = e; }
    }
    if (el) return el;
    // Not a control: any text on the page that reads like it.
    const walk = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walk.nextNode())) {
      const p = n.parentElement;
      if (!p || p.closest('script,style,noscript,#__krypt_cursor')) continue;
      if (n.nodeValue.replace(/\s+/g, ' ').trim().toLowerCase().includes(want) && shown(p)) return p;
    }
    try { return document.querySelector(t); } catch (e) { return null; }
  };
  const settle = (el) => new Promise((done) => {
    let last = null;
    let same = 0;
    let n = 0;
    const tick = () => {
      const r = el.getBoundingClientRect();
      const k = Math.round(r.left) + ',' + Math.round(r.top);
      same = k === last ? same + 1 : 0;
      last = k;
      if (same >= 6 || ++n > 150) done(r); else requestAnimationFrame(tick);
    };
    tick();
  });
  K.locate = async (target) => {
    const el = pick(target);
    let r = el && shown(el);
    if (!r) return { found: false, options: K.list().slice(0, 40).map((o) => o.text) };
    const pad = 60;
    if (r.top < pad || r.bottom > innerHeight - pad || r.left < 0 || r.right > innerWidth) {
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
      r = await settle(el);
    }
    // The part of it that is on screen: a tall or wide thing is clicked where it can be seen.
    const x0 = Math.max(r.left, 0), x1 = Math.min(r.right, innerWidth), y0 = Math.max(r.top, 0), y1 = Math.min(r.bottom, innerHeight);
    if (x1 <= x0 || y1 <= y0) return { found: false, options: K.list().slice(0, 40).map((o) => o.text) };
    return { found: true, x: (x0 + x1) / 2, y: (y0 + y1) / 2, text: label(el).slice(0, 60) };
  };
  K.has = (target) => { const el = pick(target); const r = el && shown(el); return !!r && inView(r); };
  K.page = () => ({ scrollY: Math.round(scrollY), pageHeight: Math.round(document.documentElement.scrollHeight), viewHeight: innerHeight, viewWidth: innerWidth });
  return true;
})()`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function okUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

async function page<T>(s: Live, code: string): Promise<T> {
  await s.win.webContents.executeJavaScript(PAGE_JS, true);
  return s.win.webContents.executeJavaScript(code, true) as Promise<T>;
}

const zoomOf = (s: Live): number => s.zoom;
const clock = (s: Live): number => Math.max(0, (Date.now() - s.startedAt) / 1000);
const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;
const r3 = (v: number): number => Math.round(v * 1e3) / 1e3;

function check(s: Live): void {
  if (s.cancelled || live !== s || s.win.isDestroyed()) throw new Error('Cancelled.');
}

async function load(s: Live, url: string): Promise<void> {
  const wc = s.win.webContents;
  let timer: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      wc.loadURL(url),
      new Promise<never>((_, no) => {
        timer = setTimeout(() => no(new Error('The page took more than 30 seconds to load.')), LOAD_TIMEOUT);
      }),
    ]);
  } catch (e) {
    // A redirect in the middle of loading reports "aborted" although a page did arrive.
    const msg = (e as Error).message ?? '';
    if (!/ERR_ABORTED/.test(msg) || wc.isLoading()) throw new Error(/ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION/.test(msg) ? `Could not reach ${new URL(url).host}.` : msg.replace(/^Error invoking remote method[^:]*: /, ''));
  } finally {
    if (timer) clearTimeout(timer);
  }
  check(s);
  wc.setZoomFactor(zoomOf(s));
  await sleep(700);
  await ready(s);
}

/** The page's helpers are in, and the pointer is drawn where it was. */
async function ready(s: Live): Promise<void> {
  const z = zoomOf(s);
  await page(s, `(() => { const K = window.__krypt; K.follow = ${s.opts.cursor ? 'true' : 'false'}; ${s.opts.cursor ? `K.cursor(${s.at.x / z}, ${s.at.y / z});` : ''} return true; })()`).catch(() => undefined);
}

function note(s: Live, force = false): void {
  if (!s.recording) return;
  const t = clock(s);
  const last = s.moves[s.moves.length - 1];
  if (!force && last && t - last[0] < 1 / 30) return;
  s.moves.push([r3(t), r4(s.at.x / s.size.w), r4(s.at.y / s.size.h)]);
}

/** Glide the pointer to a place in the window, the way a hand would: eased, slightly arced. */
async function glide(s: Live, x: number, y: number): Promise<void> {
  const wc = s.win.webContents;
  const from = { ...s.at };
  const dist = Math.hypot(x - from.x, y - from.y);
  if (dist < 2) return;
  const ms = Math.min(900, Math.max(280, 220 + dist * 0.55));
  const bend = Math.min(60, dist * 0.12) * (x >= from.x ? 1 : -1);
  const nx = -(y - from.y) / dist;
  const ny = (x - from.x) / dist;
  const t0 = Date.now();
  for (;;) {
    check(s);
    const p = Math.min(1, (Date.now() - t0) / ms);
    const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
    const arc = Math.sin(Math.PI * e) * bend;
    s.at = { x: from.x + (x - from.x) * e + nx * arc, y: from.y + (y - from.y) * e + ny * arc };
    wc.sendInputEvent({ type: 'mouseMove', x: Math.round(s.at.x), y: Math.round(s.at.y) });
    note(s);
    if (p >= 1) break;
    await sleep(16);
  }
  s.at = { x, y };
  note(s, true);
}

async function locate(s: Live, step: WebStep): Promise<{ x: number; y: number; text: string }> {
  if (typeof step.x === 'number' && typeof step.y === 'number') return { x: step.x * s.size.w, y: step.y * s.size.h, text: `${Math.round(step.x * 100)}%, ${Math.round(step.y * 100)}%` };
  const target = step.target ?? '';
  const z = zoomOf(s);
  const hit = await page<{ found: boolean; x?: number; y?: number; text?: string; options?: string[] }>(s, `window.__krypt.locate(${JSON.stringify(target)})`);
  if (!hit.found) {
    const options = (hit.options ?? []).filter(Boolean);
    throw new Error(`Nothing on the page reads "${target}".${options.length ? ` On screen now: ${options.map((o) => `"${o}"`).join(', ')}.` : ''}`);
  }
  return { x: hit.x! * z, y: hit.y! * z, text: hit.text || target };
}

async function click(s: Live, x: number, y: number): Promise<void> {
  const wc = s.win.webContents;
  await glide(s, x, y);
  await sleep(140);
  check(s);
  const at = { x: Math.round(x), y: Math.round(y) };
  if (s.recording) s.clicks.push([r3(clock(s)), r4(x / s.size.w), r4(y / s.size.h), 0]);
  wc.sendInputEvent({ type: 'mouseDown', ...at, button: 'left', clickCount: 1 });
  await sleep(70);
  wc.sendInputEvent({ type: 'mouseUp', ...at, button: 'left', clickCount: 1 });
  await sleep(350);
}

async function doStep(s: Live, step: WebStep): Promise<string> {
  const wc = s.win.webContents;
  check(s);
  switch (step.do) {
    case 'goto': {
      const url = okUrl(step.url ?? '');
      if (!url) throw new Error('goto needs an http or https address.');
      await load(s, url);
      return `opened ${wc.getURL()}`;
    }
    case 'wait': {
      if (step.target) {
        const until = Date.now() + Math.min(20, Math.max(0.5, step.seconds ?? 10)) * 1000;
        while (Date.now() < until) {
          check(s);
          if (await page<boolean>(s, `window.__krypt.has(${JSON.stringify(step.target)})`).catch(() => false)) return `"${step.target}" is on screen`;
          await sleep(200);
        }
        throw new Error(`"${step.target}" did not appear.`);
      }
      const ms = Math.min(20, Math.max(0.1, step.seconds ?? 1)) * 1000;
      for (const until = Date.now() + ms; Date.now() < until; ) {
        check(s);
        await sleep(50);
      }
      return `waited ${Math.round(ms / 100) / 10}s`;
    }
    case 'hover': {
      const p = await locate(s, step);
      await glide(s, p.x, p.y);
      await sleep(300);
      return `pointed at "${p.text}"`;
    }
    case 'click': {
      const p = await locate(s, step);
      await click(s, p.x, p.y);
      // A click that went somewhere: wait for the new page before the next step.
      for (let n = 0; n < 150 && wc.isLoading(); n++) {
        check(s);
        await sleep(100);
      }
      await ready(s);
      return `clicked "${p.text}"`;
    }
    case 'type': {
      let where = '';
      if (step.target || typeof step.x === 'number') {
        const p = await locate(s, step);
        await click(s, p.x, p.y);
        where = ` into "${p.text}"`;
      }
      const text = String(step.text ?? '');
      for (const ch of text) {
        check(s);
        if (ch === '\n') {
          wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
          wc.sendInputEvent({ type: 'char', keyCode: 'Enter' });
          wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
        } else wc.sendInputEvent({ type: 'char', keyCode: ch });
        await sleep(45 + Math.random() * 50);
      }
      await sleep(250);
      return `typed "${text.length > 40 ? `${text.slice(0, 40)}…` : text}"${where}`;
    }
    case 'press': {
      const raw = String(step.key ?? '').trim();
      const key = KEYS[raw.toLowerCase()] ?? (raw.length === 1 ? raw : '');
      if (!key) throw new Error(`press: "${raw}" is not a key this knows. Use ${[...new Set(Object.values(KEYS))].join(', ')} or one character.`);
      wc.sendInputEvent({ type: 'keyDown', keyCode: key });
      if (key === 'Enter') wc.sendInputEvent({ type: 'char', keyCode: 'Enter' });
      else if (key.length === 1) wc.sendInputEvent({ type: 'char', keyCode: key });
      wc.sendInputEvent({ type: 'keyUp', keyCode: key });
      await sleep(400);
      for (let n = 0; n < 150 && wc.isLoading(); n++) {
        check(s);
        await sleep(100);
      }
      await ready(s);
      return `pressed ${key}`;
    }
    case 'scroll': {
      if (step.target) {
        const p = await locate(s, step);
        return `scrolled to "${p.text}"`;
      }
      // The wheel, turned over about a second, scrolls whatever is under the pointer, as it would for a person.
      const total = Math.round(Math.max(-20000, Math.min(20000, step.by ?? 600)) * zoomOf(s));
      // Over the page, not over a fixed header: the wheel goes to whatever is under the pointer.
      if (s.at.y < s.size.h * 0.3) await glide(s, s.at.x, s.size.h * 0.55);
      const ticks = Math.max(8, Math.min(60, Math.round(Math.abs(total) / 40)));
      let sent = 0;
      for (let n = 1; n <= ticks; n++) {
        check(s);
        const p = n / ticks;
        const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
        const upTo = Math.round(total * e);
        wc.sendInputEvent({ type: 'mouseWheel', x: Math.round(s.at.x), y: Math.round(s.at.y), deltaX: 0, deltaY: -(upTo - sent), canScroll: true });
        sent = upTo;
        await sleep(18);
      }
      await sleep(450);
      return `scrolled ${total >= 0 ? 'down' : 'up'}`;
    }
    default:
      throw new Error(`"${String((step as { do?: unknown }).do)}" is not something a step can do.`);
  }
}

/** Open a page, ready to be looked at or filmed. One at a time: a second open closes the first. */
export async function open(to: WebContents, opts: WebOpenOptions): Promise<{ title: string; url: string }> {
  close();
  const url = okUrl(opts.url);
  if (!url) throw new Error('Web capture opens http and https addresses only.');
  const ses = session.fromPartition(`krypt-webcapture-${Date.now()}`, { cache: false });
  // A page being filmed gets nothing a visitor would have to agree to, and takes nothing home.
  ses.setPermissionRequestHandler((_wc, _permission, done) => done(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', (e) => e.preventDefault());
  ses.setUserAgent(ses.getUserAgent().replace(/\s(?:Electron|krypt-?editor|KryptEditor)\/\S+/gi, ''));
  // Small enough for the screen, dense enough for the picture. When the page's own width fits, one window pixel is one page pixel.
  const work = screen.getPrimaryDisplay().workAreaSize;
  const fits = Math.max(1, opts.width / Math.max(320, work.width - 48), opts.height / Math.max(240, work.height - 48));
  const density = Math.max(fits, Math.min(3, opts.width / opts.pageWidth));
  const size = { w: Math.round(opts.width / density), h: Math.round(opts.height / density) };
  const win = new BrowserWindow({
    show: false,
    width: size.w,
    height: size.h,
    useContentSize: true,
    frame: false,
    skipTaskbar: true,
    // The typings here predate the density option; an Electron without it paints at 1 and the encoder scales up.
    webPreferences: { offscreen: { deviceScaleFactor: density } as unknown as boolean, session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false },
  });
  const s: Live = { win, to, opts, size, density, zoom: size.w / opts.pageWidth, painted: null, at: { x: size.w * 0.5, y: size.h * 0.62 }, recording: false, startedAt: 0, lastFrameAt: 0, moves: [], clicks: [], cancelled: false };
  live = s;
  const wc = win.webContents;
  wc.setAudioMuted(true);
  wc.setFrameRate(FPS);
  // A link that wants a new window opens here instead; nothing but web pages is followed.
  wc.setWindowOpenHandler(({ url: next }) => {
    const ok = okUrl(next);
    if (ok) setImmediate(() => !win.isDestroyed() && void wc.loadURL(ok).catch(() => undefined));
    return { action: 'deny' };
  });
  // A film of a page has no use for scroll bars: they are the window's, not the site's.
  wc.on('dom-ready', () => void wc.insertCSS('::-webkit-scrollbar{width:0!important;height:0!important;display:none!important}').catch(() => undefined));
  wc.on('will-navigate', (e, next) => {
    if (!okUrl(next)) e.preventDefault();
  });
  wc.on('paint', (_e, _dirty, image) => {
    const got = image.getSize();
    s.painted = { w: got.width, h: got.height };
    if (!s.recording || s.to.isDestroyed()) return;
    const now = Date.now();
    if (now - s.lastFrameAt < 1000 / FPS - 3) return;
    s.lastFrameAt = now;
    s.to.send('web:frame', { t: clock(s), jpeg: image.toJPEG(90) });
  });
  win.on('closed', () => {
    if (live === s) live = null;
  });
  try {
    await load(s, url);
  } catch (e) {
    close();
    throw e;
  }
  return { title: wc.getTitle(), url: wc.getURL() };
}

/** What the page looks like now, and what on it can be clicked. */
export async function look(): Promise<WebLook> {
  const s = live;
  if (!s) throw new Error('No page is open.');
  const wc = s.win.webContents;
  const elements = await page<WebLook['elements']>(s, 'window.__krypt.list()');
  const at = await page<{ scrollY: number; pageHeight: number; viewHeight: number; viewWidth: number }>(s, 'window.__krypt.page()');
  let image = await wc.capturePage();
  const size = image.getSize();
  if (size.width > 1280) image = image.resize({ width: 1280, quality: 'good' });
  return { title: wc.getTitle(), url: wc.getURL(), image: image.toJPEG(72).toString('base64'), elements, scrollY: at.scrollY, pageHeight: at.pageHeight, viewHeight: at.viewHeight, viewWidth: at.viewWidth, painted: s.painted ?? { w: size.width, h: size.height } };
}

/**
 * Do the steps, filming or not. Stops at the first step that cannot be done and
 * says why: what was filmed up to there is still returned.
 */
export async function run(steps: WebStep[], record: boolean, maxSeconds: number): Promise<WebRunResult> {
  const s = live;
  if (!s) throw new Error('No page is open.');
  const wc = s.win.webContents;
  const log: string[] = [];
  let failed: string | undefined;
  s.moves = [];
  s.clicks = [];
  s.startedAt = Date.now();
  s.lastFrameAt = 0;
  s.recording = record;
  const cap = setTimeout(() => {
    s.cancelled = true;
  }, maxSeconds * 1000);
  try {
    await ready(s);
    if (record) {
      note(s, true);
      wc.invalidate();
      // A beat on the page as it is before anything moves.
      await sleep(900);
    }
    for (let i = 0; i < steps.length; i++) {
      try {
        log.push(`${i + 1}. ${await doStep(s, steps[i])}`);
      } catch (e) {
        const timedOut = s.cancelled && live === s && !s.win.isDestroyed();
        failed = timedOut ? `Stopped at step ${i + 1}: the recording reached its ${maxSeconds} second limit.` : `Step ${i + 1} (${steps[i].do}${steps[i].target ? ` "${steps[i].target}"` : ''}): ${(e as Error).message}`;
        break;
      }
    }
    if (record && !s.win.isDestroyed()) {
      s.cancelled = false;
      wc.invalidate();
      await sleep(1100);
      note(s, true);
    }
  } finally {
    clearTimeout(cap);
    s.recording = false;
  }
  return { duration: r3(clock(s)), moves: s.moves, clicks: s.clicks, log, failed };
}

/** Keep a finished web capture: the video and, next to it, its pointer track. */
export function save(data: Uint8Array, pointer: string): { path: string } {
  const dir = files.recordingsDir();
  fs.mkdirSync(dir, { recursive: true });
  const d = new Date();
  const two = (n: number): string => String(n).padStart(2, '0');
  const base = `web-${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
  let target = path.join(dir, `${base}-screen.mp4`);
  for (let n = 2; fs.existsSync(target); n++) target = path.join(dir, `${base}-${n}-screen.mp4`);
  fs.writeFileSync(target, data);
  try {
    if (pointer) fs.writeFileSync(target.replace(/\.mp4$/, '.pointer.json'), pointer);
  } catch (e) {
    logger.warn(`web capture: could not save the pointer track: ${(e as Error).message}`);
  }
  return { path: target };
}

/** Stop whatever is running and let the page go. */
export function close(): void {
  const s = live;
  live = null;
  if (!s) return;
  s.cancelled = true;
  s.recording = false;
  if (!s.win.isDestroyed()) s.win.destroy();
}
