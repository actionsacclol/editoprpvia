/**
 * Filesystem helpers for the editor: the directory picker (working folder
 * setting) and the media file picker (import clips/audio/images onto the
 * timeline). All dialogs resolve to plain paths/results and never throw.
 *
 * User data lives under app.getPath('userData') by default — never
 * Documents/Desktop, which Controlled Folder Access can silently block
 * (kryptguidelines §5.8). The user can still point the working folder
 * anywhere they like via the directory picker.
 */

import { app, dialog, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { MediaFile, MediaKind } from '../../shared/types';
import { mediaUrl } from './mediaProtocol';
import { allowPath } from './allowlist';
import * as store from './settings-store';
import { creditFor } from './images';

export function defaultWorkingDir(): string {
  return path.join(app.getPath('userData'), 'Projects');
}

function parentWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
}

// AVI is deliberately absent: neither Chromium nor mediabunny can demux it,
// so accepting it would only produce clips that never play or export.
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'mkv', 'm4v']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);

// Formats the editor can't read itself. They are accepted because FFmpeg, when
// the computer has one, converts them on import (see convert.ts).
const FOREIGN_VIDEO_EXT = new Set(['avi', 'mts', 'm2ts', 'wmv', 'mpg', 'mpeg', 'mxf', 'flv', '3gp', 'ogv', 'vob']);
const FOREIGN_AUDIO_EXT = new Set(['wma', 'aiff', 'aif', 'ac3', 'amr', 'opus', 'mka']);

function kindFor(ext: string): MediaKind | null {
  const e = ext.toLowerCase();
  if (VIDEO_EXT.has(e) || FOREIGN_VIDEO_EXT.has(e)) return 'video';
  if (AUDIO_EXT.has(e) || FOREIGN_AUDIO_EXT.has(e)) return 'audio';
  if (IMAGE_EXT.has(e)) return 'image';
  return null;
}

/** A format that always goes through the converter. */
function isForeign(ext: string): boolean {
  const e = ext.toLowerCase();
  return FOREIGN_VIDEO_EXT.has(e) || FOREIGN_AUDIO_EXT.has(e);
}

/** True if the path has a media extension and points at an existing file. */
export function isMediaFilePath(p: string): boolean {
  if (kindFor(path.extname(p).slice(1)) === null) return false;
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Crash-safe write: the bytes land in a sibling temp file first and are
 * renamed over the target, so a crash mid-write never truncates the original.
 */
function writeFileAtomicSync(target: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, typeof data === 'string' ? 'utf8' : undefined);
  fs.renameSync(tmp, target);
}

/** Resolve an absolute file path into a MediaFile, or null if unsupported. */
export function resolveMediaFile(filePath: string): MediaFile | null {
  const ext = path.extname(filePath).slice(1);
  const kind = kindFor(ext);
  if (!kind) return null;
  let sizeBytes = 0;
  try {
    sizeBytes = fs.statSync(filePath).size;
  } catch {
    return null;
  }
  allowPath(filePath); // grant the krypteditor:// handler access to this file
  return {
    // Globally unique so ids never collide across sessions / reopened projects.
    id: `m-${randomUUID()}`,
    name: path.basename(filePath),
    filePath,
    kind,
    sizeBytes,
    mediaUrl: mediaUrl(filePath),
    ...(isForeign(ext) ? { needsConvert: true } : {}),
    // A picture found on the web carries its credit (images.ts writes it next to the file).
    ...(kind === 'image' ? credited(filePath) : {}),
  };
}

function credited(filePath: string): { credit?: string } {
  const c = creditFor(filePath);
  return c ? { credit: c.credit } : {};
}

export function resolveMediaFiles(paths: string[]): MediaFile[] {
  return paths.map(resolveMediaFile).filter((m): m is MediaFile => m !== null);
}

/** Show an Open dialog for media files; returns the resolved MediaFiles. */
export async function pickMediaFiles(): Promise<MediaFile[]> {
  const win = parentWindow();
  const opts = {
    properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
    filters: [
      { name: 'Media', extensions: [...VIDEO_EXT, ...FOREIGN_VIDEO_EXT, ...AUDIO_EXT, ...FOREIGN_AUDIO_EXT, ...IMAGE_EXT] },
      { name: 'Video', extensions: [...VIDEO_EXT, ...FOREIGN_VIDEO_EXT] },
      { name: 'Audio', extensions: [...AUDIO_EXT, ...FOREIGN_AUDIO_EXT] },
      { name: 'Images', extensions: [...IMAGE_EXT] },
      { name: 'All files', extensions: ['*'] },
    ],
  };
  const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (result.canceled || result.filePaths.length === 0) return [];
  return resolveMediaFiles(result.filePaths);
}

/**
 * Save exported media bytes through a Save dialog, defaulting into the user's
 * working directory. Returns the chosen path, or null if cancelled.
 */
export async function saveExport(data: Uint8Array, suggestedName: string): Promise<string | null> {
  const win = parentWindow();
  const ext = path.extname(suggestedName).slice(1).toLowerCase() || 'mp4';
  const filters =
    ext === 'mp4' || ext === 'webm'
      ? [{ name: 'Video', extensions: [ext] }]
      : [{ name: 'Audio', extensions: [ext] }];
  const baseDir = store.load().workingDirectory ?? defaultWorkingDir();
  const opts = { defaultPath: path.join(baseDir, suggestedName), filters };
  const result = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
  if (result.canceled || !result.filePath) return null;
  writeFileAtomicSync(result.filePath, Buffer.from(data));
  return result.filePath;
}

/**
 * Persist app-generated media (e.g. a reversed clip render) into the media
 * cache under userData and resolve it like an import. The filename is
 * sanitized to a basename so the renderer can't steer the write path.
 */
export function saveDerivedMedia(data: Uint8Array, name: string): MediaFile | null {
  const dir = path.join(app.getPath('userData'), 'MediaCache');
  fs.mkdirSync(dir, { recursive: true });
  const safe = path.basename(name).replace(/[^\w.-]+/g, '_');
  const p = path.join(dir, safe);
  fs.writeFileSync(p, Buffer.from(data));
  return resolveMediaFile(p);
}

/** Pick .cube LUT files and return their contents (they're small text files). */
export async function pickLutFiles(): Promise<Array<{ name: string; text: string }>> {
  const win = parentWindow();
  const opts = {
    properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
    filters: [{ name: 'Color LUT', extensions: ['cube'] }],
  };
  const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (result.canceled) return [];
  const out: Array<{ name: string; text: string }> = [];
  for (const p of result.filePaths) {
    try {
      // Cap at 8MB — a 64³ .cube is well under 2MB; anything bigger is not a LUT.
      if (fs.statSync(p).size > 8 * 1024 * 1024) continue;
      out.push({ name: path.basename(p), text: fs.readFileSync(p, 'utf8') });
    } catch {
      /* unreadable — skip */
    }
  }
  return out;
}

// ── Streamed exports ────────────────────────────────────────────────────
// The renderer encodes straight to disk in positioned chunks instead of
// accumulating the whole file in RAM. Writes land in a .part sibling that is
// renamed over the final path on commit, so a crash or cancel never leaves a
// half-written file under the chosen name.
const exportStreams = new Map<string, { fd: number; partPath: string; finalPath: string }>();

export async function exportBegin(suggestedName: string): Promise<{ token: string; path: string } | null> {
  const win = parentWindow();
  const ext = path.extname(suggestedName).slice(1).toLowerCase() || 'mp4';
  const filters = ext === 'mp4' || ext === 'webm' ? [{ name: 'Video', extensions: [ext] }] : [{ name: 'Audio', extensions: [ext] }];
  const baseDir = store.load().workingDirectory ?? defaultWorkingDir();
  const opts = { defaultPath: path.join(baseDir, suggestedName), filters };
  const result = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
  if (result.canceled || !result.filePath) return null;
  fs.mkdirSync(path.dirname(result.filePath), { recursive: true });
  const partPath = `${result.filePath}.part`;
  const fd = fs.openSync(partPath, 'w');
  const token = randomUUID();
  exportStreams.set(token, { fd, partPath, finalPath: result.filePath });
  return { token, path: result.filePath };
}

/**
 * Start an export to a known path without a dialog (agent exports). Relative or
 * empty paths land in the working folder; an existing file is never
 * overwritten — the name gets " (2)", " (3)", … instead.
 */
export function exportBeginAt(requested: string, ext: string): { token: string; path: string } {
  const baseDir = store.load().workingDirectory ?? defaultWorkingDir();
  let target = requested.trim() ? requested.trim() : path.join(baseDir, `krypt-export-${Date.now().toString(36)}.${ext}`);
  if (!path.isAbsolute(target)) target = path.join(baseDir, target);
  const want = ext.toLowerCase();
  if (path.extname(target).slice(1).toLowerCase() !== want) target = `${target.replace(/.[A-Za-z0-9]{1,5}$/, '')}.${want}`;
  const dir = path.dirname(target);
  const stem = path.basename(target, path.extname(target));
  let finalPath = target;
  for (let n = 2; fs.existsSync(finalPath) || fs.existsSync(`${finalPath}.part`); n++) finalPath = path.join(dir, `${stem} (${n}).${want}`);
  fs.mkdirSync(dir, { recursive: true });
  const partPath = `${finalPath}.part`;
  const fd = fs.openSync(partPath, 'wx');
  const token = randomUUID();
  exportStreams.set(token, { fd, partPath, finalPath });
  return { token, path: finalPath };
}

// ── Preview copies (proxies) ────────────────────────────────────────────
// Small copies of large video for the preview, made by the renderer and
// streamed here like an export. One per source file, named after the file and
// keyed by its path, size and date, so a changed file gets a new copy.
function proxyPathFor(src: string): string {
  const st = fs.statSync(src);
  const key = createHash('sha1').update(`${path.resolve(src)}|${st.size}|${Math.round(st.mtimeMs)}|p1`).digest('hex').slice(0, 10);
  const base = path.basename(src, path.extname(src)).replace(/[^\w.-]+/g, '_').slice(0, 60) || 'video';
  return path.join(app.getPath('userData'), 'MediaCache', 'Proxies', `${base}-${key}.mp4`);
}

/** The preview copy made earlier for a file, if it is still there. */
export function proxyFind(src: string): MediaFile | null {
  try {
    const p = proxyPathFor(src);
    if (!fs.existsSync(p) || fs.statSync(p).size === 0) return null;
    return resolveMediaFile(p);
  } catch {
    return null;
  }
}

/** Open the preview copy of a file for writing (through exportWrite / exportEnd). */
export function proxyBegin(src: string): { token: string; path: string } {
  const finalPath = proxyPathFor(src);
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  const partPath = `${finalPath}.part`;
  // A half-written copy from a session that was closed mid-way.
  if (![...exportStreams.values()].some((s) => s.partPath === partPath)) fs.rmSync(partPath, { force: true });
  const fd = fs.openSync(partPath, 'wx');
  const token = randomUUID();
  exportStreams.set(token, { fd, partPath, finalPath });
  return { token, path: finalPath };
}

export function exportWrite(token: string, data: Uint8Array, position: number): void {
  const s = exportStreams.get(token);
  if (!s) throw new Error('Export stream is not open.');
  fs.writeSync(s.fd, Buffer.from(data), 0, data.byteLength, position);
}

export function exportEnd(token: string, commit: boolean): string | null {
  const s = exportStreams.get(token);
  if (!s) return null;
  exportStreams.delete(token);
  try {
    fs.closeSync(s.fd);
  } catch {
    /* already closed */
  }
  if (commit) {
    if (s.partPath !== s.finalPath) fs.renameSync(s.partPath, s.finalPath);
    return s.finalPath;
  }
  try {
    fs.unlinkSync(s.partPath);
  } catch {
    /* best effort */
  }
  return null;
}

// ── Recordings ──────────────────────────────────────────────────────────
// A recording streams into one crash-safe (fragmented) file holding every
// track; when it stops, the renderer saves the tracks as ordinary files next
// to it and the streamed one is deleted. If the app dies mid-recording the
// "unfinished" file is still a playable video the user can import.
const rawRecordings = new Set<string>();

export function recordingsDir(): string {
  return path.join(store.load().workingDirectory ?? defaultWorkingDir(), 'Recordings');
}

export function recordingBegin(): { token: string; rawPath: string; base: string } {
  const dir = recordingsDir();
  fs.mkdirSync(dir, { recursive: true });
  const d = new Date();
  const two = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
  let base = path.join(dir, `recording-${stamp}`);
  for (let n = 2; fs.readdirSync(dir).some((f) => f.startsWith(`${path.basename(base)}-`)); n++) base = path.join(dir, `recording-${stamp}-${n}`);
  const rawPath = `${base}-unfinished.mp4`;
  const fd = fs.openSync(rawPath, 'wx');
  const token = randomUUID();
  exportStreams.set(token, { fd, partPath: rawPath, finalPath: rawPath });
  rawRecordings.add(rawPath);
  return { token, rawPath, base };
}

/**
 * Recordings that were never finished (the app died or was force-quit while
 * recording), newest first. Listing them also makes them deletable.
 */
export function unfinishedRecordings(): Array<{ path: string; modified: number; bytes: number }> {
  const dir = recordingsDir();
  const open = new Set([...exportStreams.values()].map((s) => s.partPath));
  const out: Array<{ path: string; modified: number; bytes: number }> = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith('-unfinished.mp4')) continue;
    const p = path.join(dir, name);
    if (open.has(p)) continue;
    try {
      const st = fs.statSync(p);
      if (!st.isFile() || st.size === 0) continue;
      rawRecordings.add(p);
      out.push({ path: p, modified: st.mtimeMs, bytes: st.size });
    } catch {
      /* vanished meanwhile */
    }
  }
  return out.sort((a, b) => b.modified - a.modified);
}

/** Delete a streamed recording file. Only files this session created or listed as unfinished qualify. */
export function recordingDiscard(rawPath: string): void {
  if (!rawRecordings.delete(rawPath)) return;
  try {
    fs.unlinkSync(rawPath);
  } catch {
    /* already gone */
  }
}

// ── Projects (.krypt) ───────────────────────────────────────────────────
const PROJECT_FILTERS = [{ name: 'Krypt project', extensions: ['krypt'] }];

// Project paths the renderer may write to without a dialog (Ctrl+S). Only
// paths that came out of a save/open dialog or a successful recents open
// qualify — the renderer cannot mint write access to arbitrary paths.
const grantedProjectPaths = new Set<string>();
// Case-fold only on Windows — macOS volumes can be case-sensitive, and a
// folded key would authorize writing a *different* file.
const grantKey = (p: string): string => {
  const n = path.normalize(p.normalize('NFC'));
  return process.platform === 'win32' ? n.toLowerCase() : n;
};
const grantProjectPath = (p: string): void => void grantedProjectPaths.add(grantKey(p));
const isKryptPath = (p: string): boolean => path.extname(p).toLowerCase() === '.krypt';

export async function saveProject(json: string, suggestedName: string): Promise<string | null> {
  const win = parentWindow();
  const baseDir = store.load().workingDirectory ?? defaultWorkingDir();
  const opts = { defaultPath: path.join(baseDir, suggestedName), filters: PROJECT_FILTERS };
  const result = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
  if (result.canceled || !result.filePath) return null;
  writeFileAtomicSync(result.filePath, json);
  grantProjectPath(result.filePath);
  return result.filePath;
}

export async function openProject(): Promise<{ path: string; json: string } | null> {
  const win = parentWindow();
  const opts = { properties: ['openFile'] as Array<'openFile'>, filters: PROJECT_FILTERS };
  const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (result.canceled || result.filePaths.length === 0) return null;
  const p = result.filePaths[0];
  const json = fs.readFileSync(p, 'utf8');
  grantProjectPath(p);
  return { path: p, json };
}

export function saveProjectToPath(json: string, p: string): string {
  if (!isKryptPath(p) || !grantedProjectPaths.has(grantKey(p))) {
    throw new Error('Save location not granted — use Save As.');
  }
  writeFileAtomicSync(p, json);
  return p;
}

/**
 * Save a project to a path without a dialog (agent saves). Relative or empty
 * paths land in the working folder; an existing file is never overwritten.
 */
export function saveProjectAs(json: string, requested: string, fallbackName: string): string {
  const baseDir = store.load().workingDirectory ?? defaultWorkingDir();
  let target = requested.trim() || path.join(baseDir, `${fallbackName.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'project'}.krypt`);
  if (!path.isAbsolute(target)) target = path.join(baseDir, target);
  if (!isKryptPath(target)) target = `${target}.krypt`;
  const dir = path.dirname(target);
  const stem = path.basename(target, '.krypt');
  let finalPath = target;
  for (let n = 2; fs.existsSync(finalPath); n++) finalPath = path.join(dir, `${stem} (${n}).krypt`);
  fs.mkdirSync(dir, { recursive: true });
  writeFileAtomicSync(finalPath, json);
  grantProjectPath(finalPath);
  return finalPath;
}

/** Read one .cube LUT by path (agent imports). */
export function readLutFile(p: string): { name: string; text: string } {
  if (path.extname(p).toLowerCase() !== '.cube') throw new Error('Not a .cube LUT file.');
  if (fs.statSync(p).size > 8 * 1024 * 1024) throw new Error('That file is too big to be a LUT.');
  return { name: path.basename(p), text: fs.readFileSync(p, 'utf8') };
}

// ── Slide decks (PDF) ───────────────────────────────────────────────────
// The renderer turns each page into an image (pdf.js); main only hands over
// the bytes, and only for .pdf files.
const MAX_SLIDES_BYTES = 400 * 1024 * 1024;

export async function pickSlideFiles(): Promise<string[]> {
  const win = parentWindow();
  const opts = {
    properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
    filters: [{ name: 'Slides (PDF)', extensions: ['pdf'] }],
  };
  const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  return result.canceled ? [] : result.filePaths;
}

export function readSlidesFile(p: string): { name: string; data: Uint8Array } {
  if (path.extname(p).toLowerCase() !== '.pdf') throw new Error('Slides have to be a PDF file. In PowerPoint, Keynote or Google Slides, export the deck as PDF first.');
  let size = 0;
  try {
    size = fs.statSync(p).size;
  } catch {
    throw new Error(`No file at ${p}.`);
  }
  if (size > MAX_SLIDES_BYTES) throw new Error('That PDF is over 400 MB; split it into smaller files.');
  return { name: path.basename(p), data: fs.readFileSync(p) };
}

/** Open a project by absolute path (recent projects). null if it's gone. */
export function openProjectPath(p: string): { path: string; json: string } | null {
  if (!isKryptPath(p)) return null;
  try {
    const json = fs.readFileSync(p, 'utf8');
    grantProjectPath(p);
    return { path: p, json };
  } catch {
    return null;
  }
}

function autosavePath(): string {
  return path.join(app.getPath('userData'), 'autosave.krypt');
}

export function autosaveWrite(json: string): void {
  try {
    // Keep the previous autosave as .bak so one bad write never costs both.
    const target = autosavePath();
    try {
      fs.copyFileSync(target, `${target}.bak`);
    } catch {
      /* first autosave */
    }
    writeFileAtomicSync(target, json);
  } catch {
    /* best effort */
  }
}

export function autosaveRead(): string | null {
  for (const p of [autosavePath(), `${autosavePath()}.bak`]) {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Pick a folder (for the working-directory setting). */
export async function pickDirectory(): Promise<string | null> {
  const win = parentWindow();
  const opts = { properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> };
  const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
}
