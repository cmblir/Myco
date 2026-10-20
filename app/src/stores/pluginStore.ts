// Declarative plugins' state (lib/plugins): the open vault's manifests as
// last read, and — per device, persisted — the vaults whose plugins the user
// trusts, the plugins switched off in each, and the calls granted to each
// plugin that runs code (stage 6). Whenever the enabled plugins'
// fences change they are handed to the block registry (setPluginFences),
// which Live and Preview draw through.

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { setPluginFences } from "../lib/blocks";
import type { SlashItem } from "../lib/editorCompletions";
import { ipc } from "../lib/ipc";
import {
  activePlugins,
  pluginSlashItems,
  readPlugin,
  type PluginEntry,
  type RunCommand,
  type PluginManifest,
  type PluginPrefs,
} from "../lib/plugins";
import { templateVars } from "../lib/templates";

interface PluginState {
  trusted: string[];
  disabled: Record<string, string[]>;
  /** Per vault, per plugin id: the calls the user allowed its code. */
  granted: Record<string, Record<string, string[]>>;
  /** The vault `entries` were read from; null = none open. */
  vault: string | null;
  entries: PluginEntry[];
  /** A read of `.myco/plugins/` is under way. */
  loading: boolean;
  /** list_plugins failed: its message. */
  loadError: string | null;
  /** Read the open vault's `.myco/plugins/` again. */
  load(vault: string | null): Promise<void>;
  setTrusted(vault: string, on: boolean): void;
  setEnabled(vault: string, id: string, on: boolean): void;
  /** The permission prompt's "Allow": `calls` granted, the plugin on. */
  grant(vault: string, id: string, calls: readonly string[]): void;
  /** Take a plugin's grant back: its code stops running. */
  revoke(vault: string, id: string): void;
}

let loads = 0;

export const usePluginStore = create<PluginState>()(
  persist(
    (set) => ({
      trusted: [],
      disabled: {},
      granted: {},
      vault: null,
      entries: [],
      loading: false,
      loadError: null,
      async load(vault) {
        const seq = ++loads;
        if (!vault) {
          set({ vault: null, entries: [], loading: false, loadError: null });
          return;
        }
        set({ loading: true });
        try {
          const files = await ipc.listPlugins();
          // A vault opened meanwhile has its own load.
          if (seq === loads)
            set({
              vault,
              entries: files.map(readPlugin),
              loading: false,
              loadError: null,
            });
        } catch (err) {
          if (seq === loads)
            set({ vault, entries: [], loading: false, loadError: String(err) });
        }
      },
      setTrusted: (vault, on) =>
        set((s) => {
          // Trust taken back takes the vault's grants with it: trusting
          // it again asks each plugin's calls again.
          const { [vault]: _dropped, ...granted } = s.granted;
          return {
            trusted: on
              ? [...s.trusted.filter((v) => v !== vault), vault]
              : s.trusted.filter((v) => v !== vault),
            ...(on ? {} : { granted }),
          };
        }),
      setEnabled: (vault, id, on) =>
        set((s) => {
          const off = (s.disabled[vault] ?? []).filter((x) => x !== id);
          return {
            disabled: { ...s.disabled, [vault]: on ? off : [...off, id] },
          };
        }),
      grant: (vault, id, calls) =>
        set((s) => ({
          granted: {
            ...s.granted,
            [vault]: { ...s.granted[vault], [id]: [...calls] },
          },
          disabled: {
            ...s.disabled,
            [vault]: (s.disabled[vault] ?? []).filter((x) => x !== id),
          },
        })),
      revoke: (vault, id) =>
        set((s) => {
          const { [id]: _dropped, ...rest } = s.granted[vault] ?? {};
          return { granted: { ...s.granted, [vault]: rest } };
        }),
    }),
    {
      name: "myco-plugins",
      version: 1,
      partialize: (s) => ({
        trusted: s.trusted,
        disabled: s.disabled,
        granted: s.granted,
      }),
      // A hand-edited or corrupt store must not break every note's render.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<PluginPrefs>;
        const strings = (v: unknown): string[] =>
          Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
        const byKey = <T>(v: unknown, each: (x: unknown) => T) =>
          Object.fromEntries(
            Object.entries(typeof v === "object" && v ? v : {}).map(
              ([k, x]) => [k, each(x)],
            ),
          );
        return {
          ...current,
          trusted: strings(p.trusted),
          disabled: byKey(p.disabled, strings),
          granted: byKey(p.granted, (x) => byKey(x, strings)),
        };
      },
    },
  ),
);

/** The open vault's plugins that are on (none until it is trusted). */
export const enabledPlugins = (s: PluginState): PluginManifest[] =>
  activePlugins(s.entries, s.vault, s);

/** Changes exactly when the enabled plugins' fences do: Live and Preview
 *  redraw on it. */
export const pluginFenceKey = (s: PluginState): string =>
  JSON.stringify(enabledPlugins(s).flatMap((p) => p.contributes.fences));

/** The enabled plugins' `/` items, filled for the note titled `title`;
 *  their commands go to `run` (none without it). */
export function pluginSlash(title: string, run?: RunCommand): SlashItem[] {
  return pluginSlashItems(
    enabledPlugins(usePluginStore.getState()),
    templateVars(title),
    run,
  );
}

let fenceKey = "[]";
usePluginStore.subscribe((s) => {
  const key = pluginFenceKey(s);
  if (key === fenceKey) return;
  fenceKey = key;
  setPluginFences(enabledPlugins(s).flatMap((p) => p.contributes.fences));
});
