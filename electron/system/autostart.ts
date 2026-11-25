import { app } from 'electron';

/**
 * Wraps `app.setLoginItemSettings` for start-at-login (Windows + macOS).
 * Skipped in dev because `process.execPath` points at electron.exe —
 * registering that would cold-launch bare Electron on every login.
 *
 * The login-launched instance starts hidden in the tray (see main.ts
 * `startMinimized` handling). Windows signals that via a --hidden arg;
 * macOS ignores custom args; there the app sees that it was opened at login
 * (`wasOpenedAtLogin`). Electron dropped `openAsHidden` / `wasOpenedAsHidden`.
 */

export function setStartWithWindows(enabled: boolean): void {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  if (!app.isPackaged) return;
  try {
    app.setLoginItemSettings(
      process.platform === 'darwin' ? { openAtLogin: enabled } : { openAtLogin: enabled, args: enabled ? ['--hidden'] : [] },
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[autostart] failed to set login item:', err);
  }
}

export function isStartWithWindows(): boolean {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return false;
  if (!app.isPackaged) return false;
  try {
    return app.getLoginItemSettings().openAtLogin;
  } catch {
    return false;
  }
}
