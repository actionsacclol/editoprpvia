import { app, BrowserWindow, shell } from 'electron';
import path from 'node:path';
import type { MediaFile } from '../shared/types';
import { registerIpc } from './ipc';
import * as store from './system/settings-store';
import * as files from './system/files';
import * as tray from './system/tray';
import * as discord from './system/discord';
import * as mediaProtocol from './system/mediaProtocol';
import { installCaptureHandler } from './system/capture';
import { setStartWithWindows } from './system/autostart';
import { resolveClientContext } from './system/identity';
import { logger } from './system/logger';
import { cancelAllConverts } from './system/convert';
import { startAgentHost } from './mcp/host';
import * as pointer from './system/pointer';
import * as webCapture from './system/webCapture';
import * as agentCapture from './system/agentCapture';

// ──────────────────────────────────────────────────────────────────────
// Environment
// ──────────────────────────────────────────────────────────────────────
process.env.DIST_ELECTRON = __dirname;
process.env.DIST = path.join(__dirname, '..', 'dist');
process.env.VITE_PUBLIC = app.isPackaged ? process.env.DIST : path.join(__dirname, '..', 'public');

const ctx = resolveClientContext();

// Must run before app 'ready' — registers the krypteditor:// media scheme
// used to stream local clips into the renderer.
mediaProtocol.registerScheme();

// ──────────────────────────────────────────────────────────────────────
// Single-instance lock
// ──────────────────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // A second launch (e.g. double-clicking another file in Explorer) lands here
  // instead of starting a new process — surface the window and import its files.
  app.on('second-instance', (_e, argv) => {
    const win = showMainWindow();
    deliverOpenMedia(win, mediaArgs(argv));
  });
  // macOS opens files through this event rather than argv. Queue any that
  // arrive before the app is ready; deliver the rest live.
  app.on('open-file', (e, filePath) => {
    e.preventDefault();
    if (app.isReady()) {
      deliverOpenMedia(showMainWindow(), [filePath]);
    } else {
      earlyOpenPaths.push(filePath);
    }
  });
  app.whenReady().then(bootstrap);
}

let mainWindow: BrowserWindow | null = null;
let isQuitting = false;

// Media the app was launched with (file association / "Open with" / dropping a
// file on the app icon). Resolved once at boot; the renderer pulls it on mount
// via media:takeLaunchFiles, which clears it.
let launchFiles: MediaFile[] = [];
// macOS open-file events that fire before the app is ready (see above).
const earlyOpenPaths: string[] = [];

/**
 * Pull importable file paths out of a process argv. Drops the executable
 * (argv[0]), the dev `.` cwd arg, and any `--flags`; resolveMediaFiles then
 * discards anything that isn't a supported, existing media file.
 */
function mediaArgs(argv: string[]): string[] {
  return argv.slice(1).filter((a) => a && a !== '.' && !a.startsWith('-'));
}

/** Resolve paths to media and push them to a (possibly still-loading) window. */
function deliverOpenMedia(win: BrowserWindow, paths: string[]): void {
  const resolved = files.resolveMediaFiles(paths);
  if (resolved.length === 0) return;
  const send = (): void => {
    if (!win.isDestroyed()) win.webContents.send('media:opened', resolved);
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
  else send();
}

function showMainWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }

  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1024,
    minHeight: 660,
    backgroundColor: '#0A0A0F',
    title: ctx.productName,
    autoHideMenuBar: true,
    icon: path.join(
      app.isPackaged ? path.join(process.resourcesPath, 'resources') : path.join(__dirname, '..', 'resources'),
      process.platform === 'win32' ? 'krypt.ico' : 'krypt.png',
    ),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // No devtools in shipped builds (also kills the F12/Ctrl+Shift+I accelerators).
      devTools: !app.isPackaged,
    },
    show: false,
  });

  const reveal = (): void => {
    if (win.isDestroyed() || win.isVisible()) return;
    win.show();
    win.focus();
  };
  win.once('ready-to-show', reveal);
  win.webContents.once('did-finish-load', reveal);
  const revealTimer = setTimeout(reveal, 4000);

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    logger.error(`mainWindow: did-fail-load ${code} "${desc}" ${url}`);
    reveal();
  });

  // Close-to-tray (always on): hide instead of quitting unless we're really
  // quitting — the tray menu's Quit is the way out.
  win.on('close', (e) => {
    if (isQuitting) return;
    e.preventDefault();
    win.hide();
  });

  win.on('closed', () => {
    clearTimeout(revealTimer);
    if (mainWindow === win) mainWindow = null;
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    // Same scheme allowlist as app:openExternal — never hand file:/ms-*: URLs
    // to the OS shell.
    if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  // Navigation lock: the app never navigates away from its own document; any
  // attempt (e.g. an injected link, a dropped file:// that slipped the guard)
  // is denied, and webviews are forbidden entirely.
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault();
  });
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    win.loadURL(devUrl).catch((err) => logger.error(`loadURL failed: ${err}`));
  } else {
    win.loadFile(path.join(process.env.DIST!, 'index.html')).catch((err) => logger.error(`loadFile failed: ${err}`));
  }
  mainWindow = win;
  return win;
}

async function bootstrap(): Promise<void> {
  mediaProtocol.installHandler();
  installCaptureHandler();

  // macOS expects a real application menu (and it's what makes Cmd+C/V/X work
  // in text fields). Keep the standard roles, minus devtools when packaged.
  if (process.platform === 'darwin') {
    const { Menu } = await import('electron');
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: 'appMenu' },
        { role: 'fileMenu' },
        { role: 'editMenu' },
        ...(app.isPackaged ? [] : [{ role: 'viewMenu' } as const]),
        { role: 'windowMenu' },
      ]),
    );
  }

  // Resolve files this instance was launched with: argv (Windows/Linux file
  // association, "Open with", CLI) plus any early macOS open-file events.
  launchFiles = files.resolveMediaFiles([...mediaArgs(process.argv), ...earlyOpenPaths.splice(0)]);

  registerIpc({
    showMainWindow,
    takeLaunchFiles: () => {
      const f = launchFiles;
      launchFiles = [];
      return f;
    },
  });
  // AI agents (MCP): Claude Code, Codex, Cursor, … edit the open project live.
  void startAgentHost({ getMainWindow: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null), showMainWindow });

  // Always-on behaviors: start at login, start minimized when launched at
  // login, close to tray, Discord presence.
  if (app.isPackaged) setStartWithWindows(true);

  const launchedAtLogin =
    (() => {
      try {
        const s = app.getLoginItemSettings();
        return s.wasOpenedAtLogin === true;
      } catch {
        return false;
      }
    })() || process.argv.some((a) => a === '--hidden' || a === '--autostart');

  if (!launchedAtLogin) showMainWindow();

  tray.installTray({
    show: () => showMainWindow(),
    quit: () => {
      isQuitting = true;
      app.quit();
    },
  });

  // Discord RPC — best-effort, never blocks boot (§8).
  discord.startDiscordRpc().catch(() => {});
  discord.setActivity('Idle', 'Editing video');

  logger.info(`${ctx.productName} ready`);
}

// ──────────────────────────────────────────────────────────────────────
// Lifecycle
// ──────────────────────────────────────────────────────────────────────
app.on('before-quit', () => {
  pointer.cancel();
  webCapture.close();
  agentCapture.cancel();
  isQuitting = true;
  cancelAllConverts();
  discord.stopDiscordRpc();
  tray.destroyTray();
});

app.on('window-all-closed', () => {
  // With close-to-tray the window can be hidden rather than destroyed, so
  // this only fires on a real quit. Honour macOS convention regardless.
  if (process.platform !== 'darwin') app.quit();
});

// macOS: clicking the Dock icon must resurrect (or re-show) the window.
app.on('activate', () => {
  if (app.isReady()) showMainWindow();
});

// ──────────────────────────────────────────────────────────────────────
// Crash diagnostics — log instead of dying silently (no telemetry, so the
// on-disk log is the only post-hoc signal).
// ──────────────────────────────────────────────────────────────────────
process.on('uncaughtException', (err) => logger.error(`uncaughtException: ${err?.stack ?? err}`));
process.on('unhandledRejection', (reason) => logger.error(`unhandledRejection: ${String(reason)}`));
app.on('render-process-gone', (_e, _wc, details) => logger.error(`render-process-gone: ${details.reason} (${details.exitCode})`));
app.on('child-process-gone', (_e, details) => logger.error(`child-process-gone: ${details.type}/${details.name ?? ''} ${details.reason}`));
