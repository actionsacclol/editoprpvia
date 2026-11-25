// Krypt Editor as a client of Krypt Marketo (the hub that runs the user's
// social accounts and uploads to YouTube), for handing a finished video over.
//
// Marketo serves MCP on a per-user pipe, the same way this app does
// (electron/mcp): its connection file says where the pipe is and holds the
// token, the first line on the pipe is a hello with that token, and after it
// the pipe carries newline-delimited JSON-RPC. This is what Marketo's own
// stdio bridge does; here the main process speaks it directly.
//
// Nothing in this file needs Electron, so the client is tested against a
// stand-in server (test/mcp.e2e.ts) and never against the user's real hub.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export interface MarketoStatus {
  /** Krypt Marketo has run on this computer and its program is still there (or it is running now). */
  installed: boolean;
  running: boolean;
  version?: string;
  /** Why it can't be used, in words for the user. */
  message?: string;
}

export interface MarketoResult {
  ok: boolean;
  text: string;
  images?: Array<{ data: string; mimeType: string }>;
}

export interface MarketoOptions {
  /** Marketo's connection file (default: in its user-data folder). */
  configPath?: string;
  /** How this app is named in Marketo's activity list. */
  client?: string;
  version?: string;
  /** How long to wait for Marketo to come up after starting it. */
  launchWaitMs?: number;
  log?: (message: string) => void;
}

interface Config {
  pipe: string;
  token: string;
  appExePath?: string | null;
  appArgs?: string[];
}

const NAME = 'Krypt Marketo';
const NOT_INSTALLED = `${NAME} is not installed on this computer (or has never been opened). It is the Krypt app that uploads videos to YouTube; get it from krypt.cc/tools, open it once, then try again.`;
const NOT_RUNNING = `${NAME} isn't running. Open ${NAME}, then try again.`;

/** Where Marketo keeps its connection file. */
export function marketoConfigPath(): string {
  const dir =
    process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), NAME)
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support', NAME)
        : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), NAME);
  return path.join(dir, 'mcp.json');
}

function readConfig(file: string): Config | null {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as Partial<Config>;
    return typeof j.pipe === 'string' && j.pipe && typeof j.token === 'string' && j.token ? (j as Config) : null;
  } catch {
    return null;
  }
}

type Json = Record<string, unknown>;

/** One authorised connection to the hub. */
class Session {
  private buf = '';
  private nextId = 1;
  private waiting = new Map<number, { resolve: (m: Json) => void; reject: (e: Error) => void }>();
  closed = false;
  version = '';

  private constructor(private sock: net.Socket) {}

  static open(cfg: Config, client: string): Promise<Session> {
    return new Promise((resolve, reject) => {
      const sock = net.connect(cfg.pipe);
      let buf = '';
      let done = false;
      const fail = (e: Error): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        sock.destroy();
        reject(e);
      };
      const timer = setTimeout(() => fail(new Error(`timed out waiting for ${NAME}`)), 5000);
      sock.once('error', fail);
      sock.on('connect', () => sock.write(`${JSON.stringify({ krypt: 'hello', token: cfg.token, client })}\n`));
      const onData = (chunk: Buffer): void => {
        buf += chunk.toString('utf8');
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        sock.removeListener('data', onData);
        let reply: { krypt?: string; message?: string; version?: string } | null = null;
        try {
          reply = JSON.parse(buf.slice(0, nl));
        } catch {
          /* handled below */
        }
        // A refusal is the hub's answer, not a reason to start a second copy of it.
        if (!reply || reply.krypt !== 'ok') return fail(new Refused(reply?.message || `${NAME} refused the connection.`));
        done = true;
        clearTimeout(timer);
        sock.removeListener('error', fail);
        const s = new Session(sock);
        s.version = String(reply.version ?? '');
        s.attach(buf.slice(nl + 1));
        resolve(s);
      };
      sock.on('data', onData);
    });
  }

  private attach(rest: string): void {
    this.buf = rest;
    const drain = (): void => {
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        let msg: Json;
        try {
          msg = JSON.parse(line) as Json;
        } catch {
          continue;
        }
        if (typeof msg.id === 'number' && (msg.result !== undefined || msg.error !== undefined)) {
          const w = this.waiting.get(msg.id);
          this.waiting.delete(msg.id);
          w?.resolve(msg);
        } else if (msg.id !== undefined && typeof msg.method === 'string') {
          // The hub asking this client something (a ping, say): there is nothing here to ask.
          this.sock.write(`${JSON.stringify(msg.method === 'ping' ? { jsonrpc: '2.0', id: msg.id, result: {} } : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Not supported.' } })}\n`);
        }
      }
    };
    drain();
    this.sock.on('data', (chunk: Buffer) => {
      this.buf += chunk.toString('utf8');
      drain();
    });
    const gone = (): void => {
      if (this.closed) return;
      this.closed = true;
      for (const w of this.waiting.values()) w.reject(new Error(`${NAME} closed while handling this. Try again.`));
      this.waiting.clear();
    };
    this.sock.on('close', gone);
    this.sock.on('error', gone);
  }

  request(method: string, params: Json, timeoutMs: number): Promise<Json> {
    if (this.closed) return Promise.reject(new Error(NOT_RUNNING));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`${NAME} did not answer in time.`));
      }, timeoutMs);
      this.waiting.set(id, {
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.sock.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method: string): void {
    if (!this.closed) this.sock.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  }

  end(): void {
    this.closed = true;
    this.sock.end();
  }
}

class Refused extends Error {}

export interface Marketo {
  /** Whether Krypt Marketo is on this computer, without connecting to it. */
  present(): boolean;
  status(): Promise<MarketoStatus>;
  /** Run one of the hub's tools. With launch, a closed hub is started first. */
  call(tool: string, args: unknown, opts?: { launch?: boolean; timeoutMs?: number }): Promise<MarketoResult>;
  close(): void;
}

export function createMarketo(o: MarketoOptions = {}): Marketo {
  const file = o.configPath ?? marketoConfigPath();
  const client = o.client ?? 'Krypt Editor';
  const log = o.log ?? (() => {});
  let session: Session | null = null;
  let opening: Promise<Session | null> | null = null;
  let refusal = '';

  const tryOnce = async (): Promise<Session | null> => {
    const cfg = readConfig(file);
    if (!cfg) return null;
    try {
      const s = await Session.open(cfg, client);
      const init = await s.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: client, version: o.version ?? '0' } }, 10_000);
      if (init.error) throw new Error(String((init.error as Json).message ?? 'initialize failed'));
      s.notify('notifications/initialized');
      return s;
    } catch (e) {
      if (e instanceof Refused) refusal = e.message;
      else log(`marketo: ${(e as Error).message}`);
      return null;
    }
  };

  const launch = (): boolean => {
    const cfg = readConfig(file);
    if (!cfg?.appExePath || !fs.existsSync(cfg.appExePath)) return false;
    try {
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE; // it must start as an app, not as Node
      const child = spawn(cfg.appExePath, [...(cfg.appArgs ?? []), `--launched-by-agent=${client}`], { detached: true, stdio: 'ignore', env, windowsHide: false });
      child.unref();
      return true;
    } catch (e) {
      log(`marketo: launch failed: ${(e as Error).message}`);
      return false;
    }
  };

  const connect = (start: boolean): Promise<Session | null> => {
    if (session && !session.closed) return Promise.resolve(session);
    if (opening) return opening;
    refusal = '';
    opening = (async () => {
      let s = await tryOnce();
      if (!s && !refusal && start && launch()) {
        const until = Date.now() + (o.launchWaitMs ?? 25_000);
        while (!s && !refusal && Date.now() < until) {
          await new Promise((r) => setTimeout(r, 500));
          s = await tryOnce();
        }
      }
      session = s;
      return s;
    })();
    return opening.finally(() => {
      opening = null;
    });
  };

  const installed = (): boolean => {
    const cfg = readConfig(file);
    return !!cfg && ((!!session && !session.closed) || (!!cfg.appExePath && fs.existsSync(cfg.appExePath)));
  };

  return {
    present: installed,

    async status() {
      if (!readConfig(file)) return { installed: false, running: false, message: NOT_INSTALLED };
      const s = await connect(false);
      if (s) return { installed: true, running: true, version: s.version };
      if (refusal) return { installed: true, running: true, message: refusal };
      return installed() ? { installed: true, running: false, message: NOT_RUNNING } : { installed: false, running: false, message: NOT_INSTALLED };
    },

    async call(tool, args, opts = {}) {
      if (!readConfig(file)) return { ok: false, text: NOT_INSTALLED };
      const s = await connect(opts.launch !== false);
      if (!s) return { ok: false, text: refusal || (installed() ? NOT_RUNNING : NOT_INSTALLED) };
      let reply: Json;
      try {
        reply = await s.request('tools/call', { name: tool, arguments: args ?? {} }, opts.timeoutMs ?? 15 * 60_000);
      } catch (e) {
        return { ok: false, text: (e as Error).message };
      }
      if (reply.error) return { ok: false, text: String((reply.error as Json).message ?? `${NAME} could not run ${tool}.`) };
      const result = (reply.result ?? {}) as { content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean };
      const content = Array.isArray(result.content) ? result.content : [];
      const images = content.flatMap((c) => (c.type === 'image' && typeof c.data === 'string' ? [{ data: c.data, mimeType: c.mimeType ?? 'image/png' }] : []));
      return {
        ok: result.isError !== true,
        text: content
          .flatMap((c) => (c.type === 'text' && typeof c.text === 'string' ? [c.text] : []))
          .join('\n')
          .trim(),
        ...(images.length ? { images } : {}),
      };
    },

    close() {
      session?.end();
      session = null;
    },
  };
}
