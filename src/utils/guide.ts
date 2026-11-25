/** The getting-started guide's shared bits (used by the Editor + About pages). */

export const TUTORIAL_URL = 'https://www.youtube.com/watch?v=CrpPmKf1r0Q';

export const ONBOARD_KEY = 'krypt-onboarded';

/** Fired to tell the shell to switch to the editor (where the guide lives). */
export const SHOW_GUIDE_EVENT = 'krypt:show-guide';

/**
 * Replay the onboarding guide: clear the seen flag and jump to the editor —
 * the editor page re-checks the flag on mount and opens the guide.
 */
export function replayOnboarding(): void {
  localStorage.removeItem(ONBOARD_KEY);
  window.dispatchEvent(new CustomEvent(SHOW_GUIDE_EVENT));
}
