import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Minimal in-process logger that fans out to (a) stdout for dev, and
 * (b) every BrowserWindow via the `log:append` IPC channel so the UI can
 * surface errors as toasts without polling. Deliberately tiny — Krypt Editor
 * is small enough that an external file logger would be more maintenance
 * than it's worth.
 */

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  message: string;
  ts: string; // ISO
}

let logFile: string | null = null;
function fileSink(): string | null {
  // Lazily resolve (needs app 'ready'); truncate once if it has grown large.
  try {
    if (!logFile) {
      logFile = path.join(app.getPath('userData'), 'krypt.log');
      try {
        if (fs.statSync(logFile).size > 1_000_000) fs.writeFileSync(logFile, '');
      } catch {
        /* no existing log */
      }
    }
    return logFile;
  } catch {
    return null;
  }
}

function emit(entry: LogEntry): void {
  const tag = entry.level === 'error' ? '\x1b[31m' : entry.level === 'warn' ? '\x1b[33m' : '\x1b[36m';
  const reset = '\x1b[0m';
  // eslint-disable-next-line no-console
  console.log(`${tag}[${entry.ts}] ${entry.level.toUpperCase()} ${entry.message}${reset}`);
  // Persist to a file so packaged-app issues are diagnosable (no stdout there).
  try {
    const p = fileSink();
    if (p) fs.appendFileSync(p, `[${entry.ts}] ${entry.level.toUpperCase()} ${entry.message}\n`);
  } catch {
    /* best effort */
  }
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      w.webContents.send('log:append', entry);
    }
  }
}

export const logger = {
  info(message: string): void {
    emit({ level: 'info', message, ts: new Date().toISOString() });
  },
  warn(message: string): void {
    emit({ level: 'warn', message, ts: new Date().toISOString() });
  },
  error(message: string): void {
    emit({ level: 'error', message, ts: new Date().toISOString() });
  },
};
