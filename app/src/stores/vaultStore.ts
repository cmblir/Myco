// Vault store. Single source of truth for the currently opened vault, file
// tree, and active file. The store mediates all Tauri IPC for vault data.

import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { Adjacency, FileContent, FileNode, VaultMeta } from "../lib/ipc";
import { useUIStore } from "./uiStore";

const LAST_VAULT_KEY = "memex.lastVaultPath";

// Monotonic counter to guard against race conditions when openVault or
// refreshLinkGraph is called multiple times in quick succession. Only the
// latest invocation is allowed to commit its results to the store.
let openSeq = 0;
let refreshSeq = 0;

// Vault fingerprint (path+mtime+length over every .md) as of the last committed
// link graph, plus the vault it belongs to — pairing them means switching vaults
// invalidates it without an explicit reset. Only the background poll consults
// this; see refreshLinkGraph.
let lastRevision: number | null = null;
let lastRevisionVault: string | null = null;

export interface VaultState {
  currentVault: VaultMeta | null;
  fileTree: FileNode[];
  activeFile: FileContent | null;
  adjacency: Adjacency | null;
  isLoading: boolean;
  error: string | null;
  openVault: (path: string) => Promise<void>;
  openFile: (path: string) => Promise<void>;
  saveFile: (path: string, content: string) => Promise<void>;
  /** `ifChanged` skips the rebuild when the vault fingerprint is unmoved
   *  (background poll only — a caller that just wrote should force). */
  refreshLinkGraph: (opts?: { ifChanged?: boolean }) => Promise<void>;
  refreshTree: () => Promise<void>;
  createFile: (parentDir: string, name: string) => Promise<string | null>;
  createFolder: (parentDir: string, name: string) => Promise<string | null>;
  deletePath: (path: string) => Promise<void>;
  renamePath: (from: string, toName: string) => Promise<string | null>;
  resolveWikilink: (target: string) => string | null;
  reset: () => void;
}

export const useVaultStore = create<VaultState>((set, get) => ({
  currentVault: null,
  fileTree: [],
  activeFile: null,
  adjacency: null,
  isLoading: false,
  error: null,

  async openVault(path) {
    const seq = ++openSeq;
    set({ isLoading: true, error: null });
    try {
      const meta = await ipc.openVault(path);
      const tree = await ipc.listFiles(meta.path);
      const adjacency = await ipc.buildLinkGraph(meta.path);
      if (seq !== openSeq) return; // a newer openVault won; discard.
      set({
        currentVault: meta,
        fileTree: tree,
        adjacency,
        activeFile: null,
        isLoading: false,
      });
      try {
        localStorage.setItem(LAST_VAULT_KEY, meta.path);
      } catch {
        /* localStorage unavailable */
      }
    } catch (err) {
      if (seq !== openSeq) return;
      set({ error: errorMessage(err), isLoading: false });
    }
  },

  async refreshLinkGraph(opts) {
    const vault = get().currentVault;
    if (!vault) return;
    const seq = ++refreshSeq;
    try {
      // `ifChanged` is for the background poll only: it fires every few seconds
      // to catch edits made outside the app, and rebuilding the graph to answer
      // that means reading and parsing every note — 305 ms on a 10k-note vault,
      // over and over, almost always to conclude nothing happened. The
      // fingerprint answers the same question ~26x cheaper (it only stats).
      //
      // Every other caller has just written to the vault and passes nothing, so
      // it always rebuilds. That is deliberate rather than lazy: mtime+len
      // cannot see an edit that keeps both (rewriting [[a]] to [[b]] inside one
      // mtime tick), and after a local write we know the file changed, so there
      // is no reason to ask.
      if (opts?.ifChanged) {
        const revision = await ipc.vaultRevision(vault.path);
        if (seq !== refreshSeq) return;
        const fresh =
          lastRevisionVault === vault.path &&
          lastRevision === revision &&
          get().adjacency !== null;
        if (fresh) return;
        lastRevision = revision;
        lastRevisionVault = vault.path;
      } else {
        // A forced rebuild leaves the poll's baseline stale — clear it so the
        // next poll re-reads the fingerprint rather than trusting an old one.
        lastRevision = null;
        lastRevisionVault = null;
      }
      const adjacency = await ipc.buildLinkGraph(vault.path);
      // Discard if the user switched vaults during the rebuild, or if
      // another refresh has been kicked off after this one.
      if (seq !== refreshSeq) return;
      if (get().currentVault?.path !== vault.path) return;
      // Only commit when the graph actually changed. The auto-refresh poll
      // calls this on an interval; without this guard every tick would publish
      // a fresh adjacency object and force PageGraph to tear down and rebuild
      // the 3D graph (it keys off `adjacency`). BTreeMap serialization is
      // key-sorted, so identical content yields identical JSON.
      if (sameJSON(get().adjacency, adjacency)) return;
      set({ adjacency });
    } catch (err) {
      if (seq !== refreshSeq) return;
      set({ error: errorMessage(err) });
    }
  },

  async openFile(path) {
    set({ isLoading: true, error: null });
    try {
      const file = await ipc.readFile(path);
      set({ activeFile: file, isLoading: false });
    } catch (err) {
      set({ error: errorMessage(err), isLoading: false });
    }
  },

  async saveFile(path, content) {
    try {
      await ipc.writeFile(path, content);
      // The editor saves the full raw document, so the saved string IS the new
      // `raw`. Keep `raw` in sync (the editor re-seeds from it); the stripped
      // `content` preview field is recomputed on the next fresh read_file.
      set((state) =>
        state.activeFile?.path === path
          ? { activeFile: { ...state.activeFile, raw: content }, error: null }
          : { error: null },
      );
      void get().refreshLinkGraph();
    } catch (err) {
      set({ error: errorMessage(err) });
    }
  },

  async refreshTree() {
    const vault = get().currentVault;
    if (!vault) return;
    try {
      const tree = await ipc.listFiles(vault.path);
      // Vault switched mid-call, or nothing changed → don't churn the sidebar.
      // list_files returns a name-sorted tree, so identical content === identical JSON.
      if (get().currentVault?.path !== vault.path) return;
      if (sameJSON(get().fileTree, tree)) return;
      set({ fileTree: tree });
    } catch (err) {
      set({ error: errorMessage(err) });
    }
  },

  createFile: async (parentDir: string, name: string) => {
    try {
      const path = await ipc.createFile(parentDir, name);
      await get().refreshTree();
      void get().refreshLinkGraph();
      return path;
    } catch (err) {
      set({ error: errorMessage(err) });
      return null;
    }
  },

  createFolder: async (parentDir: string, name: string) => {
    try {
      const path = await ipc.createFolder(parentDir, name);
      await get().refreshTree();
      return path;
    } catch (err) {
      set({ error: errorMessage(err) });
      return null;
    }
  },

  deletePath: async (path: string) => {
    try {
      await ipc.deletePath(path);
      const active = get().activeFile;
      if (
        active &&
        (active.path === path || active.path.startsWith(`${path}/`))
      ) {
        set({ activeFile: null });
      }
      await get().refreshTree();
      void get().refreshLinkGraph();
    } catch (err) {
      set({ error: errorMessage(err) });
    }
  },

  renamePath: async (from: string, toName: string) => {
    try {
      const newPath = await ipc.renamePath(from, toName);
      // Rewrite the open file's path for an exact match AND for descendants
      // (renaming a parent folder of the open file), mirroring deletePath.
      const active = get().activeFile;
      if (active) {
        let rewritten: string | null = null;
        if (active.path === from) rewritten = newPath;
        else if (active.path.startsWith(`${from}/`))
          rewritten = newPath + active.path.slice(from.length);
        if (rewritten) set({ activeFile: { ...active, path: rewritten } });
      }
      // Keep the open route in sync so autosave/navigation target the new path.
      const ui = useUIStore.getState();
      const oldRoute = `page:${from}`;
      if (ui.route === oldRoute) ui.setRoute(`page:${newPath}`);
      else if (ui.route.startsWith(`${oldRoute}/`))
        ui.setRoute(`page:${newPath}${ui.route.slice(oldRoute.length)}`);
      await get().refreshTree();
      void get().refreshLinkGraph();
      return newPath;
    } catch (err) {
      set({ error: errorMessage(err) });
      return null;
    }
  },

  resolveWikilink: (target: string) => {
    return findFileByStem(get().fileTree, target.toLowerCase());
  },

  reset: () => {
    set({
      currentVault: null,
      fileTree: [],
      activeFile: null,
      adjacency: null,
      isLoading: false,
      error: null,
    });
  },
}));

export function getLastVaultPath(): string | null {
  try {
    return localStorage.getItem(LAST_VAULT_KEY);
  } catch {
    return null;
  }
}

function findFileByStem(nodes: FileNode[], lowerStem: string): string | null {
  for (const node of nodes) {
    if (node.kind === "file") {
      const stem = stripExtension(node.name).toLowerCase();
      if (stem === lowerStem) return node.path;
    } else {
      const found = findFileByStem(node.children, lowerStem);
      if (found) return found;
    }
  }
  return null;
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "unknown error";
}

// Structural equality via JSON. Safe here because both payloads come from Rust
// in a stable order — list_files is name-sorted and Adjacency is a BTreeMap
// (key-sorted serialization) — so equal content always serializes identically.
function sameJSON(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
