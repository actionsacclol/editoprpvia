/**
 * Installing a model that is a fixed list of files: each one pinned to an
 * address and a SHA-256, downloaded with resume into its own folder under
 * userData/models, checked before it is ever used. (The voice model's
 * installer in kokoro.ts is the older sibling of this; it also knows how to
 * copy from Krypt Studio.)
 */

import { app, net } from 'electron';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger';

export interface PinnedFile {
  /** File name in the model's folder. */
  name: string;
  url: string;
  sha256: string;
  bytes: number;
}

export interface InstallProgress {
  stage: 'downloading' | 'verifying';
  done: number;
  total: number;
}

export interface InstallStatus {
  installed: boolean;
  /** Bytes still to fetch. */
  downloadBytes: number;
  /** Size of the whole model on disk. */
  totalBytes: number;
  installing: boolean;
  progress: InstallProgress | null;
}

type Marker = Record<string, { sha256: string; size: number; mtimeMs: number }>;

function sizeOf(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return -1;
  }
}

/** One model: where it lives, what it is made of, and its install in progress (one at a time). */
export class PinnedModel {
  private running: { promise: Promise<void>; abort: AbortController } | null = null;
  private last: InstallProgress | null = null;
  private readonly listeners = new Set<(p: InstallProgress) => void>();
  private readonly watchers = new Set<() => void>();

  /** `folder` is the folder name under userData/models; `what` names it in messages ("picture model"). */
  constructor(
    private readonly folder: string,
    private readonly what: string,
    readonly files: readonly PinnedFile[],
  ) {}

  dir(): string {
    return path.join(app.getPath('userData'), 'models', this.folder);
  }

  file(name: string): string {
    return path.join(this.dir(), name);
  }

  get bytes(): number {
    return this.files.reduce((s, f) => s + f.bytes, 0);
  }

  private markerPath(): string {
    return path.join(this.dir(), 'verified.json');
  }

  private marker(): Marker {
    try {
      return JSON.parse(fs.readFileSync(this.markerPath(), 'utf8')) as Marker;
    } catch {
      return {};
    }
  }

  private verified(marker: Marker, f: PinnedFile): boolean {
    const m = marker[f.name];
    if (!m || m.sha256 !== f.sha256) return false;
    try {
      const st = fs.statSync(this.file(f.name));
      return st.size === f.bytes && st.mtimeMs === m.mtimeMs;
    } catch {
      return false;
    }
  }

  status(): InstallStatus {
    const marker = this.marker();
    const missing = this.files.filter((f) => !this.verified(marker, f));
    // What a stopped download already has on disk does not need fetching again.
    const have = missing.reduce((s, f) => s + Math.max(0, Math.min(f.bytes, sizeOf(`${this.file(f.name)}.part`))), 0);
    return { installed: missing.length === 0, downloadBytes: missing.reduce((s, f) => s + f.bytes, 0) - have, totalBytes: this.bytes, installing: this.running !== null, progress: this.running ? this.last : null };
  }

  /** Told whenever an install starts or ends, or the model is removed. */
  onChange(fn: () => void): () => void {
    this.watchers.add(fn);
    return () => this.watchers.delete(fn);
  }

  private changed(): void {
    this.watchers.forEach((w) => w());
  }

  private cancelled(): Error {
    return new Error(`The ${this.what} download was cancelled.`);
  }

  private async hashFile(src: string, hash: ReturnType<typeof createHash>, onBytes: (n: number) => void, signal: AbortSignal): Promise<void> {
    for await (const chunk of fs.createReadStream(src, { highWaterMark: 1 << 20 })) {
      if (signal.aborted) throw this.cancelled();
      hash.update(chunk as Buffer);
      onBytes((chunk as Buffer).length);
    }
  }

  /** Downloads `f` into `part`, carrying on from a partial file; returns its SHA-256. */
  private async download(f: PinnedFile, part: string, onBytes: (n: number, stage: InstallProgress['stage']) => void, signal: AbortSignal): Promise<string> {
    let have = sizeOf(part);
    if (have < 0 || have > f.bytes) have = 0;
    let hash = createHash('sha256');
    if (have > 0) await this.hashFile(part, hash, (n) => onBytes(n, 'verifying'), signal);
    let res: Response;
    try {
      res = await net.fetch(f.url, { headers: have > 0 ? { Range: `bytes=${have}-` } : {}, signal });
    } catch (e) {
      if (signal.aborted) throw this.cancelled();
      throw new Error(`Couldn't download the ${this.what} (${(e as Error).message}). Check your internet connection.`);
    }
    if (have > 0 && res.status !== 206) {
      // The server ignored the range: this file starts over.
      onBytes(-have, 'downloading');
      have = 0;
      hash = createHash('sha256');
    }
    if (!res.ok || !res.body) throw new Error(`Couldn't download the ${this.what} (${f.name}: HTTP ${res.status}).`);
    const out = await fs.promises.open(part, have > 0 ? 'a' : 'w');
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (signal.aborted) throw this.cancelled();
        hash.update(value);
        await out.write(value);
        onBytes(value.length, 'downloading');
      }
    } catch (e) {
      if (signal.aborted) throw this.cancelled();
      throw new Error(`The ${this.what} download stopped (${(e as Error).message}). Press Download again: it carries on where it stopped.`);
    } finally {
      await out.close();
    }
    return hash.digest('hex');
  }

  private async install(signal: AbortSignal, emit: (p: InstallProgress) => void): Promise<void> {
    const dir = this.dir();
    fs.mkdirSync(dir, { recursive: true });
    const marker = this.marker();
    const todo = this.files.filter((f) => !this.verified(marker, f));
    const total = todo.reduce((s, f) => s + f.bytes, 0);
    let base = 0;
    let last = 0;
    for (const f of todo) {
      const dest = this.file(f.name);
      const part = `${dest}.part`;
      let current = 0;
      let stage: InstallProgress['stage'] = 'verifying';
      const progress = (n: number, st: InstallProgress['stage']): void => {
        stage = st;
        current = Math.max(0, current + n);
        const now = Date.now();
        if (now - last > 150) {
          last = now;
          emit({ stage, done: base + Math.min(current, f.bytes), total });
        }
      };
      let digest = '';
      // A complete file already in place (the marker was lost): checked, not fetched again.
      if (sizeOf(dest) === f.bytes) {
        const h = createHash('sha256');
        await this.hashFile(dest, h, (n) => progress(n, 'verifying'), signal);
        digest = h.digest('hex');
        if (digest !== f.sha256) current = 0;
      }
      if (digest !== f.sha256) {
        digest = await this.download(f, part, progress, signal);
        if (digest !== f.sha256) {
          fs.rmSync(part, { force: true });
          throw new Error(`The downloaded ${this.what} is damaged (${f.name} failed its check). Try again.`);
        }
        fs.renameSync(part, dest);
      }
      marker[f.name] = { sha256: f.sha256, size: f.bytes, mtimeMs: fs.statSync(dest).mtimeMs };
      fs.writeFileSync(this.markerPath(), JSON.stringify(marker, null, 1));
      base += f.bytes;
      emit({ stage, done: base, total });
    }
    if (todo.length) logger.info(`[models] installed ${todo.length} file(s) into ${dir}`);
  }

  /** Installs what is missing (concurrent callers share one install). */
  async ensure(onProgress: (p: InstallProgress) => void): Promise<void> {
    this.listeners.add(onProgress);
    try {
      // Kept in a local: changed() sends IPC, and Electron runs pending promise callbacks inside that
      // call, so `running` may already have been cleared by the time it returns.
      let job = this.running;
      if (!job) {
        const current: NonNullable<typeof this.running> = { promise: Promise.resolve(), abort: new AbortController() };
        this.last = null;
        current.promise = this.install(current.abort.signal, (p) => {
          this.last = p;
          this.listeners.forEach((l) => l(p));
        }).finally(() => {
          if (this.running === current) this.running = null;
          this.changed();
        });
        this.running = job = current;
        this.changed();
      }
      await job.promise;
    } finally {
      this.listeners.delete(onProgress);
    }
  }

  /** Stops a running install; finished files stay and a partial one carries on next time. */
  cancel(): void {
    this.running?.abort.abort();
  }

  /** Deletes the model. Refused while it is downloading. */
  remove(): void {
    if (this.running) throw new Error(`The ${this.what} is still downloading. Cancel it first.`);
    fs.rmSync(this.dir(), { recursive: true, force: true });
    this.changed();
  }
}
