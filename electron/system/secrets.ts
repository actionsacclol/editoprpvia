/**
 * API keys the user gives the app (their own accounts at picture services).
 * Kept encrypted by the operating system (DPAPI on Windows, the Keychain on
 * macOS) in userData/secrets.json. A key never leaves the main process: the
 * page and connected agents can learn that one is set and its last four
 * characters, nothing more.
 */

import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger';

const file = (): string => path.join(app.getPath('userData'), 'secrets.json');

let cache: Record<string, string> | null = null;

function load(): Record<string, string> {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as unknown;
    cache = raw && typeof raw === 'object' ? Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string')) : {};
  } catch {
    cache = {};
  }
  return cache;
}

function persist(): void {
  const p = file();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(`${p}.tmp`, JSON.stringify(cache ?? {}, null, 1), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(`${p}.tmp`, p);
}

/** The secret, or null when none is kept (or it can no longer be opened: another user, another computer). */
export function getSecret(name: string): string | null {
  const enc = load()[name];
  if (!enc) return null;
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64')) || null;
  } catch (e) {
    logger.warn(`[secrets] ${name} could not be opened: ${(e as Error).message}`);
    return null;
  }
}

/** Keep a secret; an empty value forgets it. */
export function setSecret(name: string, value: string): void {
  const all = load();
  const v = value.trim();
  if (!v) delete all[name];
  else {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('This computer offers no protected storage for a key, so it was not saved.');
    all[name] = safeStorage.encryptString(v).toString('base64');
  }
  persist();
}

/** The end of a kept secret, to tell two keys apart: "…a1b2". Null when none is kept. */
export function secretHint(name: string): string | null {
  const v = getSecret(name);
  return v ? `…${v.slice(-4)}` : null;
}
