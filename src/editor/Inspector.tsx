import { useMemo, useState } from 'react';
import { Link2Off, Copy, Trash2, Volume2, VolumeX, Gauge, Sun, Type as TypeIcon, AlignLeft, AlignCenter, AlignRight, Sparkles, Move, Crop, RotateCcw, Italic, Diamond, Blend, Eraser, Image as ImageIcon, Scissors, Square, Pencil, Circle, Flag } from 'lucide-react';
import { DEFAULT_MASK, type ClipMask } from './mask';
import { fxMode } from './fx';
import { parseCube } from './lut';
import { renderReversedClip } from './reverse';
import { useLutStore } from './lutStore';
import { useToast } from '../state/ToastProvider';
import { useMediaStore } from './mediaStore';
import {
  chapterStamp,
  BACKGROUNDS,
  BLEND_MODES,
  EASINGS,
  EFFECTS,
  FONTS,
  MAX_FADE,
  MAX_KEY_SPEED,
  MAX_SPEED,
  MIN_KEY_SPEED,
  MIN_SPEED,
  SPEED_PRESETS,
  DEFAULT_KARAOKE_COLOR,
  KARAOKE_STYLES,
  hasSpeedKeys,
  linkPartners,
  CLIP_ANIMS,
  MOTIONS,
  TEXT_ANIMS,
  TEXT_BG,
  TRANSITIONS,
  clipHasKeys,
  keyframeAt,
  resolvedValue,
  useTimelineStore,
  type BlendMode,
  type TransitionType,
  type BackgroundType,
  type Clip,
  type ClipPatch,
  type DrawClip,
  type Easing,
  type MediaClip,
  type MotionAnim,
  type ShapeClip,
  type TextAnim,
  type TextBgStyle,
  type TextClip,
} from './timelineStore';
import { cls } from '../utils/format';
import { EQ_RANGE, VOICE_PRESET, hasAudioFx, isVoicePreset, resolveFx } from './audioFx';

const TRANSFORM_RESET: ClipPatch = { scaleX: 1, scaleY: 1, posX: 0, posY: 0, rotation: 0, tiltX: 0, tiltY: 0, cropTop: 0, cropRight: 0, cropBottom: 0, cropLeft: 0 };

/**
 * Properties panel for the selected clip — the CapCut-style inspector. Media
 * clips expose volume/mute, speed, color adjustments and fades; text clips
 * expose content, font, color, alignment and fades. Continuous controls
 * snapshot history once when the gesture starts (onPointerDown / onFocus).
 */
export function Inspector() {
  // Select stable references and derive the array with useMemo — returning a
  // fresh array straight from the selector makes zustand re-render forever.
  const clips = useTimelineStore((s) => s.clips);
  const selectedIds = useTimelineStore((s) => s.selectedIds);
  const selected = useMemo(() => clips.filter((c) => selectedIds.includes(c.id)), [clips, selectedIds]);

  if (selected.length === 0) {
    return (
      <div className="flex-1 space-y-5 overflow-auto p-4">
        <BackgroundControls />
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 text-center">
          <Sparkles className="mx-auto h-6 w-6 text-krypt-purple/70" />
          <div className="mt-2 text-sm font-semibold text-white">Select a clip to edit it</div>
          <div className="mt-1 text-xs leading-relaxed text-krypt-muted">
            Click a clip on the timeline (or marquee-select several). Video/image clips show Effects, Transitions, Chroma key, AI background
            removal, Transform, Opacity, Crop, Color &amp; Fades. Text, shapes and drawings can keyframe position and opacity via the ◇ next to
            each slider.
          </div>
        </div>
      </div>
    );
  }

  if (selected.length > 1) return <BatchInspector clips={selected} />;

  const clip = selected[0];
  return (
    <div className="flex-1 space-y-5 overflow-auto p-4">
      {clip.type === 'media' ? (
        <MediaInspector clip={clip} />
      ) : clip.type === 'text' ? (
        <TextInspector clip={clip} />
      ) : clip.type === 'shape' ? (
        <ShapeInspector clip={clip} />
      ) : (
        <DrawInspector clip={clip} />
      )}
      <ClipActions id={clip.id} />
    </div>
  );
}

/** Multi-selection: batch-edit (text styling when all are text) + delete all. */
function BatchInspector({ clips }: { clips: Clip[] }) {
  const update = useTimelineStore((s) => s.updateSelected);
  const push = useTimelineStore((s) => s.pushHistory);
  const removeSelected = useTimelineStore((s) => s.removeSelected);
  const textClips = clips.filter((c): c is TextClip => c.type === 'text');
  const allText = textClips.length === clips.length;
  const first = textClips[0];

  return (
    <div className="flex-1 space-y-5 overflow-auto p-4">
      <Header icon={Sparkles} title={`${clips.length} clips selected`} sub={allText ? 'text · batch' : 'batch'} />

      {allText && first && (
        <>
          <Group title="Style" icon={TypeIcon}>
            <div>
              <div className="mb-1 text-xs text-krypt-muted">Font</div>
              <Select value={first.fontFamily} onChange={(v) => update({ fontFamily: v })}>
                {FONTS.map((f) => (
                  <option key={f.value} value={f.value} style={{ fontFamily: f.value }}>
                    {f.label}
                  </option>
                ))}
              </Select>
            </div>
            <Slider label="Size" value={first.fontSize} min={20} max={240} step={1} fmt={(v) => `${v}`} onChange={(v) => update({ fontSize: v })} />
            <div className="flex items-center justify-between">
              <span className="text-xs text-krypt-muted">Color</span>
              <input type="color" value={first.color} onPointerDown={push} onChange={(e) => update({ color: e.target.value })} className="h-7 w-12 cursor-pointer rounded border border-white/10 bg-transparent" />
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  push();
                  update({ bold: !first.bold });
                }}
                className={cls('rounded-lg border px-3 py-2 text-xs font-bold transition', first.bold ? 'border-krypt-purple/50 bg-krypt-purple/15 text-white' : 'border-white/10 bg-white/5 text-white/80')}
              >
                B
              </button>
              <button
                onClick={() => {
                  push();
                  update({ italic: !first.italic });
                }}
                className={cls('rounded-lg border px-3 py-2 transition', first.italic ? 'border-krypt-purple/50 bg-krypt-purple/15 text-white' : 'border-white/10 bg-white/5 text-white/80')}
              >
                <Italic className="h-3.5 w-3.5" />
              </button>
              <div className="flex flex-1 overflow-hidden rounded-lg border border-white/10">
                {(['left', 'center', 'right'] as const).map((v) => {
                  const Icon = v === 'left' ? AlignLeft : v === 'center' ? AlignCenter : AlignRight;
                  return (
                    <button
                      key={v}
                      onClick={() => {
                        push();
                        update({ align: v });
                      }}
                      className={cls('flex flex-1 items-center justify-center py-2 transition', first.align === v ? 'bg-krypt-purple/20 text-white' : 'bg-white/5 text-krypt-muted hover:text-white')}
                    >
                      <Icon className="h-4 w-4" />
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-krypt-muted">Outline</span>
              <input type="color" value={first.outlineColor} onPointerDown={push} onChange={(e) => update({ outlineColor: e.target.value })} className="h-7 w-12 cursor-pointer rounded border border-white/10 bg-transparent" />
            </div>
            <Slider label="Outline width" value={first.outlineWidth} min={0} max={16} step={1} fmt={(v) => (v === 0 ? 'Off' : `${v}`)} onChange={(v) => update({ outlineWidth: v })} />
          </Group>
          <TextBgGroup
            style={first.bgStyle ?? 'none'}
            color={first.bgColor ?? '#000000'}
            opacity={first.bgOpacity ?? 0.6}
            radius={first.bgRadius ?? 10}
            padding={first.bgPadding ?? 16}
            onPatch={(p) => update(p)}
            push={push}
          />
          <p className="text-[11px] text-krypt-muted/70">Edits apply to all {clips.length} selected captions.</p>
        </>
      )}

      <div className="flex gap-2 border-t border-white/10 pt-4">
        <button
          onClick={() => removeSelected()}
          className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs font-semibold text-rose-200 transition hover:bg-rose-500/20"
        >
          <Trash2 className="h-4 w-4" /> Delete {clips.length}
        </button>
      </div>
    </div>
  );
}

function MediaInspector({ clip }: { clip: MediaClip }) {
  const toast = useToast();
  const media = useMediaStore((s) => s.media.find((m) => m.id === clip.mediaId));
  const update = useTimelineStore((s) => s.updateClip);
  const setSpeed = useTimelineStore((s) => s.setSpeed);
  const applySpeedPreset = useTimelineStore((s) => s.applySpeedPreset);
  const freezeFrame = useTimelineStore((s) => s.freezeFrameAtPlayhead);
  const [reversing, setReversing] = useState<number | null>(null);

  const doReverse = async (): Promise<void> => {
    if (!media || media.kind !== 'video') return;
    if (hasSpeedKeys(clip)) {
      toast.warn('Remove the speed curve before reversing (set Speed to Constant).');
      return;
    }
    setReversing(0);
    try {
      const { data, span } = await renderReversedClip(clip, media, useTimelineStore.getState().fps, (r) => setReversing(r));
      const r = await window.krypt.media.saveDerived(data, `reversed-${Date.now().toString(36)}.mp4`);
      if (!r.ok || !r.data) throw new Error(r.message ?? 'Could not store the reversed clip.');
      useMediaStore.getState().add([r.data]);
      push();
      update(clip.id, { mediaId: r.data.id, inPoint: 0, sourceDuration: span });
      // The reversed file carries the reversed sound: the linked sound clip plays it too.
      if (sound?.type === 'media' && Math.abs(sound.inPoint - clip.inPoint) < 0.02 && Math.abs(sound.duration - clip.duration) < 0.02) {
        update(sound.id, { mediaId: r.data.id, inPoint: 0, sourceDuration: span });
      }
      toast.success('Clip reversed.');
    } catch (e) {
      toast.error(`Reverse failed: ${(e as Error).message}`);
    } finally {
      setReversing(null);
    }
  };
  const detachAudio = useTimelineStore((s) => s.detachAudio);
  const push = useTimelineStore((s) => s.pushHistory);
  const maxFade = Math.min(MAX_FADE, clip.duration);
  const tracks = useTimelineStore((s) => s.tracks);
  const allClips = useTimelineStore((s) => s.clips);
  const kindOf = (trackId: string): string | undefined => tracks.find((t) => t.id === trackId)?.kind;
  const onAudioLane = kindOf(clip.trackId) === 'audio';
  // A sound clip made from a video file has no picture to adjust.
  const hasVisual = !onAudioLane && (media?.kind === 'video' || media?.kind === 'image');
  const partners = linkPartners(allClips, clip);
  // This picture's sound, when it is a clip of its own on an audio track.
  const sound = onAudioLane ? undefined : partners.find((p) => p.type === 'media' && p.mediaId === clip.mediaId && kindOf(p.trackId) === 'audio');
  const laneName = (trackId: string): string => tracks.find((t) => t.id === trackId)?.name ?? 'another track';
  const unlink = useTimelineStore((s) => s.unlinkSelected);
  const select = useTimelineStore((s) => s.selectClip);
  const quiet = 'flex w-full items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-white/90 transition hover:bg-white/10';

  return (
    <>
      <Header icon={Sparkles} title={media?.name ?? 'Clip'} sub={clip.type} />

      {sound ? (
        <Group title="Audio">
          <p className="text-xs leading-relaxed text-krypt-muted">
            This clip's sound is a clip of its own on {laneName(sound.trackId)}. Volume, fades and noise reduction are set there; the two move and cut together.
          </p>
          <button onClick={() => select(sound.id)} className={quiet}>
            <Volume2 className="h-4 w-4" /> Select the sound
          </button>
          <button onClick={() => unlink()} title="Let the picture and its sound move and cut on their own" className={quiet}>
            <Link2Off className="h-4 w-4" /> Unlink
          </button>
        </Group>
      ) : (
      <Group title="Audio">
        <KfSlider clip={clip} prop="volume" base={clip.volume} label="Volume" min={0} max={1} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`} />
        <button
          onClick={() => {
            push();
            update(clip.id, { muted: !clip.muted });
          }}
          className={cls(
            'flex w-full items-center justify-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold transition',
            clip.muted
              ? 'border-rose-500/40 bg-rose-500/10 text-rose-200'
              : 'border-white/10 bg-white/5 text-white/90 hover:bg-white/10',
          )}
        >
          {clip.muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          {clip.muted ? 'Muted' : 'Mute'}
        </button>
        {media?.kind === 'video' && !onAudioLane && (
          <button onClick={() => detachAudio(clip.id)} title="Put this clip's sound on an audio track as a clip of its own, linked to the picture" className={quiet}>
            <Scissors className="h-4 w-4" /> Separate the sound
          </button>
        )}
        {partners.length > 0 && (
          <>
            <p className="text-[11px] text-krypt-muted/70">
              Linked to {partners.length === 1 ? `the clip on ${laneName(partners[0].trackId)}` : `${partners.length} clips`}: they move and cut together. Alt+drag moves this one alone.
            </p>
            <button onClick={() => unlink()} className={quiet}>
              <Link2Off className="h-4 w-4" /> Unlink
            </button>
          </>
        )}
        <button
          onClick={() => {
            push();
            update(clip.id, { denoise: !clip.denoise });
          }}
          className={cls(
            'w-full rounded-lg border px-3 py-2 text-xs font-semibold transition',
            clip.denoise ? 'border-krypt-purple/50 bg-krypt-purple/15 text-white' : 'border-white/10 bg-white/5 text-white/80 hover:bg-white/10',
          )}
        >
          {clip.denoise ? 'On — noise reduction' : 'Reduce noise'}
        </button>
        {clip.denoise && (
          <p className="text-[11px] text-krypt-muted/70">On-device spectral gate for steady noise (hiss, hum, fans). Applied when the project exports.</p>
        )}
        <SoundShaping clip={clip} />
      </Group>
      )}

      <Group title="Speed" icon={Gauge}>
        <div className="grid grid-cols-5 gap-1">
          {SPEED_PRESETS.map((p) => {
            const active = p.value === 'none' ? !hasSpeedKeys(clip) : false;
            return (
              <button
                key={p.value}
                onClick={() => applySpeedPreset(clip.id, p.value)}
                className={cls(
                  'rounded-md px-1 py-1.5 text-[10.5px] transition',
                  active ? 'bg-krypt-purple/25 text-white ring-1 ring-krypt-purple/50' : 'bg-white/5 text-krypt-muted hover:text-white',
                )}
              >
                {p.label}
              </button>
            );
          })}
        </div>
        <KfSlider
          clip={clip}
          prop="speed"
          base={clip.speed}
          label="Playback speed"
          min={hasSpeedKeys(clip) ? MIN_KEY_SPEED : MIN_SPEED}
          max={hasSpeedKeys(clip) ? MAX_KEY_SPEED : MAX_SPEED}
          step={0.05}
          fmt={(v) => `${v.toFixed(2)}×`}
          onBase={(v) => setSpeed(clip.id, v)}
        />
        {hasSpeedKeys(clip) && (
          <p className="text-[11px] text-krypt-muted/70">Speed curve active — ◇ edits the curve at the playhead; pitch stays natural in preview and export.</p>
        )}
        {media?.kind === 'video' && (
          <div className="flex gap-2">
            <button
              onClick={() => {
                if (!freezeFrame()) toast.warn('Move the playhead inside this clip first.');
              }}
              disabled={clip.freezeAt != null}
              className="flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-white/90 transition hover:bg-white/10 disabled:opacity-40"
            >
              Freeze frame (3s)
            </button>
            <button
              onClick={() => void doReverse()}
              disabled={reversing !== null || clip.freezeAt != null}
              className="flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-white/90 transition hover:bg-white/10 disabled:opacity-40"
            >
              {reversing !== null ? `Reversing… ${Math.round(reversing * 100)}%` : 'Reverse clip'}
            </button>
          </div>
        )}
        {clip.freezeAt != null && <p className="text-[11px] text-krypt-muted/70">Frozen frame — trim it to any length; it plays silent.</p>}
      </Group>

      {hasVisual && (
        <>
          <Group title="Remove background" icon={Eraser}>
            <button
              onClick={() => {
                push();
                update(clip.id, { bgRemove: !clip.bgRemove, chromaKey: false });
              }}
              className={cls(
                'w-full rounded-lg border px-3 py-2 text-xs font-semibold transition',
                clip.bgRemove ? 'border-krypt-purple/50 bg-krypt-purple/15 text-white' : 'border-white/10 bg-white/5 text-white/80 hover:bg-white/10',
              )}
            >
              {clip.bgRemove ? 'On — AI background removal' : 'Remove background (AI)'}
            </button>
            {clip.bgRemove && (
              <p className="text-[11px] text-krypt-muted/70">On-device person segmentation. First use downloads a small model. Works best with a person on screen.</p>
            )}
          </Group>

          <Group title="Chroma key" icon={Blend}>
            <button
              onClick={() => {
                push();
                update(clip.id, { chromaKey: !clip.chromaKey, bgRemove: false });
              }}
              className={cls(
                'w-full rounded-lg border px-3 py-2 text-xs font-semibold transition',
                clip.chromaKey ? 'border-krypt-purple/50 bg-krypt-purple/15 text-white' : 'border-white/10 bg-white/5 text-white/80 hover:bg-white/10',
              )}
            >
              {clip.chromaKey ? 'On — keying out the color' : 'Remove green screen'}
            </button>
            {clip.chromaKey && (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-krypt-muted">Key color</span>
                  <input
                    type="color"
                    value={clip.chromaColor}
                    onPointerDown={push}
                    onChange={(e) => update(clip.id, { chromaColor: e.target.value })}
                    className="h-7 w-12 cursor-pointer rounded border border-white/10 bg-transparent"
                  />
                </div>
                <Slider label="Similarity" value={clip.chromaSimilarity} min={0} max={1} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => update(clip.id, { chromaSimilarity: v })} />
                <Slider label="Smoothness" value={clip.chromaSmoothness} min={0} max={0.5} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => update(clip.id, { chromaSmoothness: v })} />
              </>
            )}
          </Group>

          <Group title="Adjust" icon={Sun}>
            <Slider label="Brightness" value={clip.brightness} min={0} max={200} step={1} fmt={(v) => `${v}%`} onChange={(v) => update(clip.id, { brightness: v })} />
            <Slider label="Contrast" value={clip.contrast} min={0} max={200} step={1} fmt={(v) => `${v}%`} onChange={(v) => update(clip.id, { contrast: v })} />
            <Slider label="Saturation" value={clip.saturation} min={0} max={200} step={1} fmt={(v) => `${v}%`} onChange={(v) => update(clip.id, { saturation: v })} />
            <Slider label="Hue" value={clip.hue ?? 0} min={-180} max={180} step={1} fmt={(v) => `${v}°`} onChange={(v) => update(clip.id, { hue: v })} />
            <Slider label="Vignette" value={clip.vignette ?? 0} min={0} max={1} step={0.01} fmt={(v) => (v === 0 ? 'Off' : `${Math.round(v * 100)}%`)} onChange={(v) => update(clip.id, { vignette: v })} />
          </Group>

          <Group title="Blend mode" icon={Blend}>
            <Select value={clip.blend ?? 'normal'} onChange={(v) => update(clip.id, { blend: v as BlendMode })}>
              {BLEND_MODES.map((b) => (
                <option key={b.value} value={b.value}>
                  {b.label}
                </option>
              ))}
            </Select>
          </Group>

          <Group title="Effect" icon={Sparkles}>
            <div className="grid grid-cols-3 gap-1">
              {EFFECTS.map((e) => (
                <button
                  key={e.value}
                  onClick={() => {
                    push();
                    update(clip.id, { effect: e.value });
                  }}
                  className={cls(
                    'rounded-md px-1.5 py-1.5 text-[11px] transition',
                    clip.effect === e.value ? 'bg-krypt-purple/25 text-white ring-1 ring-krypt-purple/50' : 'bg-white/5 text-krypt-muted hover:text-white',
                  )}
                >
                  {e.label}
                </button>
              ))}
            </div>
          </Group>

          <LutGroup clip={clip} />

          <Group title="Transition" icon={Blend}>
            <Select value={clip.transition} onChange={(v) => update(clip.id, { transition: v as TransitionType })}>
              {TRANSITIONS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
            {clip.transition !== 'none' && (
              <Slider
                label="Duration"
                value={clip.transitionDur}
                min={0.1}
                max={Math.min(5, clip.duration)}
                step={0.1}
                fmt={(v) => `${v.toFixed(1)}s`}
                onChange={(v) => update(clip.id, { transitionDur: v })}
              />
            )}
            <p className="text-[11px] text-krypt-muted/70">Plays where this clip meets the previous clip on the same track — they must touch.</p>
          </Group>

          <AnimationGroup clip={clip} anims={CLIP_ANIMS} />

          <Group
            title="Transform"
            icon={Move}
            action={
              <button
                onClick={() => {
                  push();
                  update(clip.id, TRANSFORM_RESET);
                }}
                title="Reset transform & crop"
                className="flex items-center gap-1 text-[11px] text-krypt-muted transition hover:text-white"
              >
                <RotateCcw className="h-3 w-3" /> Reset
              </button>
            }
          >
            <p className="text-[11px] text-krypt-muted/70">Drag in the preview to move; corner/edge dots resize. ◇ adds a keyframe at the playhead.</p>
            <KfSlider clip={clip} prop="scaleX" base={clip.scaleX} label="Scale X" min={0.1} max={4} step={0.02} fmt={(v) => `${Math.round(v * 100)}%`} />
            <KfSlider clip={clip} prop="scaleY" base={clip.scaleY} label="Scale Y" min={0.1} max={4} step={0.02} fmt={(v) => `${Math.round(v * 100)}%`} />
            <KfSlider clip={clip} prop="posX" base={clip.posX} label="Position X" min={-1} max={1} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`} />
            <KfSlider clip={clip} prop="posY" base={clip.posY} label="Position Y" min={-1} max={1} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`} />
            <KfSlider clip={clip} prop="rotation" base={clip.rotation} label="Rotation" min={-180} max={180} step={1} fmt={(v) => `${v}°`} />
            <KfSlider clip={clip} prop="tiltX" base={clip.tiltX ?? 0} label="Tilt back" min={-60} max={60} step={1} fmt={(v) => `${v}°`} />
            <KfSlider clip={clip} prop="tiltY" base={clip.tiltY ?? 0} label="Tilt sideways" min={-60} max={60} step={1} fmt={(v) => `${v}°`} />
            <KfSlider clip={clip} prop="opacity" base={clip.opacity ?? 1} label="Opacity" min={0} max={1} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`} />
            <Slider label="Corners" value={clip.cornerRadius ?? 0} min={0} max={0.5} step={0.005} fmt={(v) => (v === 0 ? 'Square' : `${Math.round(v * 200)}%`)} onChange={(v) => update(clip.id, { cornerRadius: v })} />
            <Slider label="Shadow" value={clip.shadow ?? 0} min={0} max={1} step={0.01} fmt={(v) => (v === 0 ? 'Off' : `${Math.round(v * 100)}%`)} onChange={(v) => update(clip.id, { shadow: v })} />
          </Group>

          <Group title="Crop" icon={Crop}>
            <Slider label="Top" value={clip.cropTop} min={0} max={0.45} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => update(clip.id, { cropTop: v })} />
            <Slider label="Bottom" value={clip.cropBottom} min={0} max={0.45} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => update(clip.id, { cropBottom: v })} />
            <Slider label="Left" value={clip.cropLeft} min={0} max={0.45} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => update(clip.id, { cropLeft: v })} />
            <Slider label="Right" value={clip.cropRight} min={0} max={0.45} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => update(clip.id, { cropRight: v })} />
          </Group>

          <MaskGroup clip={clip} />
        </>
      )}

      <Group title="Fade">
        <Slider label="Fade in" value={clip.fadeIn} min={0} max={maxFade} step={0.1} fmt={(v) => `${v.toFixed(1)}s`} onChange={(v) => update(clip.id, { fadeIn: v })} />
        <Slider label="Fade out" value={clip.fadeOut} min={0} max={maxFade} step={0.1} fmt={(v) => `${v.toFixed(1)}s`} onChange={(v) => update(clip.id, { fadeOut: v })} />
      </Group>
    </>
  );
}

/** Color LUT (.cube) picker: import into the session bin, assign per clip. */
/** EQ, low cut, compressor and pan for a clip's sound: heard in the preview and written to the export alike. */
function SoundShaping({ clip }: { clip: MediaClip }) {
  const update = useTimelineStore((s) => s.updateClip);
  const push = useTimelineStore((s) => s.pushHistory);
  const fx = resolveFx(clip);
  const voice = isVoicePreset(clip);
  const shaped = hasAudioFx({ ...clip, pan: 0 });
  const db = (v: number): string => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;
  const toggle = 'w-full rounded-lg border px-3 py-2 text-xs font-semibold transition';
  const on = 'border-krypt-purple/50 bg-krypt-purple/15 text-white';
  const off = 'border-white/10 bg-white/5 text-white/80 hover:bg-white/10';
  return (
    <>
      <button
        onClick={() => {
          push();
          update(clip.id, voice ? { lowCut: false, eqLow: 0, eqMid: 0, eqHigh: 0, comp: 0 } : VOICE_PRESET);
        }}
        title="For a spoken voice: removes rumble, takes out a little mud, adds presence and air, and evens out the level"
        className={cls(toggle, voice ? on : off)}
      >
        {voice ? 'On: voice enhance' : 'Enhance voice'}
      </button>
      <Slider label="Lows" value={fx.eqLow} min={-EQ_RANGE} max={EQ_RANGE} step={0.5} fmt={db} onChange={(v) => update(clip.id, { eqLow: v })} />
      <Slider label="Presence" value={fx.eqMid} min={-EQ_RANGE} max={EQ_RANGE} step={0.5} fmt={db} onChange={(v) => update(clip.id, { eqMid: v })} />
      <Slider label="Highs" value={fx.eqHigh} min={-EQ_RANGE} max={EQ_RANGE} step={0.5} fmt={db} onChange={(v) => update(clip.id, { eqHigh: v })} />
      <Slider label="Compressor" value={fx.comp} min={0} max={1} step={0.05} fmt={(v) => (v === 0 ? 'Off' : `${Math.round(v * 100)}%`)} onChange={(v) => update(clip.id, { comp: v })} />
      <button
        onClick={() => {
          push();
          update(clip.id, { lowCut: !fx.lowCut });
        }}
        title="Removes rumble below 80 Hz: desk bumps, traffic, microphone handling"
        className={cls(toggle, fx.lowCut ? on : off)}
      >
        {fx.lowCut ? 'On: low cut (80 Hz)' : 'Low cut (80 Hz)'}
      </button>
      <Slider
        label="Pan"
        value={fx.pan}
        min={-1}
        max={1}
        step={0.05}
        fmt={(v) => (Math.abs(v) < 0.025 ? 'Centre' : `${Math.round(Math.abs(v) * 100)}% ${v < 0 ? 'left' : 'right'}`)}
        onChange={(v) => update(clip.id, { pan: Math.abs(v) < 0.025 ? 0 : v })}
      />
      {shaped && !voice && (
        <button
          onClick={() => {
            push();
            update(clip.id, { lowCut: false, eqLow: 0, eqMid: 0, eqHigh: 0, comp: 0 });
          }}
          className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] text-krypt-muted transition hover:bg-white/10 hover:text-white"
        >
          Reset EQ and compressor
        </button>
      )}
    </>
  );
}

function LutGroup({ clip }: { clip: MediaClip }) {
  const toast = useToast();
  const luts = useLutStore((s) => s.luts);
  const addLut = useLutStore((s) => s.add);
  const update = useTimelineStore((s) => s.updateClip);
  const push = useTimelineStore((s) => s.pushHistory);

  const importLuts = async (): Promise<void> => {
    const r = await window.krypt.media.pickLuts();
    if (!r.ok) {
      toast.error(r.message ?? 'Could not open LUT files.');
      return;
    }
    let lastId: string | null = null;
    for (const f of r.data ?? []) {
      try {
        const parsed = parseCube(f.name, f.text);
        const id = `lut-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
        addLut({ id, ...parsed });
        lastId = id;
      } catch (e) {
        toast.error((e as Error).message);
      }
    }
    if (lastId) {
      push();
      // A shader effect would take the render slot over the LUT — clear it.
      update(clip.id, { lut: lastId, ...(fxMode(clip.effect) > 0 ? { effect: 'none' } : {}) });
      toast.success('LUT imported and applied.');
    }
  };

  return (
    <Group title="Color LUT" icon={Sun}>
      <div className="flex gap-2">
        <div className="min-w-0 flex-1">
          <Select
            value={clip.lut ?? ''}
            onChange={(v) => update(clip.id, { lut: v || undefined, ...(v && fxMode(clip.effect) > 0 ? { effect: 'none' } : {}) })}
          >
            <option value="">None</option>
            {luts.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} ({l.size}³)
              </option>
            ))}
          </Select>
        </div>
        <button
          onClick={() => void importLuts()}
          className="flex-shrink-0 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-white/90 transition hover:bg-white/10"
        >
          Import .cube…
        </button>
      </div>
      {clip.lut && (
        <Slider label="Strength" value={clip.lutAmount ?? 1} min={0} max={1} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => update(clip.id, { lutAmount: v })} />
      )}
      <p className="text-[11px] text-krypt-muted/70">3D .cube LUTs grade the clip on the GPU; GPU look effects (glitch, VHS…) take priority over a LUT.</p>
    </Group>
  );
}

const MASK_TYPES: Array<{ label: string; value: ClipMask['type'] | 'none' }> = [
  { label: 'None', value: 'none' },
  { label: 'Linear', value: 'linear' },
  { label: 'Rect', value: 'rect' },
  { label: 'Ellipse', value: 'ellipse' },
];

function MaskGroup({ clip }: { clip: MediaClip }) {
  const update = useTimelineStore((s) => s.updateClip);
  const push = useTimelineStore((s) => s.pushHistory);
  const m = clip.mask;
  const setMask = (patch: Partial<ClipMask>): void => {
    if (m) update(clip.id, { mask: { ...m, ...patch } });
  };
  return (
    <Group title="Mask" icon={Circle}>
      <div className="grid grid-cols-4 gap-1">
        {MASK_TYPES.map((t) => (
          <button
            key={t.value}
            onClick={() => {
              push();
              update(clip.id, { mask: t.value === 'none' ? undefined : { ...DEFAULT_MASK, ...(m ?? {}), type: t.value } });
            }}
            className={cls(
              'rounded-md px-1.5 py-1.5 text-[11px] transition',
              (m?.type ?? 'none') === t.value ? 'bg-krypt-purple/25 text-white ring-1 ring-krypt-purple/50' : 'bg-white/5 text-krypt-muted hover:text-white',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      {m && (
        <>
          <Slider label="Center X" value={m.x} min={0} max={1} step={0.005} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setMask({ x: v })} />
          <Slider label="Center Y" value={m.y} min={0} max={1} step={0.005} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setMask({ y: v })} />
          {m.type !== 'linear' && (
            <>
              <Slider label="Width" value={m.w} min={0.05} max={1.5} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setMask({ w: v })} />
              <Slider label="Height" value={m.h} min={0.05} max={1.5} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setMask({ h: v })} />
            </>
          )}
          <Slider label="Rotation" value={m.rotation} min={-180} max={180} step={1} fmt={(v) => `${v}°`} onChange={(v) => setMask({ rotation: v })} />
          <Slider label="Feather" value={m.feather} min={0} max={0.5} step={0.005} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setMask({ feather: v })} />
          <button
            onClick={() => {
              push();
              setMask({ invert: !m.invert });
            }}
            className={cls(
              'w-full rounded-lg border px-3 py-2 text-xs font-semibold transition',
              m.invert ? 'border-krypt-purple/50 bg-krypt-purple/15 text-white' : 'border-white/10 bg-white/5 text-white/80 hover:bg-white/10',
            )}
          >
            {m.invert ? 'Inverted — showing the outside' : 'Invert mask'}
          </button>
        </>
      )}
    </Group>
  );
}

function TextInspector({ clip }: { clip: TextClip }) {
  const update = useTimelineStore((s) => s.updateClip);
  const push = useTimelineStore((s) => s.pushHistory);
  const maxFade = Math.min(MAX_FADE, clip.duration);
  const ALIGN: Array<{ v: TextClip['align']; Icon: typeof AlignLeft }> = [
    { v: 'left', Icon: AlignLeft },
    { v: 'center', Icon: AlignCenter },
    { v: 'right', Icon: AlignRight },
  ];

  return (
    <>
      <Header icon={TypeIcon} title="Text" sub="overlay" />

      <Group title="Content">
        <textarea
          value={clip.text}
          onFocus={push}
          onChange={(e) => update(clip.id, { text: e.target.value })}
          rows={2}
          className="w-full resize-none rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-krypt-purple/60"
        />
      </Group>

      <Group title="Style">
        <div>
          <div className="mb-1 text-xs text-krypt-muted">Font</div>
          <select
            value={clip.fontFamily}
            onChange={(e) => {
              push();
              update(clip.id, { fontFamily: e.target.value });
            }}
            className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-sm text-white outline-none focus:border-krypt-purple/60"
          >
            {FONTS.map((f) => (
              <option key={f.value} value={f.value} style={{ fontFamily: f.value }}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
        <Slider label="Size" value={clip.fontSize} min={20} max={240} step={1} fmt={(v) => `${v}`} onChange={(v) => update(clip.id, { fontSize: v })} />
        <div className="flex items-center justify-between">
          <span className="text-xs text-krypt-muted">Color</span>
          <input
            type="color"
            value={clip.color}
            onPointerDown={push}
            onChange={(e) => update(clip.id, { color: e.target.value })}
            className="h-7 w-12 cursor-pointer rounded border border-white/10 bg-transparent"
          />
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              push();
              update(clip.id, { bold: !clip.bold });
            }}
            className={cls('rounded-lg border px-3 py-2 text-xs font-bold transition', clip.bold ? 'border-krypt-purple/50 bg-krypt-purple/15 text-white' : 'border-white/10 bg-white/5 text-white/80')}
          >
            B
          </button>
          <button
            onClick={() => {
              push();
              update(clip.id, { italic: !clip.italic });
            }}
            className={cls('rounded-lg border px-3 py-2 transition', clip.italic ? 'border-krypt-purple/50 bg-krypt-purple/15 text-white' : 'border-white/10 bg-white/5 text-white/80')}
          >
            <Italic className="h-3.5 w-3.5" />
          </button>
          <div className="flex flex-1 overflow-hidden rounded-lg border border-white/10">
            {ALIGN.map(({ v, Icon }) => (
              <button
                key={v}
                onClick={() => {
                  push();
                  update(clip.id, { align: v });
                }}
                className={cls('flex flex-1 items-center justify-center py-2 transition', clip.align === v ? 'bg-krypt-purple/20 text-white' : 'bg-white/5 text-krypt-muted hover:text-white')}
              >
                <Icon className="h-4 w-4" />
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="mb-1 text-xs text-krypt-muted">Position is the</div>
          <Select value={clip.anchor ?? 'center'} onChange={(v) => update(clip.id, { anchor: v === 'center' ? undefined : (v as 'left' | 'right') })}>
            <option value="center">Centre of the text</option>
            <option value="left">Left edge (lines up lists and lower thirds)</option>
            <option value="right">Right edge</option>
          </Select>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-krypt-muted">Outline</span>
          <input
            type="color"
            value={clip.outlineColor}
            onPointerDown={push}
            onChange={(e) => update(clip.id, { outlineColor: e.target.value })}
            className="h-7 w-12 cursor-pointer rounded border border-white/10 bg-transparent"
          />
        </div>
        <Slider label="Outline width" value={clip.outlineWidth} min={0} max={16} step={1} fmt={(v) => (v === 0 ? 'Off' : `${v}`)} onChange={(v) => update(clip.id, { outlineWidth: v })} />
        <div className="flex items-center justify-between">
          <span className="text-xs text-krypt-muted">Glow</span>
          <input
            type="color"
            value={clip.glowColor}
            onPointerDown={push}
            onChange={(e) => update(clip.id, { glowColor: e.target.value })}
            className="h-7 w-12 cursor-pointer rounded border border-white/10 bg-transparent"
          />
        </div>
        <Slider label="Glow" value={clip.glow} min={0} max={40} step={1} fmt={(v) => (v === 0 ? 'Off' : `${v}`)} onChange={(v) => update(clip.id, { glow: v })} />
      </Group>

      <TextBgGroup
        style={clip.bgStyle ?? 'none'}
        color={clip.bgColor ?? '#000000'}
        opacity={clip.bgOpacity ?? 0.6}
        radius={clip.bgRadius ?? 10}
        padding={clip.bgPadding ?? 16}
        onPatch={(p) => update(clip.id, p)}
        push={push}
      />

      {(clip.words?.length ?? 0) > 0 && (
        <Group title="Karaoke" icon={Sparkles}>
          <div className="grid grid-cols-4 gap-1">
            {KARAOKE_STYLES.map((k) => (
              <button
                key={k.value}
                onClick={() => {
                  push();
                  update(clip.id, { karaoke: k.value });
                }}
                className={cls(
                  'rounded-md px-1.5 py-1.5 text-[11px] transition',
                  (clip.karaoke ?? 'none') === k.value ? 'bg-krypt-purple/25 text-white ring-1 ring-krypt-purple/50' : 'bg-white/5 text-krypt-muted hover:text-white',
                )}
              >
                {k.label}
              </button>
            ))}
          </div>
          {clip.karaoke && clip.karaoke !== 'none' && (
            <div className="flex items-center justify-between">
              <span className="text-xs text-krypt-muted">Word color</span>
              <input
                type="color"
                value={clip.karaokeColor ?? DEFAULT_KARAOKE_COLOR}
                onPointerDown={push}
                onChange={(e) => update(clip.id, { karaokeColor: e.target.value })}
                className="h-7 w-12 cursor-pointer rounded border border-white/10 bg-transparent"
              />
            </div>
          )}
          <p className="text-[11px] text-krypt-muted/70">Styles the word being spoken, using the word timings from auto-captions.</p>
        </Group>
      )}

      <Group title="Position" icon={Move}>
        <p className="text-[11px] text-krypt-muted/70">Drag the text in the preview to move it. ◇ adds a keyframe at the playhead.</p>
        <KfSlider clip={clip} prop="x" base={clip.x} label="Position X" min={0} max={1} step={0.005} fmt={(v) => `${Math.round(v * 100)}%`} />
        <KfSlider clip={clip} prop="y" base={clip.y} label="Position Y" min={0} max={1} step={0.005} fmt={(v) => `${Math.round(v * 100)}%`} />
        <KfSlider clip={clip} prop="opacity" base={clip.opacity ?? 1} label="Opacity" min={0} max={1} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`} />
      </Group>

      <AnimationGroup clip={clip} anims={TEXT_ANIMS} />

      <Group title="Fade">
        <Slider label="Fade in" value={clip.fadeIn} min={0} max={maxFade} step={0.1} fmt={(v) => `${v.toFixed(1)}s`} onChange={(v) => update(clip.id, { fadeIn: v })} />
        <Slider label="Fade out" value={clip.fadeOut} min={0} max={maxFade} step={0.1} fmt={(v) => `${v.toFixed(1)}s`} onChange={(v) => update(clip.id, { fadeOut: v })} />
      </Group>
    </>
  );
}

/** Text background controls — shared by the single and batch text inspectors. */
function TextBgGroup({
  style,
  color,
  opacity,
  radius,
  padding,
  onPatch,
  push,
}: {
  style: TextBgStyle;
  color: string;
  opacity: number;
  radius: number;
  padding: number;
  onPatch: (p: ClipPatch) => void;
  push: () => void;
}) {
  return (
    <Group title="Background" icon={Square}>
      <div className="grid grid-cols-3 gap-1">
        {TEXT_BG.map((b) => (
          <button
            key={b.value}
            onClick={() => {
              push();
              onPatch({ bgStyle: b.value });
            }}
            className={cls(
              'rounded-md px-1.5 py-1.5 text-[11px] transition',
              style === b.value ? 'bg-krypt-purple/25 text-white ring-1 ring-krypt-purple/50' : 'bg-white/5 text-krypt-muted hover:text-white',
            )}
          >
            {b.label}
          </button>
        ))}
      </div>
      {style !== 'none' && (
        <>
          <div className="flex items-center justify-between">
            <span className="text-xs text-krypt-muted">Color</span>
            <input type="color" value={color} onPointerDown={push} onChange={(e) => onPatch({ bgColor: e.target.value })} className="h-7 w-12 cursor-pointer rounded border border-white/10 bg-transparent" />
          </div>
          <Slider label="Opacity" value={opacity} min={0} max={1} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => onPatch({ bgOpacity: v })} />
          <Slider label="Corner" value={radius} min={0} max={40} step={1} fmt={(v) => `${v}`} onChange={(v) => onPatch({ bgRadius: v })} />
          <Slider label="Padding" value={padding} min={0} max={60} step={1} fmt={(v) => `${v}`} onChange={(v) => onPatch({ bgPadding: v })} />
        </>
      )}
    </Group>
  );
}

function ShapeInspector({ clip }: { clip: ShapeClip }) {
  const update = useTimelineStore((s) => s.updateClip);
  const push = useTimelineStore((s) => s.pushHistory);
  const maxFade = Math.min(MAX_FADE, clip.duration);
  const hasFill = clip.shape !== 'line';

  return (
    <>
      <Header icon={Square} title="Shape" sub={clip.shape} />

      <Group title="Style" icon={Square}>
        {hasFill && (
          <div className="flex items-center justify-between">
            <span className="text-xs text-krypt-muted">Fill</span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  push();
                  update(clip.id, { fill: clip.fill ? '' : '#7c5cff' });
                }}
                className={cls('rounded px-2 py-1 text-[11px] transition', clip.fill ? 'bg-white/5 text-krypt-muted hover:text-white' : 'bg-krypt-purple/20 text-white')}
              >
                {clip.fill ? 'On' : 'Off'}
              </button>
              <input type="color" value={clip.fill || '#7c5cff'} onPointerDown={push} onChange={(e) => update(clip.id, { fill: e.target.value })} className="h-7 w-12 cursor-pointer rounded border border-white/10 bg-transparent" />
            </div>
          </div>
        )}
        <div className="flex items-center justify-between">
          <span className="text-xs text-krypt-muted">Stroke</span>
          <input type="color" value={clip.stroke || '#ffffff'} onPointerDown={push} onChange={(e) => update(clip.id, { stroke: e.target.value })} className="h-7 w-12 cursor-pointer rounded border border-white/10 bg-transparent" />
        </div>
        <Slider label="Stroke width" value={clip.strokeWidth} min={0} max={40} step={1} fmt={(v) => (v === 0 ? 'Off' : `${v}`)} onChange={(v) => update(clip.id, { strokeWidth: v })} />
        <KfSlider clip={clip} prop="opacity" base={clip.opacity} label="Opacity" min={0} max={1} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`} />
      </Group>

      <Group title="Transform" icon={Move}>
        <p className="text-[11px] text-krypt-muted/70">Drag the shape in the preview to move it. ◇ adds a keyframe at the playhead.</p>
        <KfSlider clip={clip} prop="x" base={clip.x} label="Position X" min={0} max={1} step={0.005} fmt={(v) => `${Math.round(v * 100)}%`} />
        <KfSlider clip={clip} prop="y" base={clip.y} label="Position Y" min={0} max={1} step={0.005} fmt={(v) => `${Math.round(v * 100)}%`} />
        <Slider label="Width" value={clip.w} min={0.02} max={1} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => update(clip.id, { w: v })} />
        <Slider label="Height" value={clip.h} min={0.01} max={1} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => update(clip.id, { h: v })} />
        <Slider label="Rotation" value={clip.rotation} min={-180} max={180} step={1} fmt={(v) => `${v}°`} onChange={(v) => update(clip.id, { rotation: v })} />
      </Group>

      <AnimationGroup clip={clip} anims={CLIP_ANIMS} />

      <Group title="Fade">
        <Slider label="Fade in" value={clip.fadeIn} min={0} max={maxFade} step={0.1} fmt={(v) => `${v.toFixed(1)}s`} onChange={(v) => update(clip.id, { fadeIn: v })} />
        <Slider label="Fade out" value={clip.fadeOut} min={0} max={maxFade} step={0.1} fmt={(v) => `${v.toFixed(1)}s`} onChange={(v) => update(clip.id, { fadeOut: v })} />
      </Group>
    </>
  );
}

function DrawInspector({ clip }: { clip: DrawClip }) {
  const update = useTimelineStore((s) => s.updateClip);
  const push = useTimelineStore((s) => s.pushHistory);
  const maxFade = Math.min(MAX_FADE, clip.duration);

  return (
    <>
      <Header icon={Pencil} title="Drawing" sub={`${clip.strokes.length} stroke${clip.strokes.length === 1 ? '' : 's'}`} />

      <Group title="Style" icon={Pencil}>
        <KfSlider clip={clip} prop="opacity" base={clip.opacity} label="Opacity" min={0} max={1} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`} />
        <KfSlider clip={clip} prop="x" base={clip.x} label="Position X" min={-1} max={1} step={0.005} fmt={(v) => `${Math.round(v * 100)}%`} />
        <KfSlider clip={clip} prop="y" base={clip.y} label="Position Y" min={-1} max={1} step={0.005} fmt={(v) => `${Math.round(v * 100)}%`} />
        <button
          onClick={() => {
            push();
            update(clip.id, { strokes: [] });
          }}
          className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-white/80 transition hover:bg-white/10"
        >
          Clear strokes
        </button>
        <p className="text-[11px] text-krypt-muted/70">Toggle the ✏ Draw button above the preview, then draw on the canvas. Strokes add to the selected drawing.</p>
      </Group>

      <AnimationGroup clip={clip} anims={CLIP_ANIMS} />

      <Group title="Fade">
        <Slider label="Fade in" value={clip.fadeIn} min={0} max={maxFade} step={0.1} fmt={(v) => `${v.toFixed(1)}s`} onChange={(v) => update(clip.id, { fadeIn: v })} />
        <Slider label="Fade out" value={clip.fadeOut} min={0} max={maxFade} step={0.1} fmt={(v) => `${v.toFixed(1)}s`} onChange={(v) => update(clip.id, { fadeOut: v })} />
      </Group>
    </>
  );
}

function ClipActions({ id }: { id: string }) {
  const duplicate = useTimelineStore((s) => s.duplicateClip);
  const remove = useTimelineStore((s) => s.removeClip);
  return (
    <div className="flex gap-2 border-t border-white/10 pt-4">
      <button
        onClick={() => duplicate(id)}
        className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-white/90 transition hover:bg-white/10"
      >
        <Copy className="h-4 w-4" /> Duplicate
      </button>
      <button
        onClick={() => remove(id)}
        className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs font-semibold text-rose-200 transition hover:bg-rose-500/20"
      >
        <Trash2 className="h-4 w-4" /> Delete
      </button>
    </div>
  );
}

/** Project background fill — shown when no clip is selected. */
function BackgroundControls() {
  const background = useTimelineStore((s) => s.background);
  const setBackground = useTimelineStore((s) => s.setBackground);
  const push = useTimelineStore((s) => s.pushHistory);
  return (
    <Group title="Background" icon={ImageIcon}>
      <div className="grid grid-cols-4 gap-1">
        {BACKGROUNDS.map((b) => (
          <button
            key={b.value}
            onClick={() => {
              push();
              setBackground({ type: b.value as BackgroundType });
            }}
            className={cls(
              'rounded-md px-1.5 py-1.5 text-[11px] transition',
              background.type === b.value ? 'bg-krypt-purple/25 text-white ring-1 ring-krypt-purple/50' : 'bg-white/5 text-krypt-muted hover:text-white',
            )}
          >
            {b.label}
          </button>
        ))}
      </div>
      {(background.type === 'color' || background.type === 'gradient') && (
        <div className="flex items-center justify-between">
          <span className="text-xs text-krypt-muted">{background.type === 'gradient' ? 'Top color' : 'Color'}</span>
          <input
            type="color"
            value={background.color}
            onPointerDown={push}
            onChange={(e) => setBackground({ color: e.target.value })}
            className="h-7 w-12 cursor-pointer rounded border border-white/10 bg-transparent"
          />
        </div>
      )}
      {background.type === 'gradient' && (
        <div className="flex items-center justify-between">
          <span className="text-xs text-krypt-muted">Bottom color</span>
          <input
            type="color"
            value={background.color2}
            onPointerDown={push}
            onChange={(e) => setBackground({ color2: e.target.value })}
            className="h-7 w-12 cursor-pointer rounded border border-white/10 bg-transparent"
          />
        </div>
      )}
      {background.type === 'blur' && <p className="text-[11px] text-krypt-muted/70">Fills the deadspace with a blurred copy of the bottom video/image layer.</p>}
    </Group>
  );
}

// ── small building blocks ─────────────────────────────────────────────────
function Header({ icon: Icon, title, sub }: { icon: typeof Sparkles; title: string; sub: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border border-white/10 bg-krypt-panel/80">
        <Icon className="h-4 w-4 text-krypt-purple" />
      </div>
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold text-white" title={title}>
          {title}
        </div>
        <div className="text-[11px] uppercase tracking-wider text-krypt-muted">{sub}</div>
      </div>
    </div>
  );
}

function Group({
  title,
  icon: Icon,
  action,
  children,
}: {
  title: string;
  icon?: typeof Sun;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-krypt-muted">
        {Icon && <Icon className="h-3.5 w-3.5" />}
        {title}
        {action && <span className="ml-auto normal-case tracking-normal">{action}</span>}
      </div>
      {children}
    </div>
  );
}

/** Slider with keyframe support: ◇ toggles a keyframe at the playhead; when the
 *  property is keyframed the slider edits the keyframe at the playhead. */
function KfSlider({
  clip,
  prop,
  base,
  label,
  min,
  max,
  step,
  fmt,
  onBase,
}: {
  clip: Clip;
  prop: string;
  base: number;
  label: string;
  min: number;
  max: number;
  step: number;
  fmt: (v: number) => string;
  /** Custom setter for the un-keyed base value (e.g. setSpeed's duration rescale). */
  onBase?: (v: number) => void;
}) {
  const playhead = useTimelineStore((s) => s.playhead);
  const push = useTimelineStore((s) => s.pushHistory);
  const setKeyframe = useTimelineStore((s) => s.setKeyframe);
  const toggleKeyframe = useTimelineStore((s) => s.toggleKeyframe);
  const setKeyframeEase = useTimelineStore((s) => s.setKeyframeEase);
  const update = useTimelineStore((s) => s.updateClip);

  const keyed = clipHasKeys(clip, prop);
  const lt = Math.max(0, Math.min(clip.duration, playhead - clip.start));
  const inRange = playhead >= clip.start && playhead <= clip.start + clip.duration;
  const kfHere = keyframeAt(clip, prop, lt);
  const onKey = !!kfHere;
  const value = keyed ? resolvedValue(clip, prop, clip.start + lt, base) : base;

  const onChange = (v: number): void => {
    if (keyed) setKeyframe(clip.id, prop, lt, v);
    else if (onBase) onBase(v);
    else update(clip.id, { [prop]: v } as ClipPatch);
  };

  return (
    <div>
      <div className="flex items-center justify-between text-xs">
        <span className="text-krypt-muted">{label}</span>
        <div className="flex items-center gap-1.5">
          <ValueField value={value} min={min} max={max} fmt={fmt} onCommit={onChange} push={push} />
          <button
            onClick={() => toggleKeyframe(clip.id, prop, lt, value)}
            disabled={!inRange}
            title={inRange ? 'Toggle keyframe at playhead' : 'Move the playhead over this clip'}
            className={cls('transition disabled:opacity-30', onKey ? 'text-krypt-pink' : keyed ? 'text-krypt-purple' : 'text-krypt-muted hover:text-white')}
          >
            <Diamond className={cls('h-3 w-3', onKey && 'fill-current')} />
          </button>
        </div>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onPointerDown={push}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full cursor-pointer accent-krypt-purple"
      />
      {onKey && (
        <div className="mt-1 flex items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wider text-krypt-muted">Ease</span>
          <select
            value={kfHere?.ease ?? 'linear'}
            onChange={(e) => setKeyframeEase(clip.id, prop, lt, e.target.value as Easing)}
            className="flex-1 rounded border border-white/10 bg-black/40 px-1 py-0.5 text-[11px] text-white outline-none focus:border-krypt-purple/60"
          >
            {EASINGS.map((es) => (
              <option key={es.value} value={es.value}>
                {es.label}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

/**
 * The value readout on a slider row — click it to type an exact number, in the
 * same unit the readout shows. Fraction-based sliders (0..1 shown as a
 * percentage) are detected by probing fmt(1) === '100%' so typing 50 means 0.5.
 */
function ValueField({
  value,
  min,
  max,
  fmt,
  onCommit,
  push,
}: {
  value: number;
  min: number;
  max: number;
  fmt: (v: number) => string;
  onCommit: (v: number) => void;
  push: () => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const unit = fmt(1) === '100%' ? 100 : 1;
  if (text === null) {
    return (
      <button
        className="cursor-text font-mono text-white/90 transition hover:text-krypt-pink"
        title="Click to type a value"
        onClick={() => setText(String(Math.round(value * unit * 100) / 100))}
      >
        {fmt(value)}
      </button>
    );
  }
  const commit = (): void => {
    const n = Number(text);
    if (Number.isFinite(n)) {
      push();
      onCommit(Math.min(max, Math.max(min, n / unit)));
    }
    setText(null);
  };
  return (
    <input
      autoFocus
      type="number"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') setText(null);
      }}
      className="w-16 rounded border border-krypt-purple/50 bg-black/60 px-1 py-0 text-right font-mono text-xs text-white outline-none"
    />
  );
}

/**
 * In / out animation and whole-clip motion. Every clip type has the same
 * controls (footage included); only text gets the typewriter.
 */
function AnimationGroup({ clip, anims }: { clip: Clip; anims: Array<{ label: string; value: TextAnim }> }) {
  const update = useTimelineStore((s) => s.updateClip);
  const animIn = clip.animIn ?? 'none';
  const animOut = clip.animOut ?? 'none';
  const motion = clip.motion ?? 'none';
  const maxLen = Math.max(0.1, Math.min(3, clip.duration));
  const secs = (v: number): string => `${v.toFixed(2)}s`;
  return (
    <>
    <Group title="Animation" icon={Sparkles}>
      <div className="flex gap-2">
        <div className="min-w-0 flex-1">
          <div className="mb-1 text-xs text-krypt-muted">In</div>
          <Select value={animIn} onChange={(v) => update(clip.id, { animIn: v as TextAnim })}>
            {anims.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-1 text-xs text-krypt-muted">Out</div>
          <Select value={animOut} onChange={(v) => update(clip.id, { animOut: v as TextAnim })}>
            {anims.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </Select>
        </div>
      </div>
      {animIn !== 'none' && <Slider label="In length" value={Math.min(maxLen, clip.animInDur ?? 0.5)} min={0.1} max={maxLen} step={0.05} fmt={secs} onChange={(v) => update(clip.id, { animInDur: v })} />}
      {animOut !== 'none' && <Slider label="Out length" value={Math.min(maxLen, clip.animOutDur ?? 0.5)} min={0.1} max={maxLen} step={0.05} fmt={secs} onChange={(v) => update(clip.id, { animOutDur: v })} />}
      <div>
        <div className="mb-1 text-xs text-krypt-muted">Motion</div>
        <Select value={motion} onChange={(v) => update(clip.id, { motion: v as MotionAnim })}>
          {MOTIONS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </Select>
      </div>
      {motion !== 'none' && (
        <Slider label="Amount" value={clip.motionAmount ?? 1} min={0.2} max={3} step={0.1} fmt={(v) => `${Math.round(v * 100)}%`} onChange={(v) => update(clip.id, { motionAmount: v })} />
      )}
    </Group>
    <ChapterGroup clip={clip} />
    </>
  );
}

/** Chapter mark: a chapter of the video starts where this clip starts. */
function ChapterGroup({ clip }: { clip: Clip }) {
  const update = useTimelineStore((s) => s.updateClip);
  const push = useTimelineStore((s) => s.pushHistory);
  return (
    <Group title="Chapter" icon={Flag}>
      <input
        value={clip.chapter ?? ''}
        placeholder="Chapter title (starts at this clip)"
        maxLength={100}
        onFocus={push}
        onChange={(e) => update(clip.id, { chapter: e.target.value || undefined })}
        className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none placeholder:text-krypt-muted/60 focus:border-krypt-purple/60"
      />
      <p className="text-[11px] leading-snug text-krypt-muted">
        {clip.chapter ? `A chapter starts at ${chapterStamp(clip.start, clip.start >= 3600)}. The list for your video description is under Chapters in the toolbar.` : 'Name a chapter to start one here.'}
      </p>
    </Group>
  );
}

function Select({ value, onChange, children }: { value: string; onChange: (v: string) => void; children: React.ReactNode }) {
  const push = useTimelineStore((s) => s.pushHistory);
  return (
    <select
      value={value}
      onChange={(e) => {
        push();
        onChange(e.target.value);
      }}
      className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-sm text-white outline-none focus:border-krypt-purple/60"
    >
      {children}
    </select>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  fmt,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  fmt?: (v: number) => string;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  const push = useTimelineStore((s) => s.pushHistory);
  return (
    <div className={cls(disabled && 'opacity-50')}>
      <div className="flex items-center justify-between text-xs">
        <span className="text-krypt-muted">{label}</span>
        {disabled ? (
          <span className="font-mono text-white/90">{fmt ? fmt(value) : value}</span>
        ) : (
          <ValueField value={value} min={min} max={max} fmt={fmt ?? ((v) => String(v))} onCommit={onChange} push={push} />
        )}
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onPointerDown={push}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full cursor-pointer accent-krypt-purple"
      />
    </div>
  );
}
