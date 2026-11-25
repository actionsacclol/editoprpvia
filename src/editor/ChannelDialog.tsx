import { useState } from 'react';
import { Copy, ImagePlus, Loader2, Tv } from 'lucide-react';
import { useToast } from '../state/ToastProvider';
import { bigNumber, titleHabits } from '@shared/channelStudy';
import { describeLook, lookAtChannel, type ChannelLook } from './channel';

const PREFS_KEY = 'krypt.channelLink';

/**
 * A YouTube channel as the example to take after: how it titles its videos, how often it uploads,
 * what its thumbnails look like. For the shape of the packaging; nothing of the channel is reused.
 */
export function ChannelDialog({ onClose, onThumbnail }: { onClose: () => void; onThumbnail: (palette: string[]) => void }) {
  const [link, setLink] = useState(() => {
    try {
      return localStorage.getItem(PREFS_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const toast = useToast();
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [look, setLook] = useState<ChannelLook | null>(null);

  const read = async (): Promise<void> => {
    const asked = link.trim();
    if (!asked) return;
    setError(null);
    setStep('Reading the channel…');
    try {
      const r = await lookAtChannel(asked, setStep);
      setLook(r);
      try {
        localStorage.setItem(PREFS_KEY, asked);
      } catch {
        /* not remembered */
      }
    } catch (e) {
      setError((e as Error).message);
    }
    setStep(null);
  };

  const copy = async (): Promise<void> => {
    if (!look) return;
    await window.krypt.app.copyText(`Make my next video take after this channel. Use krypt-editor: build_longform for the video, make_thumbnail for the thumbnail, get_chapters for the description.\n\n${describeLook(look)}`);
    toast.success('Copied. Paste it to your AI agent with what the video is about.');
  };

  const s = look?.study;
  const field = 'rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-krypt-purple/60 disabled:opacity-50';
  const head = 'mb-1 text-[11px] font-semibold uppercase tracking-wide text-krypt-muted';
  return (
    <div data-dialog="channel" className="absolute inset-0 z-50 flex items-center justify-center rounded-2xl bg-krypt-void/85 backdrop-blur-sm animate-fade-in">
      <div className="flex max-h-[96%] w-[900px] max-w-[97%] flex-col rounded-2xl border border-white/10 bg-krypt-panel/95 p-6 shadow-krypt-card">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl border border-white/10 bg-krypt-purple/15">
            <Tv className="h-5 w-5 text-krypt-purple" />
          </div>
          <div>
            <div className="text-sm font-bold text-white">Take after a channel</div>
            <div className="text-xs text-krypt-muted">Point at a YouTube channel you like. You get how it titles and packages its newest videos, to shape your own. Only its public feed is read; nothing is downloaded or copied.</div>
          </div>
        </div>

        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!step) void read();
          }}
        >
          <input autoFocus data-channel-link value={link} disabled={step !== null} onChange={(e) => setLink(e.target.value)} placeholder="youtube.com/@name, or a link to one of its videos" className={`${field} min-w-0 flex-1`} />
          <button type="submit" disabled={step !== null || link.trim().length < 2} className="flex items-center gap-2 rounded-lg bg-krypt-gradient px-4 py-2 text-sm font-semibold text-white shadow-krypt-glow transition hover:brightness-110 disabled:opacity-50">
            {step && <Loader2 className="h-4 w-4 animate-spin" />}
            {step ?? 'Look'}
          </button>
        </form>
        {error && (
          <div data-channel-error className="mt-2 text-xs text-red-300">
            {error}
          </div>
        )}

        {look && s && (
          <div data-channel-study className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1">
            <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <div className="text-base font-bold text-white">{s.name}</div>
              <div className="text-xs text-krypt-muted">
                {s.videos === 1 ? "its one public upload" : `its newest ${s.videos} uploads`}{s.shorts ? `, ${s.shorts} of them Shorts` : ''}
                {s.daysBetween !== null ? ` · ${s.daysBetween < 1.5 ? 'about one a day' : s.daysBetween <= 10 ? `about every ${Math.round(s.daysBetween)} days` : `about every ${Math.round(s.daysBetween / 7)} weeks`}` : ''}
                {s.views.median !== null ? ` · usually about ${bigNumber(s.views.median)} views` : ''}
              </div>
            </div>

            {s.videos === 0 ? (
              <div className="text-sm text-white/80">This channel has no public uploads in its feed.</div>
            ) : (
              <div className="grid grid-cols-1 gap-5 md:grid-cols-[1fr_1.15fr]">
                <div className="min-w-0">
                  <div className={head}>How it writes titles</div>
                  <ul className="space-y-1 text-[13px] leading-snug text-white/90">
                    {titleHabits(s).map((h) => (
                      <li key={h}>{h}</li>
                    ))}
                  </ul>
                  {s.views.best.length > 0 && (
                    <>
                      <div className={`${head} mt-4`}>What did best</div>
                      <ul className="space-y-1 text-[13px] leading-snug text-white/90">
                        {s.views.best.map((b) => (
                          <li key={b.title}>
                            <span className="font-semibold text-emerald-300">{b.times}×</span> the usual: {b.title}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  {look.palette.length > 0 && (
                    <>
                      <div className={`${head} mt-4`}>Colours its thumbnails lean on</div>
                      <div className="flex gap-1.5">
                        {look.palette.map((c) => (
                          <div key={c} data-channel-colour={c} title={c} className="h-7 w-10 rounded-md border border-white/20" style={{ background: c }} />
                        ))}
                      </div>
                    </>
                  )}
                </div>
                <div className="min-w-0">
                  <div className={head}>Its newest uploads</div>
                  <div className="grid grid-cols-3 gap-2">
                    {look.feed.videos.slice(0, 12).map((v) => (
                      <div key={v.id} className="min-w-0">
                        <div className="aspect-video overflow-hidden rounded-md border border-white/10 bg-black/40">{look.thumbs.get(v.id) && <img src={look.thumbs.get(v.id)} alt="" className="h-full w-full object-cover" />}</div>
                        <div className="mt-1 line-clamp-2 text-[11px] leading-tight text-white/80" title={v.title}>
                          {v.title}
                        </div>
                        <div className="text-[10px] text-krypt-muted">
                          {typeof v.views === 'number' ? `${bigNumber(v.views)} views` : ''}
                          {v.short ? ' · Short' : ''}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
            <div className="mt-4 text-[11px] leading-snug text-krypt-muted">Take the shape, not the words: a title of that length and build on your own subject, a thumbnail with that much text and those colours. Titles and thumbnails here belong to the channel.</div>
          </div>
        )}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm font-semibold text-white/90 transition hover:bg-white/10">
            Close
          </button>
          {look && s && s.videos > 0 && (
            <>
              <button type="button" data-channel-copy onClick={() => void copy()} title="Copies what was found as instructions for a connected AI agent" className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm font-semibold text-white/90 transition hover:bg-white/10">
                <Copy className="h-4 w-4" />
                Copy for my AI agent
              </button>
              <button type="button" data-channel-thumbnail onClick={() => onThumbnail(look.palette)} className="flex items-center gap-2 rounded-lg bg-krypt-gradient px-4 py-2 text-sm font-semibold text-white shadow-krypt-glow transition hover:brightness-110">
                <ImagePlus className="h-4 w-4" />
                Thumbnail in these colours
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
