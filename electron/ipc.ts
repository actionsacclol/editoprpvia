import { app, BrowserWindow, clipboard, ipcMain, shell } from 'electron';
import type { ActionResult, AppState, MediaFile } from '../shared/types';
import * as store from './system/settings-store';
import * as files from './system/files';
import * as discord from './system/discord';
import { allowPaths } from './system/allowlist';
import { mediaUrl } from './system/mediaProtocol';
import { setStartWithWindows } from './system/autostart';
import * as kokoro from './system/kokoro';
import * as capture from './system/capture';
import * as pointer from './system/pointer';
import * as webCapture from './system/webCapture';
import * as images from './system/images';
import * as pictures from './system/pictures';
import type { PictureOrder } from '../shared/imageGen';
import * as channel from './system/channel';
import type { ImageQuery } from '../shared/imageSearch';
import * as agentCapture from './system/agentCapture';
import { cancelConvert, convertMedia, findFfmpeg } from './system/convert';
import type { CaptureInfo, WebOpenOptions, WebStep, WindowAsk, WindowStep } from '../shared/types';
import { createMarketo, marketoConfigPath } from './system/marketo';

// ──────────────────────────────────────────────────────────────────────
// IPC contract — every ipcMain.handle() in one file, mirrored in
// preload.ts. Wrappers return ActionResult and never throw across IPC (§4.3).
// ──────────────────────────────────────────────────────────────────────

const ok = <T>(data?: T, message?: string): ActionResult<T> => ({ ok: true, data, message });
const err = (message: string): ActionResult => ({ ok: false, message });

// Only web/mail links may leave the app — file:, ms-*:, and other protocol
// handlers launched via openExternal are an execution vector.
const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);
function safeOpenExternal(url: string): Promise<void> {
  try {
    if (EXTERNAL_SCHEMES.has(new URL(url).protocol)) return shell.openExternal(url);
  } catch {
    /* unparseable */
  }
  return Promise.resolve();
}

export interface IpcDeps {
  showMainWindow: () => BrowserWindow;
  /** Media the app was launched with; consumed (cleared) on first read. */
  takeLaunchFiles: () => MediaFile[];
}

export function registerIpc(deps: IpcDeps): void {
  // ───── App ──────────────────────────────────────────────────────
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('app:openExternal', (_e, url: string) => safeOpenExternal(url));
  ipcMain.handle('app:showItemInFolder', (_e, p: string) => shell.showItemInFolder(p));
  ipcMain.handle('app:getUserDataPath', () => app.getPath('userData'));
  ipcMain.handle('app:quit', () => app.quit());
  ipcMain.handle('app:minimize', () => {
    for (const w of BrowserWindow.getAllWindows()) w.minimize();
  });
  ipcMain.handle('app:copyText', (_e, text: string) => clipboard.writeText(text ?? ''));
  ipcMain.handle('app:pickDirectory', () => files.pickDirectory());

  // ───── Krypt Marketo (handing a finished video over for upload) ─
  // A development copy can be pointed at a stand-in hub; an installed one always talks to the user's own.
  const marketo = createMarketo({
    configPath: !app.isPackaged && process.env.KRYPT_MARKETO_MCP_CONFIG ? process.env.KRYPT_MARKETO_MCP_CONFIG : marketoConfigPath(),
    version: app.getVersion(),
    log: (m) => console.warn(m),
  });
  app.on('before-quit', () => marketo.close());
  ipcMain.handle('marketo:present', () => marketo.present());
  ipcMain.handle('marketo:status', () => marketo.status());
  ipcMain.handle('marketo:call', (_e, tool: string, args: unknown, launch: boolean) => marketo.call(String(tool), args, { launch: launch !== false }));

  // ───── State / settings ─────────────────────────────────────────
  ipcMain.handle('state:get', () => store.load());
  // Autostart, close-to-tray, start-minimized, and Discord presence are
  // always on (main.ts bootstrap) — state carries only real preferences.
  ipcMain.handle('state:update', (_e, patch: Partial<AppState>) => store.update(patch));
  ipcMain.handle('state:reset', () => store.reset());

  // ───── Media (local files loaded into the editor) ───────────────
  ipcMain.handle('media:pickFiles', async () => {
    try {
      return ok<MediaFile[]>(await files.pickMediaFiles());
    } catch (e) {
      return err((e as Error).message);
    }
  });
  ipcMain.handle('media:resolvePaths', (_e, paths: string[]) => {
    try {
      return ok<MediaFile[]>(files.resolveMediaFiles(Array.isArray(paths) ? paths : []));
    } catch (e) {
      return err((e as Error).message);
    }
  });
  ipcMain.handle('media:urlForPath', (_e, p: string) => mediaUrl(p));
  ipcMain.handle('media:converter', async () => {
    const ff = await findFfmpeg();
    return { available: ff !== null, path: ff?.path ?? null };
  });
  ipcMain.handle('media:convert', async (e, id: string, p: string, kind: 'video' | 'audio') => {
    try {
      if (typeof p !== 'string' || !files.isMediaFilePath(p)) return err('That file can no longer be found.');
      let last = -1;
      const out = await convertMedia(String(id), p, kind === 'audio' ? 'audio' : 'video', (fraction) => {
        // A few updates a second is plenty for a progress bar.
        const step = Math.floor(fraction * 200);
        if (step === last || e.sender.isDestroyed()) return;
        last = step;
        e.sender.send('media:convertProgress', { id, fraction });
      });
      const m = files.resolveMediaFile(out);
      return m ? ok<MediaFile>(m) : err('The converted file could not be read.');
    } catch (ex) {
      return err((ex as Error).message);
    }
  });
  ipcMain.handle('media:cancelConvert', (_e, id: string) => cancelConvert(String(id)));
  ipcMain.handle('media:proxyFind', (_e, p: string) => (typeof p === 'string' && files.isMediaFilePath(p) ? files.proxyFind(p) : null));
  ipcMain.handle('media:proxyBegin', (_e, p: string) => {
    try {
      if (typeof p !== 'string' || !files.isMediaFilePath(p)) return err('That file can no longer be found.');
      return ok<{ token: string; path: string }>(files.proxyBegin(p));
    } catch (e) {
      return err((e as Error).message);
    }
  });
  // Re-granting protocol access when a project reopens is limited to existing
  // files with media extensions — the renderer cannot allowlist arbitrary
  // paths for reading through krypteditor://.
  ipcMain.handle('media:allow', (_e, paths: string[]) =>
    allowPaths((Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && files.isMediaFilePath(p))),
  );
  ipcMain.handle('media:takeLaunchFiles', () => deps.takeLaunchFiles());
  ipcMain.handle('media:saveExport', async (_e, data: Uint8Array, suggestedName: string) => {
    try {
      return ok<string | null>(await files.saveExport(data, suggestedName));
    } catch (e) {
      return err((e as Error).message);
    }
  });
  ipcMain.handle('media:saveDerived', (_e, data: Uint8Array, name: string) => {
    try {
      const m = files.saveDerivedMedia(data, String(name));
      return m ? ok<MediaFile>(m) : err('Could not store the generated media.');
    } catch (e) {
      return err((e as Error).message);
    }
  });
  ipcMain.handle('media:pickLuts', async () => {
    try {
      return ok<Array<{ name: string; text: string }>>(await files.pickLutFiles());
    } catch (e) {
      return err((e as Error).message);
    }
  });
  ipcMain.handle('media:pickSlides', async () => {
    try {
      return ok<string[]>(await files.pickSlideFiles());
    } catch (e) {
      return err((e as Error).message);
    }
  });
  ipcMain.handle('media:readSlides', (_e, p: string) => {
    try {
      return ok<{ name: string; data: Uint8Array }>(files.readSlidesFile(String(p)));
    } catch (e) {
      return err((e as Error).message);
    }
  });
  ipcMain.handle('media:readLut', (_e, p: string) => {
    try {
      return ok<{ name: string; text: string }>(files.readLutFile(String(p)));
    } catch (e) {
      return err((e as Error).message);
    }
  });
  ipcMain.handle('media:exportBegin', async (_e, suggestedName: string) => {
    try {
      return ok<{ token: string; path: string } | null>(await files.exportBegin(String(suggestedName)));
    } catch (e) {
      return err((e as Error).message);
    }
  });
  ipcMain.handle('media:exportBeginAt', (_e, p: string, ext: string) => {
    try {
      return ok<{ token: string; path: string }>(files.exportBeginAt(String(p ?? ''), String(ext || 'mp4')));
    } catch (e) {
      return err((e as Error).message);
    }
  });
  ipcMain.handle('media:exportWrite', (_e, token: string, data: Uint8Array, position: number) => {
    try {
      files.exportWrite(String(token), data, Number(position));
      return ok();
    } catch (e) {
      return err((e as Error).message);
    }
  });
  ipcMain.handle('media:exportEnd', (_e, token: string, commit: boolean) => {
    try {
      return ok<string | null>(files.exportEnd(String(token), !!commit));
    } catch (e) {
      return err((e as Error).message);
    }
  });

  // ───── Recording (screen, camera, microphone) ───────────────────
  ipcMain.handle('capture:info', async () => {
    try {
      return ok<CaptureInfo>(await capture.captureInfo());
    } catch (e) {
      return err((e as Error).message);
    }
  });
  ipcMain.handle('capture:arm', (_e, id: string, audio: boolean) => capture.arm(String(id), !!audio));
  ipcMain.handle('capture:askAccess', (_e, kind: string) => capture.askAccess(kind === 'camera' ? 'camera' : 'microphone'));
  ipcMain.handle('capture:begin', () => {
    try {
      return ok<{ token: string; rawPath: string; base: string }>(files.recordingBegin());
    } catch (e) {
      return err((e as Error).message);
    }
  });
  ipcMain.handle('capture:setRecording', (e, on: boolean, hide: boolean) => capture.setRecording(BrowserWindow.fromWebContents(e.sender), !!on, !!hide));
  ipcMain.handle('capture:discard', (_e, p: string) => files.recordingDiscard(String(p)));
  // The pointer during a recording (for Product demo): see system/pointer.ts.
  // Web capture. Every call answers with a result rather than throwing, so the reason reaches the person or agent who asked.
  const tried = async <T>(work: () => T | Promise<T>): Promise<{ ok: boolean; data?: T; message?: string }> => {
    try {
      return { ok: true, data: await work() };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  };
  ipcMain.handle('web:open', (e, opts: WebOpenOptions) =>
    tried(() => {
      const n = (v: unknown, lo: number, hi: number, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);
      return webCapture.open(e.sender, { url: String(opts?.url ?? ''), width: n(opts?.width, 320, 1920, 1920), height: n(opts?.height, 320, 1920, 1080), pageWidth: n(opts?.pageWidth, 320, 1920, 1280), cursor: opts?.cursor !== false });
    }),
  );
  ipcMain.handle('web:look', () => tried(() => webCapture.look()));
  ipcMain.handle('web:run', (_e, steps: WebStep[], record: boolean, maxSeconds: number) => tried(() => webCapture.run(Array.isArray(steps) ? steps.slice(0, 100) : [], !!record, Math.min(300, Math.max(5, Number(maxSeconds) || 90)))));
  ipcMain.handle('web:save', (_e, data: Uint8Array, track: string) => tried(() => webCapture.save(data, typeof track === 'string' ? track : '')));
  ipcMain.handle('web:close', () => webCapture.close());

  // Pictures from the web. Ids go back and forth, never addresses: only what a search here returned can be downloaded.
  ipcMain.handle('images:search', (_e, q: ImageQuery) => tried(() => images.search(q && typeof q === 'object' ? q : {})));
  ipcMain.handle('images:thumb', (_e, id: string) => tried(() => images.thumb(String(id))));
  ipcMain.handle('images:save', (_e, ids: string[]) => tried(() => images.save(Array.isArray(ids) ? ids.map(String) : [])));

  // ───── Pictures from words (a service with the user's key, or this computer) ─────
  ipcMain.handle('pictures:setup', () => pictures.setup());
  ipcMain.handle('pictures:configure', (_e, patch: unknown) => tried(() => pictures.configure({ ...pictures.settings(), ...(patch && typeof patch === 'object' ? patch : {}) })));
  ipcMain.handle('pictures:setKey', (_e, id: string, key: string) => tried(() => pictures.setKey(String(id), typeof key === 'string' ? key : '')));
  ipcMain.handle('pictures:generate', (_e, order: PictureOrder) => tried(() => pictures.generate(order)));
  ipcMain.handle('pictures:cancel', () => pictures.cancel());
  ipcMain.handle('pictures:keepDrawing', (_e, data: Uint8Array, svg: string, name: string) =>
    tried(() => {
      if (!(data instanceof Uint8Array)) throw new Error('No drawing was handed over.');
      return pictures.keepDrawing(data, String(svg ?? ''), String(name ?? ''));
    }),
  );
  ipcMain.handle('pictures:drawingSource', (_e, filePath: string) => tried(() => pictures.drawingSource(String(filePath ?? ''))));
  ipcMain.handle('pictures:keep', (_e, data: Uint8Array, subject: string, prompt: string, model: string) =>
    tried(() => {
      if (!(data instanceof Uint8Array)) throw new Error('No picture was handed over.');
      return pictures.keep(data, String(subject ?? ''), String(prompt ?? ''), String(model));
    }),
  );
  ipcMain.handle('pictures:localStatus', () => pictures.localStatus());
  ipcMain.handle('pictures:localEnsure', (e, id: string) =>
    tried(() =>
      pictures.localEnsure(id, (progress) => {
        if (!e.sender.isDestroyed()) e.sender.send('pictures:localProgress', { id, progress });
      }),
    ),
  );
  ipcMain.handle('pictures:localOpen', (_e, id: string) => tried(() => pictures.localOpen(id)));
  ipcMain.handle('pictures:localCancel', (_e, id: string) => {
    try {
      pictures.localCancel(id);
    } catch {
      /* an unknown model has nothing to cancel */
    }
  });
  ipcMain.handle('pictures:localRemove', (_e, id: string) => tried(() => pictures.localRemove(id)));
  pictures.onLocalChange(() => {
    const list = pictures.localStatus();
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('pictures:localState', list);
  });

  // A YouTube channel as an example (its public feed), and the thumbnails the editor draws.
  ipcMain.handle('channel:read', (_e, link: string) => tried(() => channel.read(String(link ?? '').slice(0, 400))));
  ipcMain.handle('channel:thumb', (_e, id: string) => tried(() => channel.thumb(String(id))));
  ipcMain.handle('thumbnails:save', (_e, data: Uint8Array, name: string) => tried(async () => channel.saveThumbnail(data, String(name ?? ''))));

  // Another app's window, for an agent: asked for here, answered by the person.
  ipcMain.handle('capture:agentWindow', (e, ask: WindowAsk) => tried(() => agentCapture.request(BrowserWindow.fromWebContents(e.sender), ask)));
  ipcMain.handle('capture:agentShot', (_e, id: string) => tried(() => agentCapture.shot(String(id))));
  ipcMain.handle('capture:agentInput', (_e, id: string, steps: WindowStep[]) => tried(() => agentCapture.input(String(id), Array.isArray(steps) ? steps.slice(0, 60) : [])));
  ipcMain.handle('capture:agentCancel', () => agentCapture.cancel());

  ipcMain.handle('capture:pointerPrepare', (_e, id: string) => pointer.prepare(String(id)));
  ipcMain.handle('capture:pointerMark', () => pointer.mark());
  ipcMain.handle('capture:pointerPause', (_e, on: boolean) => pointer.pause(!!on));
  ipcMain.handle('capture:pointerFinish', (_e, p: string | null) => pointer.finish(typeof p === 'string' && p ? p : null));
  ipcMain.handle('media:pointer', (_e, p: string) => pointer.read(String(p)));

  // ───── Voice-over (on-device Kokoro speech) ──────────────────────
  ipcMain.handle('tts:kokoroStatus', () => kokoro.status());
  ipcMain.handle('tts:kokoroEnsure', async (e) => {
    try {
      return ok<kokoro.KokoroUrls>(
        await kokoro.ensure((p) => {
          if (!e.sender.isDestroyed()) e.sender.send('tts:kokoroProgress', p);
        }),
      );
    } catch (x) {
      return err((x as Error).message);
    }
  });
  ipcMain.handle('tts:kokoroCancel', () => kokoro.cancel());
  ipcMain.handle('tts:kokoroRemove', () => {
    try {
      kokoro.remove();
      return ok();
    } catch (x) {
      return err((x as Error).message);
    }
  });
  kokoro.onChange(() => {
    const st = kokoro.status();
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('tts:kokoroState', st);
  });

  // ───── Projects (.krypt) ─────────────────────────────────────────
  ipcMain.handle('project:save', async (_e, json: string, suggestedName: string) => {
    try {
      return ok<string | null>(await files.saveProject(json, suggestedName));
    } catch (e) {
      return err((e as Error).message);
    }
  });
  ipcMain.handle('project:open', async () => {
    try {
      return ok<{ path: string; json: string } | null>(await files.openProject());
    } catch (e) {
      return err((e as Error).message);
    }
  });
  ipcMain.handle('project:saveToPath', (_e, json: string, p: string) => {
    try {
      return ok<string>(files.saveProjectToPath(json, p));
    } catch (e) {
      return err((e as Error).message);
    }
  });
  ipcMain.handle('project:saveAs', (_e, json: string, p: string, name: string) => {
    try {
      return ok<string>(files.saveProjectAs(json, String(p ?? ''), String(name ?? 'project')));
    } catch (e) {
      return err((e as Error).message);
    }
  });
  ipcMain.handle('project:openPath', (_e, p: string) => {
    try {
      return ok<{ path: string; json: string } | null>(files.openProjectPath(p));
    } catch (e) {
      return err((e as Error).message);
    }
  });
  ipcMain.handle('project:autosaveWrite', (_e, json: string) => files.autosaveWrite(json));
  ipcMain.handle('project:autosaveRead', () => files.autosaveRead());
}

export type { AppState };
