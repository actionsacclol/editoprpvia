/**
 * Asking for something from anywhere in the app: the top bar and the Guides
 * page open dialogs that live on the editor page, which is not mounted while
 * another page shows. The request waits here until the editor takes it.
 */
import { create } from 'zustand';
import type { Feature } from './guides';

export type Page = 'editor' | 'guides' | 'settings' | 'about';

interface LaunchState {
  /** A dialog the editor page should open. */
  want: Exclude<Feature, 'agents'> | null;
  /** A page the shell should show. */
  go: Page | null;
  /** The "Make a video with AI" chooser is open. */
  making: boolean;
  /** The guide the Guides page should show. */
  guide: string | null;
  /** That guide was asked for by name ("Watch how"): start playing it. The Guides page takes this. */
  play: boolean;
}

export const useLaunch = create<LaunchState>(() => ({ want: null, go: null, making: false, guide: null, play: false }));

/** Open a feature: the agents panel is in the top bar, the rest are dialogs on the editor page. */
export function launch(feature: Feature): void {
  if (feature === 'agents') {
    useLaunch.setState({ making: false });
    // After this click has finished: the panel closes itself on a press outside it.
    window.setTimeout(() => window.dispatchEvent(new CustomEvent('krypt:open-agents')), 0);
    return;
  }
  useLaunch.setState({ making: false, want: feature, go: 'editor' });
}

/** Show the Guides page; a guide given by id is shown and starts playing. */
export function openGuide(id: string | null): void {
  useLaunch.setState((s) => ({ making: false, go: 'guides', guide: id ?? s.guide, play: id !== null }));
}

export const openMakeVideo = (): void => useLaunch.setState({ making: true });
