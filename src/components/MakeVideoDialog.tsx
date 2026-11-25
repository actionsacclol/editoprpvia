import { useEffect } from 'react';
import { Bot, FileText, Globe, ImagePlus, MonitorPlay, PlayCircle, Sparkles, Tv, X, type LucideIcon } from 'lucide-react';
import { MAKE_WAYS, findGuide, guideClock, type MakeWay } from '../utils/guides';
import { launch, openGuide, useLaunch } from '../utils/launch';

const ICONS: Record<MakeWay['id'], LucideIcon> = { script: FileText, website: Globe, screen: MonitorPlay, agent: Bot };

/**
 * "Make a video with AI" (top bar): the four ways to have a video made, each
 * one click from the dialog that does it and from the guide that shows it.
 */
export function MakeVideoDialog() {
  const close = (): void => useLaunch.setState({ making: false });
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div data-dialog="make-video" className="fixed inset-0 z-[60] flex items-center justify-center bg-krypt-void/85 p-4 backdrop-blur-sm animate-fade-in" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="flex max-h-full w-[860px] max-w-full flex-col rounded-2xl border border-white/10 bg-krypt-panel/95 p-6 shadow-krypt-card">
        <div className="mb-5 flex items-start gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-krypt-gradient shadow-krypt-glow">
            <Sparkles className="h-5 w-5 text-white" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-lg font-bold text-white">Make a video with AI</div>
            <div className="text-sm text-krypt-muted">Pick how you want to start. Whatever it makes lands on the timeline, where you can change any of it.</div>
          </div>
          <button onClick={close} title="Close" className="rounded-lg p-1.5 text-krypt-muted transition hover:bg-white/10 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid min-h-0 grid-cols-1 gap-3 overflow-y-auto sm:grid-cols-2">
          {MAKE_WAYS.map((w) => {
            const Icon = ICONS[w.id];
            const guide = findGuide(w.guide);
            return (
              <div key={w.id} data-way={w.id} className="flex flex-col rounded-xl border border-white/10 bg-black/25 p-4 transition hover:border-krypt-purple/40">
                <div className="mb-2 flex items-center gap-2.5">
                  <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border border-white/10 bg-krypt-purple/15">
                    <Icon className="h-4 w-4 text-krypt-purple" />
                  </div>
                  <div className="text-sm font-semibold text-white">{w.title}</div>
                </div>
                <div className="text-[13px] leading-snug text-white/80">{w.text}</div>
                <div className="mt-1.5 flex-1 text-xs text-krypt-muted">{w.needs}</div>
                <div className="mt-3 flex items-center gap-3">
                  <button
                    data-go={w.id}
                    onClick={() => launch(w.feature)}
                    className="rounded-lg bg-krypt-gradient px-3 py-1.5 text-xs font-semibold text-white shadow-krypt-glow transition hover:brightness-110 active:scale-[0.98]"
                  >
                    {w.button}
                  </button>
                  {guide && (
                    <button onClick={() => openGuide(guide.id)} className="flex items-center gap-1 text-xs font-medium text-krypt-muted transition hover:text-white">
                      <PlayCircle className="h-3.5 w-3.5" />
                      Watch how{guide.seconds > 0 ? ` (${guideClock(guide.seconds)})` : ''}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* What goes around the video: the picture people click, and an example to take after. */}
        <div data-make-extras className="mt-4 flex flex-wrap items-center gap-2 border-t border-white/10 pt-4">
          <div className="mr-1 text-xs text-krypt-muted">Around the video:</div>
          <button data-go="thumbnail" onClick={() => launch('thumbnail')} title="A few big words over a drawing, a frame of the video or a picture" className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-white/90 transition hover:bg-white/10">
            <ImagePlus className="h-3.5 w-3.5" />
            Make the thumbnail
          </button>
          <button data-go="channel" onClick={() => launch('channel')} title="How a YouTube channel you like titles and packages its videos, to shape your own" className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-white/90 transition hover:bg-white/10">
            <Tv className="h-3.5 w-3.5" />
            Take after a channel
          </button>
          <div className="text-xs text-krypt-muted">A story in comic panels is in "From a script": pick the Comic story format.</div>
        </div>
      </div>
    </div>
  );
}
