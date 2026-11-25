/**
 * Recording another app's window because an AI agent asked for it.
 *
 * Recording the screen is the one thing an agent cannot do on its own in
 * Krypt Editor: the person at the computer is asked, in a prompt this process
 * shows (the agent cannot answer it), every time or once per session.
 *
 * - One window, found by its title, never a whole screen.
 * - Window titles are private (document names, browser tabs): the agent is
 *   told only about titles that contain the words it asked for.
 * - Looking at the window (a picture) and clicking or typing in it are part of
 *   the same permission and need it too. Clicking and typing use a helper
 *   (resources/pointer/input-win.ps1, Windows only) that lets go as soon as
 *   the person moves the mouse or another app comes to the front.
 */

import { app, BrowserWindow, desktopCapturer, dialog, shell } from 'electron';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { WindowAsk, WindowStep } from '../../shared/types';
import { logger } from './logger';

interface Grant {
  name: string;
  control: boolean;
  until: number;
}

/** Windows this session may look at or record, by capture source id. */
const granted = new Map<string, Grant>();
/**
 * "Allow for this session", by window title: what was allowed. A yes to more
 * covers less (recording covers a look, clicking covers watching), never the
 * other way round.
 */
const standing = new Map<string, { record: boolean; control: boolean }>();
let helper: ChildProcess | null = null;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const VK: Record<string, number> = {
  enter: 0x0d,
  return: 0x0d,
  tab: 0x09,
  escape: 0x1b,
  esc: 0x1b,
  backspace: 0x08,
  delete: 0x2e,
  space: 0x20,
  left: 0x25,
  up: 0x26,
  right: 0x27,
  down: 0x28,
  arrowleft: 0x25,
  arrowup: 0x26,
  arrowright: 0x27,
  arrowdown: 0x28,
  pageup: 0x21,
  pagedown: 0x22,
  end: 0x23,
  home: 0x24,
};
export const WINDOW_KEYS = ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Space', 'Left', 'Up', 'Right', 'Down', 'PageUp', 'PageDown', 'Home', 'End'];

async function windows(thumb = 0): Promise<Electron.DesktopCapturerSource[]> {
  return desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: thumb, height: thumb } });
}

/** The one window whose title has these words. Says so, without naming other windows, when there is none or more than one. */
async function find(words: string): Promise<Electron.DesktopCapturerSource | null> {
  const want = words.trim().toLowerCase();
  const list = (await windows()).filter((s) => s.name.toLowerCase().includes(want));
  if (list.length <= 1) return list[0] ?? null;
  const exact = list.filter((s) => s.name.toLowerCase() === want);
  if (exact.length === 1) return exact[0];
  throw new Error(`${list.length} open windows have "${words}" in their title: ${list.slice(0, 5).map((s) => `"${s.name}"`).join(', ')}. Pass more of the title of the one you mean.`);
}

function shortcutFor(name: string): string | null {
  const roots = [path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'), path.join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs')];
  const want = name.toLowerCase();
  let starts: string | null = null;
  const walk = (dir: string, depth: number): string | null => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        const hit = depth < 4 ? walk(full, depth + 1) : null;
        if (hit) return hit;
      } else if (/\.lnk$/i.test(e.name)) {
        const base = e.name.replace(/\.lnk$/i, '').toLowerCase();
        if (base === want) return full;
        if (!starts && base.startsWith(want)) starts = full;
      }
    }
    return null;
  };
  for (const r of roots) {
    const hit = r && walk(r, 0);
    if (hit) return hit;
  }
  return starts;
}

/** Open an installed app by the name it has in the Start menu (Windows) or Applications (macOS). Names only: no paths, no arguments. */
async function launch(name: string): Promise<void> {
  if (!/^[\w .+\-()&']{1,60}$/.test(name)) throw new Error('launch is the name of an installed app as its menu shows it, e.g. "Krypt Tweaker". Paths and arguments are not accepted.');
  if (process.platform === 'win32') {
    const lnk = shortcutFor(name);
    if (!lnk) throw new Error(`No app called "${name}" is in the Start menu.`);
    const err = await shell.openPath(lnk);
    if (err) throw new Error(`"${name}" could not be opened: ${err}`);
    return;
  }
  if (process.platform === 'darwin') {
    await new Promise<void>((ok, no) => execFile('/usr/bin/open', ['-a', name], (e) => (e ? no(new Error(`No app called "${name}" could be opened.`)) : ok())));
    return;
  }
  throw new Error('Opening an app by name works on Windows and macOS. Open it yourself, then ask again.');
}

/**
 * Find the window, ask the person, and remember the answer for the calls that
 * follow (shot, input, and the recording itself). Throws with the reason when
 * there is no such window or the person says no.
 */
export async function request(parent: BrowserWindow | null, raw: WindowAsk): Promise<{ sourceId: string; name: string; launched: boolean }> {
  const words = String(raw?.window ?? '').trim();
  if (words.length < 2) throw new Error('window is the title of the window, or a distinctive part of it (at least two characters).');
  const ask: WindowAsk = { window: words, launch: typeof raw.launch === 'string' && raw.launch.trim() ? raw.launch.trim() : undefined, seconds: Math.min(120, Math.max(2, Number(raw.seconds) || 15)), control: !!raw.control, steps: Math.max(0, Number(raw.steps) || 0), plan: typeof raw.plan === 'string' ? raw.plan.replace(/\s+/g, ' ').trim().slice(0, 420) : undefined, record: raw.record !== false };
  if (ask.control && process.platform !== 'win32') throw new Error('Clicking and typing in another app works on Windows only for now. Recording or looking at the window works here: leave out the steps.');
  let source = await find(ask.window);
  if (!source && !ask.launch) throw new Error(`No open window has "${ask.window}" in its title. Ask the user what the window is called, or pass launch with the app's name to open it. (A minimized window cannot be recorded.)`);

  const name = source?.name ?? ask.launch!;
  const key = name.toLowerCase();
  const had = standing.get(key);
  const covered = !!had && (had.record || !ask.record) && (had.control || !ask.control);
  const testing = !app.isPackaged && !!process.env.KRYPT_EDITOR_TEST_ALLOW_WINDOW && process.env.KRYPT_EDITOR_TEST_ALLOW_WINDOW === source?.name;
  if (!testing && !covered) {
    const what = ask.record ? 'record' : 'look at';
    const detail = [
      source ? '' : `Krypt Editor will open ${ask.launch} first.`,
      ask.record ? `Only that window is recorded, for up to ${ask.seconds} seconds, and the recording is put on your timeline.` : 'One picture of that window is taken and shown to the AI agent.',
      ask.control ? `It will also move your mouse and click and type in that window (${ask.steps} step${ask.steps === 1 ? '' : 's'})${ask.plan ? `: ${ask.plan}` : ''}. Move the mouse yourself at any time to stop it.` : 'It will not click or type anything.',
      'Whatever that window shows will be seen by the AI agent.',
    ].filter(Boolean);
    const options = { type: 'question' as const, title: 'Krypt Editor', message: `An AI agent wants to ${what} ${source ? `the window “${name}”` : `the app “${name}”`}`, detail: detail.join('\n\n'), buttons: ['Allow once', ask.control ? 'Allow for this session, clicks and typing too' : 'Allow for this session', "Don't allow"], defaultId: 2, cancelId: 2, noLink: true };
    const answer = parent && !parent.isDestroyed() ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
    if (answer.response === 2) throw new Error(`The user did not allow ${ask.record ? 'recording' : 'looking at'} "${name}". Do not ask again unless they bring it up.`);
    if (answer.response === 1) standing.set(key, { record: ask.record || !!had?.record, control: ask.control || !!had?.control });
  }

  let launched = false;
  if (!source) {
    await launch(ask.launch!);
    launched = true;
    for (let n = 0; n < 40 && !source; n++) {
      await sleep(500);
      source = await find(ask.window).catch(() => null);
    }
    if (!source) throw new Error(`${ask.launch} was opened, but no window with "${ask.window}" in its title appeared within 20 seconds.`);
    await sleep(1200);
  }
  granted.set(source.id, { name: source.name, control: ask.control, until: Date.now() + 10 * 60_000 });
  return { sourceId: source.id, name: source.name, launched };
}

function grant(sourceId: string, control = false): Grant {
  const g = granted.get(sourceId);
  if (!g || g.until < Date.now() || (control && !g.control)) throw new Error('That window has not been allowed. Ask for it first.');
  return g;
}

/** Whether a recording of this source was allowed (the recorder asks before it arms the capture). */
export function allowed(sourceId: string): boolean {
  const g = granted.get(sourceId);
  return !!g && g.until >= Date.now();
}

/** One picture of an allowed window, a JPEG in base64. */
export async function shot(sourceId: string): Promise<{ image: string; width: number; height: number; name: string }> {
  const g = grant(sourceId);
  const source = (await windows(1600)).find((s) => s.id === sourceId);
  if (!source) throw new Error(`"${g.name}" is no longer open.`);
  let image = source.thumbnail;
  if (image.isEmpty()) throw new Error(`"${g.name}" could not be pictured. A minimized window has no picture: restore it first.`);
  if (image.getSize().width > 1280) image = image.resize({ width: 1280, quality: 'good' });
  const size = image.getSize();
  return { image: image.toJPEG(75).toString('base64'), width: size.width, height: size.height, name: g.name };
}

function helperPath(): string | null {
  const p = app.isPackaged ? path.join(process.resourcesPath, 'resources', 'pointer', 'input-win.ps1') : path.join(__dirname, '..', 'resources', 'pointer', 'input-win.ps1');
  return fs.existsSync(p) ? p : null;
}

/** Stop any clicking and typing at once. */
export function cancel(): void {
  const child = helper;
  helper = null;
  if (child && child.exitCode === null) child.kill();
}

/**
 * Click and type in an allowed window. Stops at the first step that cannot be
 * done (the person moved the mouse, another app came to the front…) and says
 * why.
 */
export async function input(sourceId: string, steps: WindowStep[]): Promise<{ log: string[]; failed?: string }> {
  const g = grant(sourceId, true);
  if (process.platform !== 'win32') throw new Error('Clicking and typing in another app works on Windows only for now.');
  const script = helperPath();
  const hwnd = sourceId.split(':')[1] ?? '';
  if (!script || !/^[1-9]\d*$/.test(hwnd)) throw new Error('The helper that clicks and types is missing from this install.');
  cancel();
  const dry = !app.isPackaged && process.env.KRYPT_EDITOR_TEST_INPUT_DRY === '1';
  const exe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = spawn(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Hwnd', hwnd, ...(dry ? ['-DryRun'] : [])], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  helper = child;
  const log: string[] = [];
  const lines: string[] = [];
  let wake: (() => void) | null = null;
  let over = false;
  readline.createInterface({ input: child.stdout! }).on('line', (line) => {
    lines.push(line.trim());
    wake?.();
  });
  child.on('exit', () => {
    over = true;
    wake?.();
  });
  child.on('error', (e) => logger.warn(`agent capture: the input helper did not start: ${e.message}`));
  child.stdin?.on('error', () => undefined);
  /** The next "ok" / "err …" / "ready"; "dry …" lines on the way are kept for the log. */
  const reply = async (ms: number): Promise<string> => {
    const until = Date.now() + ms;
    for (;;) {
      while (lines.length) {
        const line = lines.shift()!;
        if (line.startsWith('dry ')) log.push(`   (would: ${line.slice(4)})`);
        else return line;
      }
      if (over) return 'err the helper stopped';
      if (Date.now() > until) return 'err it took too long';
      await new Promise<void>((r) => {
        wake = r;
        setTimeout(r, 200);
      });
      wake = null;
    }
  };
  const send = async (cmd: string, ms: number): Promise<string | null> => {
    if (helper !== child) return 'cancelled';
    child.stdin?.write(`${cmd}\n`);
    const r = await reply(ms);
    return r === 'ok' ? null : r.replace(/^err\s*/, '') || 'it failed';
  };
  let failed: string | undefined;
  try {
    const hello = await reply(10_000);
    if (hello !== 'ready') throw new Error(hello.replace(/^err\s*/, '') || 'the helper did not start');
    const front = await send('focus', 5000);
    if (front) throw new Error(front);
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      let cmd = '';
      let said = '';
      if (s.do === 'click' || s.do === 'move') {
        cmd = `${s.do} ${Number(s.x).toFixed(4)} ${Number(s.y).toFixed(4)}`;
        said = `${s.do === 'click' ? 'clicked' : 'moved to'} ${Math.round(Number(s.x) * 100)}%, ${Math.round(Number(s.y) * 100)}%`;
      } else if (s.do === 'type') {
        cmd = `type ${Buffer.from(String(s.text ?? ''), 'utf8').toString('base64')}`;
        said = `typed ${String(s.text ?? '').length} characters`;
      } else if (s.do === 'press') {
        const vk = VK[String(s.key ?? '').toLowerCase()];
        if (!vk) throw new Error(`step ${i + 1}: "${s.key}" is not a key this presses. Use ${WINDOW_KEYS.join(', ')}.`);
        cmd = `key ${vk}`;
        said = `pressed ${s.key}`;
      } else if (s.do === 'scroll') {
        const by = Number(s.by) || 300;
        const notches = Math.max(1, Math.min(40, Math.round(Math.abs(by) / 100))) * (by < 0 ? -1 : 1);
        cmd = `wheel ${notches}`;
        said = `scrolled ${by < 0 ? 'up' : 'down'}`;
      } else {
        const ms = Math.round(Math.min(20, Math.max(0.1, Number(s.seconds) || 1)) * 1000);
        cmd = `wait ${ms}`;
        said = `waited ${ms / 1000}s`;
      }
      const err = await send(cmd, 30_000);
      if (err) {
        failed = `Step ${i + 1} (${s.do}): ${err}.`;
        break;
      }
      log.push(`${i + 1}. ${said}`);
    }
  } catch (e) {
    failed = (e as Error).message;
  } finally {
    try {
      child.stdin?.end();
    } catch {
      /* already closed */
    }
    setTimeout(() => {
      if (child.exitCode === null) child.kill();
    }, 500).unref();
    if (helper === child) helper = null;
  }
  return { log, failed };
}
