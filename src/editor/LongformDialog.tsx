import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Clapperboard, Copy, ImagePlus, Images, Plug, Sparkles } from 'lucide-react';
import { GhostButton, PrimaryButton } from '../components/common';
import { useToast } from '../state/ToastProvider';
import { runAgentTool } from './agentTools';
import { LONGFORM_FORMATS, findFormat, parseScript, scriptStats } from './longform';
import { useMediaStore } from './mediaStore';
import { activeStyle, allStyles } from './styles';
import { ART_STYLES } from './art/art';
import { ArtPicker } from './ArtPicker';
import { useMcpStatus } from './AiPanel';
import { LONGFORM_EXAMPLES, agentPrompt } from './longformExamples';
import { answerIndex } from './quiz';
import { useTimelineStore } from './timelineStore';
import { TTS_VOICES, warmUpVoice } from './tts';
import { VoiceModelCard } from './VoiceModelCard';
import { ImageFinderDialog } from './ImageFinderDialog';
import { usePictureSetup } from './PictureSetupCard';
import { NO_PICTURE_SOURCE } from './pictures';
import { DEFAULT_LOOK, PICTURE_LOOKS, pictureBeatsWithin, sourceName } from '@shared/imageGen';

const VOICES = TTS_VOICES.filter((v) => v.value.startsWith('kokoro:'));
const DRAFT_KEY = 'krypt.longformDraft';

const HELP = '# Title on the first line. Text before the first section is the opening.\n## A heading starts a section; the paragraphs under it are what the narrator says.\n- A line starting with a dash is a key point shown on screen.\nA line that is only a file path (or "Add pictures" / "Find pictures") puts that picture or video on screen for the section.\n## Outro is spoken over the closing card.';

const mmss = (s: number): string => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

interface Draft {
  format: string;
  script: string;
  voice: string;
}

function loadDraft(): Draft {
  try {
    const j = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? '{}') as Partial<Draft>;
    return { format: findFormat(j.format)?.id ?? LONGFORM_FORMATS[0].id, script: typeof j.script === 'string' ? j.script : '', voice: VOICES.some((v) => v.value === j.voice) ? j.voice! : VOICES[0].value };
  } catch {
    return { format: LONGFORM_FORMATS[0].id, script: '', voice: VOICES[0].value };
  }
}

/**
 * Longform: a whole narrated video from a script. The script is typed or
 * pasted as plain text (longform.ts parseScript), a format says how the video
 * is put together, and the build is the same one agents run (build_longform),
 * so it queues behind any agent call and is one undo step.
 */
export function LongformDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const draft = useMemo(loadDraft, []);
  const [formatId, setFormatId] = useState(draft.format);
  const [script, setScript] = useState(draft.script);
  const [voice, setVoice] = useState(draft.voice);
  // A style the user saved and keeps active is their look; otherwise the format brings its own.
  const [styleId, setStyleId] = useState(() => {
    const a = activeStyle();
    return a && !a.builtin ? a.id : '';
  });
  const [musicId, setMusicId] = useState('');
  // Drawn visuals: '' = the pictures named in the script (a section without any becomes designed text).
  const [artId, setArtId] = useState(() => {
    try {
      const v = localStorage.getItem('krypt.longformArt') ?? '';
      return ART_STYLES.some((s) => s.id === v) ? v : '';
    } catch {
      return '';
    }
  });
  const pickArt = (v: string): void => {
    setArtId(v);
    // A drawn style and made pictures both fill the parts without pictures: one or the other.
    if (v) setMadePics(false);
    try {
      localStorage.setItem('krypt.longformArt', v);
    } catch {
      // Not remembered, nothing else.
    }
  };
  const artStyle = ART_STYLES.find((s) => s.id === artId);
  // Pictures made from the words: one per beat of every part that has none of its own.
  const pictureSetup = usePictureSetup();
  const [madePics, setMadePics] = useState(false);
  const [madeLook, setMadeLook] = useState(() => {
    try {
      const v = localStorage.getItem('krypt.longformMadeLook') ?? '';
      return PICTURE_LOOKS.some((l) => l.id === v) ? v : DEFAULT_LOOK;
    } catch {
      return DEFAULT_LOOK;
    }
  });
  const [madeKeep, setMadeKeep] = useState('');
  const pickMadeLook = (v: string): void => {
    setMadeLook(v);
    try {
      localStorage.setItem('krypt.longformMadeLook', v);
    } catch {
      // Not remembered, nothing else.
    }
  };
  // Comic panels: a still per sentence instead of an acted-out scene.
  const [panels, setPanels] = useState(() => findFormat(draft.format)?.panels === true);
  // An agent can write the script too: who is connected, and a prompt to hand it.
  const mcp = useMcpStatus();
  const agents = mcp?.enabled && mcp.clients.length > 0 ? mcp.clients.map((c) => c.name).join(', ') : '';
  const [copied, setCopied] = useState(false);
  const [captions, setCaptions] = useState(true);
  const [clear, setClear] = useState(false);
  const [voiceover, setVoiceover] = useState(false);
  const [busy, setBusy] = useState<{ status: string; ratio: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const boxRef = useRef<HTMLTextAreaElement | null>(null);
  const songs = useMediaStore((s) => s.media).filter((m) => m.kind === 'audio' && !/^(voiceover|revoice)-/.test(m.name));
  const hasClips = useTimelineStore((s) => s.clips.length > 0);
  const format = findFormat(formatId) ?? LONGFORM_FORMATS[0];
  const styles = useMemo(() => allStyles(), []);

  useEffect(() => void warmUpVoice(), []);
  useEffect(() => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ format: formatId, script, voice } satisfies Draft));
    } catch {
      /* a full or blocked store only loses the draft */
    }
  }, [formatId, script, voice]);

  const parsed = useMemo(() => parseScript(script), [script]);
  // A trailer's sections need only a headline, and a quiz's are questions: neither has to have narration under it.
  const layout = format.layout;
  const spoken = layout ? parsed.sections : parsed.sections.filter((s) => s.text.trim());
  const unanswered = layout === 'quiz' ? parsed.sections.filter((s) => s.points.length < 2 || s.points.length > 4 || answerIndex(s.answer, s.points) < 0).map((s) => s.heading) : [];
  // How many pictures "made from the words" would come to: the parts that name none of their own.
  const madeCount = useMemo(
    () =>
      pictureBeatsWithin([...(parsed.hook && !parsed.hookVisuals?.length ? [parsed.hook] : []), ...parsed.sections.filter((s) => s.text.trim() && !s.visuals?.length).map((s) => s.text)])
        .reduce((n, b) => n + b.length, 0),
    [parsed],
  );
  const stats = scriptStats({ hook: parsed.hook, sections: spoken, outro: parsed.outro }, format);
  const pictures = parsed.hookVisuals.length + parsed.sections.reduce((n, s) => n + s.visuals.length, 0);
  const silent = layout ? [] : parsed.sections.filter((s) => !s.text.trim()).map((s) => s.heading);
  const ready = parsed.title.trim() !== '' && spoken.length > 0 && silent.length === 0 && unanswered.length === 0;

  const example = LONGFORM_EXAMPLES[format.id] ?? LONGFORM_EXAMPLES.explainer;
  const pickFormat = (id: string): void => {
    // An example nobody has changed follows the format.
    const next = LONGFORM_EXAMPLES[id];
    if (next && Object.values(LONGFORM_EXAMPLES).includes(script)) setScript(next);
    setFormatId(id);
    // A format that is drawn by default (a comic story) picks its style, unless one is already chosen.
    const picked = findFormat(id);
    if (picked?.visualStyle && !artId && !madePics) setArtId(picked.visualStyle);
    setPanels(picked?.panels === true);
  };
  const copyPrompt = async (): Promise<void> => {
    await window.krypt.app.copyText(agentPrompt(format.name, artStyle?.name));
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
    toast.success(agents ? `Prompt copied. Paste it into ${agents} and put your topic in.` : 'Prompt copied. Paste it into your AI agent and put your topic in.');
  };

  // Where the text cursor was when a picture was asked for: the box loses it while a dialog is open.
  const caret = useRef<number | null>(null);
  const [finding, setFinding] = useState(false);
  const putPictures = (paths: string[]): void => {
    if (paths.length === 0) return;
    const at = Math.min(caret.current ?? boxRef.current?.selectionStart ?? script.length, script.length);
    // Whole lines: a picture belongs to the section it is under.
    const lineEnd = script.indexOf('\n', at);
    const cut = lineEnd < 0 ? script.length : lineEnd;
    const lines = paths.join('\n');
    setScript(`${script.slice(0, cut)}${cut > 0 ? '\n' : ''}${lines}${script.slice(cut) || '\n'}`);
  };
  const addPictures = async (): Promise<void> => {
    caret.current = boxRef.current?.selectionStart ?? null;
    const r = await window.krypt.media.pickFiles();
    putPictures((r.ok ? (r.data ?? []) : []).filter((f) => f.kind !== 'audio').map((f) => f.filePath));
  };
  const findPictures = (): void => {
    caret.current = boxRef.current?.selectionStart ?? null;
    setFinding(true);
  };

  const build = async (): Promise<void> => {
    const abort = new AbortController();
    abortRef.current = abort;
    setError(null);
    setBusy({ status: 'Starting…', ratio: 0 });
    const args = {
      format: format.id,
      title: parsed.title,
      subtitle: parsed.subtitle,
      hook: parsed.hook,
      hook_visuals: parsed.hookVisuals,
      sections: spoken.map((s) =>
        layout === 'quiz'
          ? { heading: s.heading, text: s.text || undefined, options: s.points.slice(0, 4), answer: s.answer, visuals: s.visuals }
          : { heading: s.heading, text: s.text || undefined, points: s.points.slice(0, 6), visuals: s.visuals, kicker: s.kicker, figure: s.figure, winner: s.winner },
      ),
      // A trailer's closing words are its call to action, on the end card.
      outro: layout === 'trailer' && parsed.outro?.text ? { title: parsed.outro.text.split('\n')[0].slice(0, 80) } : parsed.outro,
      voice,
      music: musicId || undefined,
      captions: layout === 'trailer' ? captions && voiceover : captions,
      ...(layout === 'trailer' ? { voiceover } : {}),
      // What the cards show is what is built: "My pictures" means none, even in a format that draws by default.
      visual_style: layout || madePics ? undefined : artId || 'none',
      scene_mode: artId && !madePics && !layout ? (panels ? 'panels' : 'animated') : undefined,
      ...(madePics && !layout ? { pictures: 'auto', picture_look: madeLook, picture_keep: madeKeep.trim() || undefined } : {}),
      // The format's own look unless another was picked here. With drawn visuals and no pick, the cards take the drawing's colours.
      style: styleId || (artId && !layout ? undefined : format.style),
      clear,
    };
    const r = await runAgentTool({ rid: 0, tool: 'build_longform', args, client: 'Krypt Editor' }, (ratio, status) => setBusy({ ratio, status }), abort.signal);
    if (r.ok) {
      toast.success(`${r.text.split('\n')[0]} Undo reverts it.`);
      onClose();
      return;
    }
    if (!abort.signal.aborted) setError(r.text);
    setBusy(null);
  };

  const field = 'w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-sm text-white outline-none focus:border-krypt-purple/60 disabled:opacity-50';
  const building = busy !== null;
  return (
    <>
    {finding && <ImageFinderDialog onClose={() => setFinding(false)} onUse={putPictures} useLabel="Put in the script" />}
    <div className="absolute inset-0 z-40 flex items-center justify-center rounded-2xl bg-krypt-void/85 backdrop-blur-sm animate-fade-in">
      <div className="flex max-h-[94%] w-[760px] max-w-[96%] flex-col rounded-2xl border border-white/10 bg-krypt-panel/95 p-6 shadow-krypt-card">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl border border-white/10 bg-krypt-purple/15">
            <Clapperboard className="h-5 w-5 text-krypt-purple" />
          </div>
          <div>
            <div className="text-sm font-bold text-white">Longform</div>
            <div className="text-xs text-krypt-muted">A whole narrated video from a script: voice, title and chapter cards, your pictures or scenes drawn for you, key points, captions, music and chapters. Everything it makes can be edited afterwards.</div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          <div className="mb-1 text-xs text-krypt-muted">Format</div>
          <div className="grid grid-cols-4 gap-2">
            {LONGFORM_FORMATS.map((f) => (
              <button
                key={f.id}
                type="button"
                disabled={building}
                onClick={() => pickFormat(f.id)}
                title={f.description}
                className={`rounded-lg border px-3 py-2 text-left transition disabled:opacity-50 ${f.id === format.id ? 'border-krypt-purple/60 bg-krypt-purple/20' : 'border-white/10 bg-white/5 hover:bg-white/10'}`}
              >
                <div className="text-sm font-semibold text-white">{f.name}</div>
                <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-krypt-muted">{f.description}</div>
              </button>
            ))}
          </div>

          {/* A trailer and a quiz lay themselves out: nothing is drawn or made for them. */}
          <div className={layout ? 'hidden' : ''}>
          <div className="mb-1 mt-4 flex items-baseline justify-between gap-3">
            <div className="text-xs text-krypt-muted">Visuals</div>
            <div className="truncate text-[11px] text-krypt-muted">{artStyle ? artStyle.about : 'Drawn for you, or your own pictures. Point at a style to see it move.'}</div>
          </div>
          <ArtPicker value={artId} disabled={building} onChange={pickArt} />
          {artStyle && (
            <label data-agent="longform-panels" className="mt-2 flex items-center gap-2 text-xs text-white/90" title="On: one still drawing per sentence, like comic panels; a panel that stays up four seconds or more moves slightly. Builds in seconds. Off: every scene is acted out as animation, which takes a few minutes">
              <input type="checkbox" checked={panels} disabled={building} onChange={(e) => setPanels(e.target.checked)} />
              Comic panels: a still per sentence, the long ones moving slightly (fast to build)
            </label>
          )}

          <label data-agent="longform-made-pictures" className="mt-2 flex items-center gap-2 text-xs text-white/90" title="Every part of the script that has no pictures of its own gets pictures made from its words, one about every four seconds. Where they are made is set in Settings, Pictures from words">
            <input
              type="checkbox"
              checked={madePics}
              disabled={building || pictureSetup.source === null}
              onChange={(e) => {
                setMadePics(e.target.checked);
                if (e.target.checked) pickArt('');
              }}
            />
            Make the pictures from the words (AI): one per beat of the narration
          </label>
          {madePics && pictureSetup.source !== null ? (
            <>
              <div className="mt-1.5 flex gap-2">
                <select data-agent="longform-made-look" value={madeLook} disabled={building} onChange={(e) => pickMadeLook(e.target.value)} className="rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 text-xs text-white outline-none focus:border-krypt-purple/60 disabled:opacity-50">
                  {PICTURE_LOOKS.filter((l) => l.id !== 'plain').map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
                <input
                  data-agent="longform-made-keep"
                  value={madeKeep}
                  disabled={building}
                  maxLength={300}
                  onChange={(e) => setMadeKeep(e.target.value)}
                  placeholder="Same in every picture: Sam, a tall man in a red scarf; a rainy city"
                  className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 text-xs text-white outline-none focus:border-krypt-purple/60 disabled:opacity-50"
                />
              </div>
              <div className="mt-1 text-[11px] leading-snug text-krypt-muted">
                About {madeCount} picture{madeCount === 1 ? '' : 's'}, made{' '}
                {pictureSetup.source === 'local' ? 'on this computer (free, nothing is sent anywhere).' : `by ${sourceName(pictureSetup.source)} with your key: each one is charged to your account there, and the narration is sent to it.`}
              </div>
            </>
          ) : (
            pictureSetup.setup && pictureSetup.source === null && <div className="mt-1 text-[11px] leading-snug text-krypt-muted">{NO_PICTURE_SOURCE}</div>
          )}

          </div>

          <div className="mb-1 mt-4 flex items-center justify-between">
            <div className="text-xs text-krypt-muted">Script</div>
            <div className="flex items-center gap-3 text-xs">
              {!script.trim() && (
                <button type="button" className="text-krypt-purple hover:underline" title={`A short ${format.name.toLowerCase()} script to try. It changes with the format until you edit it`} onClick={() => setScript(example)}>
                  Start from an example
                </button>
              )}
              <button type="button" disabled={building} className="flex items-center gap-1 text-krypt-purple hover:underline disabled:opacity-50" onClick={() => void addPictures()} title="Pictures and videos go under the section they belong to, in the order they should appear">
                <ImagePlus className="h-3.5 w-3.5" />
                Add pictures
              </button>
              <button type="button" data-agent="longform-find-pictures" disabled={building} className="flex items-center gap-1 text-krypt-purple hover:underline disabled:opacity-50" onClick={findPictures} title="Look for free-to-use photographs, or read a Pinterest board. They go under the section the text cursor is in">
                <Images className="h-3.5 w-3.5" />
                Find pictures
              </button>
            </div>
          </div>
          <textarea ref={boxRef} value={script} disabled={building} onChange={(e) => setScript(e.target.value)} placeholder={HELP} spellCheck rows={12} className={`${field} resize-y font-mono text-[12.5px] leading-relaxed`} />
          <div className="mt-1 text-[11px] leading-snug text-krypt-muted">{format.tip}{layout === 'trailer' ? '' : ' About 150 spoken words make a minute.'}</div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-krypt-purple/25 bg-krypt-purple/10 px-3 py-2 text-[11px] leading-snug text-white/85">
            <Sparkles className="h-3.5 w-3.5 flex-shrink-0 text-krypt-purple" />
            <span className="min-w-0 flex-1 basis-64">
              No script? {agents ? `${agents} is connected and can` : 'An AI agent (Claude Code, Codex, Cursor…) can'} write it and build the whole video from one sentence.
            </span>
            <button type="button" data-agent="longform-copy-prompt" className="flex items-center gap-1 font-semibold text-krypt-purple hover:underline" onClick={() => void copyPrompt()} title={agentPrompt(format.name, artStyle?.name)}>
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? 'Copied' : 'Copy a prompt'}
            </button>
            {!agents && (
              <button type="button" className="flex items-center gap-1 font-semibold text-krypt-purple hover:underline" onClick={() => window.dispatchEvent(new Event('krypt:open-agents'))} title="Open AI agents to connect one">
                <Plug className="h-3.5 w-3.5" />
                Connect an agent
              </button>
            )}
          </div>

          <div className="mt-4 grid grid-cols-3 gap-3">
            <div>
              <div className="mb-1 text-xs text-krypt-muted">Voice</div>
              <select value={voice} disabled={building} onChange={(e) => setVoice(e.target.value)} className={field}>
                {VOICES.map((v) => (
                  <option key={v.value} value={v.value}>
                    {v.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <div className="mb-1 text-xs text-krypt-muted">Look</div>
              <select value={styleId} disabled={building} onChange={(e) => setStyleId(e.target.value)} className={field}>
                <option value="">The format's own</option>
                {styles.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <div className="mb-1 text-xs text-krypt-muted">Music</div>
              <select value={musicId} disabled={building} onChange={(e) => setMusicId(e.target.value)} className={field} title="A song from the media bin. It loops under the whole video and goes down under the voice">
                <option value="">{layout === 'trailer' ? 'A beat made for it' : songs.length ? 'None' : 'None (import a song first)'}</option>
                {songs.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-white/90">
            {layout === 'trailer' && (
              <label data-agent="longform-voiceover" className="flex items-center gap-2" title="Off: text and music carry the trailer. On: the line under each headline is said over its recording">
                <input type="checkbox" checked={voiceover} disabled={building} onChange={(e) => setVoiceover(e.target.checked)} />
                Voice-over
              </label>
            )}
            {layout !== 'quiz' && (layout !== 'trailer' || voiceover) && (
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={captions} disabled={building} onChange={(e) => setCaptions(e.target.checked)} />
                Captions
              </label>
            )}
            {hasClips && (
              <label className="flex items-center gap-2" title="Off: the video is built after what is already on the timeline">
                <input type="checkbox" checked={clear} disabled={building} onChange={(e) => setClear(e.target.checked)} />
                Replace what is on the timeline
              </label>
            )}
          </div>

          {!building && <VoiceModelCard compact />}
        </div>

        <div className="mt-3 text-xs text-krypt-muted">
          {!script.trim()
            ? 'Write or paste a script to begin.'
            : !parsed.title.trim() || parsed.sections.length === 0
              ? 'The script needs a "# Title" line and at least one "## Section".'
              : silent.length
                ? `Nothing to say yet under: ${silent.join(', ')}.`
                : unanswered.length
                  ? `Needs two to four answers as bullets, and a line "Answer: …" naming one of them: ${unanswered.slice(0, 3).map((q) => `"${q}"`).join(', ')}${unanswered.length > 3 ? ` and ${unanswered.length - 3} more` : ''}`
                  : layout === 'trailer'
                    ? `${spoken.length} feature${spoken.length === 1 ? '' : 's'} · about ${mmss(stats.seconds)} of video · ${pictures ? `${pictures} recording${pictures === 1 ? '' : 's'} in windows` : 'no recordings yet (a file path under a headline shows it; without one the headline stands alone)'} · every cut on the beat`
                    : layout === 'quiz'
                      ? `${spoken.length} question${spoken.length === 1 ? '' : 's'} · about ${mmss(stats.seconds)} of video · a 5-second countdown each · narrating takes about ${mmss(Math.max(10, stats.seconds / 8))}`
                      : `${spoken.length} section${spoken.length === 1 ? '' : 's'} · ${stats.words.toLocaleString()} words · about ${mmss(stats.seconds)} of video · ${artStyle ? `${pictures ? `${pictures} picture${pictures === 1 ? '' : 's'}, the rest ` : ''}drawn in ${artStyle.name}${panels ? ' as comic panels' : ''}` : pictures ? `${pictures} picture${pictures === 1 ? '' : 's'}` : 'no pictures (sections become designed text)'} · ${artStyle && !panels ? `narrating and drawing take about ${mmss(Math.max(15, stats.seconds / 6 + stats.seconds / (artStyle.engine === 'mascot' ? 2 : 4)))}` : `narrating takes about ${mmss(Math.max(10, stats.seconds / 6))}`}`}
        </div>

        {busy && (
          <div className="mt-3">
            <div className="flex items-center justify-between text-xs text-krypt-muted">
              <span className="truncate">{busy.status}</span>
              {busy.ratio > 0 && <span className="font-mono text-white">{Math.round(busy.ratio * 100)}%</span>}
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-white/10">
              {busy.ratio > 0 ? <div className="h-full bg-krypt-gradient transition-all" style={{ width: `${Math.round(busy.ratio * 100)}%` }} /> : <div className="h-full w-full animate-pulse bg-krypt-gradient" />}
            </div>
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
          <PrimaryButton onClick={() => void build()} disabled={building || !ready}>
            <Clapperboard className="h-4 w-4" />
            Build video
          </PrimaryButton>
        </div>
      </div>
    </div>
    </>
  );
}
