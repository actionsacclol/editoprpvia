import { useEffect, useRef, useState } from 'react';
import { ArrowRight, HelpCircle, PlayCircle, Sparkles, Youtube } from 'lucide-react';
import { Card, GhostButton, Page, PrimaryButton, Section } from '../components/common';
import { cls } from '../utils/format';
import { GUIDES, chapterAt, findGuide, guideClock, guideUrl, type Guide } from '../utils/guides';
import { launch, openMakeVideo, useLaunch } from '../utils/launch';
import { TUTORIAL_URL, replayOnboarding } from '../utils/guide';

/** A guide's picture; its title on a plain tile when the file is not there. */
function Poster({ guide, className }: { guide: Guide; className?: string }) {
  const [missing, setMissing] = useState(false);
  return missing ? (
    <div className={cls('flex items-center justify-center bg-gradient-to-br from-[#4F46E5]/50 to-[#A855F7]/40 p-2 text-center text-[11px] font-semibold text-white/90', className)}>{guide.title}</div>
  ) : (
    <img src={guideUrl(guide.poster)} alt="" draggable={false} onError={() => setMissing(true)} className={cls('object-cover', className)} />
  );
}

/**
 * Guides: short videos that show one thing each, with the steps beside the
 * player (press one to jump there) and a button that opens what the video
 * showed. The videos ship with the app, so they play offline.
 */
export function GuidesPage() {
  const asked = useLaunch((s) => s.guide);
  const guide = findGuide(asked) ?? GUIDES[0];
  const video = useRef<HTMLVideoElement>(null);
  const [time, setTime] = useState(0);
  const [failed, setFailed] = useState(false);
  // A guide picked from a card, or asked for by name ("Watch how"), starts playing; the one the page
  // opens on waits for the person.
  const play = useLaunch((s) => s.play);
  const [picked, setPicked] = useState(false);
  const autoplay = picked || play;
  useEffect(() => {
    if (!play) return;
    setPicked(true);
    useLaunch.setState({ play: false });
    // Already showing that guide: the player is not made again, so start it here.
    void video.current?.play().catch(() => undefined);
  }, [play]);
  useEffect(() => {
    setTime(0);
    setFailed(false);
  }, [guide.id]);

  const pick = (id: string): void => {
    setPicked(true);
    useLaunch.setState({ guide: id });
  };
  const jump = (at: number): void => {
    const v = video.current;
    if (!v) return;
    v.currentTime = at;
    void v.play().catch(() => undefined);
  };
  const now = chapterAt(guide, time);

  return (
    <Page
      title="Guides"
      subtitle="Short videos that show one thing each. Made in Krypt Editor: the voice is the built-in one."
      actions={
        <PrimaryButton onClick={openMakeVideo}>
          <Sparkles className="h-4 w-4" />
          Make a video with AI
        </PrimaryButton>
      }
    >
      <div className="flex flex-col gap-5 xl:flex-row">
        <div className="min-w-0 flex-1">
          <Card padded={false} className="overflow-hidden">
            <div className="relative aspect-video w-full bg-black">
              {failed ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center">
                  <div className="text-sm font-semibold text-white">This guide's video is not in this copy of Krypt Editor.</div>
                  <div className="max-w-md text-xs text-krypt-muted">The steps are listed below, and the button under them opens what the guide is about.</div>
                </div>
              ) : (
                <video
                  key={guide.id}
                  ref={video}
                  data-guide-video={guide.id}
                  src={guideUrl(guide.file)}
                  poster={guideUrl(guide.poster)}
                  controls
                  autoPlay={autoplay}
                  preload="metadata"
                  onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
                  onError={() => setFailed(true)}
                  className="absolute inset-0 h-full w-full"
                />
              )}
            </div>
            <div className="p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-lg font-bold text-white">{guide.title}</div>
                  <div className="text-sm text-krypt-muted">{guide.summary}</div>
                </div>
                <PrimaryButton onClick={() => launch(guide.action.feature)} className="flex-shrink-0">
                  {guide.action.label}
                  <ArrowRight className="h-4 w-4" />
                </PrimaryButton>
              </div>
              {guide.chapters.length > 0 && (
                <div className="mt-4 grid grid-cols-1 gap-1 sm:grid-cols-2">
                  {guide.chapters.map((c, i) => (
                    <button
                      key={c.at}
                      onClick={() => jump(c.at)}
                      disabled={failed}
                      className={cls(
                        'flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition',
                        i === now && !failed ? 'bg-krypt-purple/20 text-white' : 'text-white/80 hover:bg-white/5 hover:text-white',
                      )}
                    >
                      <span className="w-9 flex-shrink-0 font-mono text-xs text-krypt-muted">{guideClock(c.at)}</span>
                      <span className="min-w-0 flex-1 truncate">{c.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </Card>
        </div>

        <div className="flex flex-shrink-0 flex-col gap-2 xl:w-[340px]">
          {GUIDES.map((g) => {
            const active = g.id === guide.id;
            return (
              <button
                key={g.id}
                data-guide={g.id}
                onClick={() => pick(g.id)}
                className={cls(
                  'group flex items-center gap-3 rounded-xl border p-2 text-left transition',
                  active ? 'border-krypt-purple/60 bg-krypt-purple/15' : 'border-white/10 bg-krypt-panel/80 hover:border-white/25',
                )}
              >
                <div className="relative h-[68px] w-[120px] flex-shrink-0 overflow-hidden rounded-lg bg-black">
                  <Poster guide={g} className="h-full w-full" />
                  {!active && <PlayCircle className="absolute inset-0 m-auto h-7 w-7 text-white/85 opacity-0 drop-shadow transition group-hover:opacity-100" />}
                  {g.seconds > 0 && <span className="absolute bottom-1 right-1 rounded bg-black/75 px-1 font-mono text-[10px] text-white">{guideClock(g.seconds)}</span>}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-white">{g.title}</div>
                  <div className="line-clamp-2 text-xs leading-snug text-krypt-muted">{g.summary}</div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-8">
        <Section title="New here?" description="The tour points at the parts of the editor; the longer video shows a full edit from start to finish.">
          <div className="flex flex-wrap gap-2">
            <GhostButton onClick={replayOnboarding}>
              <HelpCircle className="h-4 w-4" />
              Take the one-minute tour
            </GhostButton>
            <GhostButton onClick={() => window.krypt.app.openExternal(TUTORIAL_URL)}>
              <Youtube className="h-4 w-4" />
              Watch a full edit on YouTube
            </GhostButton>
          </div>
        </Section>
      </div>
    </Page>
  );
}
