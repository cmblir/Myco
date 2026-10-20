// Whether the Tidy sheet is open. Every entry point — the gaps rail's 정리,
// the ⌘K command, Settings → 내 공간 — opens the one sheet App mounts.

import { create } from "zustand";

interface TidyState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export const useTidyStore = create<TidyState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
