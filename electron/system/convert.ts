/**
 * Footage the editor can't read on its own (ProRes, DNxHD, 10-bit 4:2:2
 * camera files, AVI, MTS, WMV, HEVC on a machine without a hardware decoder…)
 * is converted once, on import, into an H.264 MP4 in the media cache, and the
 * editor works on that copy.
 *
 * The conversion is done by FFmpeg. Krypt Editor does not ship one: it uses a
 * copy placed in its resources folder if a build ever includes it, otherwise
 * the FFmpeg installed on the computer. Without either, the importer says what
 * the file needs and nothing else changes.
 */

import { app } from 'electron';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger';

const EXE = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';

interface Ffmpeg {
  path: string;
  encoders: Set<string>;
}

let found: Promise<Ffmpeg | null> | null = null;

function candidates(): string[] {
  const env = process.env;
  const dirs: string[] = [];
  if (env.KRYPT_FFMPEG) dirs.push(path.dirname(env.KRYPT_FFMPEG));
  dirs.push(path.join(process.resourcesPath ?? '', 'ffmpeg'));
  dirs.push(...(env.PATH ?? env.Path ?? '').split(path.delimiter));
  if (process.platform === 'win32') {
    const local = env.LOCALAPPDATA ?? '';
    const home = env.USERPROFILE ?? '';
    dirs.push(
      path.join(local, 'Microsoft', 'WinGet', 'Links'),
      path.join(home, 'scoop', 'shims'),
      path.join(env.ChocolateyInstall ?? 'C:\\ProgramData\\chocolatey', 'bin'),
      'C:\\ffmpeg\\bin',
      'C:\\Program Files\\ffmpeg\\bin',
    );
  } else {
    // An app started from the dock or a launcher doesn't get the shell's PATH.
    dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/snap/bin', path.join(env.HOME ?? '', '.local', 'bin'));
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of dirs) {
    const dir = d.trim().replace(/^"|"$/g, '');
    if (!dir) continue;
    const p = path.join(dir, EXE);
    const key = process.platform === 'win32' ? p.toLowerCase() : p;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function probe(p: string): Promise<Ffmpeg | null> {
  return new Promise((resolve) => {
    try {
      if (!fs.statSync(p).isFile()) return resolve(null);
    } catch {
      return resolve(null);
    }
    execFile(p, ['-hide_banner', '-encoders'], { timeout: 10_000, windowsHide: true, maxBuffer: 4 << 20 }, (err, stdout) => {
      if (err) return resolve(null);
      const encoders = new Set<string>();
      for (const line of String(stdout).split(/\r?\n/)) {
        const m = /^\s*[VAS][A-Z.]{5}\s+(\S+)/.exec(line);
        if (m) encoders.add(m[1]);
      }
      resolve(encoders.size > 0 ? { path: p, encoders } : null);
    });
  });
}

/** The FFmpeg this computer can run, looked up once per session. */
export function findFfmpeg(): Promise<Ffmpeg | null> {
  found ??= (async () => {
    for (const p of candidates()) {
      const f = await probe(p);
      if (f) {
        logger.info(`[convert] using ffmpeg at ${f.path}`);
        return f;
      }
    }
    logger.info('[convert] no ffmpeg found');
    return null;
  })();
  return found;
}

export async function converterAvailable(): Promise<boolean> {
  return (await findFfmpeg()) !== null;
}

/** H.264 encoders in the order they are tried, each with settings for a near-lossless working copy. */
const VIDEO_ENCODERS: Array<[string, string[]]> = [
  ['libx264', ['-preset', 'veryfast', '-crf', '17']],
  ['h264_nvenc', ['-preset', 'p5', '-rc', 'vbr', '-cq', '19', '-b:v', '0']],
  ['h264_videotoolbox', ['-q:v', '65']],
  ['h264_qsv', ['-global_quality', '20']],
  ['h264_amf', ['-quality', 'balanced', '-rc', 'cqp', '-qp_i', '18', '-qp_p', '20']],
  ['h264_mf', ['-rate_control', 'quality', '-quality', '85']],
  ['libopenh264', ['-b:v', '24M']],
];

export function convertedDir(): string {
  return path.join(app.getPath('userData'), 'MediaCache', 'Converted');
}

/** Where the converted copy of a file lives: named after the file, keyed by its path, size and date. */
export function convertedPathFor(src: string, kind: 'video' | 'audio'): string {
  const st = fs.statSync(src);
  const key = createHash('sha1').update(`${path.resolve(src)}|${st.size}|${Math.round(st.mtimeMs)}|v1`).digest('hex').slice(0, 10);
  const base = path.basename(src, path.extname(src)).replace(/[^\w.-]+/g, '_').slice(0, 60) || 'media';
  return path.join(convertedDir(), `${base}-${key}.${kind === 'video' ? 'mp4' : 'm4a'}`);
}

function argsFor(src: string, out: string, kind: 'video' | 'audio', encoder: [string, string[]] | null): string[] {
  const head = ['-y', '-hide_banner', '-nostdin', '-i', src];
  const tail = ['-progress', 'pipe:1', '-nostats', '-f', kind === 'video' ? 'mp4' : 'ipod', out];
  if (kind === 'audio') return [...head, '-map', '0:a:0', '-vn', '-sn', '-dn', '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', ...tail];
  return [
    ...head,
    '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn',
    // Nothing above 4K on the long side, even dimensions, and 8-bit 4:2:0: what every player and the editor's own decoder read.
    '-vf', "scale='min(3840,iw)':'min(3840,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p",
    '-c:v', encoder![0], ...encoder![1],
    '-c:a', 'aac', '-b:a', '256k',
    '-movflags', '+faststart',
    ...tail,
  ];
}

const clockSeconds = (h: string, m: string, s: string): number => Number(h) * 3600 + Number(m) * 60 + Number(s);

interface Job {
  proc: ChildProcess | null;
  cancelled: boolean;
}

const jobs = new Map<string, Job>();

function runOnce(ff: Ffmpeg, args: string[], job: Job, onProgress: (fraction: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ff.path, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    job.proc = proc;
    let total = 0;
    let tailErr = '';
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d: string) => {
      tailErr = (tailErr + d).slice(-4000);
      if (total === 0) {
        const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(tailErr);
        if (m) total = clockSeconds(m[1], m[2], m[3]);
      }
    });
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d: string) => {
      const m = /out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(d);
      if (m && total > 0) onProgress(Math.max(0, Math.min(0.999, clockSeconds(m[1], m[2], m[3]) / total)));
    });
    proc.on('error', (e) => reject(e));
    proc.on('close', (code) => {
      job.proc = null;
      if (job.cancelled) return reject(new Error('cancelled'));
      if (code === 0) return resolve();
      const last = tailErr.trim().split(/\r?\n/).filter((l) => l.trim()).slice(-2).join(' ').slice(0, 300);
      reject(new Error(last || `ffmpeg exited with code ${code}`));
    });
  });
}

/**
 * Convert a file into the media cache and return the copy's path. A copy made
 * earlier from the same, unchanged file is reused. `id` names the job so it
 * can be cancelled.
 */
export async function convertMedia(id: string, src: string, kind: 'video' | 'audio', onProgress: (fraction: number) => void): Promise<string> {
  const ff = await findFfmpeg();
  if (!ff) throw new Error('FFmpeg is not installed.');
  const out = convertedPathFor(src, kind);
  if (fs.existsSync(out) && fs.statSync(out).size > 0) return out;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const part = `${out}.part`;
  const job: Job = { proc: null, cancelled: false };
  jobs.set(id, job);
  try {
    const encoders = kind === 'audio' ? [null] : VIDEO_ENCODERS.filter(([name]) => ff.encoders.has(name));
    if (encoders.length === 0) throw new Error('This FFmpeg has no H.264 encoder.');
    let lastError: Error | null = null;
    for (const enc of encoders) {
      try {
        await runOnce(ff, argsFor(src, part, kind, enc), job, onProgress);
        fs.renameSync(part, out);
        return out;
      } catch (e) {
        lastError = e as Error;
        if (job.cancelled) break;
        // A hardware encoder that is listed but has no device behind it fails at once: try the next.
        logger.warn(`[convert] ${enc ? enc[0] : 'aac'} failed for ${path.basename(src)}: ${lastError.message}`);
      }
    }
    throw lastError ?? new Error('Conversion failed.');
  } finally {
    jobs.delete(id);
    try {
      fs.rmSync(part, { force: true });
    } catch {
      /* nothing to clean */
    }
  }
}

export function cancelConvert(id: string): void {
  const job = jobs.get(id);
  if (!job) return;
  job.cancelled = true;
  try {
    job.proc?.kill();
  } catch {
    /* already gone */
  }
}

/** Stop every running conversion (the app is quitting). */
export function cancelAllConverts(): void {
  for (const id of [...jobs.keys()]) cancelConvert(id);
}
