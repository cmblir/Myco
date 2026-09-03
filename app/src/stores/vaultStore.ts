// Vault store. Single source of truth for the currently opened vault, file
// tree, and active file. The store mediates all Tauri IPC for vault data.

import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { Adjacency, FileContent, FileNode, VaultMeta } from "../lib/ipc";
import { createDebouncedCommitter } from "../lib/humanCommit";
import {
  parseFrontmatter,
  patchFrontmatter,
  type FmPatch,
  type Frontmatter,
} from "../lib/frontmatter";
import { dropNested, filterMovable, rewritePrefix } from "../lib/treeOps";
import { useSettingsStore } from "./settingsStore";
import { useUIStore } from "./uiStore";

/** Shared with notchDriver (a separate webview that cannot reach this
 * store's state): the notch panel reads the last vault path for best-effort
 * inbox-name prediction. */
export const LAST_VAULT_KEY = "myco.lastVaultPath";

// One committer per app: coalesces the editor's rapid autosaves of a file
// into a single human-authored history commit (Q4 item 1).
const humanCommitter = createDebouncedCommitter((rel) => {
  const vault = useVaultStore.getState().currentVault;
  if (!vault) return;
  void ipc.commitHumanEdit(vault.path, rel).catch(() => {
    /* history commit is best-effort; the save itself already landed */
  });
});

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

/** Unsaved editor text by absolute path, published by the reader while its
 *  autosave debounce is pending and removed once that text is written. A
 *  rename/move consumes the entry (afterPathChange) so the draft follows the
 *  note instead of being flushed to the old path. Kept out of store state:
 *  it changes on every keystroke and no view renders it. */
export const pendingDrafts = new Map<string, string>();

export interface VaultState {
  currentVault: VaultMeta | null;
  fileTree: FileNode[];
  activeFile: FileContent | null;
  adjacency: Adjacency | null;
  /** Starred files, vault-relative, in star order (`.myco/favorites.json`). */
  favorites: string[];
  isLoading: boolean;
  error: string | null;
  openVault: (path: string) => Promise<void>;
  openFile: (path: string) => Promise<void>;
  /** `skipRefresh` defers the link-graph rebuild to the caller (bulk writes). */
  saveFile: (
    path: string,
    content: string,
    opts?: { skipRefresh?: boolean },
  ) => Promise<void>;
  /** Read → patch → saveFile({skipRefresh}) per path, one refreshLinkGraph at
   *  the end; the first failure stops the loop and lands in `error`. */
  patchPages: (
    paths: string[],
    make: (fm: Frontmatter | null) => FmPatch,
  ) => Promise<void>;
  /** `ifChanged` skips the rebuild when the vault fingerprint is unmoved
   *  (background poll only — a caller that just wrote should force). */
  refreshLinkGraph: (opts?: { ifChanged?: boolean }) => Promise<void>;
  refreshTree: () => Promise<void>;
  createFile: (parentDir: string, name: string) => Promise<string | null>;
  createFolder: (parentDir: string, name: string) => Promise<string | null>;
  deletePath: (paths: string | string[]) => Promise<void>;
  renamePath: (from: string, toName: string) => Promise<string | null>;
  /** Move each path into `destDir` (no-ops and impossible moves skipped); the
   *  rest continues past a failure and the last error surfaces. */
  movePaths: (paths: string[], destDir: string) => Promise<void>;
  /** Optimistic star/unstar of an absolute path; reverted with `error` on failure. */
  toggleFavorite: (path: string) => Promise<void>;
  resolveWikilink: (target: string) => string | null;
  /**
   * Resolve a wikilink to an existing page, or CREATE it and open it
   * (Obsidian-style create-on-click). Returns the absolute path to route to, or
   * null. `contextDir` is where a new note lands; without it, `wiki/`. A created
   * page is seeded with frontmatter by the create_file command.
   */
  openWikilink: (target: string, contextDir?: string) => Promise<string | null>;
  reset: () => void;
}

export const useVaultStore = create<VaultState>((set, get) => ({
  currentVault: null,
  fileTree: [],
  activeFile: null,
  adjacency: null,
  favorites: [],
  isLoading: false,
  error: null,

  async openVault(path) {
    const seq = ++openSeq;
    set({ isLoading: true, error: null });
    try {
      const meta = await ipc.openVault(path);
      const tree = await ipc.listFiles(meta.path);
      const adjacency = await ipc.buildLinkGraph(meta.path);
      // Best effort: a missing or corrupt favorites file just means none.
      const favorites = await ipc
        .readFile(`${meta.path}/.myco/favorites.json`)
        .then((f) => {
          const v: unknown = JSON.parse(f.raw);
          return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
        })
        .catch(() => []);
      if (seq !== openSeq) return; // a newer openVault won; discard.
      set({
        currentVault: meta,
        fileTree: tree,
        adjacency,
        activeFile: null,
        favorites,
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
      const vault = get().currentVault;
      if (vault && path.startsWith(vault.path)) {
        const rel = path.slice(vault.path.length).replace(/^\/+/, "");
        // Feeds resurface dormancy (Q4 item 10). Best-effort like the
        // history commit in saveFile: the open itself already succeeded.
        void ipc.recordPageOpen(vault.path, rel).catch(() => undefined);
      }
    } catch (err) {
      set({ error: errorMessage(err), isLoading: false });
    }
  },

  async saveFile(path, content, opts) {
    try {
      await ipc.writeFile(path, content);
      const vault = get().currentVault;
      if (
        vault &&
        useSettingsStore.getState().settings?.vault_history_enabled &&
        path.startsWith(vault.path)
      ) {
        const rel = path.slice(vault.path.length).replace(/^\/+/, "");
        humanCommitter.touch(rel);
      }
      // The editor saves the full raw document, so the saved string IS the new
      // `raw`. Keep `raw` in sync (the editor re-seeds from it); the stripped
      // `content` preview field is recomputed on the next fresh read_file.
      set((state) =>
        state.activeFile?.path === path
          ? { activeFile: { ...state.activeFile, raw: content }, error: null }
          : { error: null },
      );
      if (!opts?.skipRefresh) void get().refreshLinkGraph();
    } catch (err) {
      set({ error: errorMessage(err) });
    }
  },

  async patchPages(paths, make) {
    let wrote = false;
    try {
      for (const path of paths) {
        const { raw } = await ipc.readFile(path);
        const edit = patchFrontmatter(raw, make(parseFrontmatter(raw)));
        if (edit.raw === raw) continue;
        await get().saveFile(path, edit.raw, { skipRefresh: true });
        // saveFile swallows its own write failure into `error`.
        if (get().error) return;
        wrote = true;
      }
    } catch (err) {
      set({ error: errorMessage(err) });
    } finally {
      if (wrote) await get().refreshLinkGraph();
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

  deletePath: async (paths) => {
    set({ error: null });
    try {
      for (const path of typeof paths === "string"
        ? [paths]
        : dropNested(paths)) {
        await ipc.deletePath(path);
        // Drop pending autosaves under the trashed path: the unmounting
        // reader's flush would otherwise recreate the file we just deleted.
        for (const pending of [...pendingDrafts.keys()]) {
          if (pending === path || pending.startsWith(`${path}/`)) {
            pendingDrafts.delete(pending);
          }
        }
        const active = get().activeFile;
        if (
          active &&
          (active.path === path || active.path.startsWith(`${path}/`))
        ) {
          set({ activeFile: null });
        }
      }
    } catch (err) {
      set({ error: errorMessage(err) });
    } finally {
      // A failure mid-list has already trashed earlier items: always refresh.
      await get().refreshTree();
      void get().refreshLinkGraph();
    }
  },

  renamePath: async (from: string, toName: string) => {
    try {
      const newPath = await ipc.renamePath(from, toName);
      await afterPathChange(from, newPath);
      await get().refreshTree();
      void get().refreshLinkGraph();
      return newPath;
    } catch (err) {
      set({ error: errorMessage(err) });
      return null;
    }
  },

  movePaths: async (paths, destDir) => {
    set({ error: null });
    let error: string | null = null;
    for (const p of filterMovable(paths, destDir)) {
      try {
        await afterPathChange(p, await ipc.movePath(p, destDir));
      } catch (err) {
        error = errorMessage(err);
      }
    }
    if (error) set({ error });
    await get().refreshTree();
    void get().refreshLinkGraph();
  },

  toggleFavorite: async (path) => {
    const vault = get().currentVault;
    if (!vault) return;
    set({ error: null });
    const rel = path.slice(vault.path.length + 1);
    const prev = get().favorites;
    const next = prev.includes(rel) ? prev.filter((f) => f !== rel) : [...prev, rel];
    set({ favorites: next });
    try {
      await ipc.saveFavorites(next);
    } catch (err) {
      set({ favorites: prev, error: errorMessage(err) });
    }
  },

  resolveWikilink: (target: string) => {
    // Top-level templates/ holds scaffolds, not notes (index.rs is_staging_dir
    // skips it too): a note titled "note" must not resolve to templates/note.md.
    const tree = get().fileTree.filter(
      (n) => !(n.kind === "directory" && n.name === "templates"),
    );
    return findFileByStem(tree, target.toLowerCase());
  },

  openWikilink: async (target: string, contextDir?: string) => {
    const resolved = get().resolveWikilink(target);
    if (resolved) return resolved;
    const vault = get().currentVault;
    if (!vault) return null;
    // A new note defaults to wiki/ (the knowledge dir); ensure it exists.
    const dir = contextDir ?? `${vault.path}/wiki`;
    if (!contextDir) await ipc.createFolder(vault.path, "wiki").catch(() => undefined);
    const name = `${target.replace(/[\\/]/g, "-")}.md`;
    try {
      const created = await ipc.createFile(dir, name);
      await get().refreshTree();
      void get().refreshLinkGraph();
      return created;
    } catch {
      // Lost a race (already created) — resolve again; else give up.
      return get().resolveWikilink(target);
    }
  },

  reset: () => {
    set({
      currentVault: null,
      fileTree: [],
      activeFile: null,
      adjacency: null,
      favorites: [],
      isLoading: false,
      error: null,
    });
  },
}));

/** A path was renamed or moved: follow it (exact match and descendants) in the
 *  open file, the route — without a history entry, so autosave/navigation
 *  target the new path — and the favorites list. */
async function afterPathChange(from: string, to: string) {
  const { activeFile, favorites, currentVault } = useVaultStore.getState();
  if (activeFile) {
    const path = rewritePrefix(activeFile.path, from, to);
    if (path) useVaultStore.setState({ activeFile: { ...activeFile, path } });
  }
  // A dirty draft follows the note. The reader that holds it unmounts on the
  // route change below with its flush still closed over the OLD path, which
  // would recreate the old file (ghost duplicate) while the new path re-seeds
  // from disk and drops the last keystrokes. Write the draft to the new path
  // here and drop the entry so that flush becomes a no-op. Awaited after the
  // activeFile rewrite so saveFile lands the text in activeFile.raw and the
  // remounted reader seeds from it; the callers refresh the graph once.
  for (const [path, draft] of pendingDrafts) {
    const moved = rewritePrefix(path, from, to);
    if (!moved) continue;
    pendingDrafts.delete(path);
    await useVaultStore.getState().saveFile(moved, draft, { skipRefresh: true });
  }
  const ui = useUIStore.getState();
  if (ui.route.startsWith("page:")) {
    const path = rewritePrefix(ui.route.slice("page:".length), from, to);
    if (path) ui.replaceRoute(`page:${path}`);
  }
  if (!currentVault) return;
  const rel = (p: string) => p.slice(currentVault.path.length + 1);
  const next = favorites.map((f) => rewritePrefix(f, rel(from), rel(to)) ?? f);
  if (next.some((f, i) => f !== favorites[i])) {
    useVaultStore.setState({ favorites: next });
    // Best effort, like the history commit: the move itself already landed.
    // Awaited so successive moves never have two writes in flight.
    await ipc.saveFavorites(next).catch(() => undefined);
  }
}

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
