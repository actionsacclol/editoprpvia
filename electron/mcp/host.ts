// Glue between the MCP server (index.ts), the renderer that executes tools
// (src/editor/agentTools.ts via window.krypt.mcp.serve) and the AI panel's IPC.

import { app, BrowserWindow, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { McpStatus, McpToolResult } from '../../shared/types';
import * as store from '../system/settings-store';
import { logger } from '../system/logger';
import { startMcp, type McpHandle, type ToolOutcome } from './index';
import { clientSnippets, installClient } from './clients';

interface HostDeps {
  getMainWindow: () => BrowserWindow | null;
  showMainWindow: () => BrowserWindow;
}

const READY_TIMEOUT_MS = 30_000;

function shimPath(): string | null {
  const p = app.isPackaged
    ? path.join(process.resourcesPath, 'resources', 'mcp', 'krypt-editor-mcp.cjs')
    : path.join(__dirname, '..', 'resources', 'mcp', 'krypt-editor-mcp.cjs');
  if (!fs.existsSync(p)) return null;
  // An AppImage is mounted at a new temporary path on every start, so a path
  // into it written to an agent's config would be dead by the next launch.
  // The connector script is kept in the data folder instead, and the AppImage
  // file itself stands in for the executable (appExe below).
  if (process.env.APPIMAGE) {
    try {
      const stable = path.join(app.getPath('userData'), 'mcp', 'krypt-editor-mcp.cjs');
      fs.mkdirSync(path.dirname(stable), { recursive: true });
      fs.copyFileSync(p, stable);
      return stable;
    } catch (e) {
      logger.warn(`[mcp] could not copy the connector script out of the AppImage: ${(e as Error).message}`);
    }
  }
  return p;
}

/** The file that starts this app: the AppImage when running from one, otherwise the executable. */
const appExe = (): string => process.env.APPIMAGE || process.execPath;

export async function startAgentHost(deps: HostDeps): Promise<McpHandle | null> {
  let readyFor: number | null = null; // webContents id whose renderer serves tools
  let readyWaiters: Array<() => void> = [];
  let nextRid = 1;
  const pending = new Map<number, { resolve: (r: ToolOutcome) => void; progress: (f: number, m: string) => void; wc: number }>();

  const failPending = (wcId: number, why: string): void => {
    for (const [rid, p] of pending) {
      if (p.wc !== wcId) continue;
      pending.delete(rid);
      p.resolve({ ok: false, text: why });
    }
  };

  ipcMain.on('mcp:ready', (e, on: boolean) => {
    const wc = e.sender;
    if (on) {
      readyFor = wc.id;
      readyWaiters.splice(0).forEach((f) => f());
      // A reload or crash takes the executor (and its in-flight calls) with it.
      const reset = (): void => {
        if (readyFor === wc.id) readyFor = null;
        failPending(wc.id, 'Krypt Editor reloaded while running this tool. Retry it.');
      };
      wc.once('did-start-loading', reset);
      wc.once('render-process-gone', reset);
      wc.once('destroyed', reset);
    } else if (readyFor === wc.id) {
      readyFor = null;
    }
  });
  ipcMain.on('mcp:result', (_e, rid: number, result: McpToolResult) => {
    const p = pending.get(rid);
    if (!p) return;
    pending.delete(rid);
    p.resolve({ ok: !!result?.ok, text: String(result?.text ?? ''), images: result?.images });
  });
  ipcMain.on('mcp:progress', (_e, rid: number, fraction: number, message: string) => {
    pending.get(rid)?.progress(Number(fraction), String(message ?? ''));
  });

  const executor = async (): Promise<BrowserWindow> => {
    const win = deps.getMainWindow() ?? deps.showMainWindow();
    if (readyFor !== null && readyFor === win.webContents.id) return win;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Krypt Editor\'s window didn\'t become ready in time. Retry in a moment.')), READY_TIMEOUT_MS);
      readyWaiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
    return win;
  };

  const exe = appExe();
  const shim = shimPath();
  let handle: McpHandle | null = null;
  const broadcast = (s: McpStatus): void => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('mcp:status', s);
  };

  try {
    handle = await startMcp({
      userData: app.getPath('userData'),
      // Dev only: a test instance (own --user-data-dir) can serve on its own pipe beside the user's app.
      pipe: !app.isPackaged && process.env.KRYPT_EDITOR_MCP_PIPE ? process.env.KRYPT_EDITOR_MCP_PIPE : undefined,
      version: app.getVersion(),
      shimPath: shim,
      exePath: exe,
      appExePath: app.isPackaged ? exe : null,
      isEnabled: () => store.load().agentAccess !== false,
      onStatus: broadcast,
      log: (level, message) => logger[level](message),
      runTool: async (name, args, client, onProgress, signal) => {
        const win = await executor();
        const rid = nextRid++;
        return new Promise<ToolOutcome>((resolve) => {
          pending.set(rid, { resolve, progress: onProgress, wc: win.webContents.id });
          const onAbort = (): void => {
            if (!win.isDestroyed()) win.webContents.send('mcp:cancel', rid);
          };
          signal.addEventListener('abort', onAbort, { once: true });
          win.webContents.send('mcp:call', { rid, tool: name, args, client });
        });
      },
    });
  } catch (e) {
    logger.error(`MCP: failed to start: ${(e as Error).message}`);
  }

  const emptyStatus = (): McpStatus => ({ enabled: store.load().agentAccess !== false, listening: false, error: 'The agent server failed to start (see the log).', clients: [], activity: [], shimPath: shim, exePath: exe, toolCount: 0 });
  ipcMain.handle('mcp:status', () => handle?.status() ?? emptyStatus());
  ipcMain.handle('mcp:setEnabled', (_e, on: boolean) => {
    store.update({ agentAccess: !!on });
    const s = handle?.status() ?? emptyStatus();
    broadcast(s);
    return s;
  });
  ipcMain.handle('mcp:snippets', () => clientSnippets(exe, shim));
  ipcMain.handle('mcp:install', (_e, client: string, opts: { allowAll?: boolean }) => installClient(String(client), exe, shim, { allowAll: opts?.allowAll }));

  return handle;
}
