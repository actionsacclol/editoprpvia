/**
 * Web capture, the editor's side: the steps (checked, or read from the lines
 * typed into the dialog), the picture size, and the encoder that turns the
 * frames coming from the page (electron/system/webCapture.ts) into an MP4.
 *
 * The page is filmed in real time, but the file is made at a steady frame
 * rate: each frame arrives with the moment it was painted, and a picture is
 * held until the next one's moment comes.
 */
import { BufferTarget, CanvasSource, Mp4OutputFormat, Output, QUALITY_HIGH, canEncodeVideo } from 'mediabunny';
import type { WebLook, WebRunResult, WebStep, WindowStep } from '../../shared/types';

export const WEB_FPS = 30;
export const WEB_MAX_STEPS = 60;
const KINDS = ['click', 'hover', 'type', 'press', 'scroll', 'wait', 'goto'] as const;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Steps as given by an agent, checked. Throws a sentence that says which step is wrong and how. */
export function cleanSteps(raw: unknown): WebStep[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('steps is a list: [{ do: "click", target: "Pricing" }, …].');
  if (raw.length > WEB_MAX_STEPS) throw new Error(`At most ${WEB_MAX_STEPS} steps in one capture; film a long walkthrough in parts.`);
  return raw.map((item, i) => {
    const r = (item ?? {}) as Record<string, unknown>;
    const kind = String(r.do ?? '').toLowerCase() as WebStep['do'];
    const where = `steps[${i}]`;
    if (!KINDS.includes(kind)) throw new Error(`${where}: do is one of ${KINDS.join(', ')}.`);
    const step: WebStep = { do: kind };
    const target = text(r.target);
    const px = isNum(r.x) ? r.x : NaN;
    const py = isNum(r.y) ? r.y : NaN;
    const point = !Number.isNaN(px) && !Number.isNaN(py);
    if (point && (px < 0 || px > 1 || py < 0 || py > 1)) throw new Error(`${where}: x and y are 0..1 across and down the picture.`);
    if (target) step.target = target;
    else if (point) {
      step.x = px;
      step.y = py;
    }
    if (kind === 'click' || kind === 'hover') {
      if (!target && !point) throw new Error(`${where}: ${kind} needs a target (the words on the thing, or css=<selector>) or x and y.`);
    } else if (kind === 'type') {
      if (typeof r.text !== 'string' || !r.text) throw new Error(`${where}: type needs text.`);
      step.text = r.text.slice(0, 500);
    } else if (kind === 'press') {
      if (!text(r.key)) throw new Error(`${where}: press needs a key (Enter, Tab, Escape, Down…).`);
      step.key = text(r.key);
    } else if (kind === 'scroll') {
      if (!target) step.by = isNum(r.by) ? r.by : 600;
      delete step.x;
      delete step.y;
    } else if (kind === 'wait') {
      if (isNum(r.seconds)) step.seconds = r.seconds;
      delete step.x;
      delete step.y;
    } else if (kind === 'goto') {
      const url = text(r.url) ?? target;
      if (!url || !/^https?:\/\//i.test(url)) throw new Error(`${where}: goto needs url, an http or https address.`);
      return { do: 'goto', url };
    }
    return step;
  });
}

/** Steps for another app's window (record_window), checked. Places are 0..1 of the window: there is nothing to name there. */
export function cleanWindowSteps(raw: unknown): WindowStep[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('steps is a list: [{ do: "click", x: 0.5, y: 0.3 }, …].');
  if (raw.length > WEB_MAX_STEPS) throw new Error(`At most ${WEB_MAX_STEPS} steps in one recording.`);
  const kinds = ['click', 'move', 'type', 'press', 'scroll', 'wait'] as const;
  return raw.map((item, i) => {
    const r = (item ?? {}) as Record<string, unknown>;
    const kind = String(r.do ?? '').toLowerCase() as WindowStep['do'];
    const where = `steps[${i}]`;
    if (!kinds.includes(kind)) throw new Error(`${where}: do is one of ${kinds.join(', ')}.`);
    if (kind === 'click' || kind === 'move') {
      if (!isNum(r.x) || !isNum(r.y) || r.x < 0 || r.x > 1 || r.y < 0 || r.y > 1) throw new Error(`${where}: ${kind} needs x and y, 0..1 across and down the window (read them off the picture record: false returns).`);
      return { do: kind, x: r.x, y: r.y };
    }
    if (kind === 'type') {
      if (typeof r.text !== 'string' || !r.text) throw new Error(`${where}: type needs text.`);
      return { do: kind, text: r.text.slice(0, 500) };
    }
    if (kind === 'press') {
      if (!text(r.key)) throw new Error(`${where}: press needs a key (Enter, Tab, Escape, Down…).`);
      return { do: kind, key: text(r.key) };
    }
    if (kind === 'scroll') return { do: kind, by: isNum(r.by) ? r.by : 300 };
    return { do: 'wait', seconds: isNum(r.seconds) ? r.seconds : 1 };
  });
}

const unquote = (s: string): string => s.trim().replace(/^["“'](.*)["”']$/, '$1').trim();

/**
 * The dialog's lines, one step each:
 *   click Pricing            type hello into Search       press Enter
 *   hover Features           scroll 600 / scroll up / scroll to Pricing
 *   wait 2 / wait for Results                              go to https://…
 * Blank lines and lines starting with # are skipped.
 */
export function parseSteps(source: string): { steps: WebStep[]; errors: string[] } {
  const steps: WebStep[] = [];
  const errors: string[] = [];
  source.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const bad = (why: string): void => void errors.push(`Line ${i + 1}: ${why}`);
    const m = /^(\S+)\s*(.*)$/.exec(line)!;
    const verb = m[1].toLowerCase();
    const rest = m[2].trim();
    if (verb === 'click' || verb === 'hover') {
      if (!rest) return bad(`${verb} what? Write the words on it, e.g. "${verb} Pricing".`);
      steps.push({ do: verb, target: unquote(rest.replace(/^on\s+/i, '')) });
    } else if (verb === 'type') {
      const into = /^(.*?)\s+in(?:to)?\s+(.+)$/i.exec(rest);
      const words = unquote(into ? into[1] : rest);
      if (!words) return bad('type what? e.g. "type hello into Search".');
      steps.push(into ? { do: 'type', text: words, target: unquote(into[2]) } : { do: 'type', text: words });
    } else if (verb === 'press') {
      if (!rest) return bad('press which key? e.g. "press Enter".');
      steps.push({ do: 'press', key: unquote(rest) });
    } else if (verb === 'scroll') {
      const to = /^to\s+(.+)$/i.exec(rest);
      if (to) steps.push({ do: 'scroll', target: unquote(to[1]) });
      else if (!rest || /^down$/i.test(rest)) steps.push({ do: 'scroll', by: 600 });
      else if (/^up$/i.test(rest)) steps.push({ do: 'scroll', by: -600 });
      else if (/^(down\s+|up\s+)?-?\d+$/i.test(rest)) steps.push({ do: 'scroll', by: (/^up/i.test(rest) ? -1 : 1) * Number(rest.replace(/^\D+(?=-?\d)/, '')) });
      else bad('scroll how far? e.g. "scroll 600", "scroll up" or "scroll to Pricing".');
    } else if (verb === 'wait') {
      const until = /^(?:for|until)\s+(.+)$/i.exec(rest);
      if (until && !/^\d/.test(until[1])) steps.push({ do: 'wait', target: unquote(until[1]) });
      else {
        const n = Number((until ? until[1] : rest).replace(/\s*(s|sec|secs|seconds?)$/i, ''));
        if (!rest) steps.push({ do: 'wait', seconds: 1 });
        else if (Number.isFinite(n) && n > 0) steps.push({ do: 'wait', seconds: n });
        else bad('wait how long? e.g. "wait 2" or "wait for Results".');
      }
    } else if (verb === 'go' || verb === 'goto' || verb === 'open') {
      const url = unquote(rest.replace(/^to\s+/i, ''));
      if (!/^https?:\/\//i.test(url)) return bad('go to which address? It starts with https://');
      steps.push({ do: 'goto', url });
    } else bad(`"${m[1]}" is not a step. Use click, hover, type, press, scroll, wait or go to.`);
  });
  if (steps.length > WEB_MAX_STEPS) errors.push(`At most ${WEB_MAX_STEPS} steps in one capture.`);
  return { steps, errors };
}

/** An address as typed ("krypt.cc") made whole, or null when it is not a web address. */
export function webAddress(raw: string): string | null {
  const t = raw.trim();
  if (!t || /\s/.test(t)) return null;
  // Something running on this computer or network is plain http; everything else is https unless it says otherwise.
  const whole = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `${/^(localhost|127\.|192\.168\.|10\.)/i.test(t) ? 'http' : 'https'}://${t}`;
  try {
    const u = new URL(whole);
    const web = u.protocol === 'http:' || u.protocol === 'https:';
    return web && (u.hostname.includes('.') || u.hostname === 'localhost') ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The picture's size for a canvas, and how wide the page should believe its
 * window is. A wide canvas films a desktop layout at 1.5× so text stays sharp;
 * a tall one films the phone layout.
 */
export function webSize(canvas: { width: number; height: number }, pageWidth?: number): { width: number; height: number; pageWidth: number } {
  const k = Math.min(1, 1920 / Math.max(canvas.width, canvas.height, 1));
  const even = (n: number): number => Math.max(320, Math.round((n * k) / 2) * 2);
  const width = even(canvas.width);
  const height = even(canvas.height);
  const natural = width >= height ? 1280 : 430;
  // Between one and three picture pixels per page pixel.
  const page = Math.round(Math.min(width, Math.max(width / 3, pageWidth && pageWidth > 0 ? pageWidth : natural)));
  return { width, height, pageWidth: page };
}

/** The pointer track of a capture, as the file kept next to the video. */
export function pointerJson(r: WebRunResult): string {
  return JSON.stringify({ v: 1, duration: r.duration, buttons: true, moves: r.moves, clicks: r.clicks });
}

/**
 * Film what `run` does to the open page: frames are encoded as they arrive.
 * Returns the MP4 and what the run reported.
 */
export async function filmWeb(size: { width: number; height: number }, run: () => Promise<WebRunResult>, signal: AbortSignal): Promise<{ bytes: Uint8Array; result: WebRunResult }> {
  if (!(await canEncodeVideo('avc', { width: size.width, height: size.height }).catch(() => false))) throw new Error('This computer cannot encode H.264 video, which a web capture needs.');
  const el = document.createElement('canvas');
  el.width = size.width;
  el.height = size.height;
  const ctx = el.getContext('2d', { alpha: false })!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, el.width, el.height);
  const out = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const source = new CanvasSource(el, { codec: 'avc', bitrate: QUALITY_HIGH });
  out.addVideoTrack(source, { frameRate: WEB_FPS });
  await out.start();
  let n = 0;
  let have = false;
  let broken: Error | null = null;
  let chain: Promise<void> = Promise.resolve();
  // The picture on the canvas stands until `t`.
  const holdUntil = async (t: number): Promise<void> => {
    while (n / WEB_FPS < t) {
      await source.add(n / WEB_FPS, 1 / WEB_FPS);
      n++;
    }
  };
  const off = window.krypt.web.onFrame(({ t, jpeg }) => {
    chain = chain
      .then(async () => {
        if (broken) return;
        const bmp = await createImageBitmap(new Blob([jpeg as BlobPart], { type: 'image/jpeg' }));
        if (have) await holdUntil(t);
        ctx.drawImage(bmp, 0, 0, el.width, el.height);
        bmp.close();
        have = true;
      })
      .catch((e: Error) => {
        broken ??= e;
      });
  });
  try {
    const result = await run();
    await chain;
    if (signal.aborted) throw new Error('Cancelled.');
    if (broken) throw broken;
    if (!have) throw new Error('The page never drew anything, so there is nothing to keep.');
    await holdUntil(Math.max(result.duration, (n + 1) / WEB_FPS));
    await out.finalize();
    const buf = (out.target as BufferTarget).buffer;
    if (!buf) throw new Error('The capture could not be encoded.');
    return { bytes: new Uint8Array(buf), result: { ...result, duration: n / WEB_FPS } };
  } catch (e) {
    await out.cancel().catch(() => undefined);
    throw e;
  } finally {
    off();
  }
}

export interface WebCaptureRequest {
  url: string;
  steps: WebStep[];
  /** false = do the steps and report what the page shows, without filming. */
  record: boolean;
  pageWidth?: number;
  cursor?: boolean;
  maxSeconds?: number;
}

export interface WebCaptureOutcome {
  title: string;
  url: string;
  log: string[];
  /** Why the steps stopped early. Nothing is kept then. */
  failed?: string;
  /** record: false, or after a failure: the page as it stands. */
  look?: WebLook;
  /** record: true and it worked: the saved file and its length. */
  path?: string;
  duration?: number;
  clicks?: number;
}

const need = <T>(r: { ok: boolean; data?: T; message?: string }, what: string): T => {
  if (!r.ok || r.data === undefined) throw new Error(r.message ?? what);
  return r.data;
};

/** Open the page, do the steps, and either film them into the Recordings folder or report what the page shows. */
export async function captureWeb(req: WebCaptureRequest, canvas: { width: number; height: number }, signal: AbortSignal): Promise<WebCaptureOutcome> {
  const size = webSize(canvas, req.pageWidth);
  const stop = (): void => void window.krypt.web.close();
  signal.addEventListener('abort', stop);
  try {
    const opened = need(await window.krypt.web.open({ url: req.url, width: size.width, height: size.height, pageWidth: size.pageWidth, cursor: req.cursor !== false }), 'The page could not be opened.');
    if (signal.aborted) throw new Error('Cancelled.');
    const max = Math.min(300, Math.max(5, req.maxSeconds ?? 90));
    if (!req.record) {
      const ran = need(await window.krypt.web.run(req.steps, false, max), 'The steps could not be run.');
      const look = need(await window.krypt.web.look(), 'The page could not be read.');
      return { title: look.title, url: look.url, log: ran.log, failed: ran.failed, look };
    }
    let failedLook: WebLook | undefined;
    const filmed = await filmWeb(
      size,
      async () => {
        const ran = need(await window.krypt.web.run(req.steps, true, max), 'The steps could not be run.');
        // The page as it stood when a step failed, so whoever asked can see what to change.
        if (ran.failed) failedLook = (await window.krypt.web.look().catch(() => null))?.data;
        return ran;
      },
      signal,
    );
    if (filmed.result.failed) return { title: opened.title, url: opened.url, log: filmed.result.log, failed: filmed.result.failed, look: failedLook };
    const saved = need(await window.krypt.web.save(filmed.bytes, pointerJson(filmed.result)), 'The capture could not be saved.');
    return { title: opened.title, url: opened.url, log: filmed.result.log, path: saved.path, duration: filmed.result.duration, clicks: filmed.result.clicks.length };
  } finally {
    signal.removeEventListener('abort', stop);
    stop();
  }
}
