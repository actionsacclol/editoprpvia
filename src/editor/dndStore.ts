import { create } from 'zustand';

/**
 * Tracks what's being dragged out of the Effects/Transitions panel so the
 * timeline can light up the right drop targets (clips for effects, the seams
 * between clips for transitions) only while a drag is in progress.
 */

export type DragKind = 'effect' | 'transition' | null;

export const DND_EFFECT = 'application/x-krypt-effect';
export const DND_TRANSITION = 'application/x-krypt-transition';

export const useDnd = create<{ kind: DragKind; setKind: (k: DragKind) => void }>((set) => ({
  kind: null,
  setKind: (kind) => set({ kind }),
}));
