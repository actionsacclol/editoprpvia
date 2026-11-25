import { useEffect, useMemo, useState } from 'react';
import { Send } from 'lucide-react';
import type { MarketoStatus } from '@shared/types';
import { GhostButton, PrimaryButton } from '../components/common';
import { useToast } from '../state/ToastProvider';
import { sendToMarketo, useHandoffStore } from './marketo';
import { useProjectStore } from './projectStore';
import { chapterList, useTimelineStore } from './timelineStore';

type Visibility = 'unlisted' | 'public' | 'private';

/**
 * Send to Krypt Marketo: hands the exported video to the Krypt app that
 * uploads to YouTube (marketo.ts). Marketo keeps the video with its title,
 * description and files, and can put the file straight into YouTube Studio's
 * upload dialog; publishing is finished there.
 */
export function MarketoDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const exportPath = useHandoffStore((s) => s.exportPath);
  const script = useHandoffStore((s) => s.script);
  const sentId = useHandoffStore((s) => s.sentId);
  const projectName = useProjectStore((s) => s.name);
  const clips = useTimelineStore((s) => s.clips);
  const chapters = useMemo(() => chapterList(clips).text, [clips]);
  const [status, setStatus] = useState<MarketoStatus | null>(null);
  const [title, setTitle] = useState((script?.title ?? (projectName === 'Untitled' ? '' : projectName)).slice(0, 100));
  const [description, setDescription] = useState(chapters);
  const [tags, setTags] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('unlisted');
  const [upload, setUpload] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.krypt.marketo
      .status()
      .then(setStatus)
      .catch(() => setStatus({ installed: false, running: false, message: 'Could not reach Krypt Marketo.' }));
  }, []);

  const send = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const r = await sendToMarketo({
      title: title.trim() || undefined,
      description: description.trim() || undefined,
      tags: tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      visibility,
      upload,
    });
    setBusy(false);
    if (!r.ok) {
      setError(r.text);
      return;
    }
    toast.success(upload ? 'Sent to Krypt Marketo. The file is in YouTube Studio\'s upload dialog there: finish the details and press Save.' : 'Sent to Krypt Marketo: it is in the Long videos list.');
    onClose();
  };

  const field = 'w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-sm text-white outline-none focus:border-krypt-purple/60 disabled:opacity-50';
  const usable = status?.installed === true && !!exportPath;
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center rounded-2xl bg-krypt-void/85 backdrop-blur-sm animate-fade-in">
      <div className="flex max-h-[92%] w-[560px] max-w-[96%] flex-col rounded-2xl border border-white/10 bg-krypt-panel/95 p-6 shadow-krypt-card">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl border border-white/10 bg-krypt-purple/15">
            <Send className="h-5 w-5 text-krypt-purple" />
          </div>
          <div>
            <div className="text-sm font-bold text-white">Send to Krypt Marketo</div>
            <div className="text-xs text-krypt-muted">Krypt Marketo keeps the video with its title and description and uploads it to your YouTube channel. Nothing is published until you save it in YouTube Studio.</div>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          {status && !status.installed && <div className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">{status.message ?? 'Krypt Marketo is not installed.'}</div>}
          {status?.installed && !status.running && <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-krypt-muted">Krypt Marketo is closed. Sending opens it.</div>}
          {status?.installed && status.running && status.message && <div className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">{status.message}</div>}

          <div>
            <div className="mb-1 text-xs text-krypt-muted">Video</div>
            {exportPath ? (
              <div className="truncate rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 font-mono text-[11px] text-white/90" title={exportPath}>
                {exportPath}
              </div>
            ) : (
              <div className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">Export the video first (MP4). The file you export is the one that is sent.</div>
            )}
          </div>
          <div>
            <div className="mb-1 flex justify-between text-xs text-krypt-muted">
              <span>Title</span>
              <span className={title.length > 70 ? 'text-amber-300' : ''}>{title.length}/70</span>
            </div>
            <input value={title} maxLength={100} disabled={busy} onChange={(e) => setTitle(e.target.value)} placeholder={sentId ? 'Unchanged' : 'What people would type to find it'} className={field} />
          </div>
          <div>
            <div className="mb-1 text-xs text-krypt-muted">Description{chapters ? ' (the chapters come from this edit)' : ''}</div>
            <textarea value={description} rows={7} maxLength={4500} disabled={busy} onChange={(e) => setDescription(e.target.value)} placeholder={sentId ? 'Unchanged' : 'Two lines on what the video covers, then links'} className={`${field} resize-y`} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="mb-1 text-xs text-krypt-muted">Tags (comma separated)</div>
              <input value={tags} disabled={busy} onChange={(e) => setTags(e.target.value)} className={field} />
            </div>
            <div>
              <div className="mb-1 text-xs text-krypt-muted">Visibility</div>
              <select value={visibility} disabled={busy} onChange={(e) => setVisibility(e.target.value as Visibility)} className={field}>
                <option value="unlisted">Unlisted</option>
                <option value="public">Public</option>
                <option value="private">Private</option>
              </select>
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs text-white/90">
            <input type="checkbox" checked={upload} disabled={busy} onChange={(e) => setUpload(e.target.checked)} />
            Open YouTube Studio's upload with the file in it
          </label>
          {sentId && <div className="text-[11px] text-krypt-muted">This project is already in Marketo ({sentId}): sending again updates that entry.</div>}
        </div>

        {error && <div className="mt-3 max-h-28 overflow-y-auto whitespace-pre-wrap text-xs text-red-400">{error}</div>}

        <div className="mt-4 flex justify-end gap-2">
          <GhostButton onClick={onClose}>Close</GhostButton>
          <PrimaryButton onClick={() => void send()} disabled={busy || !usable}>
            <Send className="h-4 w-4" />
            {busy ? 'Sending…' : 'Send'}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}
