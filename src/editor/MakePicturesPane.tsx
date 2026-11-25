import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Sparkles, X } from 'lucide-react';
import type { MediaFile } from '@shared/types';
import { PICTURE_LOOKS, DEFAULT_LOOK, picturePrompt, sourceName, type PictureAspect } from '@shared/imageGen';
import { GhostButton, PrimaryButton } from '../components/common';
import { useToast } from '../state/ToastProvider';
import { canvasAspect, makePictures, NO_PICTURE_SOURCE } from './pictures';
import { usePictureSetup } from './PictureSetupCard';
import { useTimelineStore } from './timelineStore';

const PREFS_KEY = 'krypt.pictures.make';
const MAX_AT_ONCE = 24;

function loadPrefs(): { look: string; keep: string; text: string } {
  try {
    const j = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as { look?: string; keep?: string; text?: string };
    return { look: PICTURE_LOOKS.find((l) => l.id === j.look)?.id ?? DEFAULT_LOOK, keep: typeof j.keep === 'string' ? j.keep.slice(0, 300) : '', text: typeof j.text === 'string' ? j.text.slice(0, 4000) : '' };
  } catch {
    return { look: DEFAULT_LOOK, keep: '', text: '' };
  }
}

/**
 * The "Make from words" tab of Find pictures: one description per line, a
 * look, and what stays the same in every picture. The pictures are made where
 * Settings says (this computer, or a service with the user's key) and land in
 * the media library as they come; with `onUse` they are also handed back.
 */
export function MakePicturesPane({ onClose, onUse, useLabel }: { onClose: () => void; onUse?: (paths: string[]) => void; useLabel?: string }) {
  const toast = useToast();
  const prefs = useMemo(loadPrefs, []);
  const { setup, source } = usePictureSetup();
  const canvas = useTimelineStore((s) => s.canvas);
  const [text, setText] = useState(prefs.text);
  const [look, setLook] = useState(prefs.look);
  const [keep, setKeep] = useState(prefs.keep);
  const [aspect, setAspect] = useState<PictureAspect>(() => canvasAspect(canvas.width, canvas.height));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [remarks, setRemarks] = useState<string[]>([]);
  const [made, setMade] = useState<MediaFile[]>([]);
  const stop = useRef<AbortController | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ look, keep, text }));
    } catch {
      /* not remembered, nothing else */
    }
  }, [look, keep, text]);
  // Closing the dialog stops what is being made.
  useEffect(() => () => stop.current?.abort(), []);

  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const tooMany = lines.length > MAX_AT_ONCE;
  const paid = source !== null && source !== 'local';
  const example = lines[0] ? picturePrompt(lines[0], look, keep) : '';

  const run = async (): Promise<void> => {
    if (lines.length === 0 || tooMany || !source) return;
    const ctl = new AbortController();
    stop.current = ctl;
    setBusy(true);
    setError(null);
    setRemarks([]);
    setNote('Starting…');
    try {
      const r = await makePictures(lines, { look, keep, aspect, signal: ctl.signal, onStep: (_d, _t, n) => setNote(n), onPicture: (_i, m) => setMade((was) => (was.some((x) => x.id === m.id) ? was : [...was, m])) });
      const n = r.media.filter(Boolean).length;
      if (ctl.signal.aborted) setNote(n ? `Stopped. ${n} made before that ${n === 1 ? 'is' : 'are'} in the media library.` : 'Stopped.');
      else {
        setNote('');
        if (n) toast.success(`${n} picture${n === 1 ? '' : 's'} made and added to the media library.`);
        if (r.failed.length) setError(`Not made: ${r.failed.join('; ')}`);
        // What the caption above already says (the squares) is not said twice.
        setRemarks(r.notes.filter((x) => !x.startsWith('The model on this computer draws')));
      }
    } catch (e) {
      setNote('');
      if (!ctl.signal.aborted) setError((e as Error).message);
    }
    stop.current = null;
    setBusy(false);
  };

  const field = 'rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-krypt-purple/60 disabled:opacity-50';
  return (
    <>
      <div data-make-pictures className="grid grid-cols-[minmax(0,1fr)_230px] gap-3">
        <textarea
          autoFocus
          data-make-text
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          rows={5}
          placeholder={'One picture per line. Say what is seen:\na lighthouse in a storm at night\nthe keeper climbing the stairs with a lantern'}
          className={`${field} min-w-0 resize-none leading-snug`}
        />
        <div className="flex flex-col gap-2">
          <select data-make-look value={look} disabled={busy} onChange={(e) => setLook(e.target.value)} className={field} title="The drawing style put around every description">
            {PICTURE_LOOKS.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          <select data-make-aspect value={aspect} disabled={busy} onChange={(e) => setAspect(e.target.value as PictureAspect)} className={field}>
            <option value="16:9">Wide (16:9)</option>
            <option value="9:16">Tall (9:16)</option>
            <option value="1:1">Square</option>
          </select>
          <input data-make-keep value={keep} disabled={busy} onChange={(e) => setKeep(e.target.value)} maxLength={300} placeholder="Same in every picture: a tall man in a red scarf" className={field} title="The characters and the place, so they look alike from picture to picture" />
        </div>
      </div>
      <div className="mt-1.5 text-[11px] leading-snug text-krypt-muted">
        {!setup
          ? ''
          : source === null
            ? NO_PICTURE_SOURCE
            : paid
              ? `Made by ${sourceName(source)} with your key: each picture is charged to your account there, and the descriptions are sent to it. ${setup.madeToday} of ${setup.settings.dailyLimit} made today.`
              : 'Made on this computer: free, nothing is sent anywhere. A small model: simple scenes work best, it reads only the first 60 or so words, and it draws 512 × 512 squares, so a wide or tall picture is cut from one and is soft when shown large.'}
        {example && source !== null && <span className="mt-0.5 block truncate opacity-70" title={example}>Sent as: {example}</span>}
      </div>

      <div className="mt-3 min-h-[200px] flex-1 overflow-y-auto pr-1">
        {made.length > 0 ? (
          <div className="grid grid-cols-4 gap-2">
            {made.map((m) => (
              <div key={m.id} data-made-picture={m.id} className="overflow-hidden rounded-lg border border-white/10 bg-black/40" title={m.name}>
                <img src={m.mediaUrl} alt="" className="aspect-video w-full object-contain" draggable={false} />
              </div>
            ))}
          </div>
        ) : (
          !error && (
            <div className="flex h-full min-h-[180px] flex-col items-center justify-center gap-2 text-center text-xs text-krypt-muted">
              {busy ? <Loader2 className="h-6 w-6 animate-spin" /> : <Sparkles className="h-6 w-6 opacity-60" />}
              <div className="max-w-sm">{busy ? note : 'For scenes no photograph exists of: the panels of a story, an imagined place. For real things (a named place, a person, an event) search the libraries instead: a made picture of them would be an invention.'}</div>
            </div>
          )
        )}
        {busy && made.length > 0 && (
          <div data-make-note className="mt-2 flex items-center gap-2 text-xs text-krypt-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {note}
          </div>
        )}
        {!busy && note && <div className="mt-2 text-xs text-krypt-muted">{note}</div>}
        {remarks.length > 0 && (
          <div data-make-remarks className="mt-3 whitespace-pre-wrap rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-krypt-muted">
            {remarks.join('\n')}
          </div>
        )}
        {error && (
          <div data-make-error className="mt-3 whitespace-pre-wrap rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            {error}
          </div>
        )}
      </div>

      <div className="mt-4 flex items-center justify-between gap-2">
        <div className="text-xs text-krypt-muted">{tooMany ? `At most ${MAX_AT_ONCE} at a time (${lines.length} lines).` : made.length ? `${made.length} in the media library.` : ''}</div>
        <div className="flex gap-2">
          {busy ? (
            <GhostButton onClick={() => stop.current?.abort()}>
              <X className="h-4 w-4" />
              Stop
            </GhostButton>
          ) : (
            <GhostButton onClick={onClose}>Close</GhostButton>
          )}
          {onUse && made.length > 0 && !busy && (
            <GhostButton
              onClick={() => {
                onUse(made.map((m) => m.filePath));
                onClose();
              }}
            >
              {useLabel ?? 'Use them'} ({made.length})
            </GhostButton>
          )}
          <PrimaryButton onClick={() => void run()} disabled={busy || lines.length === 0 || tooMany || source === null}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {lines.length > 1 ? `Make ${lines.length} pictures` : 'Make the picture'}
          </PrimaryButton>
        </div>
      </div>
    </>
  );
}
