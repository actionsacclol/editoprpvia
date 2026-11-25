/**
 * Download cache for transformers.js models (set as env.customCache in the
 * workers): files live in the app's data folder, served and stored through the
 * krypteditor://models/ scheme (electron/system/mediaProtocol.ts). The browser
 * Cache API it would use otherwise rejects every write from a file:// page on
 * Electron 45, so models were downloaded again on every launch.
 */

const BASE = 'krypteditor://models/';

export const modelCache = {
  async match(key: string): Promise<Response | undefined> {
    try {
      const res = await fetch(BASE + encodeURIComponent(key));
      return res.ok ? res : undefined;
    } catch {
      return undefined;
    }
  },
  async put(key: string, response: Response): Promise<void> {
    try {
      await fetch(BASE + encodeURIComponent(key), { method: 'PUT', body: await response.blob() });
    } catch {
      /* not cached: downloaded again next time */
    }
  },
};
