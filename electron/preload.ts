import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { ActionResult, AppState, CaptureInfo, KokoroStatus, KryptApi, MediaFile, MarketoStatus, McpClientSnippet, McpStatus, McpToolCall, McpToolResult } from '../shared/types';

// ──────────────────────────────────────────────────────────────────────
// preload — the only seam between renderer and main. Every method here MUST
// have a matching ipcMain.handle() in electron/ipc.ts (the channel-name
// strings are the contract; a typo breaks the build, not runtime).
// ──────────────────────────────────────────────────────────────────────

function sub<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: unknown, payload: T): void => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const krypt: KryptApi = {
  channel: {
    read: (link) => ipcRenderer.invoke('channel:read', link),
    thumb: (id) => ipcRenderer.invoke('channel:thumb', id),
  },
  thumbnails: {
    save: (data, name) => ipcRenderer.invoke('thumbnails:save', data, name),
  },
  pictures: {
    setup: () => ipcRenderer.invoke('pictures:setup'),
    configure: (patch) => ipcRenderer.invoke('pictures:configure', patch),
    setKey: (id, key) => ipcRenderer.invoke('pictures:setKey', id, key),
    generate: (order) => ipcRenderer.invoke('pictures:generate', order),
    cancel: () => ipcRenderer.invoke('pictures:cancel'),
    keep: (data, subject, prompt, model) => ipcRenderer.invoke('pictures:keep', data, subject, prompt, model),
    keepDrawing: (data, svg, name) => ipcRenderer.invoke('pictures:keepDrawing', data, svg, name),
    drawingSource: (filePath) => ipcRenderer.invoke('pictures:drawingSource', filePath),
    localStatus: () => ipcRenderer.invoke('pictures:localStatus'),
    localEnsure: (id) => ipcRenderer.invoke('pictures:localEnsure', id),
    localOpen: (id) => ipcRenderer.invoke('pictures:localOpen', id),
    localCancel: (id) => ipcRenderer.invoke('pictures:localCancel', id),
    localRemove: (id) => ipcRenderer.invoke('pictures:localRemove', id),
    onLocalProgress: (cb) => sub('pictures:localProgress', cb),
    onLocalState: (cb) => sub('pictures:localState', cb),
  },
  images: {
    search: (q) => ipcRenderer.invoke('images:search', q),
    thumb: (id) => ipcRenderer.invoke('images:thumb', id),
    save: (ids) => ipcRenderer.invoke('images:save', ids),
  },
  web: {
    open: (opts) => ipcRenderer.invoke('web:open', opts),
    look: () => ipcRenderer.invoke('web:look'),
    run: (steps, record, maxSeconds) => ipcRenderer.invoke('web:run', steps, record, maxSeconds),
    save: (data, pointer) => ipcRenderer.invoke('web:save', data, pointer),
    close: () => ipcRenderer.invoke('web:close') as Promise<void>,
    onFrame: (cb) => sub<{ t: number; jpeg: Uint8Array }>('web:frame', cb),
  },
  capture: {
    info: () => ipcRenderer.invoke('capture:info') as Promise<ActionResult<CaptureInfo>>,
    arm: (sourceId: string, systemAudio: boolean) => ipcRenderer.invoke('capture:arm', sourceId, systemAudio) as Promise<void>,
    askAccess: (kind) => ipcRenderer.invoke('capture:askAccess', kind) as Promise<boolean>,
    begin: () => ipcRenderer.invoke('capture:begin') as Promise<ActionResult<{ token: string; rawPath: string; base: string }>>,
    setRecording: (on: boolean, hide: boolean) => ipcRenderer.invoke('capture:setRecording', on, hide) as Promise<void>,
    discard: (rawPath: string) => ipcRenderer.invoke('capture:discard', rawPath) as Promise<void>,
    pointerPrepare: (sourceId: string) => ipcRenderer.invoke('capture:pointerPrepare', sourceId) as Promise<void>,
    pointerMark: () => ipcRenderer.invoke('capture:pointerMark') as Promise<void>,
    pointerPause: (on: boolean) => ipcRenderer.invoke('capture:pointerPause', on) as Promise<void>,
    pointerFinish: (videoPath: string | null) => ipcRenderer.invoke('capture:pointerFinish', videoPath) as Promise<{ moves: number; clicks: number } | null>,
    agentWindow: (ask) => ipcRenderer.invoke('capture:agentWindow', ask),
    agentShot: (sourceId) => ipcRenderer.invoke('capture:agentShot', sourceId),
    agentInput: (sourceId, steps) => ipcRenderer.invoke('capture:agentInput', sourceId, steps),
    agentCancel: () => ipcRenderer.invoke('capture:agentCancel') as Promise<void>,
    onStopRequested: (cb) => sub<void>('capture:stopRequested', () => cb()),
  },
  app: {
    version: () => ipcRenderer.invoke('app:version'),
    openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
    showItemInFolder: (p) => ipcRenderer.invoke('app:showItemInFolder', p),
    getUserDataPath: () => ipcRenderer.invoke('app:getUserDataPath'),
    quit: () => ipcRenderer.invoke('app:quit'),
    minimize: () => ipcRenderer.invoke('app:minimize'),
    copyText: (text) => ipcRenderer.invoke('app:copyText', text) as Promise<void>,
    pickDirectory: () => ipcRenderer.invoke('app:pickDirectory') as Promise<string | null>,
    onStateChanged: (cb) => sub<AppState>('state:changed', cb),
  },
  state: {
    get: () => ipcRenderer.invoke('state:get') as Promise<AppState>,
    update: (patch) => ipcRenderer.invoke('state:update', patch) as Promise<AppState>,
    reset: () => ipcRenderer.invoke('state:reset') as Promise<AppState>,
  },
  media: {
    pickFiles: () => ipcRenderer.invoke('media:pickFiles') as Promise<ActionResult<MediaFile[]>>,
    resolvePaths: (paths: string[]) =>
      ipcRenderer.invoke('media:resolvePaths', paths) as Promise<ActionResult<MediaFile[]>>,
    urlForPath: (p: string) => ipcRenderer.invoke('media:urlForPath', p) as Promise<string>,
    converter: () => ipcRenderer.invoke('media:converter') as Promise<{ available: boolean; path: string | null }>,
    convert: (id: string, p: string, kind: 'video' | 'audio') =>
      ipcRenderer.invoke('media:convert', id, p, kind) as Promise<ActionResult<MediaFile>>,
    cancelConvert: (id: string) => ipcRenderer.invoke('media:cancelConvert', id) as Promise<void>,
    onConvertProgress: (cb) => sub<{ id: string; fraction: number }>('media:convertProgress', cb),
    proxyFind: (p: string) => ipcRenderer.invoke('media:proxyFind', p) as Promise<MediaFile | null>,
    proxyBegin: (p: string) => ipcRenderer.invoke('media:proxyBegin', p) as Promise<ActionResult<{ token: string; path: string }>>,
    // Sync, renderer-side: turn a dropped File into its absolute path. No IPC
    // round-trip — webUtils runs in the preload context.
    pathForFile: (file: File): string => {
      try {
        return webUtils.getPathForFile(file);
      } catch {
        return '';
      }
    },
    takeLaunchFiles: () => ipcRenderer.invoke('media:takeLaunchFiles') as Promise<MediaFile[]>,
    onOpened: (cb) => sub<MediaFile[]>('media:opened', cb),
    saveExport: (data: Uint8Array, suggestedName: string) =>
      ipcRenderer.invoke('media:saveExport', data, suggestedName) as Promise<ActionResult<string | null>>,
    readLut: (p: string) => ipcRenderer.invoke('media:readLut', p) as Promise<ActionResult<{ name: string; text: string }>>,
    pickSlides: () => ipcRenderer.invoke('media:pickSlides') as Promise<ActionResult<string[]>>,
    readSlides: (p: string) => ipcRenderer.invoke('media:readSlides', p) as Promise<ActionResult<{ name: string; data: Uint8Array }>>,
    pickLuts: () => ipcRenderer.invoke('media:pickLuts') as Promise<ActionResult<Array<{ name: string; text: string }>>>,
    saveDerived: (data: Uint8Array, name: string) => ipcRenderer.invoke('media:saveDerived', data, name) as Promise<ActionResult<MediaFile>>,
    pointer: (filePath: string) => ipcRenderer.invoke('media:pointer', filePath) as Promise<string | null>,
    exportBegin: (suggestedName: string) =>
      ipcRenderer.invoke('media:exportBegin', suggestedName) as Promise<ActionResult<{ token: string; path: string } | null>>,
    exportBeginAt: (p: string, ext: string) =>
      ipcRenderer.invoke('media:exportBeginAt', p, ext) as Promise<ActionResult<{ token: string; path: string }>>,
    exportWrite: (token: string, data: Uint8Array, position: number) =>
      ipcRenderer.invoke('media:exportWrite', token, data, position) as Promise<ActionResult>,
    exportEnd: (token: string, commit: boolean) =>
      ipcRenderer.invoke('media:exportEnd', token, commit) as Promise<ActionResult<string | null>>,
    allow: (paths: string[]) => ipcRenderer.invoke('media:allow', paths) as Promise<void>,
  },
  project: {
    save: (json: string, suggestedName: string) =>
      ipcRenderer.invoke('project:save', json, suggestedName) as Promise<ActionResult<string | null>>,
    open: () => ipcRenderer.invoke('project:open') as Promise<ActionResult<{ path: string; json: string } | null>>,
    saveToPath: (json: string, p: string) => ipcRenderer.invoke('project:saveToPath', json, p) as Promise<ActionResult<string>>,
    saveAs: (json: string, p: string, name: string) => ipcRenderer.invoke('project:saveAs', json, p, name) as Promise<ActionResult<string>>,
    openPath: (p: string) => ipcRenderer.invoke('project:openPath', p) as Promise<ActionResult<{ path: string; json: string } | null>>,
    autosaveWrite: (json: string) => ipcRenderer.invoke('project:autosaveWrite', json) as Promise<void>,
    autosaveRead: () => ipcRenderer.invoke('project:autosaveRead') as Promise<string | null>,
  },
  tts: {
    kokoroStatus: () => ipcRenderer.invoke('tts:kokoroStatus') as Promise<KokoroStatus>,
    kokoroEnsure: () => ipcRenderer.invoke('tts:kokoroEnsure') as Promise<ActionResult<{ model: string; voices: Record<string, string> }>>,
    kokoroCancel: () => ipcRenderer.invoke('tts:kokoroCancel') as Promise<void>,
    kokoroRemove: () => ipcRenderer.invoke('tts:kokoroRemove') as Promise<ActionResult>,
    onKokoroProgress: (cb) => sub('tts:kokoroProgress', cb),
    onKokoroState: (cb) => sub('tts:kokoroState', cb),
  },
  marketo: {
    present: () => ipcRenderer.invoke('marketo:present') as Promise<boolean>,
    status: () => ipcRenderer.invoke('marketo:status') as Promise<MarketoStatus>,
    call: (tool: string, args: unknown, launch = true) => ipcRenderer.invoke('marketo:call', tool, args, launch) as Promise<McpToolResult>,
  },
  mcp: {
    status: () => ipcRenderer.invoke('mcp:status') as Promise<McpStatus>,
    onStatus: (cb) => sub<McpStatus>('mcp:status', cb),
    setEnabled: (on: boolean) => ipcRenderer.invoke('mcp:setEnabled', on) as Promise<McpStatus>,
    snippets: () => ipcRenderer.invoke('mcp:snippets') as Promise<McpClientSnippet[]>,
    install: (client: string, opts?: { allowAll?: boolean }) => ipcRenderer.invoke('mcp:install', client, opts ?? {}) as Promise<ActionResult>,
    serve: (run) => {
      const cancels = new Map<number, Array<() => void>>();
      const onCall = (_e: unknown, call: McpToolCall): void => {
        cancels.set(call.rid, []);
        const progress = (fraction: number, message: string): void => ipcRenderer.send('mcp:progress', call.rid, fraction, message);
        const whenCancelled = (cb: () => void): void => void cancels.get(call.rid)?.push(cb);
        void run(call, progress, whenCancelled)
          .catch((e: unknown) => ({ ok: false, text: (e as Error)?.message ?? String(e) }))
          .then((result) => {
            cancels.delete(call.rid);
            ipcRenderer.send('mcp:result', call.rid, result);
          });
      };
      const onCancel = (_e: unknown, rid: number): void => cancels.get(rid)?.forEach((cb) => cb());
      ipcRenderer.on('mcp:call', onCall);
      ipcRenderer.on('mcp:cancel', onCancel);
      ipcRenderer.send('mcp:ready', true);
      return () => {
        ipcRenderer.removeListener('mcp:call', onCall);
        ipcRenderer.removeListener('mcp:cancel', onCancel);
        ipcRenderer.send('mcp:ready', false);
      };
    },
  },
  log: {
    onAppend: (cb) => sub<{ level: 'info' | 'warn' | 'error'; message: string; ts: string }>('log:append', cb),
  },
};

contextBridge.exposeInMainWorld('krypt', krypt);
