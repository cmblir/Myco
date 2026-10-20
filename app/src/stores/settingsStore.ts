// Mirror of the Rust-persisted myco settings (~/Library/Application Support/
// dev.cmblir.memex/settings.json). Loaded once on app start; mutations write
// straight back to disk so every window reflects the latest state.

import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { MycoSettings } from "../lib/ipc";
import type { RoleId, RoleSelectionRequest } from "../lib/modelRoles";

/** Normalize an unknown thrown value into a displayable message. */
function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "Failed to save settings";
}

interface SettingsState {
  settings: MycoSettings | null;
  loading: boolean;
  saving: boolean;
  saved: boolean;
  /** Last persist (disk write) failure, or null when the in-memory state is
   * known to match disk. Set when an ipc.setSettings call rejects so the UI
   * can surface that the optimistic update was rolled back. */
  error: string | null;
  notchPending: boolean;
  notchError: string | null;
  load: () => Promise<void>;
  update: (patch: Partial<MycoSettings>) => Promise<void>;
  selectRole: (request: RoleSelectionRequest) => Promise<void>;
  setRoleAutomaticUse: (role: RoleId, allowed: boolean) => Promise<void>;
  setNotchEnabled: (enabled: boolean) => Promise<void>;
  setProviderConnected: (
    key: keyof MycoSettings["providers"],
    on: boolean,
  ) => Promise<void>;
  /** Mirror the live ollama daemon state into the connection flag, so a
   * running daemon shows up in the model picker automatically and a stopped
   * one disappears. */
  syncOllama: () => Promise<void>;
}

interface SettingsChange {
  apply: (settings: MycoSettings) => MycoSettings;
  keys: (keyof MycoSettings)[];
  notch?: boolean;
  persist?: (settings: MycoSettings) => Promise<MycoSettings>;
  finish: () => void;
  completion: Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set, get) => {
  const changes: SettingsChange[] = [];
  let confirmed: MycoSettings;
  let revision = 0;
  let isPersisting = false;

  async function persistChanges(): Promise<void> {
    while (changes.length > 0) {
      const change = changes[0];
      const next = change.apply(confirmed);
      try {
        // Native visibility and full-object writes share one queue. A later
        // save must never persist a notch flag whose native change failed.
        if (change.persist) confirmed = await change.persist(confirmed);
        else {
          if (change.notch) await ipc.updateNotchEnabled(next.notch_enabled);
          else {
            const native = await ipc.setSettings(next);
            confirmed = native ?? next;
          }
          if (change.notch) confirmed = next;
        }
        set({ settings: changes.slice(1).reduce((value, pending) => pending.apply(value), confirmed) });
      } catch (e) {
        const remaining = changes
          .slice(1)
          .reduce((s, pending) => pending.apply(s), confirmed);
        const rollback = Object.fromEntries(
          change.keys.map((key) => [key, remaining[key]]),
        );
        set((state) => ({
          settings: state.settings ? { ...state.settings, ...rollback } : null,
          ...(change.notch
            ? { notchError: errorMessage(e) }
            : { error: errorMessage(e) }),
        }));
      }
      changes.shift();
      set((state) => ({
        saving: changes.length > 0,
        saved: changes.length === 0 && !state.error && !state.notchError,
        ...(change.notch ? { notchPending: false } : {}),
      }));
      change.finish();
    }
    isPersisting = false;
  }

  function enqueue(
    change: Omit<SettingsChange, "finish" | "completion">,
  ): Promise<void> {
    const current = get().settings;
    if (!current) return Promise.resolve();
    const wasIdle = !isPersisting;
    if (wasIdle) {
      confirmed = current;
      isPersisting = true;
    }
    revision += 1;
    let finish!: () => void;
    const completion = new Promise<void>((resolve) => {
      finish = resolve;
    });
    changes.push({ ...change, finish, completion });
    set({
      settings: change.apply(current),
      saving: true,
      saved: false,
      ...(change.notch
        ? { notchPending: true, notchError: null }
        : { error: null }),
    });
    if (wasIdle) {
      void persistChanges();
    }
    return completion;
  }

  return {
    settings: null,
    loading: false,
    saving: false,
    saved: false,
    error: null,
    notchPending: false,
    notchError: null,
    load: async () => {
      set({ loading: true });
      try {
        // A read that overlaps a write can return an obsolete snapshot. Retry
        // after the queue drains instead of replacing optimistic user choices.
        let s: MycoSettings;
        let readRevision: number;
        do {
          while (changes.length > 0) {
            await changes[changes.length - 1].completion;
          }
          readRevision = revision;
          s = await ipc.getSettings();
        } while (revision !== readRevision);
        set({ settings: s, loading: false, error: null });
        void get().syncOllama();
      } catch (e) {
        set({ loading: false, error: errorMessage(e) });
      }
    },
    update: (patch) =>
      enqueue({
        apply: (settings) => ({ ...settings, ...patch }),
        keys: Object.keys(patch) as (keyof MycoSettings)[],
      }),
    selectRole: (request) => {
      const selected = { ...request };
      const observedRevision = selected.expectedAuthorizationRevision ?? get().settings?.role_authorization_revision;
      return enqueue({
        apply: (settings) => settings,
        keys: ["model_roles", "query_provider", "query_model", "query_effort", "ingest_provider", "ingest_model", "ingest_effort"],
        persist: () => {
          if (!observedRevision) return Promise.reject(new Error("native role revision unavailable; reload settings"));
          return ipc.selectModelRole({ ...selected, expectedAuthorizationRevision: observedRevision });
        },
      });
    },
    setRoleAutomaticUse: (role, allowed) => {
      const observedRevision = get().settings?.role_authorization_revision;
      return enqueue({
        apply: (settings) => settings,
        keys: ["model_roles"],
        persist: () => {
          if (!observedRevision) return Promise.reject(new Error("native role revision unavailable; reload settings"));
          return ipc.setRoleAutomaticUse(role, allowed, observedRevision);
        },
      });
    },
    setNotchEnabled: async (enabled) => {
      if (get().notchPending) return;
      await enqueue({
        apply: (settings) => ({ ...settings, notch_enabled: enabled }),
        keys: ["notch_enabled"],
        notch: true,
      });
    },
    setProviderConnected: async (key, on) => {
      if (!get().settings) throw new Error("Settings are not loaded");
      const apply = (settings: MycoSettings): MycoSettings => ({
        ...settings,
        providers: { ...settings.providers, [key]: on },
      });
      const outcome: { failure?: { error: unknown } } = {};
      await enqueue({
        apply,
        keys: ["providers"],
        persist: async (settings) => {
          try {
            const next = apply(settings);
            return (await ipc.setSettings(next)) ?? next;
          } catch (error) {
            outcome.failure = { error };
            throw error;
          }
        },
      });
      // Keep the shared queue's completion contract, but let provider actions
      // stop before a dependent keychain operation when their own write fails.
      if (outcome.failure) throw outcome.failure.error;
    },

    syncOllama: async () => {
      if (!get().settings) return;
      try {
        const st = await ipc.ollamaStatus();
        const on = st.daemon_running && st.models.length > 0;
        if (get().settings?.providers.ollama !== on) {
          await get().setProviderConnected("ollama", on);
        }
      } catch {
        /* daemon unreachable — leave the flag as-is */
      }
    },
  };
});

/** Only a settled settings snapshot may describe a destructive confirmation. */
export function getDeletionPolicy(): boolean | null {
  const { settings, loading, saving } = useSettingsStore.getState();
  return !settings || loading || saving ? null : settings.permanent_delete === true;
}
