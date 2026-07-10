// Schedule store (Feature 7). Mirrors the Rust schedules.json via IPC and runs
// digests. "Run now" and the in-app timer both call runNow, which generates the
// digest note (digests.ts) and stamps last_run. Cadence "is-due" is computed
// here (matching schedules.rs interval_secs) for the app-open timer.

import { create } from "zustand";
import { ipc, type Schedule } from "../lib/ipc";
import { runDigest } from "../lib/digests";
import { useVaultStore } from "./vaultStore";

/** Seconds implied by a cadence — mirrors Rust schedules::interval_secs. */
export function intervalSecs(cadence: string): number {
  const base = cadence.split(":")[0] || "daily";
  if (base === "every") {
    const n = parseInt((cadence.split(":")[1] ?? "").replace(/h$/, ""), 10);
    return Number.isFinite(n) && n > 0 ? n * 3600 : 24 * 3600;
  }
  if (base === "weekly") return 7 * 86400;
  if (base === "monthly") return 30 * 86400;
  return 86400;
}

export function isDue(s: Schedule, nowSecs: number): boolean {
  if (!s.enabled) return false;
  if (s.last_run == null) return true;
  return nowSecs - s.last_run >= intervalSecs(s.cadence);
}

export interface ScheduleState {
  schedules: Schedule[];
  loading: boolean;
  runningId: string | null;
  lastDigestPath: string | null;
  error: string | null;
  load: (vaultPath: string) => Promise<void>;
  upsert: (vaultPath: string, s: Schedule) => Promise<void>;
  remove: (vaultPath: string, id: string) => Promise<void>;
  runNow: (vaultPath: string, s: Schedule) => Promise<string | null>;
}

export const useScheduleStore = create<ScheduleState>((set, get) => ({
  schedules: [],
  loading: false,
  runningId: null,
  lastDigestPath: null,
  error: null,

  async load(vaultPath) {
    set({ loading: true });
    try {
      set({ schedules: await ipc.listSchedules(vaultPath), loading: false });
    } catch (err) {
      set({ error: String(err), loading: false });
    }
  },

  async upsert(vaultPath, s) {
    try {
      set({ schedules: await ipc.upsertSchedule(vaultPath, s), error: null });
    } catch (err) {
      set({ error: String(err) });
    }
  },

  async remove(vaultPath, id) {
    try {
      set({ schedules: await ipc.deleteSchedule(vaultPath, id) });
    } catch (err) {
      set({ error: String(err) });
    }
  },

  async runNow(vaultPath, s) {
    if (get().runningId) return null;
    set({ runningId: s.id, error: null });
    try {
      const path = await runDigest(vaultPath, s, new Date().toISOString());
      // Stamp last_run (epoch seconds) and persist.
      const stamped: Schedule = {
        ...s,
        last_run: Math.floor(Date.now() / 1000),
      };
      const schedules = await ipc.upsertSchedule(vaultPath, stamped);
      set({ schedules, runningId: null, lastDigestPath: path });
      void useVaultStore.getState().refreshTree();
      return path;
    } catch (err) {
      set({ error: String(err), runningId: null });
      return null;
    }
  },
}));
