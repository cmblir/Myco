// In-app notices for the MAIN window. One rule: progress lives in the Topbar
// activity chip, results arrive as toasts under it — never the same event in
// both. `notices` is the toast queue (NoticeStack renders it, newest first);
// `progress` is the one chip-side slot for a determinate job that has no
// store of its own (link "accept all" today), so the chip can draw its ring
// without a new store per caller. Timers live in NoticeStack: a toast's life
// pauses on hover, which only the DOM knows about.

import { create } from "zustand";
import type { ActivityIconName } from "../components/ActivityPanel";

export type NoticeKind = "ok" | "info" | "warn";

export interface Notice {
  id: string;
  kind: NoticeKind;
  title: string;
  sub?: string;
  /** One of the activity PNGs (ActivityIcon); a kind-coloured dot otherwise. */
  icon?: ActivityIconName;
  action?: { label: string; run: () => void };
  ttlMs: number;
}

export interface NoticeProgress {
  key: string;
  label: string;
  done: number;
  total: number;
}

/** Toasts on screen at once; a fourth push drops the oldest. */
export const MAX_NOTICES = 3;

interface NoticeState {
  /** Oldest first — push appends, the stack renders it reversed. */
  notices: Notice[];
  progress: NoticeProgress | null;
  /** How the last progress job ended; the chip skips its green beat on false. */
  lastProgressOk: boolean;
  push: (notice: Omit<Notice, "id">) => string;
  dismiss: (id: string) => void;
  setProgress: (progress: NoticeProgress | null) => void;
  /** Clear the slot with an outcome (setProgress(null) is the silent form). */
  endProgress: (ok: boolean) => void;
}

let seq = 0;

export const useNoticeStore = create<NoticeState>((set) => ({
  notices: [],
  progress: null,
  lastProgressOk: true,

  push(notice) {
    const id = `notice-${++seq}`;
    set((s) => ({ notices: [...s.notices, { ...notice, id }].slice(-MAX_NOTICES) }));
    return id;
  },

  dismiss(id) {
    set((s) => ({ notices: s.notices.filter((n) => n.id !== id) }));
  },

  setProgress(progress) {
    set(progress ? { progress, lastProgressOk: true } : { progress });
  },

  endProgress(ok) {
    set({ progress: null, lastProgressOk: ok });
  },
}));
