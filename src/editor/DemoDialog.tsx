import { useEffect, useMemo, useState } from 'react';
import { MousePointerClick } from 'lucide-react';
import { GhostButton, PrimaryButton } from '../components/common';
import { useToast } from '../state/ToastProvider';
import { pointerOf, runAgentTool } from './agentTools';
import { useMediaStore } from './mediaStore';
import { useTimelineStore } from './timelineStore';

/** Backdrops for the window frame: top and bottom of a gradient (the first is what the tool uses on its own). */
const BACKDROPS = [
  { name: 'Purple', color: '#4F46E5', color2: '#A855F7' },
  { name: 'Ocean', color: '#0EA5E9', color2: '#1D4ED8' },
  { name: 'Sunset', color: '#F97316', color2: '#DB2777' },
  { name: 'Mint', color: '#34D399', color2: '#0E7490' },
  { name: 'Slate', color: '#334155', color2: '#0B1120' },
  { name: 'Paper', color: '#F8FAFC', color2: '#CBD5E1' },
];

const ZOOMS = [
  { label: 'Gentle', value: 1.4 },
  { label: 'Normal', value: 1.8 },
  { label: 'Close', value: 2.4 },
];

/**
 * Product demo: zoom a screen recording in on its clicks, with click
 * highlights and sounds (demo.ts). The work is the product_demo tool, the same
 * one agents call, so it is one undo step and can be run again to change it.
 */
export function DemoDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const clips = useTimelineStore((s) => s.clips);
  const tracks = useTimelineStore((s) => s.tracks);
  const selected = useTimelineStore((s) => s.selectedIds);
  const media = useMediaStore((s) => s.media);
  // The videos on the timeline, and which of them were recorded with a pointer track.
  const videos = useMemo(() => {
    const lanes = new Set(tracks.filter((t) => t.kind === 'video').map((t) => t.id));
    const ids = [...new Set(clips.filter((c) => c.type === 'media' && lanes.has(c.trackId)).map((c) => (c.type === 'media' ? c.mediaId : '')))];
    return media.filter((m) => m.kind === 'video' && ids.includes(m.id));
  }, [clips, tracks, media]);
  const [tracked, setTracked] = useState<Map<string, number> | null>(null);
  useEffect(() => {
    let alive = true;
    void Promise.all(videos.map(async (m) => [m.id, (await pointerOf(m))?.clicks.length ?? -1] as const)).then((rows) => {
      if (alive) setTracked(new Map(rows.filter((r) => r[1] >= 0)));
    });
    return () => {
      alive = false;
    };
  }, [videos]);
  const usable = videos.filter((m) => tracked?.has(m.id));
  const [mediaId, setMediaId] = useState('');
  useEffect(() => {
    if (usable.length === 0 || usable.some((m) => m.id === mediaId)) return;
    // The selected clip's recording when it is one of them, else the first.
    const sel = clips.find((c) => selected.includes(c.id) && c.type === 'media' && usable.some((m) => m.id === c.mediaId));
    setMediaId(sel && sel.type === 'media' ? sel.mediaId : usable[0].id);
  }, [usable, mediaId, clips, selected]);
  const has = clips.some((c) => c.group === `demo:${mediaId}`) || clips.some((c) => c.type === 'media' && c.mediaId === mediaId && c.keyframes.some((k) => k.prop === 'scaleX' || k.prop === 'posX'));

  const background = useTimelineStore((st) => st.background);
  const framedNow = clips.some((c) => c.type === 'media' && c.mediaId === mediaId && !!c.demoRest);
  // A background the user chose themselves is offered as "Mine" and left alone.
  const ownBackdrop = background.type !== 'black' && !framedNow && !BACKDROPS.some((b) => b.color === background.color && b.color2 === background.color2);
  const [frame, setFrame] = useState(true);
  const [backdrop, setBackdrop] = useState<string | null>(null);
  const picked = backdrop ?? (ownBackdrop ? 'mine' : (BACKDROPS.find((b) => background.type === 'gradient' && b.color === background.color && b.color2 === background.color2)?.name ?? BACKDROPS[0].name));
  const [zoom, setZoom] = useState(1.8);
  const [highlights, setHighlights] = useState(true);
  const [sounds, setSounds] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (remove: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    const colours = BACKDROPS.find((b) => b.name === picked);
    const args = remove ? { media_id: mediaId, remove: true } : { media_id: mediaId, zoom, highlights, sounds, frame, ...(frame && colours ? { backdrop_color: colours.color, backdrop_color2: colours.color2 } : {}) };
    const r = await runAgentTool({ rid: 0, tool: 'product_demo', args, client: 'Krypt Editor' }, () => undefined, new AbortController().signal);
    if (r.ok) {
      toast.success(`${r.text.split('\n')[0]} Undo reverts it.`);
      onClose();
      return;
    }
    setError(r.text);
    setBusy(false);
  };

  const clicks = tracked?.get(mediaId) ?? 0;
  const select = 'w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-sm text-white outline-none focus:border-krypt-purple/60 disabled:opacity-50';
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center rounded-2xl bg-krypt-void/85 backdrop-blur-sm animate-fade-in">
      <div className="w-[460px] max-w-[96%] rounded-2xl border border-white/10 bg-krypt-panel/95 p-6 shadow-krypt-card">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl border border-white/10 bg-krypt-purple/15">
            <MousePointerClick className="h-5 w-5 text-krypt-purple" />
          </div>
          <div>
            <div className="text-sm font-bold text-white">Product demo</div>
            <div className="text-xs text-krypt-muted">The recording sits in a window frame, zooms in on what you clicked and follows the pointer, and each click gets a highlight and a click sound.</div>
          </div>
        </div>

        {tracked === null ? (
          <div className="text-xs text-krypt-muted">Looking for recordings…</div>
        ) : usable.length === 0 ? (
          <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-3 text-xs leading-relaxed text-white/85">
            {videos.length === 0 ? 'There is no screen recording on the timeline yet.' : 'The videos on the timeline were not recorded here, so where the clicks were is not known.'} Use <b>Record</b> with
            “Product demo” ticked: Krypt Editor notes the pointer and its clicks while it records, and the zooms are added when the recording lands.
            <div className="mt-2 text-krypt-muted">For a recording made elsewhere, a connected AI agent can look at the picture and place the zooms: ask it to “make this a product demo”.</div>
          </div>
        ) : (
          <>
            {usable.length > 1 && (
              <div className="mb-3">
                <div className="mb-1 text-xs text-krypt-muted">Recording</div>
                <select value={mediaId} disabled={busy} onChange={(e) => setMediaId(e.target.value)} className={select}>
                  {usable.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="mb-1 text-xs text-krypt-muted">How close</div>
            <div className="grid grid-cols-3 gap-2">
              {ZOOMS.map((z) => (
                <button
                  key={z.value}
                  type="button"
                  disabled={busy}
                  onClick={() => setZoom(z.value)}
                  className={`rounded-lg border px-3 py-2 text-left transition disabled:opacity-50 ${zoom === z.value ? 'border-krypt-purple/60 bg-krypt-purple/20' : 'border-white/10 bg-white/5 hover:bg-white/10'}`}
                >
                  <div className="text-sm font-semibold text-white">{z.label}</div>
                  <div className="text-[11px] text-krypt-muted">{z.value}×</div>
                </button>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-white/90">
              <label className="flex items-center gap-2" title="The recording a little smaller, with rounded corners and a shadow, on a backdrop. Zooming in still fills the picture.">
                <input type="checkbox" checked={frame} disabled={busy} onChange={(e) => setFrame(e.target.checked)} className="accent-krypt-purple" />
                Window frame
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={highlights} disabled={busy} onChange={(e) => setHighlights(e.target.checked)} className="accent-krypt-purple" />
                Highlight clicks
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={sounds} disabled={busy} onChange={(e) => setSounds(e.target.checked)} className="accent-krypt-purple" />
                Click sounds
              </label>
            </div>
            {frame && (
              <div className="mt-3">
                <div className="mb-1 text-xs text-krypt-muted">Backdrop</div>
                <div className="flex flex-wrap gap-2">
                  {ownBackdrop && (
                    <button
                      type="button"
                      disabled={busy}
                      data-backdrop="mine"
                      title="Keep the project's own background"
                      onClick={() => setBackdrop('mine')}
                      className={`h-8 rounded-lg border px-2 text-[11px] font-semibold text-white transition disabled:opacity-50 ${picked === 'mine' ? 'border-white ring-1 ring-white/70' : 'border-white/15 hover:border-white/40'}`}
                      style={{ background: background.type === 'gradient' ? `linear-gradient(180deg, ${background.color}, ${background.color2})` : background.type === 'color' ? background.color : '#000' }}
                    >
                      Mine
                    </button>
                  )}
                  {BACKDROPS.map((b) => (
                    <button
                      key={b.name}
                      type="button"
                      disabled={busy}
                      data-backdrop={b.name}
                      title={b.name}
                      aria-label={`${b.name} backdrop`}
                      onClick={() => setBackdrop(b.name)}
                      className={`h-8 w-12 rounded-lg border transition disabled:opacity-50 ${picked === b.name ? 'border-white ring-1 ring-white/70' : 'border-white/15 hover:border-white/40'}`}
                      style={{ background: `linear-gradient(180deg, ${b.color}, ${b.color2})` }}
                    />
                  ))}
                </div>
              </div>
            )}
            <div className="mt-3 text-xs text-krypt-muted">
              {clicks > 0 ? `${clicks} click${clicks === 1 ? '' : 's'} in this recording.` : 'No clicks were recorded, so the camera follows where the pointer came to rest.'} Cut out the dead time first; the zooms follow the cuts.
              {has ? ' Applying replaces the demo that is on it now.' : ''}
            </div>
          </>
        )}
        {error && <div className="mt-3 max-h-24 overflow-y-auto whitespace-pre-wrap text-xs text-red-400">{error}</div>}

        <div className="mt-5 flex justify-end gap-2">
          {has && usable.length > 0 && (
            <GhostButton onClick={() => void run(true)} disabled={busy}>
              Remove
            </GhostButton>
          )}
          <GhostButton onClick={onClose}>Close</GhostButton>
          {usable.length > 0 && (
            <PrimaryButton onClick={() => void run(false)} disabled={busy || !mediaId}>
              <MousePointerClick className="h-4 w-4" />
              {has ? 'Apply again' : 'Apply'}
            </PrimaryButton>
          )}
        </div>
      </div>
    </div>
  );
}
