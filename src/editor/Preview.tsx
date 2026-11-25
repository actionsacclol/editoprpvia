import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { Play, Pause, SkipBack, Volume2, Clapperboard, Pencil, Maximize2, Minimize2 } from 'lucide-react';
import type { MediaFile } from '@shared/types';
import { useMediaStore } from './mediaStore';
import {
  activeAudioClips,
  carriedSound,
  activeOverlays,
  activeVisualLayers,
  upcomingVideoClips,
  activeWordAt,
  backgroundCss,
  DEFAULT_KARAOKE_COLOR,
  karaokeActive,
  boxDecor,
  clipFilter,
  fadeFactor,
  hexToRgba,
  keyOpacity,
  REF_HEIGHT,
  resolvedValue,
  sourceTimeAt,
  speedAt,
  textAnim,
  timelineDuration,
  useTimelineStore,
  visibleText,
  cascadeProgress,
  cascadeWord,
  withKeyframes,
  type Canvas,
  type DrawClip,
  type MediaClip,
  type ShapeClip,
  type Stroke,
  type TextClip,
  type VisualLayer,
} from './timelineStore';
import { polyPoints } from './shapes';
import { CHROMA_FRAG, CHROMA_VERT, hexToRgb01 } from './chroma';
import { FX_FRAG, FX_VERT, fxMode } from './fx';
import { getVideoSegmenter, maskToCanvas } from './segmenter';
import { makeMaskCanvas } from './mask';
import { LUT_FRAG, LUT_VERT, lutAtlasPixels, type LutDef } from './lut';
import { useLutStore } from './lutStore';
import { cls, fmtTimecode } from '../utils/format';
import { IconButton } from '../components/common';
import { follow } from './previewSync';
import { tiltCss } from './tilt';
import { previewUrl } from './proxy';
import { directVolume, routeAudio, setMonitorVolume, unrouteAudio, wakeAudio } from './previewAudio';
import { LevelMeter } from './LevelMeter';
import { useToast } from '../state/ToastProvider';

// One toast per session per failed GPU pipeline — the layers fall back to the
// raw clip, so the user sees *something* plus one explanation, not silence.
const warnedOnce = new Set<string>();

/** Seconds ahead of the playhead to pre-mount upcoming video clips (parked on their first frame). */
const PRELOAD_AHEAD = 2.5;
const MIN_SCALE = 0.05;
const MAX_SCALE = 12;

function fit(cw: number, ch: number, aw: number, ah: number): { width: number; height: number } {
  if (cw <= 0 || ch <= 0 || aw <= 0 || ah <= 0) return { width: 0, height: 0 };
  const s = Math.min(cw / aw, ch / ah);
  return { width: aw * s, height: ah * s };
}

function useElementSize<T extends HTMLElement>(): [React.RefObject<T>, { w: number; h: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

function mediaBox(clip: MediaClip, stageW: number, stageH: number, canvas: Canvas) {
  const stageScale = canvas.width > 0 ? stageW / canvas.width : 0;
  const srcW = clip.sourceWidth || canvas.width;
  const srcH = clip.sourceHeight || canvas.height;
  const cfW = Math.max(0.01, 1 - clip.cropLeft - clip.cropRight);
  const cfH = Math.max(0.01, 1 - clip.cropTop - clip.cropBottom);
  const sw = srcW * cfW;
  const sh = srcH * cfH;
  const fitScale = Math.min(canvas.width / sw, canvas.height / sh);
  return {
    bw: sw * fitScale * clip.scaleX * stageScale,
    bh: sh * fitScale * clip.scaleY * stageScale,
    bcx: stageW / 2 + clip.posX * stageW,
    bcy: stageH / 2 + clip.posY * stageH,
    rotation: clip.rotation,
    cfW,
    cfH,
  };
}

interface LayerFx {
  dx: number;
  scale: number;
  blur: number;
  reveal?: { l: number; t: number; r: number; b: number };
  dy?: number;
  rot?: number;
}

function layerStyles(clip: MediaClip, stageW: number, stageH: number, canvas: Canvas, fx: LayerFx): { window: CSSProperties; media: CSSProperties } {
  const { bw, bh, bcx, bcy, rotation, cfW, cfH } = mediaBox(clip, stageW, stageH, canvas);
  const fullW = bw / cfW;
  const fullH = bh / cfH;
  const blurPx = fx.blur > 0 ? fx.blur * (stageH / REF_HEIGHT) : 0;
  const rv = fx.reveal;
  const decor = boxDecor(clip, bw, bh);
  return {
    window: {
      position: 'absolute',
      left: bcx - bw / 2,
      top: bcy - bh / 2,
      width: bw,
      height: bh,
      overflow: 'hidden',
      borderRadius: decor.radius > 0 ? decor.radius : undefined,
      // A shape mask cuts the box itself, so there is no box left to cast a shadow (export skips it too).
      boxShadow: decor.shadow && !clip.mask ? `0 ${decor.shadow.dy}px ${decor.shadow.blur}px rgba(0,0,0,${decor.shadow.alpha})` : undefined,
      // A leaning clip (tilt.ts): the same turn, in perspective. The export lays the flat picture on as a quad from the same numbers.
      transform: `translate(${fx.dx * stageW}px, ${(fx.dy ?? 0) * stageH}px) ${clip.tiltX || clip.tiltY ? tiltCss(clip.tiltX ?? 0, clip.tiltY ?? 0, rotation + (fx.rot ?? 0), stageH) : `rotate(${rotation + (fx.rot ?? 0)}deg)`} scale(${fx.scale})`,
      filter: blurPx > 0 ? `blur(${blurPx}px)` : undefined,
      clipPath: rv ? `inset(${rv.t * 100}% ${rv.r * 100}% ${rv.b * 100}% ${rv.l * 100}%)` : undefined,
    },
    media: {
      position: 'absolute',
      left: -clip.cropLeft * fullW,
      top: -clip.cropTop * fullH,
      width: fullW,
      height: fullH,
      objectFit: 'fill',
      filter: clipFilter(clip),
    },
  };
}

/**
 * `sound` is the audio clip linked to this picture when the two are in step:
 * the element then plays the file's sound at that clip's volume and fades, in
 * place of a second element that could drift from the picture.
 */
function syncMediaEl(el: HTMLMediaElement | null, clip: MediaClip | null, media: MediaFile | undefined, playing: boolean, t: number, gain: number, preload = false, sound: MediaClip | null = null): void {
  if (!el) return;
  // A file whose working copy is still being made has nothing to play yet.
  if (!clip || !media || media.needsConvert || (media.kind !== 'video' && media.kind !== 'audio')) {
    if (!el.paused) el.pause();
    return;
  }
  // Keyed by media, not clip: consecutive pieces of the same file (auto-cut,
  // split) just seek instead of reloading the source.
  // A large video plays from its small preview copy once that exists (proxy.ts).
  const url = media.kind === 'video' ? previewUrl(media) : media.mediaUrl;
  const key = url === media.mediaUrl ? media.id : `${media.id}|proxy`;
  if (el.dataset.media !== key) {
    el.dataset.media = key;
    // CORS mode, so effect passes can upload its frames to WebGL (a no-cors
    // frame from the krypteditor: scheme would be refused as cross-origin).
    el.crossOrigin = 'anonymous';
    el.src = url;
    el.load();
  }
  if (preload) {
    // Not on screen yet: park silently on the first frame so the cut is instant.
    el.volume = 0;
    if (!el.paused) el.pause();
    follow(el, sourceTimeAt(clip, clip.start), 1, false);
    return;
  }
  // Speed curves: rate follows the keyed value at the playhead; the seek
  // target is the integral of the curve (sourceTimeAt), so scrubbing lands on
  // the same source frame the export renders. Frozen clips hold one frame.
  const frozen = clip.freezeAt != null;
  el.preservesPitch = true; // keep pitch natural when the clip is sped up/slowed
  const heard = sound ?? clip;
  const vol = resolvedValue(heard, 'volume', t, heard.volume);
  // Audible elements play through the preview's audio graph (the clip's EQ /
  // compressor / pan, the level meter, then the volume slider). One that
  // can't be taken into it plays directly and applies the slider itself.
  const routed = gain > 0 && routeAudio(el, heard);
  el.volume = heard.muted || frozen ? 0 : Math.max(0, Math.min(1, vol * fadeFactor(heard, t) * gain * (routed ? 1 : directVolume())));
  // Paused or frozen: the exact frame. Playing: steered to stay within a frame (previewSync).
  // Shuttling (J / L): forwards the element plays faster; backwards it can't play, so it is stepped frame by frame.
  const shuttle = useTimelineStore.getState().shuttle;
  const rolling = playing && !frozen && shuttle > 0;
  follow(el, sourceTimeAt(clip, t), frozen ? 1 : speedAt(clip, t - clip.start) * (rolling ? shuttle : 1), rolling);
  // Sound is only worth hearing up to double speed.
  if (playing && (shuttle < 0 || shuttle > 2)) el.volume = 0;
  if (rolling) {
    wakeAudio();
    if (el.paused) void el.play().catch(() => {});
  } else if (!el.paused) {
    el.pause();
  }
}

export function Preview() {
  const stageRef = useRef<HTMLDivElement>(null);
  const [masterVol, setMasterVol] = useState(1);

  // ── Fullscreen preview (the whole panel: stage + controls) ──────────────
  const rootRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const onFs = (): void => setIsFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const media = useMediaStore((s) => s.media);
  const mediaById = useMemo(() => new Map(media.map((m) => [m.id, m])), [media]);

  const clips = useTimelineStore((s) => s.clips);
  const tracks = useTimelineStore((s) => s.tracks);
  const canvas = useTimelineStore((s) => s.canvas);
  const background = useTimelineStore((s) => s.background);
  const playing = useTimelineStore((s) => s.playing);
  const shuttle = useTimelineStore((s) => s.shuttle);
  const playhead = useTimelineStore((s) => s.playhead);
  const selectedIds = useTimelineStore((s) => s.selectedIds);
  const drawMode = useTimelineStore((s) => s.drawMode);
  const setPlayhead = useTimelineStore((s) => s.setPlayhead);
  const pause = useTimelineStore((s) => s.pause);
  const selectClip = useTimelineStore((s) => s.selectClip);
  const updateClip = useTimelineStore((s) => s.updateClip);
  const pushHistory = useTimelineStore((s) => s.pushHistory);

  const total = useMemo(() => timelineDuration(clips), [clips]);

  // Every visible video layer (all video tracks composite, back→front).
  const layers = useMemo(() => activeVisualLayers(clips, tracks, playhead), [clips, tracks, playhead]);
  // Clips starting within the next couple of seconds get mounted now (hidden,
  // parked on their first frame) so a cut never shows a loading black frame.
  const upcoming = useMemo(
    () =>
      upcomingVideoClips(clips, tracks, playhead, PRELOAD_AHEAD)
        .filter((c) => mediaById.get(c.mediaId)?.kind === 'video' && !layers.some((L) => L.clip.id === c.id))
        .map((clip) => ({ clip, opacity: 0, dx: 0, scale: 1, blur: 0, audioGain: 0 })),
    [clips, tracks, playhead, mediaById, layers],
  );
  const playingAudio = useMemo(() => activeAudioClips(clips, tracks, playhead), [clips, tracks, playhead]);
  // A picture whose linked sound is still in step with it plays that sound
  // itself; only the other audio clips get an element of their own.
  const carried = useMemo(() => carriedSound(layers, playingAudio, playhead, clips, tracks), [layers, playingAudio, playhead, clips, tracks]);
  const audioClips = useMemo(() => {
    const inPicture = new Set([...carried.values()].map((c) => c.id));
    return inPicture.size === 0 ? playingAudio : playingAudio.filter((c) => !inPicture.has(c.id));
  }, [playingAudio, carried]);
  const overlays = useMemo(() => activeOverlays(clips, playhead, tracks), [clips, playhead, tracks]);

  const anyVisual = layers.length > 0 || overlays.length > 0;

  const [outerRef, outerSize] = useElementSize<HTMLDivElement>();
  const stage = fit(outerSize.w, outerSize.h, canvas.width, canvas.height);
  const fontScale = stage.height / REF_HEIGHT;
  // Transform handles for the single selected video clip, when it's on screen
  // and not mid-slide (a sliding transition or fly animation carries a large
  // offset; a slow pan or shake only nudges the layer, so the handles stay).
  const selLayer = selectedIds.length === 1 ? layers.find((L) => L.clip.id === selectedIds[0] && Math.abs(L.dx) < 0.15 && Math.abs(L.dy ?? 0) < 0.15) : undefined;
  // The flash transition whites out the picture (under titles and captions).
  const flash = layers.reduce((m, L) => Math.max(m, L.flash ?? 0), 0);
  // Hide the edit handles in fullscreen — it's a viewing mode.
  const showBox = !!selLayer && stage.width > 0 && !isFullscreen;

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let anchorWall = performance.now();
    let anchorHead = useTimelineStore.getState().playhead;
    let lastWritten = anchorHead;
    let rate = useTimelineStore.getState().shuttle;
    const tick = (): void => {
      // An external seek (the seek bar, a ruler scrub) moves the playhead out
      // from under us — re-anchor instead of snapping it back.
      const cur = useTimelineStore.getState().playhead;
      // The same when the shuttle speed changes (J / L): the new rate counts from here.
      const now = useTimelineStore.getState().shuttle;
      if (Math.abs(cur - lastWritten) > 1e-6 || now !== rate) {
        anchorWall = performance.now();
        anchorHead = cur;
        lastWritten = cur;
        rate = now;
      }
      const t = anchorHead + ((performance.now() - anchorWall) / 1000) * rate;
      if (t >= total || t <= 0) {
        setPlayhead(t <= 0 ? 0 : total);
        pause();
        return;
      }
      // Cap store writes at ~60Hz — 120Hz ProMotion displays would otherwise
      // double the React re-render load for no visible benefit.
      if (Math.abs(t - lastWritten) >= 1 / 62) {
        setPlayhead(t);
        lastWritten = t;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, total, setPlayhead, pause]);

  const onVolume = useCallback((v: number) => {
    setMonitorVolume(v);
    setMasterVol(v);
  }, []);

  // Select + drag a clip's position by dragging it in the preview.
  const onLayerDown = (clip: MediaClip) => (e: ReactPointerEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    selectClip(clip.id);
    pushHistory();
    const sx = e.clientX;
    const sy = e.clientY;
    const px0 = clip.posX;
    const py0 = clip.posY;
    const mv = (ev: PointerEvent): void => {
      updateClip(clip.id, { posX: px0 + (ev.clientX - sx) / stage.width, posY: py0 + (ev.clientY - sy) / stage.height });
    };
    const up = (): void => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  };

  const toStart = (): void => {
    pause();
    setPlayhead(0);
  };
  const toggleFullscreen = (): void => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void rootRef.current?.requestFullscreen().catch(() => {});
  };
  const toggle = (): void => {
    const st = useTimelineStore.getState();
    if (st.playing) {
      st.pause();
      return;
    }
    if (st.playhead >= total - 0.001) st.setPlayhead(0);
    st.play();
  };

  const empty = clips.length === 0;

  return (
    <div ref={rootRef} className={cls('flex h-full min-h-0 flex-col gap-3 px-1', isFullscreen && 'bg-krypt-void p-6')}>
      <div ref={outerRef} data-agent="preview" className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-krypt-surface shadow-krypt-card">
        <div
          ref={stageRef}
          className="relative overflow-hidden shadow-[0_0_0_1px_rgba(255,255,255,0.12),0_10px_40px_rgba(0,0,0,0.6)]"
          style={{ width: stage.width, height: stage.height, background: background.type === 'blur' ? '#000' : backgroundCss(background) }}
        >
          {background.type === 'blur' && layers[0] && (
            <BlurBackdrop layer={layers[0]} media={mediaById.get(layers[0].clip.mediaId)} playing={playing} playhead={playhead} />
          )}

          {/* One keyed list for live + preloaded layers, so a preloaded element
              is kept (not remounted) when its clip becomes active. */}
          {[...layers.map((L) => ({ L, preload: false })), ...upcoming.map((L) => ({ L, preload: true }))].map(({ L, preload }) => (
            <MediaLayerView
              key={L.clip.id}
              layer={L}
              media={mediaById.get(L.clip.mediaId)}
              stageW={stage.width}
              stageH={stage.height}
              canvas={canvas}
              playing={playing}
              playhead={playhead}
              masterVol={masterVol}
              preload={preload}
              sound={preload ? null : (carried.get(L.clip.id) ?? null)}
              onDown={onLayerDown(L.clip)}
            />
          ))}

          {flash > 0 && <div className="pointer-events-none absolute inset-0" style={{ background: '#ffffff', opacity: flash }} />}

          {overlays.map((oc) =>
            oc.type === 'text' ? (
              <TextOverlay key={oc.id} clip={oc} stageW={stage.width} stageH={stage.height} fontScale={fontScale} t={playhead} />
            ) : oc.type === 'shape' ? (
              <ShapeOverlay key={oc.id} clip={oc} stageW={stage.width} stageH={stage.height} fontScale={fontScale} t={playhead} />
            ) : (
              <DrawOverlay key={oc.id} clip={oc} stageW={stage.width} stageH={stage.height} fontScale={fontScale} t={playhead} />
            ),
          )}

          {showBox && selLayer && <TransformBox clip={selLayer.clip} stageRef={stageRef} stageW={stage.width} stageH={stage.height} canvas={canvas} />}

          {drawMode && stage.width > 0 && <DrawCapture stageW={stage.width} stageH={stage.height} />}
        </div>

        {!anyVisual && (
          <div className="pointer-events-none absolute flex flex-col items-center gap-3 text-center text-krypt-muted">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-white/10 bg-krypt-panel/80">
              <Clapperboard className="h-8 w-8 text-krypt-purple" />
            </div>
            <div className="text-sm">{empty ? 'Add clips to the timeline to preview your edit.' : audioClips.length > 0 ? 'Playing audio…' : 'No clip under the playhead.'}</div>
          </div>
        )}
        {/* One element per audible audio track, so overlapping tracks mix like the export. */}
        {audioClips.map((c) => (
          <AudioTrackPlayer key={c.trackId} clip={c} media={mediaById.get(c.mediaId)} playing={playing} playhead={playhead} masterVol={masterVol} />
        ))}
      </div>

      <div className="flex items-center gap-3 px-1">
        <IconButton title="Jump to start" onClick={toStart} disabled={empty}>
          <SkipBack className="h-4 w-4" />
        </IconButton>
        <IconButton title={playing ? 'Pause (Space)' : 'Play (Space)'} onClick={toggle} active={playing} disabled={empty}>
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </IconButton>
        <div className="font-mono text-sm tabular-nums text-white">
          {fmtTimecode(playhead)}
          <span className="text-krypt-muted"> / {fmtTimecode(total)}</span>
          {playing && shuttle !== 1 && (
            <span className="ml-2 rounded bg-krypt-pink/20 px-1.5 py-0.5 text-[11px] text-krypt-pink" title="Shuttle speed (J / L, K stops)">
              {shuttle < 0 ? '◀ ' : ''}
              {Math.abs(shuttle)}x
            </span>
          )}
        </div>
        <input
          type="range"
          min={0}
          max={Math.max(0.01, total)}
          step={0.01}
          value={Math.min(playhead, total)}
          disabled={empty}
          onChange={(e) => {
            const st = useTimelineStore.getState();
            st.setPlayhead(Number(e.target.value));
          }}
          className="h-1 min-w-0 flex-1 cursor-pointer accent-krypt-pink disabled:opacity-30"
          title="Seek"
        />
        {!isFullscreen && <DrawControls />}
        <div className="flex items-center gap-2">
          <Volume2 className="h-4 w-4 text-krypt-muted" />
          <LevelMeter active={playing} />
          <input type="range" min={0} max={1} step={0.01} value={masterVol} onChange={(e) => onVolume(Number(e.target.value))} className="h-1 w-28 cursor-pointer accent-krypt-purple" title="Preview volume (your speakers only: exports are not affected)" />
        </div>
        <IconButton title={isFullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen preview'} onClick={toggleFullscreen} active={isFullscreen} disabled={empty && !isFullscreen}>
          {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </IconButton>
      </div>
    </div>
  );
}

// ── Freehand drawing: toggle + brush, and the stage capture overlay ─────────
function DrawControls() {
  const drawMode = useTimelineStore((s) => s.drawMode);
  const setDrawMode = useTimelineStore((s) => s.setDrawMode);
  const brush = useTimelineStore((s) => s.brush);
  const setBrush = useTimelineStore((s) => s.setBrush);
  return (
    <div className="flex items-center gap-2">
      <IconButton title={drawMode ? 'Drawing on — click to stop' : 'Draw on the canvas'} onClick={() => setDrawMode(!drawMode)} active={drawMode}>
        <Pencil className="h-4 w-4" />
      </IconButton>
      {drawMode && (
        <>
          <input type="color" value={brush.color} onChange={(e) => setBrush({ color: e.target.value })} className="h-6 w-8 cursor-pointer rounded border border-white/10 bg-transparent" title="Brush color" />
          <input type="range" min={2} max={40} step={1} value={brush.width} onChange={(e) => setBrush({ width: Number(e.target.value) })} className="h-1 w-20 cursor-pointer accent-krypt-pink" title="Brush size" />
        </>
      )}
    </div>
  );
}

function DrawCapture({ stageW, stageH }: { stageW: number; stageH: number }) {
  const brush = useTimelineStore((s) => s.brush);
  const addStroke = useTimelineStore((s) => s.addStroke);
  const drawClipRef = useRef<string | null>(null);
  const [live, setLive] = useState<number[] | null>(null);

  // Each time draw mode (re)mounts this overlay, start a fresh drawing.
  useEffect(() => () => void (drawClipRef.current = null), []);

  const onDown = (e: ReactPointerEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const pts: number[] = [(e.clientX - rect.left) / stageW, (e.clientY - rect.top) / stageH];
    setLive([...pts]);
    const mv = (ev: PointerEvent): void => {
      pts.push((ev.clientX - rect.left) / stageW, (ev.clientY - rect.top) / stageH);
      setLive([...pts]);
    };
    const up = (): void => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
      if (pts.length >= 4) {
        const stroke: Stroke = { color: brush.color, width: brush.width, points: pts };
        drawClipRef.current = addStroke(drawClipRef.current, stroke);
      }
      setLive(null);
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className="absolute inset-0 z-10 cursor-crosshair" onPointerDown={onDown}>
      {live && live.length >= 4 && (
        <svg className="pointer-events-none absolute inset-0 h-full w-full" width={stageW} height={stageH}>
          <polyline
            points={polyToPx(live, stageW, stageH)}
            fill="none"
            stroke={brush.color}
            strokeWidth={brush.width * (stageH / REF_HEIGHT)}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </div>
  );
}

function polyToPx(frac: number[], w: number, h: number): string {
  let s = '';
  for (let i = 0; i + 1 < frac.length; i += 2) s += `${frac[i] * w},${frac[i + 1] * h} `;
  return s.trim();
}

// ── One audio track's playback (owns its own <audio>) ─────────────────────
function AudioTrackPlayer({
  clip,
  media,
  playing,
  playhead,
  masterVol,
}: {
  clip: MediaClip;
  media: MediaFile | undefined;
  playing: boolean;
  playhead: number;
  masterVol: number;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    void masterVol; // the slider acts in the audio graph; a change still re-syncs an element that plays directly
    syncMediaEl(audioRef.current, clip, media, playing, playhead, 1);
  });
  // Stop when the track has nothing under the playhead (unmount).
  useEffect(() => {
    const el = audioRef.current;
    return () => {
      if (!el) return;
      if (!el.paused) el.pause();
      unrouteAudio(el);
    };
  }, []);
  return <audio ref={audioRef} className="hidden" />;
}

// ── One composited video/image layer (owns its own <video>) ───────────────
function MediaLayerView({
  layer,
  media,
  stageW,
  stageH,
  canvas,
  playing,
  playhead,
  masterVol,
  preload = false,
  sound = null,
  onDown,
}: {
  layer: VisualLayer;
  media: MediaFile | undefined;
  stageW: number;
  stageH: number;
  canvas: Canvas;
  playing: boolean;
  playhead: number;
  masterVol: number;
  /** Mounted ahead of time: hidden, silent, parked on the first frame. */
  preload?: boolean;
  /** The linked audio clip this picture's element plays (see carriedSound). */
  sound?: MediaClip | null;
  onDown: (e: ReactPointerEvent) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const isVideo = media?.kind === 'video';
  const isImage = media?.kind === 'image';
  // A preview copy that arrives while paused has to reach the element: re-render (and so re-sync) when it does.
  useMediaStore((st) => (media ? st.proxies[media.id] : undefined));

  // Keep this layer's <video> matched to the playhead on every render.
  useEffect(() => {
    void masterVol; // the slider acts in the audio graph; a change still re-syncs an element that plays directly
    if (isVideo) syncMediaEl(videoRef.current, layer.clip, media, playing, playhead, sound ? (layer.mix ?? 1) : layer.audioGain, preload, sound);
  });
  // Stop playback when this layer leaves the composite (unmount).
  useEffect(
    () => () => {
      const el = videoRef.current;
      if (!el) return;
      if (!el.paused) el.pause();
      unrouteAudio(el);
    },
    [],
  );

  const toast = useToast();
  const [broken, setBroken] = useState<{ fx?: boolean; chroma?: boolean; seg?: boolean; lut?: boolean }>({});
  const degrade = (kind: 'fx' | 'chroma' | 'seg' | 'lut', message: string) => (): void => {
    setBroken((b) => (b[kind] ? b : { ...b, [kind]: true }));
    if (!warnedOnce.has(kind)) {
      warnedOnce.add(kind);
      toast.warn(message);
    }
  };

  const lut = useLutStore((s) => (layer.clip.lut ? s.luts.find((l) => l.id === layer.clip.lut) : undefined));

  // Rendered mask → CSS mask-image on the window div (which IS the visible
  // box). Capped at 512px on the long edge; regenerated only when the mask or
  // stage geometry changes, not per frame.
  const maskUrl = useMemo(() => {
    const mk = layer.clip.mask;
    if (!mk) return null;
    const { bw, bh } = mediaBox(layer.clip, stageW, stageH, canvas);
    const s = Math.min(1, 512 / Math.max(bw, bh, 1));
    return makeMaskCanvas(bw * s, bh * s, mk).toDataURL();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer.clip, stageW, stageH, canvas]);

  const eff = withKeyframes(layer.clip, playhead);
  const st = layerStyles(eff, stageW, stageH, canvas, { dx: layer.dx, scale: layer.scale, blur: layer.blur, reveal: layer.reveal, dy: layer.dy, rot: layer.rot });
  st.window.opacity = preload ? 0 : layer.opacity;
  if (preload) st.window.pointerEvents = 'none';
  if (eff.blend && eff.blend !== 'normal') st.window.mixBlendMode = eff.blend;
  if (maskUrl) {
    st.window.maskImage = `url(${maskUrl})`;
    st.window.maskSize = '100% 100%';
    st.window.WebkitMaskImage = `url(${maskUrl})`;
    st.window.WebkitMaskSize = '100% 100%';
  }
  // A failed GPU pipeline falls back to the raw clip instead of a blank layer.
  const live = !preload; // GPU passes only for layers actually on screen
  const seg = live && !!(isVideo && layer.clip.bgRemove) && !broken.seg;
  const keyed = live && !!(isVideo && layer.clip.chromaKey && !seg) && !broken.chroma;
  // GPU stylized effect (glitch/VHS/…) — only if not already keyed/segmented.
  const fxOn = live && fxMode(layer.clip.effect) > 0 && !seg && !keyed && (isVideo || isImage) && !broken.fx;
  // Color LUT — one GPU pass per clip; exclusive with the other passes for now.
  const lutOn = live && !!lut && !seg && !keyed && !fxOn && (isVideo || isImage) && !broken.lut;
  const hideRaw = keyed || seg || fxOn || lutOn;

  return (
    <div style={st.window} onPointerDown={onDown}>
      <video ref={videoRef} playsInline style={isVideo ? { ...st.media, opacity: hideRaw ? 0 : 1 } : { display: 'none' }} />
      {keyed && (
        <ChromaCanvas videoRef={videoRef} clip={layer.clip} style={st.media} onUnavailable={degrade('chroma', 'Chroma key is unavailable on this device (WebGL failed) — showing the clip unkeyed.')} />
      )}
      {seg && (
        <SegmentCanvas videoRef={videoRef} style={st.media} onUnavailable={degrade('seg', 'Background removal is unavailable (model not downloaded, or offline) — showing the clip without it.')} />
      )}
      {fxOn && (
        <EffectCanvas
          videoRef={isVideo ? videoRef : undefined}
          imageUrl={isImage ? media?.mediaUrl : undefined}
          effect={layer.clip.effect}
          style={st.media}
          onUnavailable={degrade('fx', 'GPU effects are unavailable on this device (WebGL failed) — clips show without them.')}
        />
      )}
      {lutOn && lut && (
        <LutCanvas
          videoRef={isVideo ? videoRef : undefined}
          imageUrl={isImage ? media?.mediaUrl : undefined}
          lut={lut}
          amount={layer.clip.lutAmount ?? 1}
          style={st.media}
          onUnavailable={degrade('lut', 'LUT rendering is unavailable on this device (WebGL failed) — showing the clip ungraded.')}
        />
      )}
      {isImage && !fxOn && media && <img src={media.mediaUrl} alt="" style={st.media} draggable={false} />}
      {(layer.clip.vignette ?? 0) > 0 && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            background: `radial-gradient(ellipse 75% 75% at 50% 50%, rgba(0,0,0,0) 60%, rgba(0,0,0,${layer.clip.vignette}) 100%)`,
          }}
        />
      )}
    </div>
  );
}

// ── Stylized GPU effect layer (glitch/VHS/… via the fx shader) ─────────────
function EffectCanvas({
  videoRef,
  imageUrl,
  effect,
  style,
  onUnavailable,
}: {
  videoRef?: React.RefObject<HTMLVideoElement>;
  imageUrl?: string;
  effect: string;
  style: CSSProperties;
  onUnavailable?: () => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const modeRef = useRef(fxMode(effect));
  modeRef.current = fxMode(effect);

  useEffect(() => {
    const cnv = ref.current;
    if (!cnv) return;
    const gl = cnv.getContext('webgl', { premultipliedAlpha: false, alpha: true });
    const prog = gl ? makeProgram(gl, FX_VERT, FX_FRAG) : null;
    if (!gl || !prog) {
      onUnavailable?.();
      return;
    }
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    const uTime = gl.getUniformLocation(prog, 'u_time');
    const uRes = gl.getUniformLocation(prog, 'u_res');
    const uMode = gl.getUniformLocation(prog, 'u_mode');

    let img: HTMLImageElement | null = null;
    let imgReady = false;
    if (imageUrl) {
      img = new Image();
      img.crossOrigin = 'anonymous'; // uploaded to WebGL (see syncMediaEl)
      img.onload = () => {
        imgReady = true;
      };
      img.src = imageUrl;
    }

    let raf = 0;
    let uploaded = -1; // last source time uploaded (-1 = never)
    const t0 = performance.now();
    const render = (): void => {
      const v = videoRef?.current;
      let src: TexImageSource | null = null;
      let w = 0;
      let h = 0;
      let frameTime = 0;
      if (v && v.videoWidth > 0 && v.readyState >= 2) {
        src = v;
        w = v.videoWidth;
        h = v.videoHeight;
        frameTime = v.paused ? v.currentTime : performance.now() / 1000;
      } else if (img && imgReady) {
        src = img;
        w = img.naturalWidth;
        h = img.naturalHeight;
      }
      if (src && w > 0) {
        if (cnv.width !== w || cnv.height !== h) {
          cnv.width = w;
          cnv.height = h;
        }
        gl.viewport(0, 0, w, h);
        try {
          // Re-upload only when the underlying frame changed; the shader still
          // redraws every frame so animated noise/jitter keeps moving.
          if (frameTime !== uploaded) {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
            uploaded = frameTime;
          }
          gl.uniform1f(uTime, (performance.now() - t0) / 1000);
          gl.uniform2f(uRes, w, h);
          gl.uniform1i(uMode, modeRef.current);
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        } catch {
          /* frame not uploadable yet */
        }
      }
      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(raf);
      gl.deleteProgram(prog);
      gl.deleteBuffer(buf);
      gl.deleteTexture(tex);
    };
  }, [videoRef, imageUrl]);

  return <canvas ref={ref} style={style} />;
}

// ── Color LUT layer (WebGL; only for clips with a LUT assigned) ────────────
function LutCanvas({
  videoRef,
  imageUrl,
  lut,
  amount,
  style,
  onUnavailable,
}: {
  videoRef?: React.RefObject<HTMLVideoElement>;
  imageUrl?: string;
  lut: LutDef;
  amount: number;
  style: CSSProperties;
  onUnavailable?: () => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const amountRef = useRef(amount);
  amountRef.current = amount;

  useEffect(() => {
    const cnv = ref.current;
    if (!cnv) return;
    const gl = cnv.getContext('webgl', { premultipliedAlpha: false, alpha: true });
    const prog = gl ? makeProgram(gl, LUT_VERT, LUT_FRAG) : null;
    if (!gl || !prog) {
      onUnavailable?.();
      return;
    }
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const setParams = (): void => {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    };
    const srcTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    setParams();
    const lutTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, lutTex);
    setParams();
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, lut.size * lut.size, lut.size, 0, gl.RGBA, gl.UNSIGNED_BYTE, lutAtlasPixels(lut));
    gl.uniform1i(gl.getUniformLocation(prog, 'u_tex'), 0);
    gl.uniform1i(gl.getUniformLocation(prog, 'u_lut'), 1);
    const uSize = gl.getUniformLocation(prog, 'u_size');
    const uAmount = gl.getUniformLocation(prog, 'u_amount');

    let img: HTMLImageElement | null = null;
    let imgReady = false;
    if (imageUrl) {
      img = new Image();
      img.crossOrigin = 'anonymous'; // uploaded to WebGL (see syncMediaEl)
      img.onload = () => {
        imgReady = true;
      };
      img.src = imageUrl;
    }

    let raf = 0;
    let last = ''; // skip redraws while paused on an unchanged frame + amount
    const render = (): void => {
      const v = videoRef?.current;
      let src: TexImageSource | null = null;
      let w = 0;
      let h = 0;
      let key = '';
      if (v && v.videoWidth > 0 && v.readyState >= 2) {
        src = v;
        w = v.videoWidth;
        h = v.videoHeight;
        key = v.paused ? `${v.currentTime}|${amountRef.current}` : `live${performance.now()}`;
      } else if (img && imgReady) {
        src = img;
        w = img.naturalWidth;
        h = img.naturalHeight;
        key = `img|${amountRef.current}`;
      }
      if (src && w > 0 && key !== last) {
        last = key;
        if (cnv.width !== w || cnv.height !== h) {
          cnv.width = w;
          cnv.height = h;
        }
        gl.viewport(0, 0, w, h);
        try {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, srcTex);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
          gl.uniform1f(uSize, lut.size);
          gl.uniform1f(uAmount, amountRef.current);
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        } catch {
          /* frame not uploadable yet */
        }
      }
      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(raf);
      gl.deleteProgram(prog);
      gl.deleteBuffer(buf);
      gl.deleteTexture(srcTex);
      gl.deleteTexture(lutTex);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoRef, imageUrl, lut]);

  return <canvas ref={ref} style={style} />;
}

// ── Blurred-cover background (the bottom layer, scaled to fill + blurred) ───
function BlurBackdrop({ layer, media, playing, playhead }: { layer: VisualLayer; media: MediaFile | undefined; playing: boolean; playhead: number }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const isVideo = media?.kind === 'video';
  const isImage = media?.kind === 'image';
  // A preview copy that arrives while paused has to reach the element: re-render (and so re-sync) when it does.
  useMediaStore((st) => (media ? st.proxies[media.id] : undefined));

  useEffect(() => {
    if (isVideo) syncMediaEl(videoRef.current, layer.clip, media, playing, playhead, 0); // muted backdrop
  });
  useEffect(
    () => () => {
      const el = videoRef.current;
      if (el && !el.paused) el.pause();
    },
    [],
  );

  const style: CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', filter: 'blur(26px) brightness(0.65)', transform: 'scale(1.12)' };
  return (
    <div className="absolute inset-0 overflow-hidden">
      {isVideo && <video ref={videoRef} playsInline muted style={style} />}
      {isImage && media && <img src={media.mediaUrl} alt="" style={style} draggable={false} />}
    </div>
  );
}

// ── CapCut-style transform handles ────────────────────────────────────────
type HandleType = 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'e' | 'w' | 'rot';

function TransformBox({ clip, stageRef, stageW, stageH, canvas }: { clip: MediaClip; stageRef: React.RefObject<HTMLDivElement>; stageW: number; stageH: number; canvas: Canvas }) {
  const updateClip = useTimelineStore((s) => s.updateClip);
  const pushHistory = useTimelineStore((s) => s.pushHistory);
  const { bw, bh, bcx, bcy, rotation } = mediaBox(clip, stageW, stageH, canvas);
  const clampS = (v: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, v));

  const onHandle = (e: ReactPointerEvent, type: HandleType): void => {
    e.preventDefault();
    e.stopPropagation();
    pushHistory();
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    const θ = (rotation * Math.PI) / 180;
    const cos = Math.cos(θ);
    const sin = Math.sin(θ);
    const C = { x: bcx, y: bcy };
    const hx0 = bw / 2;
    const hy0 = bh / 2;
    const sx0 = clip.scaleX;
    const sy0 = clip.scaleY;

    const mv = (ev: PointerEvent): void => {
      const px = ev.clientX - rect.left;
      const py = ev.clientY - rect.top;
      if (type === 'rot') {
        const deg = (Math.atan2(py - C.y, px - C.x) * 180) / Math.PI + 90;
        updateClip(clip.id, { rotation: Math.round(((deg + 180) % 360) - 180) });
        return;
      }
      const vx = px - C.x;
      const vy = py - C.y;
      const lx = cos * vx + sin * vy;
      const ly = -sin * vx + cos * vy;
      if (type === 'e' || type === 'w') {
        updateClip(clip.id, { scaleX: clampS((sx0 * Math.abs(lx)) / hx0) });
      } else if (type === 'n' || type === 's') {
        updateClip(clip.id, { scaleY: clampS((sy0 * Math.abs(ly)) / hy0) });
      } else {
        const f = Math.hypot(lx, ly) / Math.hypot(hx0, hy0);
        updateClip(clip.id, { scaleX: clampS(sx0 * f), scaleY: clampS(sy0 * f) });
      }
    };
    const up = (): void => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  };

  const corners: Array<{ t: HandleType; x: number; y: number; c: string }> = [
    { t: 'nw', x: 0, y: 0, c: 'nwse-resize' },
    { t: 'ne', x: bw, y: 0, c: 'nesw-resize' },
    { t: 'sw', x: 0, y: bh, c: 'nesw-resize' },
    { t: 'se', x: bw, y: bh, c: 'nwse-resize' },
  ];
  const edges: Array<{ t: HandleType; x: number; y: number; c: string }> = [
    { t: 'n', x: bw / 2, y: 0, c: 'ns-resize' },
    { t: 's', x: bw / 2, y: bh, c: 'ns-resize' },
    { t: 'w', x: 0, y: bh / 2, c: 'ew-resize' },
    { t: 'e', x: bw, y: bh / 2, c: 'ew-resize' },
  ];

  return (
    <div className="pointer-events-none absolute" style={{ left: bcx - bw / 2, top: bcy - bh / 2, width: bw, height: bh, transform: `rotate(${rotation}deg)`, transformOrigin: 'center' }}>
      <div className="absolute inset-0 border-[1.5px] border-krypt-pink/90" />
      <div className="absolute left-1/2 w-px -translate-x-1/2 bg-krypt-pink/80" style={{ height: 22, top: -22 }} />
      <Handle x={bw / 2} y={-22} cursor="grab" round onDown={(e) => onHandle(e, 'rot')} />
      {edges.map((h) => (
        <Handle key={h.t} x={h.x} y={h.y} cursor={h.c} onDown={(e) => onHandle(e, h.t)} />
      ))}
      {corners.map((h) => (
        <Handle key={h.t} x={h.x} y={h.y} cursor={h.c} round onDown={(e) => onHandle(e, h.t)} />
      ))}
    </div>
  );
}

function Handle({ x, y, cursor, round, onDown }: { x: number; y: number; cursor: string; round?: boolean; onDown: (e: ReactPointerEvent) => void }) {
  return (
    <div
      onPointerDown={onDown}
      className={cls('pointer-events-auto absolute h-3 w-3 border-2 border-krypt-pink bg-white shadow', round ? 'rounded-full' : 'rounded-[2px]')}
      style={{ left: x - 6, top: y - 6, cursor }}
    />
  );
}

// ── Chroma-key layer (WebGL; only for clips with chroma key on) ───────────
function makeProgram(gl: WebGLRenderingContext, vs: string, fs: string): WebGLProgram | null {
  const compile = (type: number, src: string): WebGLShader | null => {
    const sh = gl.createShader(type);
    if (!sh) return null;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    return gl.getShaderParameter(sh, gl.COMPILE_STATUS) ? sh : null;
  };
  const v = compile(gl.VERTEX_SHADER, vs);
  const f = compile(gl.FRAGMENT_SHADER, fs);
  if (!v || !f) return null;
  const prog = gl.createProgram();
  if (!prog) return null;
  gl.attachShader(prog, v);
  gl.attachShader(prog, f);
  gl.linkProgram(prog);
  return gl.getProgramParameter(prog, gl.LINK_STATUS) ? prog : null;
}

function ChromaCanvas({
  videoRef,
  clip,
  style,
  onUnavailable,
}: {
  videoRef: React.RefObject<HTMLVideoElement>;
  clip: MediaClip;
  style: CSSProperties;
  onUnavailable?: () => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const params = useRef(clip);
  params.current = clip;

  useEffect(() => {
    const cnv = ref.current;
    if (!cnv) return;
    const gl = cnv.getContext('webgl', { premultipliedAlpha: false, alpha: true });
    const prog = gl ? makeProgram(gl, CHROMA_VERT, CHROMA_FRAG) : null;
    if (!gl || !prog) {
      onUnavailable?.();
      return;
    }
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    const uKey = gl.getUniformLocation(prog, 'u_key');
    const uSim = gl.getUniformLocation(prog, 'u_sim');
    const uSm = gl.getUniformLocation(prog, 'u_smooth');

    let raf = 0;
    let lastKey = '';
    const render = (): void => {
      const v = videoRef.current;
      if (v && v.videoWidth > 0 && v.readyState >= 2) {
        const c = params.current;
        // Skip the GPU work entirely when paused on an unchanged frame + params.
        const key = `${v.currentTime}|${c.chromaColor}|${c.chromaSimilarity}|${c.chromaSmoothness}`;
        if (!v.paused || key !== lastKey) {
          lastKey = key;
          if (cnv.width !== v.videoWidth || cnv.height !== v.videoHeight) {
            cnv.width = v.videoWidth;
            cnv.height = v.videoHeight;
          }
          gl.viewport(0, 0, cnv.width, cnv.height);
          try {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
            const [r, g, b] = hexToRgb01(c.chromaColor);
            gl.uniform3f(uKey, r, g, b);
            gl.uniform1f(uSim, c.chromaSimilarity);
            gl.uniform1f(uSm, c.chromaSmoothness);
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          } catch {
            /* frame not uploadable yet */
          }
        }
      }
      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(raf);
      gl.deleteProgram(prog);
      gl.deleteBuffer(buf);
      gl.deleteTexture(tex);
    };
  }, [videoRef]);

  return <canvas ref={ref} style={style} />;
}

// ── AI background-removal layer (MediaPipe; only for bg-remove clips) ──────
function SegmentCanvas({ videoRef, style, onUnavailable }: { videoRef: React.RefObject<HTMLVideoElement>; style: CSSProperties; onUnavailable?: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let raf = 0;
    let stopped = false;
    let segmenter: Awaited<ReturnType<typeof getVideoSegmenter>> | null = null;
    let lastTs = -1;
    let lastFrame = -1;
    void getVideoSegmenter().then(
      (s) => {
        if (!stopped) segmenter = s;
      },
      (err) => {
        console.warn('[bg-remove] segmenter unavailable', err);
        if (!stopped) onUnavailable?.();
      },
    );

    const render = (): void => {
      const v = videoRef.current;
      const cnv = ref.current;
      const ctx = cnv?.getContext('2d');
      // Segmentation is the most expensive per-frame work in the app. When the
      // clip is paused on an unchanged frame, skip inference entirely.
      const stale = v ? v.paused && v.currentTime === lastFrame : true;
      if (v && cnv && ctx && segmenter && v.videoWidth > 0 && v.readyState >= 2 && !stale) {
        lastFrame = v.currentTime;
        if (cnv.width !== v.videoWidth) {
          cnv.width = v.videoWidth;
          cnv.height = v.videoHeight;
        }
        let ts = performance.now();
        if (ts <= lastTs) ts = lastTs + 1;
        lastTs = ts;
        try {
          const result = segmenter.segmentForVideo(v, ts);
          const mask = result.confidenceMasks?.[0];
          ctx.globalCompositeOperation = 'source-over';
          ctx.clearRect(0, 0, cnv.width, cnv.height);
          ctx.drawImage(v, 0, 0, cnv.width, cnv.height);
          if (mask) {
            ctx.globalCompositeOperation = 'destination-in';
            ctx.drawImage(maskToCanvas(mask), 0, 0, cnv.width, cnv.height);
            ctx.globalCompositeOperation = 'source-over';
          }
          result.close();
        } catch {
          /* segmenter not ready / busy this frame */
        }
      }
      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
  }, [videoRef]);

  return <canvas ref={ref} style={style} />;
}

function TextOverlay({ clip, stageW, stageH, fontScale, t }: { clip: TextClip; stageW: number; stageH: number; fontScale: number; t: number }) {
  const pushHistory = useTimelineStore((s) => s.pushHistory);
  const updateClip = useTimelineStore((s) => s.updateClip);
  const selectClip = useTimelineStore((s) => s.selectClip);
  const selectedIds = useTimelineStore((s) => s.selectedIds);
  const anim = textAnim(clip, t);
  const ex = resolvedValue(clip, 'x', t, clip.x);
  const ey = resolvedValue(clip, 'y', t, clip.y);
  const opacity = fadeFactor(clip, t) * anim.opacity * keyOpacity(clip, t);

  const onDown = (e: ReactPointerEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    selectClip(clip.id);
    pushHistory();
    const startX = e.clientX;
    const startY = e.clientY;
    const ox = clip.x;
    const oy = clip.y;
    const mv = (ev: PointerEvent): void => {
      updateClip(clip.id, {
        x: Math.max(0, Math.min(1, ox + (ev.clientX - startX) / stageW)),
        y: Math.max(0, Math.min(1, oy + (ev.clientY - startY) / stageH)),
      });
    };
    const up = (): void => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  };

  const bgStyle = clip.bgStyle ?? 'none';
  const padX = (clip.bgPadding ?? 16) * fontScale;
  const padY = padX * 0.55;
  const rad = (clip.bgRadius ?? 10) * fontScale;
  const bgCss = hexToRgba(clip.bgColor ?? '#000000', clip.bgOpacity ?? 1);
  const box = bgStyle === 'box';
  const highlight = bgStyle === 'highlight';
  // Anchored text pins an edge of the words (not of the box around them) at x,
  // and animations grow from that edge: the same as the export canvas.
  const anchor = clip.anchor;
  const edgePad = box ? padX : 0;
  const shiftX = anchor === 'left' ? `${-edgePad}px` : anchor === 'right' ? `calc(-100% + ${edgePad}px)` : '-50%';

  return (
    <div
      onPointerDown={onDown}
      className={cls('absolute cursor-move select-none whitespace-pre-wrap leading-tight', selectedIds.includes(clip.id) ? 'outline outline-1 outline-krypt-pink/70' : '')}
      style={{
        left: ex * stageW + anim.dxFrac * stageW,
        top: ey * stageH + anim.dyFrac * stageH,
        transform: `translate(${shiftX}, -50%) rotate(${anim.rotate}deg) scale(${anim.scale})`,
        transformOrigin: anchor === 'left' ? `${edgePad}px 50%` : anchor === 'right' ? `calc(100% - ${edgePad}px) 50%` : undefined,
        // Lines break only where the text has a line break, as in the export
        // (a box positioned by `left` would otherwise wrap at the frame's edge).
        width: 'max-content',
        fontSize: clip.fontSize * fontScale,
        fontFamily: clip.fontFamily,
        // The app's UI font features (stylistic sets) must not reach clip text: the
        // export canvas doesn't apply them, and Impact's turn lowercase into capitals.
        fontFeatureSettings: 'normal',
        color: clip.color,
        fontWeight: clip.bold ? 800 : 500,
        fontStyle: clip.italic ? 'italic' : 'normal',
        textAlign: clip.align,
        opacity,
        filter: anim.blur > 0 ? `blur(${anim.blur * fontScale}px)` : undefined,
        textShadow:
          clip.glow > 0
            ? `0 0 ${clip.glow * fontScale}px ${clip.glowColor}, 0 0 ${clip.glow * fontScale * 2}px ${clip.glowColor}`
            : '0 2px 8px rgba(0,0,0,0.55)',
        WebkitTextStroke: clip.outlineWidth > 0 ? `${clip.outlineWidth * fontScale}px ${clip.outlineColor}` : undefined,
        paintOrder: 'stroke',
        ...(box ? { background: bgCss, padding: `${padY}px ${padX}px`, borderRadius: rad } : null),
      }}
    >
      {highlight ? (
        <span
          style={{
            background: bgCss,
            padding: `${padY}px ${padX}px`,
            borderRadius: rad,
            WebkitBoxDecorationBreak: 'clone',
            boxDecorationBreak: 'clone',
          }}
        >
          {karaokeActive(clip) ? <KaraokeWords clip={clip} t={t} fontScale={fontScale} /> : <PlainWords clip={clip} t={t} />}
        </span>
      ) : karaokeActive(clip) ? (
        <KaraokeWords clip={clip} t={t} fontScale={fontScale} />
      ) : (
        <PlainWords clip={clip} t={t} />
      )}
    </div>
  );
}

/** The text as it stands at t: all of it, or, during a word-by-word entrance, each word as far in as it has come. */
function PlainWords({ clip, t }: { clip: TextClip; t: number }) {
  const p = cascadeProgress(clip, t);
  if (p === null) return <>{visibleText(clip, t)}</>;
  const lines = clip.text.split('\n').map((l) => l.split(' '));
  const n = lines.reduce((sum, l) => sum + l.filter(Boolean).length, 0);
  let i = 0;
  return (
    <>
      {lines.map((words, li) => (
        <span key={li}>
          {li > 0 ? '\n' : ''}
          {words.map((w, wi) => {
            const lead = wi > 0 ? ' ' : '';
            if (!w) return <span key={wi}>{lead}</span>;
            const a = cascadeWord(p, i++, n);
            return (
              <span key={wi}>
                {lead}
                <span style={{ display: 'inline-block', opacity: a.op, transform: `translateY(${a.dy}em)` }}>{w}</span>
              </span>
            );
          })}
        </span>
      ))}
    </>
  );
}

/** Word-by-word karaoke styling: the word being spoken is colored, popped, or
 *  boxed, driven by the per-word timings auto-captions stored on the clip. */
function KaraokeWords({ clip, t, fontScale }: { clip: TextClip; t: number; fontScale: number }) {
  const wi = activeWordAt(clip, t);
  const mode = clip.karaoke ?? 'color';
  const color = clip.karaokeColor ?? DEFAULT_KARAOKE_COLOR;
  return (
    <>
      {clip.words!.map((w, i) => {
        // Whisper words carry their leading space — keep it outside the styled
        // span so pop/box transforms don't swallow the gap.
        const lead = i === 0 ? '' : (/^\s*/.exec(w.text)?.[0] ?? '');
        const word = i === 0 ? w.text.trimStart() : w.text.slice(lead.length);
        let style: CSSProperties | undefined;
        if (i === wi) {
          if (mode === 'pop') style = { color, display: 'inline-block', transform: 'scale(1.18)', transformOrigin: '50% 80%' };
          else if (mode === 'box')
            style = { background: color, color: '#111111', borderRadius: 6 * fontScale, padding: `0 ${4 * fontScale}px`, WebkitTextStroke: '0px transparent', textShadow: 'none' };
          else style = { color };
        }
        return (
          <span key={i}>
            {lead}
            <span style={style}>{word}</span>
          </span>
        );
      })}
    </>
  );
}

// ── Shape overlay (vector) ─────────────────────────────────────────────────
function ShapeOverlay({ clip, stageW, stageH, fontScale, t }: { clip: ShapeClip; stageW: number; stageH: number; fontScale: number; t: number }) {
  const pushHistory = useTimelineStore((s) => s.pushHistory);
  const updateClip = useTimelineStore((s) => s.updateClip);
  const selectClip = useTimelineStore((s) => s.selectClip);
  const selectedIds = useTimelineStore((s) => s.selectedIds);
  const anim = textAnim(clip, t);
  const ex = resolvedValue(clip, 'x', t, clip.x) + anim.dxFrac;
  const ey = resolvedValue(clip, 'y', t, clip.y) + anim.dyFrac;
  const opacity = fadeFactor(clip, t) * anim.opacity * keyOpacity(clip, t);
  const w = Math.max(2, clip.w * stageW);
  const h = Math.max(2, clip.h * stageH);

  const onDown = (e: ReactPointerEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    selectClip(clip.id);
    pushHistory();
    const sx = e.clientX;
    const sy = e.clientY;
    const ox = clip.x;
    const oy = clip.y;
    const mv = (ev: PointerEvent): void => {
      updateClip(clip.id, { x: Math.max(0, Math.min(1, ox + (ev.clientX - sx) / stageW)), y: Math.max(0, Math.min(1, oy + (ev.clientY - sy) / stageH)) });
    };
    const up = (): void => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  };

  return (
    <div
      onPointerDown={onDown}
      className={cls('absolute cursor-move', selectedIds.includes(clip.id) ? 'outline outline-1 outline-krypt-pink/70' : '')}
      style={{ left: ex * stageW - w / 2, top: ey * stageH - h / 2, width: w, height: h, transform: `rotate(${clip.rotation + anim.rotate}deg) scale(${anim.scale})`, opacity }}
    >
      <ShapeSvg kind={clip.shape} w={w} h={h} fill={clip.fill} stroke={clip.stroke} strokeWidth={clip.strokeWidth * fontScale} />
    </div>
  );
}

function ShapeSvg({ kind, w, h, fill, stroke, strokeWidth }: { kind: ShapeClip['shape']; w: number; h: number; fill: string; stroke: string; strokeWidth: number }) {
  const fillC = fill || 'none';
  const strokeC = strokeWidth > 0 && stroke ? stroke : 'none';
  const inset = strokeWidth / 2;
  const common = { fill: fillC, stroke: strokeC, strokeWidth, strokeLinejoin: 'round' as const };
  const pp = polyPoints(kind);
  return (
    <svg width={w} height={h} className="pointer-events-none absolute inset-0 overflow-visible">
      {kind === 'rect' && <rect x={inset} y={inset} width={Math.max(0, w - strokeWidth)} height={Math.max(0, h - strokeWidth)} {...common} />}
      {kind === 'rounded' && <rect x={inset} y={inset} width={Math.max(0, w - strokeWidth)} height={Math.max(0, h - strokeWidth)} rx={Math.min(w, h) * 0.18} {...common} />}
      {kind === 'ellipse' && <ellipse cx={w / 2} cy={h / 2} rx={Math.max(0, w / 2 - inset)} ry={Math.max(0, h / 2 - inset)} {...common} />}
      {kind === 'line' && <line x1={0} y1={h / 2} x2={w} y2={h / 2} stroke={stroke || '#ffffff'} strokeWidth={Math.max(1, strokeWidth)} strokeLinecap="round" />}
      {pp && <polygon points={polyToPx(pp, w, h)} {...common} />}
    </svg>
  );
}

// ── Freehand drawing overlay (display only; edited via timeline/inspector) ──
function DrawOverlay({ clip, stageW, stageH, fontScale, t }: { clip: DrawClip; stageW: number; stageH: number; fontScale: number; t: number }) {
  const anim = textAnim(clip, t);
  const ox = (resolvedValue(clip, 'x', t, clip.x) + anim.dxFrac) * stageW;
  const oy = (resolvedValue(clip, 'y', t, clip.y) + anim.dyFrac) * stageH;
  const opacity = fadeFactor(clip, t) * anim.opacity * keyOpacity(clip, t);
  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full" width={stageW} height={stageH} style={{ opacity, transform: `translate(${ox}px, ${oy}px) scale(${anim.scale})` }}>
      {clip.strokes.map((s, i) => (
        <polyline key={i} points={polyToPx(s.points, stageW, stageH)} fill="none" stroke={s.color} strokeWidth={s.width * fontScale} strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </svg>
  );
}
