import { useMemo, useRef, useState } from 'react';
import { Globe } from 'lucide-react';
import { GhostButton, PrimaryButton } from '../components/common';
import { useToast } from '../state/ToastProvider';
import { runAgentTool } from './agentTools';
import { parseSteps, webAddress } from './webCapture';

const EXAMPLE = `# One step per line, for example:
click Pricing
wait 1
click Choose Pro
type hello into Search
press Enter
scroll 600`;

/**
 * Web capture: film a web page being used, without recording the screen. The
 * work is the capture_web tool, the same one an agent calls: the page opens in
 * a hidden window of its own, the steps are done on it, and the film lands on
 * the timeline as a product demo.
 */
export function WebCaptureDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [url, setUrl] = useState('');
  const [lines, setLines] = useState('');
  const [demo, setDemo] = useState(true);
  const [busy, setBusy] = useState<'look' | 'film' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seen, setSeen] = useState<{ image: string; names: string[] } | null>(null);
  const abort = useRef<AbortController | null>(null);

  const address = webAddress(url);
  const parsed = useMemo(() => parseSteps(lines), [lines]);
  const ready = !!address && parsed.errors.length === 0 && !busy;

  const run = async (record: boolean): Promise<void> => {
    if (!address) return;
    setBusy(record ? 'film' : 'look');
    setError(null);
    const ctl = new AbortController();
    abort.current = ctl;
    const r = await runAgentTool({ rid: 0, tool: 'capture_web', args: { url: address, steps: parsed.steps, record, demo }, client: 'Krypt Editor' }, () => undefined, ctl.signal);
    abort.current = null;
    setBusy(null);
    if (ctl.signal.aborted) return;
    if (!r.ok) {
      setError(r.text.split('\n').filter((l) => !l.startsWith('- ') && !l.startsWith('What can be')).join('\n'));
      if (r.images?.[0]) setSeen({ image: r.images[0].data, names: namesIn(r.text) });
      return;
    }
    if (!record) {
      setSeen(r.images?.[0] ? { image: r.images[0].data, names: namesIn(r.text) } : null);
      return;
    }
    toast.success(`${r.text.split('\n')[0]} It is on the timeline. Undo reverts it.`);
    onClose();
  };

  const close = (): void => {
    abort.current?.abort();
    onClose();
  };

  const field = 'w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none placeholder:text-white/30 focus:border-krypt-purple/60 disabled:opacity-50';
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center rounded-2xl bg-krypt-void/85 backdrop-blur-sm animate-fade-in">
      <div className="max-h-[94%] w-[560px] max-w-[96%] overflow-y-auto rounded-2xl border border-white/10 bg-krypt-panel/95 p-6 shadow-krypt-card" data-dialog="web-capture">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl border border-white/10 bg-krypt-purple/15">
            <Globe className="h-5 w-5 text-krypt-purple" />
          </div>
          <div>
            <div className="text-sm font-bold text-white">Film a web page</div>
            <div className="text-xs text-krypt-muted">Krypt Editor opens the page in a hidden window of its own, does the steps you list, and films only that page: your screen is never recorded. The page is not signed in to anything.</div>
          </div>
        </div>

        <div className="mb-1 text-xs text-krypt-muted">Address</div>
        <input value={url} disabled={!!busy} onChange={(e) => setUrl(e.target.value)} placeholder="yoursite.com" spellCheck={false} className={field} data-field="web-url" />
        {url.trim() && !address && <div className="mt-1 text-xs text-amber-300">That does not look like a web address.</div>}

        <div className="mb-1 mt-3 text-xs text-krypt-muted">What to do on it (optional)</div>
        <textarea value={lines} disabled={!!busy} onChange={(e) => setLines(e.target.value)} placeholder={EXAMPLE} spellCheck={false} rows={7} className={`${field} resize-y font-mono text-xs leading-relaxed`} data-field="web-steps" />
        <div className="mt-1 text-[11px] text-krypt-muted">
          Name things by the words on them. Steps: <b>click</b>, <b>hover</b>, <b>type … into …</b>, <b>press</b>, <b>scroll</b> (a number, up, or <i>to</i> something), <b>wait</b> (seconds, or <i>for</i> something), <b>go to</b>.
        </div>
        {parsed.errors.length > 0 && <div className="mt-2 whitespace-pre-wrap text-xs text-amber-300">{parsed.errors.join('\n')}</div>}

        <label className="mt-3 flex items-center gap-2 text-xs text-white/90">
          <input type="checkbox" checked={demo} disabled={!!busy} onChange={(e) => setDemo(e.target.checked)} className="accent-krypt-purple" />
          Make it a product demo: window frame, zooms on the clicks, click sounds
        </label>

        {seen && (
          <div className="mt-3 rounded-xl border border-white/10 bg-black/30 p-2">
            <img src={`data:image/jpeg;base64,${seen.image}`} alt="The page as the capture sees it" className="w-full rounded-lg" />
            {seen.names.length > 0 && (
              <div className="mt-2 text-[11px] leading-relaxed text-krypt-muted">
                On this page: {seen.names.slice(0, 24).map((n, i) => (
                  <button key={`${n}-${i}`} type="button" disabled={!!busy} onClick={() => setLines((v) => `${v.trim() ? `${v.replace(/\s+$/, '')}\n` : ''}click ${n}\n`)} className="mr-1 mt-1 inline-block rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-white/85 hover:bg-white/10" title="Add a click on this">
                    {n}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {busy && <div className="mt-3 text-xs text-krypt-muted">{busy === 'film' ? 'Filming the page as the steps are done. This takes as long as the steps do…' : 'Opening the page…'}</div>}
        {error && <div className="mt-3 max-h-28 overflow-y-auto whitespace-pre-wrap text-xs text-red-400">{error}</div>}

        <div className="mt-5 flex justify-end gap-2">
          <GhostButton onClick={close}>{busy ? 'Cancel' : 'Close'}</GhostButton>
          <GhostButton onClick={() => void run(false)} disabled={!ready}>
            Look first
          </GhostButton>
          <PrimaryButton onClick={() => void run(true)} disabled={!ready}>
            <Globe className="h-4 w-4" />
            Film it
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}

/** The names of the things that can be clicked, from the tool's list ("- "Pricing" (link) at …"). */
function namesIn(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const m = /^- "(.+)" \([a-z]+\) at /.exec(line);
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}
