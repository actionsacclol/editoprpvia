import { useCallback, useEffect, useState } from 'react';
import { Check, Cpu, Download, ExternalLink, KeyRound, Trash2, X } from 'lucide-react';
import {
  LOCAL_PICTURE_MODELS,
  PICTURE_PROVIDERS,
  pickSource,
  readyLocalModel,
  sourceName,
  sourceProblem,
  type LocalPictureModelId,
  type LocalPictureStatus,
  type PictureProviderId,
  type PictureQuality,
  type PictureSettings,
  type PictureSetup,
  type PictureSource,
} from '@shared/imageGen';
import { GhostButton, PrimaryButton } from '../components/common';
import { fmtBytes } from '../utils/format';

const field = 'rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 text-sm text-white outline-none focus:border-krypt-purple/60 disabled:opacity-50';
const STAGE: Record<string, string> = { downloading: 'Downloading', verifying: 'Checking' };

/** The picture setup, kept live from main: any window or dialog may start a download or change a setting. */
export function usePictureSetup(): {
  setup: PictureSetup | null;
  local: LocalPictureStatus[];
  /** Where pictures would be made right now; null when nothing is ready. */
  source: PictureSource | null;
  refresh: () => void;
} {
  const [setup, setSetup] = useState<PictureSetup | null>(null);
  const [local, setLocal] = useState<LocalPictureStatus[]>([]);
  const refresh = useCallback(() => {
    void window.krypt.pictures.setup().then(setSetup);
    void window.krypt.pictures.localStatus().then(setLocal);
  }, []);
  useEffect(() => {
    refresh();
    const offState = window.krypt.pictures.onLocalState(setLocal);
    const offProgress = window.krypt.pictures.onLocalProgress(({ id, progress }) => setLocal((l) => l.map((s) => (s.id === id ? { ...s, installing: true, progress } : s))));
    // A key saved in Settings while a dialog is open elsewhere: looked at again when the window is returned to.
    window.addEventListener('focus', refresh);
    return () => {
      offState();
      offProgress();
      window.removeEventListener('focus', refresh);
    };
  }, [refresh]);
  const ready = readyLocalModel(local) !== null;
  const picked = setup ? pickSource(setup, ready) : null;
  return { setup, local, source: setup && picked && !sourceProblem(setup, picked, ready) ? picked : null, refresh };
}

function ModelRow({ id, status, onError }: { id: LocalPictureModelId; status: LocalPictureStatus | undefined; onError: (m: string | null) => void }) {
  const model = LOCAL_PICTURE_MODELS.find((m) => m.id === id)!;
  const p = status?.progress;
  const ratio = p && p.total > 0 ? p.done / p.total : 0;
  const download = async (): Promise<void> => {
    onError(null);
    const r = await window.krypt.pictures.localEnsure(id);
    if (!r.ok && !/cancelled/i.test(r.message ?? '')) onError(r.message ?? 'The download failed.');
  };
  const remove = async (): Promise<void> => {
    const r = await window.krypt.pictures.localRemove(id);
    if (!r.ok) onError(r.message ?? 'Could not remove the model.');
  };
  return (
    <div data-picture-model={id} className="rounded-lg border border-white/10 bg-black/25 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-sm font-semibold text-white">
            {status?.installed && <Check className="h-4 w-4 text-emerald-400" />}
            {model.name}
            <span className="font-normal text-krypt-muted">· {fmtBytes(model.bytes)}</span>
          </div>
          <div className="mt-0.5 text-xs text-krypt-muted">{model.about}</div>
        </div>
        {status?.installing ? (
          <button type="button" onClick={() => void window.krypt.pictures.localCancel(id)} className="flex shrink-0 items-center gap-1 text-xs text-krypt-muted hover:text-white">
            <X className="h-3.5 w-3.5" />
            Cancel
          </button>
        ) : status?.installed ? (
          <GhostButton destructive onClick={() => void remove()}>
            <Trash2 className="h-4 w-4" />
            Remove
          </GhostButton>
        ) : (
          <PrimaryButton onClick={() => void download()}>
            <Download className="h-4 w-4" />
            {status && status.downloadBytes < status.totalBytes ? `Resume (${fmtBytes(status.downloadBytes)} left)` : `Download ${fmtBytes(model.bytes)}`}
          </PrimaryButton>
        )}
      </div>
      {status?.installing && (
        <>
          <div className="mt-2 text-xs text-krypt-muted">
            {STAGE[p?.stage ?? 'downloading']}… {p ? `${fmtBytes(p.done)} of ${fmtBytes(p.total)}` : ''}
          </div>
          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-white/10">
            <div className="h-full bg-krypt-gradient transition-all" style={{ width: `${Math.round(ratio * 100)}%` }} />
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Settings, Pictures from words: the two ways pictures are made (a model on
 * this computer, or a service with the user's own key) and which one is used.
 * A key typed here goes to the main process and is never read back: what is
 * shown afterwards is its last four characters.
 */
export function PictureSetupCard() {
  const { setup, local, source, refresh } = usePictureSetup();
  const [error, setError] = useState<string | null>(null);
  const [service, setService] = useState<PictureProviderId>('openai');
  const [key, setKey] = useState('');
  const [model, setModel] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [saved, setSaved] = useState(false);

  const provider = PICTURE_PROVIDERS.find((p) => p.id === service)!;
  const state = setup?.providers.find((p) => p.id === service);
  // The fields follow the service looked at, and what is kept for it.
  useEffect(() => {
    if (!setup) return;
    setKey('');
    setSaved(false);
    setModel(setup.settings.models[service] ?? '');
    setEndpoint(setup.settings.endpoint);
  }, [service, setup === null]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!setup) return null;
  const ready = readyLocalModel(local) !== null;

  const configure = async (patch: Partial<PictureSettings>): Promise<boolean> => {
    setError(null);
    const r = await window.krypt.pictures.configure(patch);
    if (!r.ok) setError(r.message ?? 'That setting could not be saved.');
    refresh();
    return r.ok;
  };
  const saveService = async (): Promise<void> => {
    setSaved(false);
    if (!(await configure({ models: { ...setup.settings.models, [service]: model.trim() }, ...(service === 'custom' ? { endpoint: endpoint.trim() } : {}) }))) return;
    if (key.trim()) {
      const r = await window.krypt.pictures.setKey(service, key.trim());
      if (!r.ok) return setError(r.message ?? 'The key could not be saved.');
      setKey('');
    }
    // The first service set up becomes the one in use, unless this computer already is.
    if (!setup.settings.source && !ready) await configure({ source: service });
    setSaved(true);
    refresh();
  };
  const forget = async (): Promise<void> => {
    const r = await window.krypt.pictures.setKey(service, '');
    if (!r.ok) setError(r.message ?? 'The key could not be removed.');
    refresh();
  };

  const sources: PictureSource[] = ['local', ...PICTURE_PROVIDERS.map((p) => p.id)];
  const chosen = setup.settings.source ?? source ?? 'local';
  const chosenProblem = sourceProblem(setup, chosen, ready);

  return (
    <div data-picture-setup className="space-y-4">
      <div>
        <div className="flex items-center gap-1.5 text-sm font-semibold text-white">
          <Cpu className="h-4 w-4 text-krypt-muted" />
          On this computer
        </div>
        <p className="mt-0.5 text-xs text-krypt-muted">Free, and nothing leaves the computer. Needs a graphics card with memory to spare while it draws: about 5 GB for the better model, about 2 GB for the small one. Both draw 512 × 512 squares: good for simple drawn scenes, weak at hands, crowds and anything written. With both downloaded the better one is used, and the small one steps in when the card is too busy.</p>
        <div className="mt-2 space-y-2">
          {LOCAL_PICTURE_MODELS.map((m) => (
            <ModelRow key={m.id} id={m.id} status={local.find((s) => s.id === m.id)} onError={setError} />
          ))}
        </div>
      </div>

      <div className="border-t border-white/10 pt-4">
        <div className="flex items-center gap-1.5 text-sm font-semibold text-white">
          <KeyRound className="h-4 w-4 text-krypt-muted" />
          A picture service, with your own key
        </div>
        <p className="mt-0.5 text-xs text-krypt-muted">Better pictures, no graphics card needed. The service charges your account for each picture, and the descriptions are sent to it. The key is kept encrypted on this computer and is only ever sent to that service.</p>
        <div className="mt-2 grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)] items-center gap-x-3 gap-y-2 text-xs text-krypt-muted">
          <span>Service</span>
          <select data-picture-service value={service} onChange={(e) => setService(e.target.value as PictureProviderId)} className={`${field} w-full`}>
            {PICTURE_PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {setup.providers.find((x) => x.id === p.id)?.hasKey ? ' (key kept)' : ''}
              </option>
            ))}
          </select>
          {service === 'custom' && (
            <>
              <span>Address</span>
              <input data-picture-endpoint value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://…/v1/images/generations" spellCheck={false} className={`${field} w-full font-mono`} />
            </>
          )}
          <span>Key</span>
          <div className="flex items-center gap-2">
            <input
              data-picture-key
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={state?.hasKey ? `Kept (${state.hint ?? '…'}). Paste a new one to replace it` : 'Paste the key'}
              className={`${field} w-full font-mono`}
            />
            {state?.hasKey && (
              <GhostButton destructive onClick={() => void forget()}>
                <Trash2 className="h-4 w-4" />
                Forget
              </GhostButton>
            )}
          </div>
          <span>Model</span>
          <div>
            <input data-picture-model-name list={`picture-models-${service}`} value={model} onChange={(e) => setModel(e.target.value)} placeholder={provider.model || 'The model name, as the service writes it'} spellCheck={false} className={`${field} w-full font-mono`} />
            <datalist id={`picture-models-${service}`}>
              {provider.models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </div>
        </div>
        <div className="mt-2 flex items-center justify-between gap-3">
          <p className="min-w-0 text-xs text-krypt-muted">
            {provider.cost}{' '}
            {provider.keyPage && (
              <button type="button" onClick={() => void window.krypt.app.openExternal(provider.keyPage)} className="inline-flex items-center gap-1 text-krypt-purple hover:underline">
                Get a key <ExternalLink className="h-3 w-3" />
              </button>
            )}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            {saved && <span className="text-xs text-emerald-400">Saved</span>}
            <PrimaryButton onClick={() => void saveService()}>Save</PrimaryButton>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)] items-center gap-x-3 gap-y-2 border-t border-white/10 pt-4 text-xs text-krypt-muted">
        <span>Make pictures with</span>
        <div>
          <select data-picture-source value={chosen} onChange={(e) => void configure({ source: e.target.value as PictureSource })} className={`${field} w-full`}>
            {sources.map((s) => (
              <option key={s} value={s}>
                {sourceName(s)}
                {sourceProblem(setup, s, ready) ? ' (not set up)' : ''}
              </option>
            ))}
          </select>
          {chosenProblem && <div className="mt-1 text-amber-300/90">{chosenProblem}</div>}
        </div>
        <span>Quality at a service</span>
        <select data-picture-quality value={setup.settings.quality} onChange={(e) => void configure({ quality: e.target.value as PictureQuality })} className={`${field} w-full`}>
          <option value="low">Draft (cheapest)</option>
          <option value="medium">Standard</option>
          <option value="high">Best (costs the most)</option>
        </select>
        <span>Most pictures a day with a key</span>
        <div className="flex items-center gap-2">
          <input
            data-picture-limit
            type="number"
            min={1}
            max={2000}
            defaultValue={setup.settings.dailyLimit}
            onBlur={(e) => void configure({ dailyLimit: Number(e.target.value) || setup.settings.dailyLimit })}
            className={`${field} w-24`}
          />
          <span>{setup.madeToday} made today. Counts the dialogs and connected AI agents alike, so a mistake cannot run up a bill.</span>
        </div>
      </div>
      {error && <div className="text-xs text-red-400">{error}</div>}
    </div>
  );
}
