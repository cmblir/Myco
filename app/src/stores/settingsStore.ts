// Mirror of the Rust-persisted Memex settings (~/Library/Application Support/
// dev.cmblir.memex/settings.json). Loaded once on app start; mutations write
// straight back to disk so every window reflects the latest state.

import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { MemexSettings } from "../lib/ipc";

/** Normalize an unknown thrown value into a displayable message. */
function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "Failed to save settings";
}

interface SettingsState {
  settings: MemexSettings | null;
  loading: boolean;
  /** Last persist (disk write) failure, or null when the in-memory state is
   * known to match disk. Set when an ipc.setSettings call rejects so the UI
   * can surface that the optimistic update was rolled back. */
  error: string | null;
  load: () => Promise<void>;
  update: (patch: Partial<MemexSettings>) => Promise<void>;
  setProviderConnected: (
    key: keyof MemexSettings["providers"],
    on: boolean,
  ) => Promise<void>;
  /** Mirror the live ollama daemon state into the connection flag, so a
   * running daemon shows up in the model picker automatically and a stopped
   * one disappears. */
  syncOllama: () => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: null,
  loading: false,
  error: null,
  load: async () => {
    set({ loading: true });
    try {
      const s = await ipc.getSettings();
      set({ settings: s, loading: false, error: null });
      void get().syncOllama();
    } catch (e) {
      set({ loading: false, error: errorMessage(e) });
    }
  },
  update: async (patch) => {
    const current = get().settings;
    if (!current) return;
    const next = { ...current, ...patch };
    set({ settings: next, error: null });
    try {
      await ipc.setSettings(next);
    } catch (e) {
      // Persist failed: roll the optimistic update back to the last known
      // on-disk state so the UI never claims a write that didn't land.
      set({ settings: current, error: errorMessage(e) });
    }
  },
  setProviderConnected: async (key, on) => {
    const current = get().settings;
    if (!current) return;
    const next: MemexSettings = {
      ...current,
      providers: { ...current.providers, [key]: on },
    };
    set({ settings: next, error: null });
    try {
      await ipc.setSettings(next);
    } catch (e) {
      // Roll back the optimistic flag flip on a failed disk write.
      set({ settings: current, error: errorMessage(e) });
    }
  },

  syncOllama: async () => {
    const current = get().settings;
    if (!current) return;
    try {
      const st = await ipc.ollamaStatus();
      const on = st.daemon_running && st.models.length > 0;
      if (current.providers.ollama !== on) {
        await get().setProviderConnected("ollama", on);
      }
    } catch {
      /* daemon unreachable — leave the flag as-is */
    }
  },
}));
