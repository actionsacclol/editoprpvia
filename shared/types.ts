// ──────────────────────────────────────────────────────────────────────
// Krypt Editor — the single shared contract between main and renderer.
//
// Everything the preload exposes on window.krypt is typed by KryptApi at
// the bottom. Every main-side wrapper returns ActionResult<T> and never
// throws across IPC (kryptguidelines.md §4.3).
// ──────────────────────────────────────────────────────────────────────

import type { ImageQuery, ImageSearchResult, SavedImage } from './imageSearch';
import type { ChannelFeed } from './channelStudy';
import type { LocalPictureFiles, LocalPictureModelId, LocalPictureStatus, MadePicture, PictureOrder, PictureProviderId, PictureSettings, PictureSetup } from './imageGen';

export interface ActionResult<T = void> {
  ok: boolean;
  message?: string;
  data?: T;
}

// ── Media (local files loaded into the editor) ──────────────────────────

/** What an imported media item actually is. */
export type MediaKind = 'video' | 'audio' | 'image';

/** A media file the user opened, ready to drop on the timeline. */
export interface MediaFile {
  /** Stable id for this import (within the session). */
  id: string;
  /** Display name (basename). */
  name: string;
  /** Absolute path on disk. */
  filePath: string;
  kind: MediaKind;
  /** Byte size on disk. */
  sizeBytes: number;
  /** krypteditor://media/<encoded-path> — streams the file to the renderer. */
  mediaUrl: string;
  /** A format the editor can't read itself: it has to be converted before use. Never saved. */
  needsConvert?: boolean;
  /**
   * Set when `filePath` is a converted working copy in the media cache: the
   * file the user actually imported. Lets a project make the copy again if the
   * cache was emptied.
   */
  sourcePath?: string;
  /** A picture found on the web (Find pictures): the line that credits it, from the <name>.credit.json next to it. */
  credit?: string;
}

// ── Persisted app state ────────────────────────────────────────────────

export interface AppState {
  schemaVersion: number;
  /** Folder media imports / exports default to. null = userData/Projects. */
  workingDirectory: string | null;
  /** Most-recently opened/saved .krypt project paths (newest first). */
  recentProjects: string[];
  /** AI agents (MCP clients) may edit the open project. */
  agentAccess: boolean;
  /** Pictures from words: the chosen service, models and limits. Never a key. */
  pictures: PictureSettings;
}

// ── AI agents (MCP) ────────────────────────────────────────────────────
export interface McpClientInfo {
  id: number;
  name: string;
  since: number;
  calls: number;
}

export interface McpActivity {
  id: string;
  ts: number;
  client: string;
  tool: string;
  args: string;
  state: 'running' | 'ok' | 'error';
  ms: number;
  result: string;
}

export interface McpStatus {
  enabled: boolean;
  listening: boolean;
  error: string | null;
  clients: McpClientInfo[];
  activity: McpActivity[];
  shimPath: string | null;
  exePath: string;
  toolCount: number;
}

export interface McpClientSnippet {
  id: string;
  label: string;
  description: string;
  snippet: string;
  installable: boolean;
}

/** A tool call the main process hands the renderer to execute. */
export interface MarketoStatus {
  /** Krypt Marketo is on this computer. */
  installed: boolean;
  running: boolean;
  version?: string;
  /** Why it can't be used right now, in words for the user. */
  message?: string;
}

export interface McpToolCall {
  rid: number;
  tool: string;
  args: unknown;
  client: string;
}

export interface McpToolResult {
  ok: boolean;
  text: string;
  images?: Array<{ data: string; mimeType: string }>;
}

// ── The preload surface (window.krypt.*) ───────────────────────────────

export interface KokoroProgress {
  stage: 'copying' | 'downloading' | 'verifying';
  done: number;
  total: number;
}

export interface KokoroStatus {
  installed: boolean;
  downloadBytes: number;
  totalBytes: number;
  installing: boolean;
  progress: KokoroProgress | null;
}

// ── Recording (screen, camera, microphone) ─────────────────────────────

/** A screen or window that can be recorded. */
export interface CaptureSource {
  id: string;
  name: string;
  kind: 'screen' | 'window';
  /** A small JPEG data URL, or '' when the system gave none. */
  thumbnail: string;
}

export interface CaptureInfo {
  sources: CaptureSource[];
  /** Whether this system can record what the computer plays (Windows). */
  systemAudio: boolean;
  /** Where recordings are stored. */
  folder: string;
  /** Free space on that drive, or null when it can't be read. */
  freeBytes: number | null;
  /** The keys that stop a recording from anywhere, as shown to the user. */
  stopShortcut: string;
  /** Recordings cut short by a crash or a forced quit, newest first; they can be recovered. */
  unfinished: Array<{ path: string; modified: number; bytes: number }>;
}

/** What an agent asks for when it wants another app's window (electron/system/agentCapture.ts). The person is asked first. */
export interface WindowAsk {
  /** The window's title, or a distinctive part of it. */
  window: string;
  /** An installed app to open first, by its menu name. */
  launch?: string;
  seconds: number;
  /** It will also click and type in the window. */
  control: boolean;
  /** How many steps, for the prompt. */
  steps: number;
  /** What the steps are, in words, for the prompt: the person sees what will be typed before saying yes. */
  plan?: string;
  /** false = one picture, no recording. */
  record: boolean;
}

/** One thing done in another app's window. x, y are 0..1 across and down the window. */
export interface WindowStep {
  do: 'click' | 'move' | 'type' | 'press' | 'scroll' | 'wait';
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  /** scroll: about 100 per notch of the wheel, negative = up. */
  by?: number;
  seconds?: number;
}

/** One thing a web capture does on the page (electron/system/webCapture.ts). */
export interface WebStep {
  do: 'click' | 'hover' | 'type' | 'press' | 'scroll' | 'wait' | 'goto';
  /** What to act on: the words a person reads on it ("Pricing", "Search"), or css=<selector>. */
  target?: string;
  /** Or a point of the page as shown, 0..1 across and down. */
  x?: number;
  y?: number;
  /** type: the text. */
  text?: string;
  /** press: Enter, Tab, Escape, Down… or one character. */
  key?: string;
  /** scroll: pixels down the page (negative = up). */
  by?: number;
  /** wait: how long; with a target, how long at most for it to appear. */
  seconds?: number;
  /** goto: the address. */
  url?: string;
}

export interface WebOpenOptions {
  url: string;
  /** The picture's size in pixels. */
  width: number;
  height: number;
  /** How wide the page believes its window is (CSS pixels): 1280 lays out a desktop site, 430 a phone one. */
  pageWidth: number;
  /** Draw a pointer into the page. */
  cursor: boolean;
}

export interface WebLook {
  title: string;
  url: string;
  /** The page as shown, a JPEG in base64. */
  image: string;
  /** What can be clicked or typed into, with where it is (0..1 of the picture). */
  elements: Array<{ text: string; kind: string; x: number; y: number }>;
  scrollY: number;
  pageHeight: number;
  viewHeight: number;
  /** How wide the page believes its window is, in CSS pixels. */
  viewWidth: number;
  /** The size frames are painted at, in pixels. */
  painted: { w: number; h: number };
}

export interface WebRunResult {
  duration: number;
  /** A pointer track, as pointer.ts writes it: [t, x, y] and [t, x, y, button]. */
  moves: Array<[number, number, number]>;
  clicks: Array<[number, number, number, number]>;
  /** One line per step done. */
  log: string[];
  /** Why it stopped early, when it did. */
  failed?: string;
}

export interface KryptApi {
  /** Pictures from the web for a video (electron/system/images.ts). */
  channel: {
    /** A YouTube channel's newest uploads (its public feed), from a channel link, an @handle or a video link. */
    read: (link: string) => Promise<ActionResult<ChannelFeed>>;
    /** A listed video's thumbnail, small, as a data: address. */
    thumb: (videoId: string) => Promise<ActionResult<string>>;
  };
  thumbnails: {
    /** Keep a drawn thumbnail (JPEG or PNG bytes) in the Thumbnails folder; returns its path. */
    save: (data: Uint8Array, name: string) => Promise<ActionResult<string>>;
  };
  images: {
    /** Look for pictures: words (Wikimedia Commons, Openverse) or a Pinterest board, profile or pin link. */
    search: (q: ImageQuery) => Promise<ActionResult<ImageSearchResult>>;
    /** A small copy of a found picture, as a data: address. */
    thumb: (id: string) => Promise<ActionResult<string>>;
    /** Download found pictures into the Images folder, each with its credit next to it. */
    save: (ids: string[]) => Promise<ActionResult<{ saved: SavedImage[]; failed: Array<{ id: string; message: string }> }>>;
  };
  /** Pictures from words: a service with the user's own key, or a model on this computer. */
  pictures: {
    setup: () => Promise<PictureSetup>;
    /** Change the chosen source, quality, models, address or daily limit. */
    configure: (patch: Partial<PictureSettings>) => Promise<ActionResult<PictureSetup>>;
    /** Keep the key for a service (empty forgets it). It is never handed back. */
    setKey: (id: PictureProviderId, key: string) => Promise<ActionResult<PictureSetup>>;
    /** Order one picture from a service; it is kept in the Images folder. */
    generate: (order: PictureOrder) => Promise<ActionResult<MadePicture>>;
    /** Stop the orders in flight. */
    cancel: () => Promise<void>;
    /** Keep a picture made on this computer (JPEG or PNG bytes) in the Images folder. */
    keep: (data: Uint8Array, subject: string, prompt: string, model: LocalPictureModelId) => Promise<ActionResult<MadePicture>>;
    /** Keeps a drawing (a PNG the page made from SVG) with its SVG beside it. */
    keepDrawing: (data: Uint8Array, svg: string, name: string) => Promise<ActionResult<{ path: string }>>;
    /** The SVG a kept drawing was made from, or null when the file is not a drawing. */
    drawingSource: (filePath: string) => Promise<ActionResult<string | null>>;
    localStatus: () => Promise<LocalPictureStatus[]>;
    /** Download a model for this computer if needed; resolves with where its files are read from. */
    localEnsure: (id: LocalPictureModelId) => Promise<ActionResult<LocalPictureFiles>>;
    /** Where an installed model is read from. Nothing is downloaded. */
    localOpen: (id: LocalPictureModelId) => Promise<ActionResult<LocalPictureFiles>>;
    localCancel: (id: LocalPictureModelId) => Promise<void>;
    localRemove: (id: LocalPictureModelId) => Promise<ActionResult>;
    onLocalProgress: (cb: (p: { id: LocalPictureModelId; progress: NonNullable<LocalPictureStatus['progress']> }) => void) => () => void;
    onLocalState: (cb: (list: LocalPictureStatus[]) => void) => () => void;
  };
  /** Web capture: a page in a window of its own, walked through and filmed. */
  web: {
    open: (opts: WebOpenOptions) => Promise<ActionResult<{ title: string; url: string }>>;
    look: () => Promise<ActionResult<WebLook>>;
    run: (steps: WebStep[], record: boolean, maxSeconds: number) => Promise<ActionResult<WebRunResult>>;
    /** Keep the encoded video in the Recordings folder with its pointer track (JSON text) next to it. */
    save: (data: Uint8Array, pointer: string) => Promise<ActionResult<{ path: string }>>;
    close: () => Promise<void>;
    /** A frame of the page being filmed: seconds since the run began, and a JPEG. */
    onFrame: (cb: (frame: { t: number; jpeg: Uint8Array }) => void) => () => void;
  };
  capture: {
    /** Screens and windows on offer, plus where recordings go. */
    info: () => Promise<ActionResult<CaptureInfo>>;
    /** Choose what the next getDisplayMedia call records. */
    arm: (sourceId: string, systemAudio: boolean) => Promise<void>;
    /** macOS asks before the microphone or camera opens; elsewhere this is always true. */
    askAccess: (kind: 'microphone' | 'camera') => Promise<boolean>;
    /** Open the file a recording streams into (written with media.exportWrite, closed with media.exportEnd). */
    begin: () => Promise<ActionResult<{ token: string; rawPath: string; base: string }>>;
    /** Recording started or ended: the stop shortcut, the tray entry, and hiding or showing the window. */
    setRecording: (on: boolean, hide: boolean) => Promise<void>;
    /** Delete the streamed file once its tracks are saved as finished files. */
    discard: (rawPath: string) => Promise<void>;
    /** Follow the pointer over the screen or window about to be recorded (for Product demo). */
    pointerPrepare: (sourceId: string) => Promise<void>;
    /** The recording starts now: pointer times count from here. */
    pointerMark: () => Promise<void>;
    pointerPause: (on: boolean) => Promise<void>;
    /** Stop following; with the recorded screen file's path the track is saved next to it, with null it is dropped. */
    pointerFinish: (videoPath: string | null) => Promise<{ moves: number; clicks: number } | null>;
    /** An agent wants a window: find it and ask the person. Fails with the reason when there is none or they say no. */
    agentWindow: (ask: WindowAsk) => Promise<ActionResult<{ sourceId: string; name: string; launched: boolean }>>;
    /** One picture of a window that was allowed. */
    agentShot: (sourceId: string) => Promise<ActionResult<{ image: string; width: number; height: number; name: string }>>;
    /** Click and type in a window that was allowed for it. */
    agentInput: (sourceId: string, steps: WindowStep[]) => Promise<ActionResult<{ log: string[]; failed?: string }>>;
    agentCancel: () => Promise<void>;
    /** The stop shortcut or the tray's Stop recording was used. */
    onStopRequested: (cb: () => void) => () => void;
  };
  app: {
    version: () => Promise<string>;
    openExternal: (url: string) => Promise<void>;
    showItemInFolder: (path: string) => Promise<void>;
    getUserDataPath: () => Promise<string>;
    quit: () => Promise<void>;
    minimize: () => Promise<void>;
    copyText: (text: string) => Promise<void>;
    pickDirectory: () => Promise<string | null>;
    onStateChanged: (cb: (state: AppState) => void) => () => void;
  };
  state: {
    get: () => Promise<AppState>;
    update: (patch: Partial<AppState>) => Promise<AppState>;
    reset: () => Promise<AppState>;
  };
  media: {
    /** Open a file picker for media; returns the chosen, resolved files. */
    pickFiles: () => Promise<ActionResult<MediaFile[]>>;
    /** Resolve arbitrary absolute paths (e.g. drag-and-drop) into MediaFiles. */
    resolvePaths: (paths: string[]) => Promise<ActionResult<MediaFile[]>>;
    /** Build the krypteditor:// stream URL for an absolute path. */
    urlForPath: (path: string) => Promise<string>;
    /** Whether an FFmpeg was found to convert footage the editor can't read (and where). */
    converter: () => Promise<{ available: boolean; path: string | null }>;
    /** Convert a file into an H.264 / AAC working copy in the media cache. `id` names the job for progress and cancelling. */
    convert: (id: string, path: string, kind: 'video' | 'audio') => Promise<ActionResult<MediaFile>>;
    cancelConvert: (id: string) => Promise<void>;
    onConvertProgress: (cb: (p: { id: string; fraction: number }) => void) => () => void;
    /** The preview copy (proxy) made earlier for a video, if there is one. */
    proxyFind: (path: string) => Promise<MediaFile | null>;
    /** Open a video's preview copy for writing; written and closed with exportWrite / exportEnd. */
    proxyBegin: (path: string) => Promise<ActionResult<{ token: string; path: string }>>;
    /**
     * Absolute disk path for a dropped File (drag-and-drop). Synchronous —
     * wraps Electron's webUtils.getPathForFile, the forward-compatible
     * replacement for the deprecated File.path. Returns '' if unavailable.
     */
    pathForFile: (file: File) => string;
    /**
     * Media the app was launched with (file association / "Open with" /
     * dropping a file on the app icon). Resolved from argv on startup; calling
     * this consumes and clears the queue, so the renderer pulls it once on
     * mount without racing the page load. Returns [] when launched normally.
     */
    takeLaunchFiles: () => Promise<MediaFile[]>;
    /**
     * Fires when an already-running instance is asked to open media (a second
     * launch with file args, or macOS open-file). Returns an unsubscribe fn.
     */
    onOpened: (cb: (files: MediaFile[]) => void) => () => void;
    /**
     * Save exported bytes via a Save dialog. Returns the saved path, or null if
     * the user cancelled. Used for small files (subtitles); video exports
     * stream through exportBegin/exportWrite/exportEnd instead.
     */
    saveExport: (data: Uint8Array, suggestedName: string) => Promise<ActionResult<string | null>>;
    /** Pick .cube color LUT files; returns their names + text contents. */
    pickLuts: () => Promise<ActionResult<Array<{ name: string; text: string }>>>;
    /** Read one .cube LUT by path (no dialog). */
    readLut: (path: string) => Promise<ActionResult<{ name: string; text: string }>>;
    /** Pick slide decks (PDF); returns their paths. */
    pickSlides: () => Promise<ActionResult<string[]>>;
    /** Read one PDF by path; the renderer turns its pages into images. */
    readSlides: (path: string) => Promise<ActionResult<{ name: string; data: Uint8Array }>>;
    /** Store app-generated media (reversed clip render) in the media cache. */
    saveDerived: (data: Uint8Array, name: string) => Promise<ActionResult<MediaFile>>;
    /** The pointer track recorded with a video file (JSON text), or null when it has none. */
    pointer: (filePath: string) => Promise<string | null>;
    /**
     * Streamed export: shows the Save dialog up front and opens a .part file
     * next to the chosen path. Returns null data if the user cancelled.
     */
    exportBegin: (suggestedName: string) => Promise<ActionResult<{ token: string; path: string } | null>>;
    /** Write encoded bytes at a byte offset of the open export stream. */
    /** Start an export to a path without a dialog (never overwrites; empty = working folder). */
    exportBeginAt: (path: string, ext: string) => Promise<ActionResult<{ token: string; path: string }>>;
    exportWrite: (token: string, data: Uint8Array, position: number) => Promise<ActionResult>;
    /** Close the stream: commit renames .part onto the final path; abort deletes it. */
    exportEnd: (token: string, commit: boolean) => Promise<ActionResult<string | null>>;
    /**
     * Grant the krypteditor:// handler access to these paths (e.g. media restored
     * from an opened project, which didn't flow through the importer this session).
     */
    allow: (paths: string[]) => Promise<void>;
  };
  project: {
    /** Save a .krypt project (JSON) via a Save dialog. Returns the path or null. */
    save: (json: string, suggestedName: string) => Promise<ActionResult<string | null>>;
    /** Overwrite a known .krypt path without a dialog (Ctrl+S on a saved project). */
    saveToPath: (json: string, path: string) => Promise<ActionResult<string>>;
    /** Open a .krypt project via an Open dialog. Returns its path + JSON, or null. */
    open: () => Promise<ActionResult<{ path: string; json: string } | null>>;
    /** Open a .krypt project by path (recent projects). null if missing. */
    openPath: (path: string) => Promise<ActionResult<{ path: string; json: string } | null>>;
    /** Save to a path without a dialog; never overwrites (empty = working folder). */
    saveAs: (json: string, path: string, name: string) => Promise<ActionResult<string>>;
    /** Write the autosave snapshot to userData (no dialog). */
    autosaveWrite: (json: string) => Promise<void>;
    /** Read the autosave snapshot, or null if none. */
    autosaveRead: () => Promise<string | null>;
  };
  tts: {
    /** Whether the Kokoro voice model is installed, how much is left to download, and any install in progress. */
    kokoroStatus: () => Promise<KokoroStatus>;
    /** Install the model if needed (copied from Krypt Studio when it has it, else downloaded); its file URLs. */
    kokoroEnsure: () => Promise<ActionResult<{ model: string; voices: Record<string, string> }>>;
    kokoroCancel: () => Promise<void>;
    /** Delete the installed model (refused while it downloads). */
    kokoroRemove: () => Promise<ActionResult>;
    onKokoroProgress: (cb: (p: KokoroProgress) => void) => () => void;
    /** An install started or ended, or the model was removed. */
    onKokoroState: (cb: (s: KokoroStatus) => void) => () => void;
  };
  log: {
    onAppend: (cb: (e: { level: 'info' | 'warn' | 'error'; message: string; ts: string }) => void) => () => void;
  };
  /** Krypt Marketo, the Krypt app that uploads to YouTube and runs social accounts, when it is installed. */
  marketo: {
    /** Whether Marketo is on this computer (no connection is opened to find out). */
    present: () => Promise<boolean>;
    status: () => Promise<MarketoStatus>;
    /** Run one of Marketo's tools. A closed Marketo is started first unless launch is false. */
    call: (tool: string, args: unknown, launch?: boolean) => Promise<McpToolResult>;
  };
  mcp: {
    status: () => Promise<McpStatus>;
    onStatus: (cb: (s: McpStatus) => void) => () => void;
    setEnabled: (on: boolean) => Promise<McpStatus>;
    snippets: () => Promise<McpClientSnippet[]>;
    install: (client: string, opts?: { allowAll?: boolean }) => Promise<ActionResult>;
    /**
     * Register the renderer's tool executor; main sends calls only after this. Returns an unsubscribe.
     * `onCancel` registers a callback for when the client cancels the call (an AbortSignal can't cross
     * the context bridge, so the renderer builds its own from this).
     */
    serve: (run: (call: McpToolCall, progress: (fraction: number, message: string) => void, onCancel: (cb: () => void) => void) => Promise<McpToolResult>) => () => void;
  };
}
