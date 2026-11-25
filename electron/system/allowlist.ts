import path from 'node:path';

/**
 * Security allowlist for the krypteditor:// protocol. The handler may only serve
 * files the user actually imported or opened — never an arbitrary absolute path.
 * Every path that flows through resolveMediaFile (imports, drops, launch/open
 * files) and every path restored from an opened project is registered here.
 */

const allowed = new Set<string>();

function norm(p: string): string {
  // NFC first: macOS hands out NFD filenames while URLs/JS round-trip NFC —
  // without this, accented filenames import fine and then 403 at playback.
  const resolved = path.resolve(p.normalize('NFC'));
  // Only Windows is reliably case-insensitive; macOS volumes can be
  // case-sensitive (APFS option), so folding there would over-grant.
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function allowPath(p: string): void {
  if (p) allowed.add(norm(p));
}

export function allowPaths(paths: string[]): void {
  for (const p of paths) allowPath(p);
}

export function isAllowed(p: string): boolean {
  return allowed.has(norm(p));
}
