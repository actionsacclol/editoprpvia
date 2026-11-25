import { useEffect, useState } from 'react';
import { FolderOpen, RotateCcw } from 'lucide-react';
import { Page, Section, Card, GhostButton, Switch } from '../components/common';
import { separateAudioDefault, setSeparateAudioDefault } from '../editor/timelineStore';
import { proxiesEnabled, setProxiesEnabled } from '../editor/proxy';
import { useApp } from '../state/AppStateProvider';
import { useToast } from '../state/ToastProvider';
import { useModal } from '../state/ModalProvider';
import { IS_MAC } from '../utils/format';
import { VoiceModelCard } from '../editor/VoiceModelCard';
import { SpeechModelCard } from '../editor/SpeechModelCard';
import { PictureSetupCard } from '../editor/PictureSetupCard';

export function SettingsPage() {
  const { state, update } = useApp();
  const toast = useToast();
  const modal = useModal();
  const [userData, setUserData] = useState('');
  const [separateAudio, setSeparateAudio] = useState(separateAudioDefault);
  const [proxies, setProxies] = useState(proxiesEnabled);
  const [converter, setConverter] = useState<{ available: boolean; path: string | null } | null>(null);
  useEffect(() => {
    let live = true;
    void window.krypt.media.converter().then((c) => {
      if (live) setConverter(c);
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    void window.krypt.app.getUserDataPath().then(setUserData);
  }, []);

  if (!state) return null;

  const pickFolder = async (): Promise<void> => {
    const dir = await window.krypt.app.pickDirectory();
    if (dir) void update({ workingDirectory: dir });
  };

  const resetAll = async (): Promise<void> => {
    const yes = await modal.confirm({
      title: 'Reset all settings?',
      message: 'The working folder and recent projects return to defaults.',
      confirmLabel: 'Reset',
      destructive: true,
    });
    if (!yes) return;
    await window.krypt.state.reset();
    toast.success('Settings reset to defaults');
  };

  const workingDir = state.workingDirectory || `${userData}${IS_MAC ? '/' : '\\'}Projects`;

  return (
    <Page title="Settings" subtitle="Working folder and app data.">
      <Section title="Working folder" description="Where media imports and exports default to.">
        <Card>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-white">Folder</div>
              <div className="text-xs text-krypt-muted font-mono truncate mt-0.5">{workingDir}</div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              {state.workingDirectory && (
                <GhostButton onClick={() => void update({ workingDirectory: null })}>Default</GhostButton>
              )}
              <GhostButton onClick={() => void pickFolder()}>
                <FolderOpen className="h-4 w-4" />
                Choose…
              </GhostButton>
            </div>
          </div>
        </Card>
      </Section>

      <Section title="Timeline" description="How clips land when you add them.">
        <Switch
          checked={separateAudio}
          onChange={(on) => {
            setSeparateAudioDefault(on);
            setSeparateAudio(on);
          }}
          label="Give a video's sound its own clip"
          description="A video with sound is added as two linked clips, the picture and (on an audio track) its sound, so each can be mixed, replaced or moved on its own. Off: one clip that carries both, until you choose Separate the sound."
        />
      </Section>

      <Section title="Footage" description="Large video, and formats the editor can't read by itself.">
        <Switch
          checked={proxies}
          onChange={(on) => {
            setProxiesEnabled(on);
            setProxies(on);
          }}
          label="Preview copies for large video"
          description="Video above 1080p (4K camera and phone footage) gets a small copy for the preview, made once in the background, so scrubbing and playback stay quick. Exports always use the original file."
        />
        <Card>
          <div className="text-sm font-semibold text-white">Converting other formats</div>
          <p className="mt-1 text-xs text-krypt-muted">
            {converter === null
              ? 'Looking for FFmpeg…'
              : converter.available
                ? 'FFmpeg was found, so files the editor can not read itself (ProRes, DNxHD, AVI, MTS, WMV, 10-bit camera files…) are converted to a working copy when you import them.'
                : `FFmpeg was not found. With it installed, files the editor can not read itself (ProRes, DNxHD, AVI, MTS, WMV, 10-bit camera files…) are converted when you import them. Install it with ${IS_MAC ? '"brew install ffmpeg"' : '"winget install ffmpeg" (or your package manager on Linux)'} and restart Krypt Editor.`}
          </p>
          {converter?.path && <p className="mt-1 break-all font-mono text-[11px] text-krypt-muted/80">{converter.path}</p>}
        </Card>
      </Section>

      <Section title="Voice-over" description="The English text-to-speech voices (Kokoro). Downloaded once, then everything runs on this PC.">
        <Card>
          <VoiceModelCard />
        </Card>
      </Section>

      <Section title="Speech recognition" description="The Whisper model behind captions, Transcript, auto edit and Re-voice. Everything runs on this PC.">
        <Card>
          <SpeechModelCard />
        </Card>
      </Section>

      <Section title="Pictures from words" description="For scenes no photograph exists of: comic panels, imagined places, thumbnail backgrounds. Made on this PC by a model you download once, or by a picture service with your own key.">
        <Card>
          <PictureSetupCard />
        </Card>
      </Section>

      <Section
        title="Always on"
        description="Krypt Editor starts at login, stays in the tray when closed, and shows Discord Rich Presence while running."
      >
        <Card>
          <div className="text-xs text-krypt-muted">
            Closing the window keeps the app in the tray — use the tray icon's Quit to exit fully.
          </div>
        </Card>
      </Section>

      <Section title="Danger zone">
        <Card>
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-white">Reset settings</div>
              <div className="text-xs text-krypt-muted mt-0.5">Return everything to defaults.</div>
            </div>
            <GhostButton destructive onClick={() => void resetAll()}>
              <RotateCcw className="h-4 w-4" />
              Reset
            </GhostButton>
          </div>
        </Card>
      </Section>
    </Page>
  );
}
