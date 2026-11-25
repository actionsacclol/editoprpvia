/**
 * Where the pointer is, and when it is pressed, during a screen recording.
 * Written next to the recorded file as `<name>.pointer.json`, it is what the
 * editor's Product demo reads to zoom in on clicks.
 *
 * - Windows: a small PowerShell helper (resources/pointer/pointer-win.ps1)
 *   reports the pointer, the mouse buttons and the recorded window's place.
 *   It reads the mouse only and runs only while a recording does.
 * - macOS: Electron says where the pointer is; a small script run by the
 *   system's own osascript (resources/pointer/pointer-mac.js) says when a
 *   mouse button goes down and where the recorded window is. Mouse only, no
 *   permission needed. Without it (it failed to start) this is the next case.
 * - Elsewhere: Electron can say where the pointer is but not when it is
 *   pressed, so a recorded screen gets positions only (the demo then follows
 *   where the pointer comes to rest) and a recorded window gets nothing.
 *
 * Times are recording seconds: counted from mark(), pauses left out.
 */

import { app, desktopCapturer, screen } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import * as files from './files';
import { logger } from './logger';

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Session {
  child: ChildProcess | null;
  poll: NodeJS.Timeout | null;
  /** The recorded picture's place, in the units the pointer is reported in. Null until known. */
  rect: Rect | null;
  /** Whether presses can be read here. */
  buttons: boolean;
  startedAt: number | null;
  pausedAt: number | null;
  pausedTotal: number;
  last: { x: number; y: number } | null;
  lastMoveAt: number;
  moves: Array<[number, number, number]>;
  clicks: Array<[number, number, number, number]>;
}

let session: Session | null = null;

const MOVE_EVERY = 1 / 30;
const MAX_ROWS = 400_000;
const round = (v: number, d: number): number => Math.round(v * d) / d;

function helperPath(name: string): string | null {
  const p = app.isPackaged ? path.join(process.resourcesPath, 'resources', 'pointer', name) : path.join(__dirname, '..', 'resources', 'pointer', name);
  return fs.existsSync(p) ? p : null;
}

function clock(s: Session): number | null {
  if (s.startedAt === null) return null;
  const now = s.pausedAt ?? Date.now();
  return Math.max(0, (now - s.startedAt - s.pausedTotal) / 1000);
}

function place(s: Session, px: number, py: number): { x: number; y: number } | null {
  if (!s.rect || s.rect.width <= 0 || s.rect.height <= 0) return null;
  return { x: round((px - s.rect.x) / s.rect.width, 1e4), y: round((py - s.rect.y) / s.rect.height, 1e4) };
}

function moved(s: Session, px: number, py: number, force = false): void {
  const at = place(s, px, py);
  if (!at) return;
  s.last = at;
  const t = clock(s);
  if (t === null || s.pausedAt !== null || s.moves.length >= MAX_ROWS) return;
  if (!force && t - s.lastMoveAt < MOVE_EVERY) return;
  s.lastMoveAt = t;
  s.moves.push([round(t, 1e3), at.x, at.y]);
}

function pressed(s: Session, button: number): void {
  const t = clock(s);
  if (t === null || s.pausedAt !== null || !s.last || s.clicks.length >= MAX_ROWS) return;
  s.clicks.push([round(t, 1e3), s.last.x, s.last.y, button]);
}

/** Get ready to follow the pointer over a screen or window about to be recorded. Never throws: a recording without a pointer track is still a recording. */
export async function prepare(sourceId: string): Promise<void> {
  cancel();
  const s: Session = { child: null, poll: null, rect: null, buttons: false, startedAt: null, pausedAt: null, pausedTotal: 0, last: null, lastMoveAt: -1, moves: [], clicks: [] };
  session = s;
  try {
    const isScreen = sourceId.startsWith('screen');
    let display = screen.getPrimaryDisplay();
    if (isScreen) {
      const list = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      const want = list.find((x) => x.id === sourceId)?.display_id;
      display = screen.getAllDisplays().find((d) => String(d.id) === want) ?? display;
    }
    if (session !== s) return;

    const helper = process.platform === 'win32' ? helperPath('pointer-win.ps1') : null;
    if (helper) {
      // The helper speaks screen pixels; Electron speaks scaled ones.
      if (isScreen) s.rect = screen.dipToScreenRect(null, display.bounds);
      const hwnd = isScreen ? '0' : (sourceId.split(':')[1] ?? '0');
      if (!isScreen && !/^[1-9]\d*$/.test(hwnd)) return;
      const exe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const child = spawn(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Hwnd', hwnd], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      s.child = child;
      child.on('error', (e) => logger.warn(`pointer: the helper did not start: ${e.message}`));
      child.stdin?.on('error', () => undefined);
      readline.createInterface({ input: child.stdout! }).on('line', (line) => {
        if (session !== s) return;
        const [kind, a, b, c, d] = line.trim().split(' ');
        if (kind === 'ready') s.buttons = true;
        else if (kind === 'p') moved(s, Number(a), Number(b));
        else if (kind === 'd') pressed(s, Number(a) === 1 ? 1 : 0);
        else if (kind === 'r' && !isScreen) s.rect = { x: Number(a), y: Number(b), width: Number(c), height: Number(d) };
      });
      return;
    }
    // Positions from Electron. A recorded window's place comes from the macOS script; without it only a screen can be followed.
    const script = process.platform === 'darwin' && fs.existsSync('/usr/bin/osascript') ? helperPath('pointer-mac.js') : null;
    const windowId = isScreen ? '0' : (sourceId.split(':')[1] ?? '0');
    if (!isScreen && (!script || !/^[1-9]\d*$/.test(windowId))) return;
    if (isScreen) s.rect = display.bounds;
    if (script) {
      const child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', script, windowId], { stdio: ['pipe', 'pipe', 'ignore'] });
      s.child = child;
      child.on('error', (e) => logger.warn(`pointer: the helper did not start: ${e.message}`));
      child.stdin?.on('error', () => undefined);
      readline.createInterface({ input: child.stdout! }).on('line', (line) => {
        if (session !== s) return;
        const [kind, a, b, c, d] = line.trim().split(' ');
        if (kind === 'ready') s.buttons = true;
        else if (kind === 'd') pressed(s, Number(a) === 1 ? 1 : 0);
        // Points from the main screen's top left: the units Electron reports the pointer in.
        else if (kind === 'r' && !isScreen && Number(c) > 0 && Number(d) > 0) s.rect = { x: Number(a), y: Number(b), width: Number(c), height: Number(d) };
      });
    }
    s.poll = setInterval(() => {
      const p = screen.getCursorScreenPoint();
      if (!s.last || place(s, p.x, p.y)?.x !== s.last.x || place(s, p.x, p.y)?.y !== s.last.y) moved(s, p.x, p.y);
    }, 33);
  } catch (e) {
    logger.warn(`pointer: not tracking this recording: ${(e as Error).message}`);
  }
}

/** The recording starts now. */
export function mark(): void {
  const s = session;
  if (!s) return;
  s.startedAt = Date.now();
  s.pausedAt = null;
  s.pausedTotal = 0;
  s.lastMoveAt = -1;
  s.moves = [];
  s.clicks = [];
  // Where the pointer already is counts as its first position.
  if (s.last) s.moves.push([0, s.last.x, s.last.y]);
}

export function pause(on: boolean): void {
  const s = session;
  if (!s || s.startedAt === null) return;
  if (on && s.pausedAt === null) s.pausedAt = Date.now();
  else if (!on && s.pausedAt !== null) {
    s.pausedTotal += Date.now() - s.pausedAt;
    s.pausedAt = null;
  }
}

function stop(s: Session): void {
  if (s.poll) clearInterval(s.poll);
  s.poll = null;
  if (s.child) {
    try {
      s.child.stdin?.end();
    } catch {
      /* already closed */
    }
    const child = s.child;
    setTimeout(() => {
      if (child.exitCode === null) child.kill();
    }, 500).unref();
    s.child = null;
  }
}

/** Stop following and throw the track away. */
export function cancel(): void {
  const s = session;
  session = null;
  if (s) stop(s);
}

export const sidecarFor = (videoPath: string): string => videoPath.replace(/\.[^.\\/]+$/, '') + '.pointer.json';

/**
 * The recording ended: write its pointer track next to `videoPath` (a file in
 * the Recordings folder) and stop. Returns how much was written, or null when
 * there was nothing worth keeping.
 */
export function finish(videoPath: string | null): { moves: number; clicks: number } | null {
  const s = session;
  session = null;
  if (!s) return null;
  const duration = clock(s) ?? 0;
  stop(s);
  if (!videoPath || s.moves.length < 2) return null;
  const dir = path.resolve(files.recordingsDir());
  const target = path.resolve(sidecarFor(videoPath));
  if (path.dirname(target) !== dir) return null;
  try {
    fs.writeFileSync(target, JSON.stringify({ v: 1, duration: round(duration, 1e3), buttons: s.buttons, moves: s.moves, clicks: s.clicks }));
    return { moves: s.moves.length, clicks: s.clicks.length };
  } catch (e) {
    logger.warn(`pointer: could not save the track: ${(e as Error).message}`);
    return null;
  }
}

/** The pointer track recorded with a video file, as text, or null when it has none. */
export function read(videoPath: string): string | null {
  try {
    const p = sidecarFor(videoPath);
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > 64 * 1024 * 1024) return null;
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}
