import { useEffect, useMemo, useRef, useState } from 'react';
import { AppWindow, ArrowUpToLine, Bot, Globe, RefreshCw, Trash2, Video } from 'lucide-react';
import { GhostButton, PrimaryButton } from '../components/common';
import { useToast } from '../state/ToastProvider';
import { pointerOf, runAgentTool } from './agentTools';
import { APP_KINDS, appVideoArgs, appVideoProblem, appVideoPrompt, findMoments, type AppVideoKind, type AppVoice } from './appVideo';
import { useMediaStore } from './mediaStore';
import { probeMedia } from './probe';
import { stills } from './reference';
import { useTimelineStore } from './timelineStore';
import { TTS_VOICES } from './tts';

const VOICES = TTS_VOICES.filter((v) => v.value.startsWith('kokoro:'));
const VOICE_NAMES: Record<AppVoice, { label: string; hint: string }> = {
  'built-in': { label: 'A built-in voice', hint: 'Reads the line you write for each step' },
  recording: { label: 'My voice, as recorded', hint: 'What you said while recording, with captions of it' },
  none: { label: 'No voice', hint: 'The lines are shown as captions' },
};

interface Row {
  key: number;
  from: number;
  to: number;
  at: number;
  /** Where the first click landed in the picture, when there was one. */
  click?: { x: number; y: number };
  clicks: number;
  guessed: boolean;
  heading: string;
  text: string;
}

const clock = (t: number): string => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}.${Math.floor((t % 1) * 10)}`;

/**
 * A video about an app from one recording of it: a guide, a product demo or a
 * trailer. The recording is cut into steps where it was clicked (appVideo.ts);
 * each one is named here, and the build is build_longform, the same one agents
 * run, so it is one undo step and everything it makes is ordinary clips.
 */
export function AppVideoDialog({ onClose, onRecord, onWeb, mediaId }: { onClose: () => void; onRecord: () => void; onWeb: () => void; mediaId?: string }) {
  const toast = useToast();
  const media = useMediaStore((s) => s.media);
  const hasClips = useTimelineStore((s) => s.clips.length > 0);
  // Recordings: the videos that are not something a build made (narrated scenes, panels).
  const videos = useMemo(() => media.filter((m) => m.kind === 'video' && !/^(scene|panel|drawn)-/.test(m.name)), [media]);
  const [tracked, setTracked] = useState<Map<string, number> | null>(null);
  useEffect(() => {
    let alive = true;
    void Promise.all(videos.map(async (m) => [m.id, (await pointerOf(m))?.clicks.length ?? -1] as const)).then((rows) => {
      if (alive) setTracked(new Map(rows));
    });
    return () => {
      alive = false;
    };
  }, [videos]);

  const [takeId, setTakeId] = useState(mediaId ?? '');
  useEffect(() => {
    if (!tracked || videos.some((m) => m.id === takeId)) return;
    // The newest recording that came with its clicks; else the newest video.
    const withClicks = videos.filter((m) => (tracked.get(m.id) ?? -1) >= 0);
    setTakeId((withClicks[withClicks.length - 1] ?? videos[videos.length - 1])?.id ?? '');
  }, [tracked, videos, takeId]);
  const take = videos.find((m) => m.id === takeId);

  const [kindId, setKindId] = useState<AppVideoKind>('guide');
  const kind = APP_KINDS.find((k) => k.id === kindId)!;
  const [voice, setVoice] = useState<AppVoice>(kind.voice);
  const [voiceName, setVoiceName] = useState(VOICES[0]?.value ?? '');
  const [title, setTitle] = useState('');
  const [subtitle, setSubtitle] = useState('');
  const [opening, setOpening] = useState('');
  const [closing, setClosing] = useState(kind.closing);
  const [action, setAction] = useState('');
  const [where, setWhere] = useState('');
  const [note, setNote] = useState('');
  const [clear, setClear] = useState(true);
  const [rows, setRows] = useState<Row[]>([]);
  const [thumbs, setThumbs] = useState<Map<number, string>>(new Map());
  const [facts, setFacts] = useState<{ duration: number; sound: boolean; clicks: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<{ status: string; ratio: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const keys = useRef(0);
  const voicePicked = useRef(false);

  const pickKind = (id: AppVideoKind): void => {
    const next = APP_KINDS.find((k) => k.id === id)!;
    setKindId(id);
    // Each kind has its own usual voice (a guide is read out, a demo and a trailer are not); one picked by hand stays when the kind can use it.
    setVoice((v) => (voicePicked.current && next.voices.includes(v) && (v !== 'recording' || facts?.sound) ? v : next.voice));
    setClosing((c) => (c === kind.closing ? next.closing : c));
  };

  // The steps of the recording picked: found once, then the person's to change.
  const load = async (again = false): Promise<void> => {
    if (!take) return;
    setLoading(true);
    setError(null);
    try {
      const info = await probeMedia(take);
      const pointer = await pointerOf(take);
      const found = findMoments({ duration: info.duration, pointer });
      const made: Row[] = found.map((m) => ({ key: ++keys.current, from: m.from, to: m.to, at: m.at, click: m.clicks > 0 ? { x: m.x, y: m.y } : undefined, clicks: m.clicks, guessed: m.guessed === true, heading: '', text: '' }));
      setFacts({ duration: info.duration, sound: info.hasAudio === true, clicks: pointer?.clicks.length ?? -1 });
      // Names already typed stay with their step when the steps are found again.
      setRows((old) => (again ? made.map((r, i) => ({ ...r, heading: old[i]?.heading ?? '', text: old[i]?.text ?? '' })) : made));
      if (info.hasAudio !== true) setVoice((v) => (v === 'recording' ? kind.voice : v));
      setThumbs(new Map());
      const pics = await stills(take, made.map((r) => Math.min(Math.max(0, info.duration - 0.05), r.at + 0.05))).catch(() => [] as string[]);
      if (pics.length === made.length) setThumbs(new Map(made.map((r, i) => [r.key, `data:image/jpeg;base64,${pics[i]}`])));
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
      setRows([]);
      setFacts(null);
    }
    setLoading(false);
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [takeId]);

  const patch = (key: number, p: Partial<Row>): void => setRows((old) => old.map((r) => (r.key === key ? { ...r, ...p } : r)));
  const remove = (key: number): void => setRows((old) => old.filter((r) => r.key !== key));
  /** Join a step to the one above it: one step from the start of the first to the end of the second. */
  const mergeUp = (key: number): void =>
    setRows((old) => {
      const i = old.findIndex((r) => r.key === key);
      if (i < 1) return old;
      const a = old[i - 1];
      const b = old[i];
      const joined: Row = { ...a, to: Math.max(a.to, b.to), clicks: a.clicks + b.clicks, heading: a.heading || b.heading, text: [a.text, b.text].filter(Boolean).join(' ') };
      return [...old.slice(0, i - 1), joined, ...old.slice(i + 1)];
    });

  const input = {
    kind: kindId,
    take: takeId,
    title,
    subtitle,
    opening,
    steps: rows.map((r) => ({ from: r.from, to: r.to, heading: r.heading, text: r.text, click: r.click })),
    voice,
    voiceName: voice === 'built-in' ? voiceName : undefined,
    closing: kindId === 'trailer' ? { action, where, note } : { text: closing, action, where },
    clear: clear && hasClips,
  };
  const problem = !take ? null : appVideoProblem(input);
  const building = busy !== null;

  const build = async (): Promise<void> => {
    const abort = new AbortController();
    abortRef.current = abort;
    setError(null);
    setBusy({ status: 'Starting…', ratio: 0 });
    const r = await runAgentTool({ rid: 0, tool: 'build_longform', args: appVideoArgs(input), client: 'Krypt Editor' }, (ratio, status) => setBusy({ ratio, status }), abort.signal);
    if (r.ok) {
      toast.success(`${r.text.split('\n')[0]} Undo reverts it.`);
      onClose();
      return;
    }
    if (!abort.signal.aborted) setError(r.text);
    setBusy(null);
  };

  const copyPrompt = async (): Promise<void> => {
    if (!take) return;
    try {
      await navigator.clipboard.writeText(appVideoPrompt(kindId, take.name));
      toast.success('Copied. Paste it to your AI agent: it looks at each step and writes the words.');
    } catch {
      toast.error('Could not copy to the clipboard.');
    }
  };

  const field = 'w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-sm text-white outline-none focus:border-krypt-purple/60 disabled:opacity-50';
  const small = 'w-16 rounded-md border border-white/10 bg-black/40 px-1.5 py-0.5 text-[11px] text-white outline-none focus:border-krypt-purple/60 disabled:opacity-50';
  const source = 'flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-white/90 transition hover:bg-white/10 disabled:opacity-50';
  const guessed = rows.some((r) => r.guessed);

  return (
    <div data-dialog="app-video" className="absolute inset-0 z-40 flex items-center justify-center rounded-2xl bg-krypt-void/85 backdrop-blur-sm animate-fade-in">
      <div className="flex max-h-[94%] w-[780px] max-w-[96%] flex-col rounded-2xl border border-white/10 bg-krypt-panel/95 p-6 shadow-krypt-card">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl border border-white/10 bg-krypt-purple/15">
            <AppWindow className="h-5 w-5 text-krypt-purple" />
          </div>
          <div>
            <div className="text-sm font-bold text-white">Video of an app</div>
            <div className="text-xs text-krypt-muted">Record any app or website once, clicking through what you want to show. The recording is cut into steps where you clicked, and built into a guide, a product demo or a trailer.</div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          <div className="mb-1 text-xs text-krypt-muted">The recording</div>
          <div className="flex flex-wrap items-center gap-2">
            {videos.length > 0 && (
              <select data-agent="app-take" value={takeId} disabled={building} onChange={(e) => setTakeId(e.target.value)} className={`${field} min-w-0 flex-1`}>
                {videos.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                    {(tracked?.get(m.id) ?? -1) >= 0 ? ` (${tracked!.get(m.id)} click${tracked!.get(m.id) === 1 ? '' : 's'})` : ''}
                  </option>
                ))}
              </select>
            )}
            <button type="button" data-agent="app-record" disabled={building} onClick={onRecord} className={source} title="Record a window or the screen while you click through the app. It comes back here when you stop">
              <Video className="h-3.5 w-3.5 text-rose-300" />
              Record an app
            </button>
            <button type="button" data-agent="app-web" disabled={building} onClick={onWeb} className={source} title="Give an address and the clicks to make: the page is filmed out of sight">
              <Globe className="h-3.5 w-3.5 text-krypt-purple" />
              Film a web page
            </button>
          </div>

          {videos.length === 0 ? (
            <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-3 text-xs leading-relaxed text-white/85">
              There is no recording yet. <b>Record an app</b> opens Record: pick the app's window, leave “Product demo” ticked so the clicks are noted, and click through what you want to show. Talk while you do it if the video should have your
              voice. When you stop, you are back here with the steps found.
            </div>
          ) : (
            <>
              <div className="mb-1 mt-4 text-xs text-krypt-muted">What to make</div>
              <div className="grid grid-cols-3 gap-2">
                {APP_KINDS.map((k) => (
                  <button
                    key={k.id}
                    type="button"
                    data-kind={k.id}
                    disabled={building}
                    onClick={() => pickKind(k.id)}
                    title={k.description}
                    className={`rounded-lg border px-3 py-2 text-left transition disabled:opacity-50 ${k.id === kindId ? 'border-krypt-purple/60 bg-krypt-purple/20' : 'border-white/10 bg-white/5 hover:bg-white/10'}`}
                  >
                    <div className="text-sm font-semibold text-white">{k.name}</div>
                    <div className="mt-0.5 line-clamp-3 text-[11px] leading-snug text-krypt-muted">{k.description}</div>
                  </button>
                ))}
              </div>

              <div className="mt-4 grid grid-cols-2 gap-3">
                <div>
                  <div className="mb-1 text-xs text-krypt-muted">{kindId === 'guide' ? 'Title' : 'Name of the app'}</div>
                  <input data-agent="app-title" value={title} disabled={building} onChange={(e) => setTitle(e.target.value)} placeholder={kindId === 'guide' ? 'How to set up your first project' : 'Notely'} className={field} />
                </div>
                <div>
                  <div className="mb-1 text-xs text-krypt-muted">{kindId === 'guide' ? 'Line under the title (optional)' : 'Tagline (optional)'}</div>
                  <input value={subtitle} disabled={building} onChange={(e) => setSubtitle(e.target.value)} placeholder={kindId === 'guide' ? 'In two minutes' : 'Notes that find themselves'} className={field} />
                </div>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-3">
                <div>
                  <div className="mb-1 text-xs text-krypt-muted">Voice</div>
                  <select data-agent="app-voice" value={voice} disabled={building} onChange={(e) => {
                      voicePicked.current = true;
                      setVoice(e.target.value as AppVoice);
                    }} className={field}>
                    {kind.voices.map((v) => (
                      <option key={v} value={v} disabled={v === 'recording' && !facts?.sound}>
                        {VOICE_NAMES[v].label}
                        {v === 'recording' && !facts?.sound ? ' (this recording has no sound)' : ''}
                      </option>
                    ))}
                  </select>
                  <div className="mt-1 text-[11px] text-krypt-muted">{kindId === 'trailer' && voice === 'none' ? 'Text and a beat made for it carry the trailer' : VOICE_NAMES[voice].hint}</div>
                </div>
                {voice === 'built-in' && (
                  <div>
                    <div className="mb-1 text-xs text-krypt-muted">Read by</div>
                    <select value={voiceName} disabled={building} onChange={(e) => setVoiceName(e.target.value)} className={field}>
                      {VOICES.map((v) => (
                        <option key={v.value} value={v.value}>
                          {v.label}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              {voice !== 'recording' && (
                <div className="mt-3">
                  <div className="mb-1 text-xs text-krypt-muted">{kindId === 'trailer' ? 'Opening lines, one per line, shown large before the name (optional)' : 'Opening, before the first step (optional)'}</div>
                  <textarea value={opening} disabled={building} onChange={(e) => setOpening(e.target.value)} rows={2} placeholder={kindId === 'trailer' ? 'Your notes are everywhere.\nFinding one takes forever.' : kindId === 'demo' ? 'The problem it solves, in a sentence or two.' : 'By the end you will have your first project set up.'} className={`${field} resize-none`} />
                </div>
              )}

              <div className="mb-1 mt-4 flex items-center gap-2 text-xs text-krypt-muted">
                <span>
                  {kind.step}s{facts ? ` · ${rows.length} from ${clock(facts.duration)} of recording${facts.clicks >= 0 ? `, ${facts.clicks} click${facts.clicks === 1 ? '' : 's'}` : ''}` : ''}
                </span>
                <button type="button" disabled={building || loading || !take} onClick={() => void load(true)} title="Find the steps again from the clicks (the names you typed stay)" className="ml-auto flex items-center gap-1 font-semibold text-krypt-purple hover:underline disabled:opacity-50">
                  <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
                  Find again
                </button>
                <button type="button" disabled={!take} onClick={() => void copyPrompt()} title={take ? appVideoPrompt(kindId, take.name) : ''} className="flex items-center gap-1 font-semibold text-krypt-purple hover:underline disabled:opacity-50">
                  <Bot className="h-3 w-3" />
                  Have an agent write them
                </button>
              </div>
              {guessed && (
                <div className="mb-2 rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-100">
                  {(facts?.clicks ?? -1) < 0 ? 'This recording did not come with its clicks (it was not made with Record and “Product demo” ticked), so' : 'Nothing was clicked in this recording, so'} it is split evenly and the
                  camera will not zoom. Set the seconds of each step to where things happen.
                </div>
              )}
              <div data-agent="app-steps" className="space-y-2">
                {loading && rows.length === 0 && <div className="text-xs text-krypt-muted">Finding the steps…</div>}
                {rows.map((r, i) => (
                  <div key={r.key} data-step={i + 1} className="flex gap-3 rounded-xl border border-white/10 bg-black/25 p-2.5">
                    <div className="flex aspect-video w-32 flex-shrink-0 items-center justify-center overflow-hidden rounded-lg border border-white/10 bg-black/60">
                      {thumbs.get(r.key) ? <img src={thumbs.get(r.key)} alt="" className="h-full w-full object-contain" /> : <AppWindow className="h-5 w-5 text-krypt-muted" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 flex items-center gap-2 text-[11px] text-krypt-muted">
                        <span className="font-semibold text-white/90">
                          {kind.step} {i + 1}
                        </span>
                        <input type="number" step={0.1} min={0} value={r.from} disabled={building} title="Where it starts in the recording, seconds" onChange={(e) => patch(r.key, { from: Math.max(0, Number(e.target.value) || 0) })} className={small} />
                        <span>to</span>
                        <input type="number" step={0.1} min={0} value={r.to} disabled={building} title="Where it ends in the recording, seconds" onChange={(e) => patch(r.key, { to: Math.max(0, Number(e.target.value) || 0) })} className={small} />
                        <span>s{r.clicks > 0 ? ` · ${r.clicks} click${r.clicks === 1 ? '' : 's'}` : ''}</span>
                        <span className="ml-auto flex gap-1">
                          {i > 0 && (
                            <button type="button" disabled={building} onClick={() => mergeUp(r.key)} title="Join it to the step above" className="rounded p-1 text-krypt-muted transition hover:bg-white/10 hover:text-white disabled:opacity-50">
                              <ArrowUpToLine className="h-3.5 w-3.5" />
                            </button>
                          )}
                          <button type="button" disabled={building} onClick={() => remove(r.key)} title="Leave this step out" className="rounded p-1 text-krypt-muted transition hover:bg-white/10 hover:text-rose-300 disabled:opacity-50">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </span>
                      </div>
                      <input
                        data-step-name={i + 1}
                        value={r.heading}
                        disabled={building}
                        onChange={(e) => patch(r.key, { heading: e.target.value })}
                        placeholder={kindId === 'guide' ? 'What to do: “Open the settings”' : 'What it does for you: “Find any note in a second”'}
                        className={`${field} font-semibold`}
                      />
                      {voice !== 'recording' && (
                        <input
                          data-step-line={i + 1}
                          value={r.text}
                          disabled={building}
                          onChange={(e) => patch(r.key, { text: e.target.value })}
                          placeholder={voice === 'built-in' ? 'One sentence to say over it (its name is said when left empty)' : 'One sentence shown under it (optional)'}
                          className={`${field} mt-1.5`}
                        />
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-4 grid grid-cols-2 gap-3">
                {kindId !== 'trailer' && voice !== 'recording' && (
                  <div className="col-span-2">
                    <div className="mb-1 text-xs text-krypt-muted">Closing line (optional{kindId === 'guide' ? '; the steps are listed again while it is said' : ''})</div>
                    <input value={closing} disabled={building} onChange={(e) => setClosing(e.target.value)} className={field} />
                  </div>
                )}
                <div>
                  <div className="mb-1 text-xs text-krypt-muted">End card (optional)</div>
                  <input value={action} disabled={building} onChange={(e) => setAction(e.target.value)} placeholder={kindId === 'guide' ? 'That is it' : 'Download free'} className={field} />
                </div>
                <div>
                  <div className="mb-1 text-xs text-krypt-muted">Where to get it (optional)</div>
                  <input value={where} disabled={building} onChange={(e) => setWhere(e.target.value)} placeholder="example.com" className={field} />
                </div>
                {kindId === 'trailer' && (
                  <div className="col-span-2">
                    <div className="mb-1 text-xs text-krypt-muted">Small print at the foot of the end card (optional)</div>
                    <input value={note} disabled={building} onChange={(e) => setNote(e.target.value)} placeholder="Windows, macOS, Linux." className={field} />
                  </div>
                )}
              </div>
              {hasClips && (
                <label className="mt-3 flex items-center gap-2 text-xs text-white/90" title="The recording stays in the library. Undo brings the timeline back">
                  <input type="checkbox" checked={clear} disabled={building} onChange={(e) => setClear(e.target.checked)} className="accent-krypt-purple" />
                  Start on an empty timeline (what is on it now is taken off; the recording stays in the library)
                </label>
              )}
            </>
          )}
        </div>

        {busy && (
          <div className="mt-3">
            <div className="mb-1 truncate text-xs text-krypt-muted">{busy.status}</div>
            <div className="h-1.5 overflow-hidden rounded-full bg-white/10">{busy.ratio > 0 ? <div className="h-full bg-krypt-gradient transition-all" style={{ width: `${Math.round(busy.ratio * 100)}%` }} /> : <div className="h-full w-full animate-pulse bg-krypt-gradient" />}</div>
          </div>
        )}
        {!busy && problem && rows.length > 0 && (
          <div data-agent="app-problem" className="mt-3 text-xs text-amber-200">
            {problem}
          </div>
        )}
        {error && <div className="mt-3 max-h-24 overflow-y-auto whitespace-pre-wrap text-xs text-red-400">{error}</div>}

        <div className="mt-4 flex justify-end gap-2">
          <GhostButton
            onClick={() => {
              abortRef.current?.abort();
              onClose();
            }}
          >
            {building ? 'Cancel' : 'Close'}
          </GhostButton>
          <PrimaryButton onClick={() => void build()} disabled={building || loading || !take || rows.length === 0 || problem !== null}>
            <AppWindow className="h-4 w-4" />
            Build the {kind.name.toLowerCase()}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}
