/**
 * Screen recording, main side. The renderer does the capturing and encoding
 * (getDisplayMedia + WebCodecs); main only does what a page can't:
 *
 * - list the screens and windows, and answer getDisplayMedia with the one the
 *   user picked in the Record dialog (there is no system picker in Electron),
 * - keep the stop shortcut and the tray's "Stop recording" alive while the
 *   window is hidden,
 * - stop Chromium from throttling the hidden window mid-recording.
 */

import { BrowserWindow, desktopCapturer, globalShortcut, session, systemPreferences } from 'electron';
import fs from 'node:fs';
import type { CaptureInfo, CaptureSource } from '../../shared/types';
import * as files from './files';
import * as tray from './tray';
import { logger } from './logger';

const STOP_ACCELERATOR = 'CommandOrControl+Shift+F9';
const STOP_LABEL = process.platform === 'darwin' ? '⌘⇧F9' : 'Ctrl+Shift+F9';

/** Recording what the computer plays ("loopback") only exists on Windows. */
const SYSTEM_AUDIO = process.platform === 'win32';

let armed: { id: string; audio: boolean } | null = null;
let recordingWindow: BrowserWindow | null = null;
let hiddenByUs = false;

export function installCaptureHandler(): void {
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    const want = armed;
    armed = null;
    const deny = (): void => {
      try {
        callback({});
      } catch {
        /* an empty answer is how a request is refused */
      }
    };
    if (!want) return deny();
    desktopCapturer
      .getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } })
      .then((list) => {
        const source = list.find((s) => s.id === want.id);
        if (!source) return deny();
        callback({ video: source, ...(want.audio && SYSTEM_AUDIO ? { audio: 'loopback' as const } : {}) });
      })
      .catch((e) => {
        logger.error(`capture: could not list sources: ${e}`);
        deny();
      });
  });
}

export async function captureInfo(): Promise<CaptureInfo> {
  if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') === 'denied') {
    throw new Error('macOS is blocking screen recording for Krypt Editor. Allow it under System Settings > Privacy & Security > Screen Recording, then reopen the app.');
  }
  const list = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
  const sources: CaptureSource[] = list
    .filter((s) => s.name.trim() !== '')
    .map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.id.startsWith('screen') ? ('screen' as const) : ('window' as const),
      thumbnail: s.thumbnail.isEmpty() ? '' : `data:image/jpeg;base64,${s.thumbnail.toJPEG(72).toString('base64')}`,
    }));
  const folder = files.recordingsDir();
  let freeBytes: number | null = null;
  try {
    fs.mkdirSync(folder, { recursive: true });
    const st = fs.statfsSync(folder);
    freeBytes = Number(st.bavail) * Number(st.bsize);
  } catch {
    /* the dialog just leaves the free space out */
  }
  return { sources, systemAudio: SYSTEM_AUDIO, folder, freeBytes, stopShortcut: STOP_LABEL, unfinished: files.unfinishedRecordings() };
}

export function arm(id: string, audio: boolean): void {
  armed = { id, audio };
}

export async function askAccess(kind: 'microphone' | 'camera'): Promise<boolean> {
  if (process.platform !== 'darwin') return true;
  try {
    return await systemPreferences.askForMediaAccess(kind);
  } catch {
    return false;
  }
}

/**
 * Recording started (on) or ended (off). While it runs the window may sit
 * minimized, so its timers must not be throttled, and the only ways back are
 * the shortcut and the tray: both just tell the renderer, which stops the
 * capture first and only then asks for the window back, so the editor popping
 * up is not in the recording.
 */
export function setRecording(win: BrowserWindow | null, on: boolean, hide: boolean): void {
  if (on) {
    if (!win || win.isDestroyed()) return;
    recordingWindow = win;
    const ask = (): void => {
      if (recordingWindow && !recordingWindow.isDestroyed()) recordingWindow.webContents.send('capture:stopRequested');
    };
    win.webContents.setBackgroundThrottling(false);
    try {
      if (!globalShortcut.register(STOP_ACCELERATOR, ask)) logger.warn('capture: the stop shortcut is taken by another app');
    } catch (e) {
      logger.warn(`capture: could not register the stop shortcut: ${e}`);
    }
    tray.setRecordingStop(ask);
    hiddenByUs = hide;
    if (hide) win.minimize();
    return;
  }
  globalShortcut.unregister(STOP_ACCELERATOR);
  tray.setRecordingStop(null);
  const w = recordingWindow;
  recordingWindow = null;
  if (!w || w.isDestroyed()) return;
  w.webContents.setBackgroundThrottling(true);
  if (hiddenByUs || w.isMinimized() || !w.isVisible()) {
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  }
  hiddenByUs = false;
}
