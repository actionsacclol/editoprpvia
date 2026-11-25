import { create } from 'zustand';
import type { LutDef } from './lut';

/**
 * The session LUT bin — every .cube the user has imported. Clips reference
 * LUTs by id; the tables are embedded in .krypt files (they're small) so
 * projects stay portable.
 */
interface LutState {
  luts: LutDef[];
  add: (lut: LutDef) => void;
  remove: (id: string) => void;
  /** Replace the whole bin (opening a project). */
  replaceAll: (luts: LutDef[]) => void;
}

export const useLutStore = create<LutState>((set) => ({
  luts: [],
  add: (lut) => set((s) => ({ luts: [...s.luts.filter((l) => l.id !== lut.id), lut] })),
  remove: (id) => set((s) => ({ luts: s.luts.filter((l) => l.id !== id) })),
  replaceAll: (luts) => set({ luts }),
}));

export function lutById(id: string | undefined): LutDef | undefined {
  return id ? useLutStore.getState().luts.find((l) => l.id === id) : undefined;
}
