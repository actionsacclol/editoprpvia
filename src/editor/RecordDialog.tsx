import { useEffect, useMemo, useRef, useState } from 'react';
import { AppWindow, Camera, Circle, LifeBuoy, Mic, Monitor, MonitorOff, Pause, Play, RefreshCw, Square, Trash2, Video, Globe } from 'lucide-react';
import type { CaptureInfo } from '@shared/types';
import { GhostButton, PrimaryButton } from '../components/common';
import { useToast } from '../state/ToastProvider';
import { cls, fmtBytes } from '../utils/format';
import { beginRecording, cancelCountdown, discardRecording, recordingStreams, recoverRecording, stopRecording, togglePause, useRecordStore } from './recorder';
import { separateAudioDefault } from './timelineStore';
import { clock, describeOutputs, type RecordingInputs } from './recordingPlan';

/**
 * Record dialog: pick a screen or window, a microphone and a camera, then
 * record. The capture itself runs in recorder.ts and outlives this component;
 * the dialog only sets it up and shows its state (countdown, running, saving).
 */

type Tab = 'screen' | 'window' | 'none';

interface Prefs {
  micId: string;
  camId: string;
  systemAudio: boolean;
  fps: 30 | 60;
  maxHeight: number | null;
  hide: boolean;
  /** Follow the pointer and make the recording a product demo (zooms on clicks). */
  demo: boolean;
}
const PREFS_KEY = 'krypt.record.prefs';
/** micId '' = first microphone found, 'none' = no microphone. */
const DEFAULT_PREFS: Prefs = { micId: '', camId: 'none', systemAudio: false, fps: 30, maxHeight: null, hide: true, demo: true };

function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>;
    return {
      micId: typeof p.micId === 'string' ? p.micId : DEFAULT_PREFS.micId,
      camId: typeof p.camId === 'string' ? p.camId : DEFAULT_PREFS.camId,
      systemAudio: p.systemAudio === true,
      fps: p.fps === 60 ? 60 : 30,
      maxHeight: p.maxHeight === 1080 || p.maxHeight === 720 ? p.maxHeight : null,
      hide: p.hide !== false,
      demo: p.demo !== false,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

const SIZES: Array<{ label: string; value: number | null; hint: string }> = [
  { label: 'As shown', value: null, hint: 'The full size of the screen or window: sharpest text' },
  { label: '1080p', value: 1080, hint: 'Scaled down to 1080 lines if the screen is bigger: smaller files' },
  { label: '720p', value: 720, hint: 'Scaled down to 720 lines: smallest files, small text gets soft' },
];

export function RecordDialog({ onClose, onWeb }: { onClose: () => void; onWeb?: () => void }) {
  const toast = useToast();
  const phase = useRecordStore((s) => s.phase);
  const error = useRecordStore((s) => s.error);
  const saved = useRecordStore((s) => s.saved);
  const count = useRecordStore((s) => s.count);

  const [info, setInfo] = useState<CaptureInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [loadingSources, setLoadingSources] = useState(false);
  const [tab, setTab] = useState<Tab>('screen');
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const [camStream, setCamStream] = useState<MediaStream | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  /** Bumped to reopen the devices after a failed or cancelled start (the recorder closes them). */
  const [epoch, setEpoch] = useState(0);
  /** Once a recording starts, the recorder owns the device streams. */
  const handedOff = useRef(false);
  const setup = phase === 'idle';

  const patch = (p: Partial<Prefs>): void =>
    setPrefs((old) => {
      const next = { ...old, ...p };
      if ('micId' in p || 'camId' in p) setDeviceError(null);
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        /* not remembered, nothing else */
      }
      return next;
    });

  // ── Screens and windows ────────────────────────────────────────────────
  const refresh = async (): Promise<void> => {
    setLoadingSources(true);
    const r = await window.krypt.capture.info();
    setLoadingSources(false);
    if (!r.ok || !r.data) {
      setInfoError(r.message ?? 'Could not list the screens and windows.');
      return;
    }
    setInfoError(null);
    setInfo(r.data);
    setSourceId((cur) => (cur && r.data!.sources.some((s) => s.id === cur) ? cur : (r.data!.sources.find((s) => s.kind === 'screen')?.id ?? null)));
  };
  useEffect(() => {
    void refresh();
  }, []);
  const shown = useMemo(() => (info?.sources ?? []).filter((s) => s.kind === tab), [info, tab]);
  const pickTab = (t: Tab): void => {
    setTab(t);
    if (t === 'none') return;
    const list = (info?.sources ?? []).filter((s) => s.kind === t);
    setSourceId((cur) => (cur && list.some((s) => s.id === cur) ? cur : (list[0]?.id ?? null)));
  };

  // ── Microphones and cameras ────────────────────────────────────────────
  useEffect(() => {
    if (!setup) return;
    let alive = true;
    const list = async (): Promise<void> => {
      try {
        const all = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.deviceId !== 'communications');
        if (!alive) return;
        setMics(all.filter((d) => d.kind === 'audioinput'));
        setCams(all.filter((d) => d.kind === 'videoinput'));
      } catch {
        /* no devices to offer */
      }
    };
    void list();
    navigator.mediaDevices.addEventListener('devicechange', list);
    return () => {
      alive = false;
      navigator.mediaDevices.removeEventListener('devicechange', list);
    };
  }, [setup]);

  const micId = prefs.micId === 'none' ? 'none' : mics.some((d) => d.deviceId === prefs.micId) ? prefs.micId : (mics[0]?.deviceId ?? 'none');
  const camId = cams.some((d) => d.deviceId === prefs.camId) ? prefs.camId : 'none';

  useEffect(() => {
    if (!setup || micId === 'none') return;
    let alive = true;
    let stream: MediaStream | null = null;
    void (async () => {
      try {
        if (!(await window.krypt.capture.askAccess('microphone'))) throw new Error('denied');
        // Noise suppression and gain help a lecture voice; echo cancelling only harms it (there is no call).
        stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: micId }, echoCancellation: false, noiseSuppression: true, autoGainControl: true } });
        if (!alive) return stream.getTracks().forEach((t) => t.stop());
        setDeviceError(null);
        setMicStream(stream);
      } catch {
        if (alive) setDeviceError('The microphone could not be opened. Another app may be holding it, or access is switched off in the system settings.');
      }
    })();
    return () => {
      alive = false;
      if (!handedOff.current) stream?.getTracks().forEach((t) => t.stop());
      setMicStream(null);
    };
  }, [setup, micId, epoch]);

  useEffect(() => {
    if (!setup || camId === 'none') return;
    let alive = true;
    let stream: MediaStream | null = null;
    void (async () => {
      try {
        if (!(await window.krypt.capture.askAccess('camera'))) throw new Error('denied');
        stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: camId }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } });
        if (!alive) return stream.getTracks().forEach((t) => t.stop());
        setDeviceError(null);
        setCamStream(stream);
      } catch {
        if (alive) setDeviceError('The camera could not be opened. Another app may be using it.');
      }
    })();
    return () => {
      alive = false;
      if (!handedOff.current) stream?.getTracks().forEach((t) => t.stop());
      setCamStream(null);
    };
  }, [setup, camId, epoch]);

  // Back at setup after a start that failed or was cancelled: the recorder closed the devices, reopen them.
  const lastPhase = useRef(phase);
  useEffect(() => {
    if (lastPhase.current !== 'idle' && phase === 'idle') {
      handedOff.current = false;
      setEpoch((n) => n + 1);
      void refresh();
    }
    lastPhase.current = phase;
  }, [phase]);
  // A recording reached the timeline: done here.
  const savedAtOpen = useRef(saved);
  useEffect(() => {
    if (saved !== savedAtOpen.current) onClose();
  }, [saved, onClose]);

  const screenOn = tab !== 'none' && !!sourceId;
  const systemOn = screenOn && !!info?.systemAudio && prefs.systemAudio;
  const inputs: RecordingInputs = { screen: screenOn, camera: camId !== 'none' && !!camStream, system: systemOn, mic: micId !== 'none' && !!micStream };
  const canStart = inputs.screen || inputs.camera || inputs.mic;

  const start = (): void => {
    handedOff.current = true;
    void beginRecording(
      { sourceId: screenOn ? sourceId : null, systemAudio: systemOn, mic: inputs.mic ? micStream : null, camera: inputs.camera ? camStream : null, fps: prefs.fps, maxHeight: prefs.maxHeight, hide: prefs.hide, demo: screenOn && prefs.demo },
      toast,
    );
    // Streams the recording does not use are closed here; the rest now belong to the recorder.
    if (!inputs.mic) micStream?.getTracks().forEach((t) => t.stop());
    if (!inputs.camera) camStream?.getTracks().forEach((t) => t.stop());
  };

  const close = (): void => {
    if (phase === 'countdown' || phase === 'starting') cancelCountdown();
    onClose();
  };

  const select = 'w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-sm text-white outline-none focus:border-krypt-purple/60';
  const chip = (on: boolean): string =>
    cls('rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition', on ? 'border-krypt-purple/50 bg-krypt-purple/20 text-white' : 'border-white/10 bg-white/5 text-krypt-muted hover:text-white');
  const live = recordingStreams();

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center rounded-2xl bg-krypt-void/85 backdrop-blur-sm animate-fade-in">
      <div className="max-h-[94%] w-[680px] max-w-[96%] overflow-auto rounded-2xl border border-white/10 bg-krypt-panel/95 p-6 shadow-krypt-card">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-rose-500/15">
            <Video className="h-5 w-5 text-rose-300" />
          </div>
          <div>
            <div className="text-sm font-bold text-white">Record</div>
            <div className="text-xs text-krypt-muted">Your screen, camera and voice, straight onto the timeline. Nothing leaves this computer.</div>
          </div>
        </div>

        {phase === 'idle' && (
          <>
            {(info?.unfinished ?? []).map((u) => (
              <div key={u.path} className="mb-3 flex items-center gap-3 rounded-xl border border-amber-400/30 bg-amber-500/10 px-3 py-2">
                <LifeBuoy className="h-4 w-4 flex-shrink-0 text-amber-300" />
                <div className="min-w-0 flex-1 text-xs text-amber-100" title={u.path}>
                  A recording from {new Date(u.modified).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} was cut short ({fmtBytes(u.bytes)}). What reached the disk can be recovered.
                </div>
                <GhostButton onClick={() => void window.krypt.capture.discard(u.path).then(refresh)}>Delete</GhostButton>
                <PrimaryButton onClick={() => void recoverRecording(u.path, toast)}>Recover</PrimaryButton>
              </div>
            ))}
            {onWeb && (
              <button
                type="button"
                onClick={onWeb}
                data-agent="record-web"
                className="mb-3 flex w-full items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-left text-xs text-white/85 transition hover:border-krypt-purple/50 hover:bg-krypt-purple/10"
              >
                <Globe className="h-4 w-4 flex-shrink-0 text-krypt-purple" />
                <span>
                  <b>Film a web page instead</b>: give an address and the clicks to make, and Krypt Editor films the page by itself. Nothing on your screen is recorded.
                </span>
              </button>
            )}
            <div className="mb-2 flex items-center gap-2">
              <div className="flex overflow-hidden rounded-lg border border-white/10">
                {(
                  [
                    ['screen', 'Screens', Monitor],
                    ['window', 'Windows', AppWindow],
                    ['none', 'No screen', MonitorOff],
                  ] as const
                ).map(([t, label, Icon]) => (
                  <button
                    key={t}
                    onClick={() => pickTab(t)}
                    className={cls('flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold transition', tab === t ? 'bg-krypt-purple/25 text-white' : 'bg-white/5 text-krypt-muted hover:text-white')}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {label}
                  </button>
                ))}
              </div>
              {tab !== 'none' && (
                <button
                  title="Refresh the list"
                  onClick={() => void refresh()}
                  className="rounded-lg border border-white/10 bg-white/5 p-1.5 text-krypt-muted transition hover:bg-white/10 hover:text-white"
                >
                  <RefreshCw className={cls('h-3.5 w-3.5', loadingSources && 'animate-spin')} />
                </button>
              )}
            </div>

            {tab === 'none' ? (
              <div className="rounded-xl border border-white/10 bg-black/30 px-3 py-4 text-xs text-krypt-muted">
                No screen is recorded: only the camera and microphone you pick below. Use this to film yourself, or to record a voice-over.
              </div>
            ) : infoError ? (
              <div className="rounded-xl border border-rose-400/30 bg-rose-500/10 px-3 py-3 text-xs text-rose-200">{infoError}</div>
            ) : shown.length === 0 ? (
              <div className="rounded-xl border border-white/10 bg-black/30 px-3 py-4 text-xs text-krypt-muted">
                {info ? (tab === 'window' ? 'No open windows found. Minimized windows cannot be recorded: restore the one you want, then refresh.' : 'No screens found.') : 'Looking for screens and windows…'}
              </div>
            ) : (
              <div className="grid max-h-[232px] grid-cols-3 gap-2 overflow-auto pr-1">
                {shown.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setSourceId(s.id)}
                    title={s.name}
                    className={cls(
                      'overflow-hidden rounded-xl border text-left transition',
                      sourceId === s.id ? 'border-krypt-purple/70 bg-krypt-purple/15 ring-1 ring-krypt-purple/50' : 'border-white/10 bg-white/5 hover:border-white/25',
                    )}
                  >
                    <div className="flex aspect-video w-full items-center justify-center bg-black/60">
                      {s.thumbnail ? <img src={s.thumbnail} alt="" className="capture-thumb h-full w-full object-contain" /> : <Monitor className="h-6 w-6 text-krypt-muted" />}
                    </div>
                    <div className="truncate px-2 py-1.5 text-[11px] text-white/90">{s.name}</div>
                  </button>
                ))}
              </div>
            )}

            <div className="mt-4 grid grid-cols-2 gap-4">
              <div>
                <div className="mb-1 flex items-center gap-1.5 text-xs text-krypt-muted">
                  <Mic className="h-3.5 w-3.5" /> Microphone
                </div>
                <select value={micId} onChange={(e) => patch({ micId: e.target.value })} className={select}>
                  <option value="none">None</option>
                  {mics.map((d, i) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `Microphone ${i + 1}`}
                    </option>
                  ))}
                </select>
                {micId !== 'none' && <LevelMeter stream={micStream} />}
                {info?.systemAudio && (
                  <label className={cls('mt-3 flex cursor-pointer items-start gap-2 text-xs', screenOn ? 'text-white/90' : 'text-krypt-muted/60')}>
                    <input type="checkbox" disabled={!screenOn} checked={systemOn} onChange={(e) => patch({ systemAudio: e.target.checked })} className="mt-0.5 accent-krypt-purple" />
                    <span>
                      Record the computer's sound
                      <span className="block text-[11px] text-krypt-muted">Everything this PC plays, kept apart from your voice.</span>
                    </span>
                  </label>
                )}
              </div>
              <div>
                <div className="mb-1 flex items-center gap-1.5 text-xs text-krypt-muted">
                  <Camera className="h-3.5 w-3.5" /> Camera
                </div>
                <select value={camId} onChange={(e) => patch({ camId: e.target.value })} className={select}>
                  <option value="none">None</option>
                  {cams.map((d, i) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `Camera ${i + 1}`}
                    </option>
                  ))}
                </select>
                {camId !== 'none' && <CameraPreview stream={camStream} className="mt-2 w-40" />}
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2">
              {screenOn && (
                <>
                  <div className="flex items-center gap-1.5">
                    <span className="mr-1 text-xs text-krypt-muted">Size</span>
                    {SIZES.map((z) => (
                      <button key={z.label} title={z.hint} onClick={() => patch({ maxHeight: z.value })} className={chip(prefs.maxHeight === z.value)}>
                        {z.label}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="mr-1 text-xs text-krypt-muted">Frames per second</span>
                    {([30, 60] as const).map((f) => (
                      <button key={f} title={f === 30 ? 'Right for slides, code and talking' : 'For fast motion such as games: bigger files'} onClick={() => patch({ fps: f })} className={chip(prefs.fps === f)}>
                        {f}
                      </button>
                    ))}
                  </div>
                </>
              )}
              <label className="flex cursor-pointer items-center gap-2 text-xs text-white/90">
                <input type="checkbox" checked={prefs.hide} onChange={(e) => patch({ hide: e.target.checked })} className="accent-krypt-purple" />
                Hide Krypt Editor while recording
              </label>
              <label className={cls('mt-2 flex cursor-pointer items-start gap-2 text-xs', screenOn ? 'text-white/90' : 'text-krypt-muted/60')} title="Krypt Editor notes where the pointer is and when it is clicked while it records (the mouse only, never the keyboard), and keeps that next to the recording. Demo in the toolbar changes or removes the result">
                <input type="checkbox" checked={prefs.demo} disabled={!screenOn} onChange={(e) => patch({ demo: e.target.checked })} className="mt-0.5 accent-krypt-purple" />
                <span>
                  Product demo: a window frame, zooms on what I click, click sounds
                  <span className="block text-[11px] text-krypt-muted">Added as ordinary keyframes and clips when the recording lands; change or remove it with Demo in the toolbar.</span>
                </span>
              </label>
            </div>

            <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-white/85">{describeOutputs(inputs, separateAudioDefault())}</div>
            {(error || deviceError) && <div className="mt-2 text-xs text-rose-300">{error ?? deviceError}</div>}

            <div className="mt-5 flex items-center gap-3">
              <div className="min-w-0 flex-1 truncate text-[11px] text-krypt-muted" title={info?.folder}>
                {info && (
                  <>
                    {info.freeBytes != null && <span className={cls(info.freeBytes < 2e9 && 'text-amber-300')}>{fmtBytes(info.freeBytes)} free · </span>}
                    Saved in {info.folder}
                  </>
                )}
              </div>
              <GhostButton onClick={close}>Cancel</GhostButton>
              <PrimaryButton onClick={start} disabled={!canStart}>
                <Circle className="h-3.5 w-3.5 fill-rose-400 text-rose-400" />
                Start recording
              </PrimaryButton>
            </div>
          </>
        )}

        {(phase === 'starting' || phase === 'countdown') && (
          <div className="flex flex-col items-center py-8">
            <div className="text-xs text-krypt-muted">{phase === 'starting' ? 'Getting ready…' : 'Recording starts in'}</div>
            <div className="my-3 font-mono text-7xl font-bold text-white">{phase === 'countdown' ? count : '·'}</div>
            <GhostButton onClick={cancelCountdown}>Cancel</GhostButton>
          </div>
        )}

        {phase === 'recording' && <Running shortcut={info?.stopShortcut ?? ''} mic={live.mic ?? micStream} camera={live.camera ?? camStream} />}

        {phase === 'saving' && <Saving />}
      </div>
    </div>
  );
}

function Running({ shortcut, mic, camera }: { shortcut: string; mic: MediaStream | null; camera: MediaStream | null }) {
  const seconds = useRecordStore((s) => s.seconds);
  const bytes = useRecordStore((s) => s.bytes);
  const paused = useRecordStore((s) => s.paused);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  return (
    <div>
      <div className="flex items-center gap-5">
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <span className={cls('h-3.5 w-3.5 rounded-full', paused ? 'bg-amber-400' : 'animate-pulse bg-rose-500')} />
            <span className="font-mono text-5xl font-bold text-white">{clock(seconds)}</span>
          </div>
          <div className="mt-1 text-xs text-krypt-muted">
            {paused ? 'Paused: nothing is being recorded' : 'Recording'} · {fmtBytes(bytes)} on disk
          </div>
          {mic && (
            <div className="mt-3 max-w-[280px]">
              <LevelMeter stream={mic} />
            </div>
          )}
        </div>
        {camera && <CameraPreview stream={camera} className="w-44" />}
      </div>
      <p className="mt-4 text-[11px] text-krypt-muted">
        {shortcut ? `Stop from anywhere with ${shortcut}, or from the Krypt Editor icon in the system tray.` : 'Stop from the Krypt Editor icon in the system tray.'} The recording is written to disk
        as it goes.
      </p>
      <div className="mt-5 flex items-center gap-2">
        {confirmDiscard ? (
          <>
            <span className="text-xs text-rose-200">Throw this recording away?</span>
            <GhostButton onClick={() => void discardRecording()} destructive>
              <Trash2 className="h-4 w-4" />
              Yes, discard
            </GhostButton>
            <GhostButton onClick={() => setConfirmDiscard(false)}>Keep recording</GhostButton>
          </>
        ) : (
          <GhostButton onClick={() => setConfirmDiscard(true)}>
            <Trash2 className="h-4 w-4" />
            Discard
          </GhostButton>
        )}
        <div className="ml-auto flex gap-2">
          <GhostButton onClick={togglePause}>
            {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
            {paused ? 'Resume' : 'Pause'}
          </GhostButton>
          <PrimaryButton onClick={() => void stopRecording()}>
            <Square className="h-3.5 w-3.5 fill-current" />
            Stop and add to timeline
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}

function Saving() {
  const progress = useRecordStore((s) => s.progress);
  const seconds = useRecordStore((s) => s.seconds);
  const pct = Math.round(progress * 100);
  return (
    <div className="py-4">
      <div className="flex items-center justify-between text-xs text-krypt-muted">
        <span>{seconds > 0 ? `Saving ${clock(seconds)} of recording…` : 'Saving the recording…'}</span>
        <span className="font-mono text-white">{pct}%</span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/10">
        <div className="h-full bg-krypt-gradient transition-all" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-3 text-[11px] text-krypt-muted">The recording is being copied into finished files (no re-encoding), then placed on the timeline.</p>
    </div>
  );
}

/** A live input level bar, so a dead or muted microphone shows before an hour is recorded with it. */
function LevelMeter({ stream }: { stream: MediaStream | null }) {
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!stream || stream.getAudioTracks().length === 0) return;
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    let level = 0;
    const timer = window.setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
      // −48 dB … 0 dB across the bar, falling back slowly so short peaks are visible.
      const db = peak > 0 ? 20 * Math.log10(peak) : -100;
      level = Math.max(Math.min(1, Math.max(0, (db + 48) / 48)), level - 0.06);
      if (bar.current) {
        bar.current.style.width = `${Math.round(level * 100)}%`;
        bar.current.style.backgroundColor = db > -1 ? '#fb7185' : db > -9 ? '#fbbf24' : '#34d399';
      }
    }, 50);
    return () => {
      window.clearInterval(timer);
      void ctx.close().catch(() => {});
    };
  }, [stream]);
  return (
    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10" title="Microphone level">
      <div ref={bar} className="h-full w-0 rounded-full transition-[width] duration-75" />
    </div>
  );
}

function CameraPreview({ stream, className }: { stream: MediaStream | null; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return (
    <div className={cls('aspect-video overflow-hidden rounded-lg border border-white/10 bg-black/60', className)}>
      <video ref={ref} autoPlay muted playsInline className="h-full w-full object-cover" />
    </div>
  );
}
