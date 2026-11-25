import { create } from 'zustand';

/**
 * Lightweight metadata about the *current* project: its file path (if saved),
 * a display name, and whether there are unsaved changes. Kept separate from the
 * timeline document so save/open/new can flip "dirty" without touching content.
 */

export function nameFromPath(p: string): string {
  const base = p.replace(/\\/g, '/').split('/').pop() ?? p;
  return base.replace(/\.krypt$/i, '');
}

interface ProjectState {
  path: string | null;
  name: string;
  dirty: boolean;
  setSaved: (path: string) => void;
  setOpened: (path: string) => void;
  setNew: (name?: string) => void;
  markDirty: () => void;
}

export const useProjectStore = create<ProjectState>((set) => ({
  path: null,
  name: 'Untitled',
  dirty: false,
  setSaved: (p) => set({ path: p, name: nameFromPath(p), dirty: false }),
  setOpened: (p) => set({ path: p, name: nameFromPath(p), dirty: false }),
  setNew: (name = 'Untitled') => set({ path: null, name, dirty: false }),
  markDirty: () => set((s) => (s.dirty ? {} : { dirty: true })),
}));
