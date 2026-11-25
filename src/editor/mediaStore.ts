import { create } from 'zustand';
import type { MediaFile } from '@shared/types';

/**
 * The session media bin — every clip/audio/image the user has imported,
 * plus which one is selected for preview. Lives in a store (not Editor-local
 * state) so imports survive navigating away to Settings/About and back.
 * Timeline clips reference bin entries by media id (see timelineStore).
 */
interface MediaState {
  media: MediaFile[];
  selectedId: string | null;
  /** Files with work running on them (being converted, a preview copy being made): what, and how far along (0–1). */
  busy: Record<string, { label: string; fraction: number }>;
  /** Preview copies of large videos, by media id: the URL the preview plays in place of the file (proxy.ts). */
  proxies: Record<string, string>;

  /**
   * Add freshly imported files, deduping by absolute path so re-importing
   * the same clip doesn't pile up duplicates. Auto-selects the first item
   * when the bin was empty. Returns the files that were actually new (so the
   * caller can drop them onto the timeline).
   */
  add: (files: MediaFile[]) => MediaFile[];
  remove: (id: string) => void;
  /** Swap a bin entry for a new version of itself (same id). */
  replace: (file: MediaFile) => void;
  setBusy: (id: string, state: { label: string; fraction: number } | null) => void;
  setProxy: (id: string, url: string) => void;
  clearProxies: () => void;
  select: (id: string | null) => void;
  /** Replace the whole bin (e.g. when opening a project). */
  replaceAll: (files: MediaFile[]) => void;
  clear: () => void;
}

export const useMediaStore = create<MediaState>((set, get) => ({
  media: [],
  selectedId: null,
  busy: {},
  proxies: {},

  add: (files) => {
    const existing = get().media;
    // A converted file is known by the file it was made from as well.
    const seen = new Set(existing.flatMap((m) => (m.sourcePath ? [m.filePath, m.sourcePath] : [m.filePath])));
    const fresh = files.filter((m) => !seen.has(m.filePath));
    if (fresh.length === 0) return [];
    set({
      media: [...existing, ...fresh],
      selectedId: get().selectedId ?? fresh[0].id,
    });
    return fresh;
  },

  remove: (id) => {
    if (get().busy[id]) void window.krypt.media.cancelConvert(id);
    set((s) => {
      const media = s.media.filter((m) => m.id !== id);
      const selectedId = s.selectedId === id ? (media[0]?.id ?? null) : s.selectedId;
      const busy = { ...s.busy };
      delete busy[id];
      const proxies = { ...s.proxies };
      delete proxies[id];
      return { media, selectedId, busy, proxies };
    });
  },

  replace: (file) => set((s) => ({ media: s.media.map((m) => (m.id === file.id ? file : m)) })),

  setProxy: (id, url) => set((s) => ({ proxies: { ...s.proxies, [id]: url } })),
  clearProxies: () => set({ proxies: {} }),

  setBusy: (id, state) =>
    set((s) => {
      if (!state && !s.busy[id]) return {};
      const busy = { ...s.busy };
      if (state) busy[id] = state;
      else delete busy[id];
      return { busy };
    }),

  select: (id) => set({ selectedId: id }),

  replaceAll: (files) => {
    for (const id of Object.keys(get().busy)) void window.krypt.media.cancelConvert(id);
    set({ media: files, selectedId: files[0]?.id ?? null, busy: {}, proxies: {} });
  },

  clear: () => {
    for (const id of Object.keys(get().busy)) void window.krypt.media.cancelConvert(id);
    set({ media: [], selectedId: null, busy: {}, proxies: {} });
  },
}));
