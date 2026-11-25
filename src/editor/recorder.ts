import { create } from 'zustand';
import {
  ALL_FORMATS,
  Conversion,
  Input,
  MediaStreamAudioTrackSource,
  MediaStreamVideoTrackSource,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  UrlSource,
  type StreamTargetChunk,
} from 'mediabunny';
import type { MediaFile } from '@shared/types';
import { useMediaStore } from './mediaStore';
import { probeMedia } from './probe';
import { fitCanvas, separateAudioDefault, timelineDuration, useTimelineStore } from './timelineStore';
import { clock, encodeSize, noVisualsYet, planOutputs, planRecordingClips, videoBitrate, type RecordingInputs, type RecordingRole } from './recordingPlan';

/**
 * Recording: a screen or window, a camera and a microphone, captured in the
 * renderer (getDisplayMedia / getUserMedia), encoded live with WebCodecs
 * through mediabunny, and streamed to disk.
 *
 * Everything goes into ONE fragmented MP4 while recording: that keeps the
 * tracks in sync by construction, needs a single stream of writes, and stays a
 * playable file if the app dies an hour in. When the recording stops, its
 * tracks are copied (no re-encode) into ordinary seekable files, one per thing
 * worth editing on its own (recordingPlan.planOutputs), and those land on the
 * timeline together.
 *
 * The session lives in this module, not in the dialog: leaving the editor page
 * unmounts the dialog, and the stop shortcut works while the window is hidden.
 */

export interface RecordOptions {
  /** The screen or window to record; null records no screen. */
  sourceId: string | null;
  /** Also record what the computer plays (Windows, with a screen). */
  systemAudio: boolean;
  /** Open device streams from the dialog; the recorder owns them from here on. */
  mic: MediaStream | null;
  camera: MediaStream | null;
  fps: 30 | 60;
  /** Cap the encoded height of the screen; null keeps it as shown. */
  maxHeight: number | null;
  /** Minimize the editor while recording. */
  hide: boolean;
  /** Follow the pointer and its clicks (kept next to the screen file), and make the recording a product demo when it lands. */
  demo: boolean;
  /**
   * A tool is doing this recording and makes the demo itself when it lands. Tools run one at a
   * time, so a recorder that asked for the product_demo tool here would wait for the tool that
   * is waiting for it.
   */
  fromTool?: boolean;
}

/** The toasts this module raises; the provider outlives the editor page. */
export interface RecordNotifier {
  success: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

interface RecordState {
  phase: 'idle' | 'starting' | 'countdown' | 'recording' | 'saving';
  /** Countdown seconds left. */
  count: number;
  paused: boolean;
  /** Recorded time, pauses excluded. */
  seconds: number;
  bytes: number;
  /** Saving progress, 0–1. */
  progress: number;
  /** Why the last attempt failed, for the dialog. */
  error: string | null;
  /** What is being recorded, for the dialog. */
  inputs: RecordingInputs | null;
}

const IDLE: RecordState = { phase: 'idle', count: 0, paused: false, seconds: 0, bytes: 0, progress: 0, error: null, inputs: null };
/**
 * `saved` counts recordings that reached the timeline; the dialog closes itself when it changes.
 * `tracked` is the last recording that came with a pointer track (its media id).
 */
export const useRecordStore = create<RecordState & { saved: number; tracked: string | null }>(() => ({ ...IDLE, saved: 0, tracked: null }));
const set = (patch: Partial<RecordState>): void => useRecordStore.setState(patch);

type AnySource = MediaStreamVideoTrackSource | MediaStreamAudioTrackSource;

interface Session {
  output: Output;
  token: string;
  rawPath: string;
  base: string;
  sources: AnySource[];
  /** The order the tracks were added in (1-based), by what they carry: the fallback when a track's name can't be read back. */
  ids: { screen?: number; camera?: number; system?: number; mic?: number };
  inputs: RecordingInputs;
  streams: MediaStream[];
  mic: MediaStream | null;
  camera: MediaStream | null;
  audioCtx: AudioContext | null;
  notify: RecordNotifier;
  startedAt: number;
  pausedAt: number | null;
  pausedTotal: number;
  /** The pointer is being followed (see RecordOptions.demo). */
  demo: boolean;
  /** See RecordOptions.fromTool. */
  fromTool: boolean;
  timer: number;
  unsubscribe: () => void;
  ending: boolean;
  /** A write or encoder failure: the recording is saved up to that point. */
  failure: string | null;
}

let session: Session | null = null;
let cancelStart = false;

const sleep = (ms: number): Promise<void> => new Promise((r) => window.setTimeout(r, ms));
const stopStreams = (streams: Array<MediaStream | null>): void => streams.forEach((s) => s?.getTracks().forEach((t) => t.stop()));

/**
 * A stream target that writes through the export IPC (positioned chunks, awaited so a slow disk pushes back).
 * With a chunk size, data is gathered into chunks of that size first (fewer, bigger writes: right for copying);
 * without one, every finished piece is written at once (right for a live recording).
 */
function diskTarget(token: string, chunkSize: number | null, onBytes?: (end: number) => void): StreamTarget {
  return new StreamTarget(
    new WritableStream<StreamTargetChunk>({
      write: async (c) => {
        const r = await window.krypt.media.exportWrite(token, c.data, c.position);
        if (!r.ok) throw new Error(r.message ?? 'Could not write the recording to disk.');
        onBytes?.(c.position + c.data.byteLength);
      },
    }),
    chunkSize ? { chunked: true, chunkSize } : {},
  );
}

/**
 * The size of the picture a track actually delivers. Its settings are not
 * enough: for a window capture they can report the monitor's size until frames
 * flow, and encoding to that stretches the window across it.
 */
async function pictureSize(track: MediaStreamTrack): Promise<{ width: number; height: number }> {
  const el = document.createElement('video');
  el.muted = true;
  el.srcObject = new MediaStream([track]);
  try {
    await new Promise<void>((resolve) => {
      el.addEventListener('loadedmetadata', () => resolve(), { once: true });
      window.setTimeout(resolve, 3000);
      void el.play().catch(() => {});
    });
    if (el.videoWidth > 0 && el.videoHeight > 0) return { width: el.videoWidth, height: el.videoHeight };
  } finally {
    el.pause();
    el.srcObject = null;
  }
  const st = track.getSettings();
  return { width: st.width ?? 0, height: st.height ?? 0 };
}

function recordedSeconds(s: Session): number {
  const now = s.pausedAt ?? performance.now();
  return Math.max(0, (now - s.startedAt - s.pausedTotal) / 1000);
}

/** Start recording. Resolves once the recording runs (or failed to start: see the store's error). */
export async function beginRecording(opts: RecordOptions, notify: RecordNotifier): Promise<void> {
  if (useRecordStore.getState().phase !== 'idle') {
    stopStreams([opts.mic, opts.camera]);
    return;
  }
  cancelStart = false;
  set({ ...IDLE, phase: 'starting' });
  const streams: MediaStream[] = [opts.mic, opts.camera].filter((s): s is MediaStream => !!s);
  let audioCtx: AudioContext | null = null;
  let token: string | null = null;
  let rawPath: string | null = null;
  let live = false;
  let tracking = false;
  try {
    let display: MediaStream | null = null;
    if (opts.sourceId) {
      await window.krypt.capture.arm(opts.sourceId, opts.systemAudio);
      try {
        display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: opts.fps, max: opts.fps } }, audio: opts.systemAudio });
      } catch {
        throw new Error('That screen or window could not be captured. It may have been closed: refresh the list and pick again.');
      }
      streams.push(display);
    }
    const displayTrack = display?.getVideoTracks()[0] ?? null;
    const systemTrack = display?.getAudioTracks()[0] ?? null;
    const cameraTrack = opts.camera?.getVideoTracks()[0] ?? null;
    const micTrack = opts.mic?.getAudioTracks()[0] ?? null;
    const inputs: RecordingInputs = { screen: !!displayTrack, camera: !!cameraTrack, system: !!systemTrack, mic: !!micTrack };
    if (planOutputs(inputs).length === 0) throw new Error('Nothing to record: pick a screen, a camera or a microphone.');
    set({ inputs });

    const begin = await window.krypt.capture.begin();
    if (!begin.ok || !begin.data) throw new Error(begin.message ?? 'Could not create the recording file.');
    token = begin.data.token;
    rawPath = begin.data.rawPath;

    const fail = (e: unknown): void => {
      const s = session;
      if (!s || s.failure) return;
      s.failure = (e as Error)?.message ?? String(e);
      void stopRecording();
    };
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 1 }),
      // Unbuffered: each one-second fragment is on disk as soon as it is complete.
      target: diskTarget(token, null, (end) => {
        if (end > useRecordStore.getState().bytes) set({ bytes: end });
      }),
    });

    const sources: AnySource[] = [];
    const ids: Session['ids'] = {};
    let added = 0;
    const video = async (track: MediaStreamTrack, fps: number, maxHeight: number | null, alwaysResize: boolean): Promise<MediaStreamVideoTrackSource> => {
      const real = await pictureSize(track);
      const size = encodeSize(real.width, real.height, maxHeight);
      const src = new MediaStreamVideoTrackSource(
        track as never,
        {
          codec: 'avc',
          bitrate: videoBitrate(size.width, size.height, fps),
          keyFrameInterval: 2,
          // A window can be resized mid-recording: the picture is fitted into the size it started at.
          sizeChangeBehavior: 'contain',
          ...(size.resize || alwaysResize ? { transform: { width: size.width, height: size.height } } : {}),
        },
        { frameRate: fps },
      );
      void src.errorPromise.catch(fail);
      sources.push(src);
      return src;
    };
    const audio = (track: MediaStreamTrack, bitrate: number): MediaStreamAudioTrackSource => {
      const src = new MediaStreamAudioTrackSource(track as never, { codec: 'aac', bitrate });
      void src.errorPromise.catch(fail);
      sources.push(src);
      return src;
    };

    if (displayTrack) {
      // A window's reported size can be odd or stale, so its frames always go through the resizer.
      output.addVideoTrack(await video(displayTrack, opts.fps, opts.maxHeight, !opts.sourceId!.startsWith('screen')), { frameRate: opts.fps, name: 'screen' });
      ids.screen = ++added;
    }
    if (cameraTrack) {
      const fps = Math.min(30, Math.round(cameraTrack.getSettings().frameRate ?? 30)) || 30;
      output.addVideoTrack(await video(cameraTrack, fps, 1080, false), { frameRate: fps, name: 'camera' });
      ids.camera = ++added;
    }
    if (systemTrack) {
      // The computer's sound arrives only while something plays. Through an audio
      // graph it becomes a steady stream (silence included), which the muxer needs
      // to keep writing fragments.
      audioCtx = new AudioContext({ sampleRate: 48000 });
      const dest = audioCtx.createMediaStreamDestination();
      audioCtx.createMediaStreamSource(new MediaStream([systemTrack])).connect(dest);
      await audioCtx.resume();
      output.addAudioTrack(audio(dest.stream.getAudioTracks()[0], 192e3), { name: 'system' });
      ids.system = ++added;
    }
    if (micTrack) {
      output.addAudioTrack(audio(micTrack, 128e3), { name: 'mic' });
      ids.mic = ++added;
    }

    // Started before the countdown: the helper needs a second to come up.
    if (opts.demo && opts.sourceId) {
      void window.krypt.capture.pointerPrepare(opts.sourceId);
      tracking = true;
    }
    for (let n = 3; n > 0; n--) {
      set({ phase: 'countdown', count: n });
      await sleep(1000);
      if (cancelStart) throw new Error('');
    }
    await window.krypt.capture.setRecording(true, opts.hide);
    live = true;
    if (opts.hide) await sleep(700); // let the window finish minimizing, so it is not in the picture
    if (cancelStart) throw new Error('');

    const s: Session = {
      output,
      token,
      rawPath,
      base: begin.data.base,
      sources,
      ids,
      inputs,
      streams,
      mic: opts.mic,
      camera: opts.camera,
      audioCtx,
      notify,
      startedAt: performance.now(),
      pausedAt: null,
      pausedTotal: 0,
      demo: tracking,
      fromTool: opts.fromTool === true,
      timer: 0,
      unsubscribe: () => {},
      ending: false,
      failure: null,
    };
    session = s;
    await output.start();
    s.startedAt = performance.now();
    if (tracking) void window.krypt.capture.pointerMark();
    s.timer = window.setInterval(() => set({ seconds: recordedSeconds(s) }), 250);
    s.unsubscribe = window.krypt.capture.onStopRequested(() => void stopRecording());
    // The window was closed, or a device unplugged: keep what was recorded.
    const ended = (what: string) => (): void => {
      if (session === s && !s.ending) {
        notify.warn(`${what}, so the recording was stopped there.`);
        void stopRecording();
      }
    };
    displayTrack?.addEventListener('ended', ended('The window or screen being recorded went away'));
    cameraTrack?.addEventListener('ended', ended('The camera was disconnected'));
    micTrack?.addEventListener('ended', ended('The microphone was disconnected'));
    set({ phase: 'recording', seconds: 0, paused: false });
  } catch (e) {
    session = null;
    stopStreams(streams);
    void audioCtx?.close().catch(() => {});
    if (token) void window.krypt.media.exportEnd(token, false);
    if (rawPath) void window.krypt.capture.discard(rawPath);
    if (live) void window.krypt.capture.setRecording(false, false);
    if (tracking) void window.krypt.capture.pointerFinish(null);
    const message = (e as Error)?.message ?? '';
    set({ ...IDLE, error: message || null });
  }
}

/** The device streams of the running recording, for the dialog's level meter and camera preview. */
export function recordingStreams(): { mic: MediaStream | null; camera: MediaStream | null } {
  return { mic: session?.mic ?? null, camera: session?.camera ?? null };
}

/** Cancel during the countdown. */
export function cancelCountdown(): void {
  cancelStart = true;
}

export function togglePause(): void {
  const s = session;
  if (!s || s.ending || useRecordStore.getState().phase !== 'recording') return;
  if (s.pausedAt === null) {
    s.sources.forEach((src) => src.pause());
    s.pausedAt = performance.now();
    if (s.demo) void window.krypt.capture.pointerPause(true);
    set({ paused: true, seconds: recordedSeconds(s) });
  } else {
    s.pausedTotal += performance.now() - s.pausedAt;
    s.pausedAt = null;
    if (s.demo) void window.krypt.capture.pointerPause(false);
    s.sources.forEach((src) => src.resume());
    set({ paused: false });
  }
}

/** Halt the capture and release the devices; the file is finalized by the caller. */
async function halt(s: Session): Promise<void> {
  s.ending = true;
  if (s.demo) void window.krypt.capture.pointerPause(true);
  // Pause first: nothing after this instant is recorded, so the editor window
  // coming back (next line) is not in the picture.
  if (s.pausedAt === null) {
    s.sources.forEach((src) => src.pause());
    s.pausedAt = performance.now();
  }
  window.clearInterval(s.timer);
  s.unsubscribe();
  await window.krypt.capture.setRecording(false, false);
}

function release(s: Session): void {
  stopStreams(s.streams);
  void s.audioCtx?.close().catch(() => {});
}

/** Throw the running recording away. */
export async function discardRecording(): Promise<void> {
  const s = session;
  if (!s || s.ending) return;
  await halt(s);
  try {
    await s.output.cancel();
  } catch {
    /* already failed */
  }
  release(s);
  if (s.demo) void window.krypt.capture.pointerFinish(null);
  await window.krypt.media.exportEnd(s.token, false);
  await window.krypt.capture.discard(s.rawPath);
  session = null;
  set(IDLE);
}

/** Stop, save the tracks as finished files, and put them on the timeline. */
export async function stopRecording(): Promise<void> {
  const s = session;
  if (!s || s.ending) return;
  await halt(s);
  const seconds = recordedSeconds(s);
  set({ phase: 'saving', progress: 0, paused: false, seconds });
  let closed = false;
  try {
    try {
      await s.output.finalize();
    } catch (e) {
      // A failed write or encoder: what reached the disk is still a valid file up to the last fragment.
      s.failure ??= (e as Error)?.message ?? String(e);
    }
    release(s);
    await window.krypt.media.exportEnd(s.token, true);
    closed = true;
    if (seconds < 0.5) throw new Error('That recording was too short to keep.');

    const files = await splitRecording(s.rawPath, s.base, { inputs: s.inputs, ids: s.ids }, (p) => set({ progress: p }));
    await window.krypt.capture.discard(s.rawPath);
    // The pointer track goes next to the screen file, under the same name.
    const screen = files.find((f) => f.role === 'screen');
    const tracked = s.demo ? await window.krypt.capture.pointerFinish(screen?.media.filePath ?? null) : null;
    const at = await placeRecording(files);
    const demo = tracked && screen && !s.fromTool ? await makeDemo(screen.media.id) : '';
    if (tracked && screen) useRecordStore.setState({ tracked: screen.media.id });
    if (s.failure) s.notify.warn(`The recording stopped early (${s.failure}). Everything up to that point was saved.`);
    useRecordStore.setState((st) => ({ saved: st.saved + 1 }));
    s.notify.success(`Recorded ${clock(seconds)}: ${files.length === 1 ? 'the clip is' : `${files.length} clips are`} on the timeline at ${clock(at)}.${demo} Files are in ${folderOf(files[0].media.filePath)}`);
    set(IDLE);
  } catch (e) {
    release(s);
    if (!closed) await window.krypt.media.exportEnd(s.token, true);
    const message = (e as Error)?.message ?? String(e);
    const short = seconds < 0.5;
    if (short) await window.krypt.capture.discard(s.rawPath);
    // The streamed file is kept: it holds the whole recording and can be imported as it is.
    s.notify.error(short ? message : `The recording could not be finished (${message}). The unfinished file was kept: ${s.rawPath}`);
    set({ ...IDLE, error: short ? message : null });
  } finally {
    if (s.demo) void window.krypt.capture.pointerFinish(null);
    session = null;
  }
}

/** Turn the recording that just landed into a product demo (zooms on its clicks). Says what it did, or nothing. */
async function makeDemo(mediaId: string): Promise<string> {
  try {
    // Loaded here: the tools module is the editor's biggest, and the recorder is on every page.
    const { runAgentTool } = await import('./agentTools');
    const r = await runAgentTool({ rid: 0, tool: 'product_demo', args: { media_id: mediaId }, client: 'Krypt Editor' }, () => undefined, new AbortController().signal);
    return r.ok ? ` ${r.text.split('\n')[0]}` : '';
  } catch {
    return '';
  }
}

const folderOf = (p: string): string => p.replace(/[\\/][^\\/]*$/, '');

export interface RecordedFile {
  role: RecordingRole;
  media: MediaFile;
  /** The sound a video file carries (it becomes a clip of its own on the timeline). */
  sound?: 'system' | 'mic' | null;
}

/**
 * Finish a recording that a crash or a forced quit cut short: the streamed
 * file it left behind is split into clips exactly as a normal stop would.
 */
export async function recoverRecording(rawPath: string, notify: RecordNotifier): Promise<void> {
  if (useRecordStore.getState().phase !== 'idle') return;
  set({ ...IDLE, phase: 'saving' });
  try {
    const base = rawPath.slice(0, rawPath.length - '-unfinished.mp4'.length);
    const files = await splitRecording(rawPath, base, null, (p) => set({ progress: p }));
    await window.krypt.capture.discard(rawPath);
    const at = await placeRecording(files);
    useRecordStore.setState((st) => ({ saved: st.saved + 1 }));
    notify.success(`Recovered the recording: ${files.length === 1 ? 'the clip is' : `${files.length} clips are`} on the timeline at ${clock(at)}.`);
  } catch (e) {
    notify.error(`That recording could not be recovered (${(e as Error)?.message ?? String(e)}). The file was left where it is: ${rawPath}`);
  } finally {
    set(IDLE);
  }
}

type TrackName = 'screen' | 'camera' | 'system' | 'mic';

/**
 * Copy the streamed file's tracks into ordinary files, one per planned output. No re-encoding.
 * `known` is what the session recorded; without it (recovering a file a crash left behind)
 * the tracks' own names say what is in there.
 */
async function splitRecording(
  rawPath: string,
  base: string,
  known: { inputs: RecordingInputs; ids: Session['ids'] } | null,
  onProgress: (ratio: number) => void,
): Promise<RecordedFile[]> {
  const raw = (await window.krypt.media.resolvePaths([rawPath])).data?.[0];
  if (!raw) throw new Error('the recorded file could not be opened');
  // Tracks are found by the name they were recorded under; the order they were added in is the fallback.
  const named = new Map<string, number>();
  const probe = new Input({ source: new UrlSource(raw.mediaUrl), formats: ALL_FORMATS });
  try {
    for (const t of await probe.getTracks()) {
      const name = await t.getName();
      if (name) named.set(name, t.id);
    }
  } finally {
    probe.dispose();
  }
  const idOf = (name: TrackName): number | undefined => named.get(name) ?? known?.ids[name];
  const inputs: RecordingInputs = known?.inputs ?? { screen: named.has('screen'), camera: named.has('camera'), system: named.has('system'), mic: named.has('mic') };
  const plan = planOutputs(inputs);
  if (plan.length === 0) throw new Error('no recorded tracks were found in it');
  const made: RecordedFile[] = [];
  for (const [i, part] of plan.entries()) {
    const videoId = part.video ? idOf(part.video) : undefined;
    const audioId = part.audio ? idOf(part.audio) : undefined;
    const begin = await window.krypt.media.exportBeginAt(`${base}-${part.role}.${part.ext}`, part.ext);
    if (!begin.ok || !begin.data) throw new Error(begin.message ?? 'could not create the file');
    const { token, path } = begin.data;
    const input = new Input({ source: new UrlSource(raw.mediaUrl), formats: ALL_FORMATS });
    try {
      const output = new Output({ format: new Mp4OutputFormat(), target: diskTarget(token, 8 << 20) });
      const conversion = await Conversion.init({
        input,
        output,
        video: (t) => ({ discard: t.id !== videoId }),
        audio: (t) => ({ discard: t.id !== audioId }),
        // From zero, not from this file's first frame: the files start together on the timeline.
        trim: { start: 0 },
        showWarnings: false,
      });
      if (!conversion.isValid) throw new Error('the recorded tracks could not be copied');
      conversion.onProgress = (p) => onProgress((i + p) / plan.length);
      await conversion.execute();
      const end = await window.krypt.media.exportEnd(token, true);
      if (!end.ok) throw new Error(end.message ?? 'could not finish the file');
    } catch (e) {
      void window.krypt.media.exportEnd(token, false);
      throw e;
    } finally {
      input.dispose();
    }
    const media = (await window.krypt.media.resolvePaths([path])).data?.[0];
    if (!media) throw new Error('the saved file could not be opened');
    made.push({ role: part.role, media, sound: part.video ? part.audio : null });
    onProgress((i + 1) / plan.length);
  }
  return made;
}

/** Add the finished files to the bin and the timeline (one undo step). Returns where they start. */
export async function placeRecording(files: RecordedFile[]): Promise<number> {
  useMediaStore.getState().add(files.map((f) => f.media));
  const infos = await Promise.all(files.map((f) => probeMedia(f.media)));
  const st = useTimelineStore.getState();
  const at = timelineDuration(st.clips);
  const plan = planRecordingClips(
    files.map((f, i) => ({ role: f.role, mediaId: f.media.id, duration: infos[i].duration, width: infos[i].width, height: infos[i].height, sound: f.sound })),
    st.tracks,
    at,
    separateAudioDefault(),
  );
  const followCanvas = !st.canvasUserSet && plan.main && plan.main.width > 0 && noVisualsYet(st.clips, st.tracks);
  st.pause();
  st.commitClips([...st.clips, ...plan.clips], plan.tracks);
  useTimelineStore.setState({
    selectedIds: plan.clips.map((c) => c.id),
    soloSelect: false,
    playhead: at,
    ...(followCanvas && plan.main ? { canvas: fitCanvas(plan.main.width, plan.main.height) } : {}),
  });
  return at;
}
