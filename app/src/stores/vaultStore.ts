// Vault store. Single source of truth for the currently opened vault, file
// tree, and active file. The store mediates all Tauri IPC for vault data.

import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { Adjacency, AgentVaultSession, EditorFileSnapshot, FileContent, FileNode, RecoveryDraft, VaultMeta } from "../lib/ipc";
import { createDebouncedCommitter } from "../lib/humanCommit";
import {
  parseFrontmatter,
  patchFrontmatter,
  tagsOf,
  type FmPatch,
  type Frontmatter,
} from "../lib/frontmatter";
import { matchWikilinkAt, resolveStem } from "../lib/wikilinks";
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
let fileRead: { path: string } | null = null;

// Serialize native transitions so a late close cannot invalidate a newer open.
let nativeTransition: Promise<void> | null = null;
function transitionVault<T>(operation: () => Promise<T>): Promise<T> {
  const result = nativeTransition ? nativeTransition.then(operation) : operation();
  // Each caller observes its error; only queue continuation recovers here.
  const settled = result.then(() => undefined, () => undefined);
  nativeTransition = settled;
  void settled.then(() => { if (nativeTransition === settled) nativeTransition = null; });
  return result;
}

// Periodic refreshes join this session's active reads until every read settles.
// A local write may still start a newer forced refresh.
const refreshFlights = new Map<string, Set<Promise<void>>>();

// Vault fingerprint (path+mtime+length over every .md) as of the last committed
// link graph, plus the vault it belongs to — pairing them means switching vaults
// invalidates it without an explicit reset. Only the background poll consults
// this; see refreshLinkGraph.
let lastRevision: number | null = null;
let lastRevisionVault: string | null = null;
let lastRevisionToken: string | null = null;

// What the link graph would learn from a file: its wikilink targets and its
// frontmatter tags, as one comparable key per path. Autosave fires every two
// seconds and every save rebuilt the whole graph (1,747 markdown files / 52 MB
// on the real vault) — for prose typing that rebuild can only ever produce the
// graph it just produced. Seeded on open so even the first save of a session
// can skip.
const lastLinkKey = new Map<string, string>();

/** Sorted `[[targets]]` + `tags:` of one document. Cheap: one scan per save. */
export function linkKey(content: string): string {
  const targets = new Set<string>();
  for (let i = content.indexOf("[["); i >= 0; i = content.indexOf("[[", i + 1)) {
    const m = matchWikilinkAt(content, i);
    if (m) targets.add(m.target.toLowerCase());
  }
  const tags = tagsOf(parseFrontmatter(content));
  return `${[...targets].sort().join("\u0000")}|${[...tags].sort().join("\u0000")}`;
}

/** Unsaved editor text by absolute path, published by the reader while its
 *  autosave debounce is pending and removed once that text is written. A
 *  supported durable draft blocks a path change until resolved. Without native
 *  recovery support, afterPathChange follows the legacy retarget protocol.
 *  Kept out of store state:
 *  it changes on every keystroke and no view renders it. */
class PendingDraftMap extends Map<string, string> {
  private mutationSeq = 0;
  private readonly versions = new Map<string, number>();

  /** Changes include equal-text writes and removals, so A → C → A is visible. */
  version(path: string): number {
    return this.versions.get(path) ?? 0;
  }

  override set(path: string, content: string): this {
    this.versions.set(path, ++this.mutationSeq);
    return super.set(path, content);
  }

  override delete(path: string): boolean {
    this.versions.set(path, ++this.mutationSeq);
    return super.delete(path);
  }

  override clear(): void {
    for (const path of this.keys()) this.versions.set(path, ++this.mutationSeq);
    super.clear();
  }
}
export const pendingDrafts = new PendingDraftMap();

// A dirty draft keeps its first native read, including after navigation or a
// root reopening. Only its own accepted save receipt advances this revision.
interface EditorBaseline {
  origin: AgentVaultSession;
  vaultToken: string;
  revision: string;
  raw: string;
  recoverySupported: boolean;
  recoveryOnly: boolean;
  journalRevision: string | null;
  journalDraft: { raw: string; version: number } | null;
}
const editorBaselines = new Map<string, EditorBaseline>();

/** Full edit-start raw for a pending local draft, never a replacement baseline. */
export function getEditorRecoveryBaseline(path: string): string | undefined {
  const baseline = editorBaselines.get(path);
  const vault = useVaultStore.getState().currentVault;
  return pendingDrafts.has(path) && baseline && vault?.path === baseline.origin.vaultPath
    ? baseline.raw : undefined;
}

function sameOrigin(left: AgentVaultSession, right: AgentVaultSession): boolean {
  return left.vaultPath === right.vaultPath && left.openingToken === right.openingToken;
}

function ownsEditorOpening(baseline: EditorBaseline): boolean {
  const state = useVaultStore.getState();
  return !baseline.recoveryOnly && !state.isOpeningVault && state.currentVault?.path === baseline.origin.vaultPath &&
    state.vaultToken === baseline.vaultToken;
}

function isRawEditorPath(path: string, root: string): boolean {
  return underPath(path.replace(/\\/g, "/"), `${root.replace(/\\/g, "/").replace(/\/$/, "")}/raw`);
}

function validateRecoveryDraft(draft: RecoveryDraft, path: string, root: string): void {
  if (!draft || draft.path !== path || typeof draft.baselineRaw !== "string" ||
    typeof draft.draftRaw !== "string" || typeof draft.baselineRevision !== "string" ||
    !/^[a-f0-9]{64}$/.test(draft.baselineRevision) || typeof draft.revision !== "string" ||
    !/^[a-f0-9]{32}$/.test(draft.revision) || draft.origin?.vaultPath !== root ||
    typeof draft.origin.openingToken !== "string" || !draft.origin.openingToken) {
    throw new Error("Editor recovery receipt does not match its captured file");
  }
}

interface EditorRead extends EditorFileSnapshot {
  recoverySupported: boolean;
}

interface EditorReadAttempt {
  origin: AgentVaultSession;
  recoverySupported: boolean;
  snapshot: EditorRead | null;
  error: unknown;
}

/** A failed file read retains only discovery context, never a native baseline. */
async function readEditorAttempt(
  path: string,
  vaultPath: string,
  vaultToken: string,
  assertCurrent?: () => void,
): Promise<EditorReadAttempt> {
  const isCurrent = () => useVaultStore.getState().currentVault?.path === vaultPath &&
    useVaultStore.getState().vaultToken === vaultToken && !useVaultStore.getState().isOpeningVault;
  assertCurrent?.();
  const origin = Object.freeze(await ipc.agentVaultSession());
  assertCurrent?.();
  if (!isCurrent() || origin.vaultPath !== vaultPath || !origin.openingToken) {
    throw new Error("Editor read belongs to an expired vault opening");
  }
  const recoverySupported = await ipc.editorRecoverySupported();
  assertCurrent?.();
  if (!isCurrent() || typeof recoverySupported !== "boolean") {
    throw new Error("Editor recovery capability belongs to an expired or invalid read");
  }
  const supportsRecovery = recoverySupported && !isRawEditorPath(path, vaultPath);
  let snapshot: EditorFileSnapshot;
  try {
    snapshot = await ipc.readEditorFile(path, origin);
  } catch (error) {
    assertCurrent?.();
    if (!isCurrent()) throw new Error("Editor read belongs to an expired vault opening");
    return { origin, recoverySupported: supportsRecovery, snapshot: null, error };
  }
  assertCurrent?.();
  if (!isCurrent() || snapshot.file.path !== path || !sameOrigin(snapshot.origin, origin) ||
    !/^[a-f0-9]{64}$/.test(snapshot.revision)) {
    throw new Error("Editor read receipt does not match its captured file and opening");
  }
  return { origin, recoverySupported: supportsRecovery,
    snapshot: { ...snapshot, recoverySupported: supportsRecovery }, error: null };
}

async function readEditorSnapshot(
  path: string,
  vaultPath: string,
  vaultToken: string,
  assertCurrent?: () => void,
): Promise<EditorRead> {
  const attempt = await readEditorAttempt(path, vaultPath, vaultToken, assertCurrent);
  if (attempt.snapshot === null) throw attempt.error;
  return attempt.snapshot;
}

function retainEditorBaseline(path: string, snapshot: EditorRead, vaultToken: string): EditorBaseline {
  const existing = editorBaselines.get(path);
  if (existing && (pendingDrafts.has(path) || fileWrites.has(path))) return existing;
  if (pendingDrafts.has(path)) throw new Error("Editor baseline unavailable; preserve the draft before reloading");
  const baseline: EditorBaseline = { origin: Object.freeze({ ...snapshot.origin }), vaultToken,
    revision: snapshot.revision, raw: snapshot.file.raw, recoverySupported: snapshot.recoverySupported,
    recoveryOnly: false, journalRevision: null, journalDraft: null };
  editorBaselines.set(path, baseline);
  return baseline;
}

async function stageEditorCheckpoint(path: string, content: string, baseline: EditorBaseline, version: number): Promise<void> {
  if (!ownsEditorOpening(baseline) || editorBaselines.get(path) !== baseline) {
    throw new Error("Editor checkpoint belongs to an expired file or opening; draft preserved");
  }
  if (!baseline.recoverySupported) return;
  if (baseline.journalDraft?.raw === content && baseline.journalDraft.version === version) return;
  const receipt = await ipc.stageEditorDraft(path, baseline.revision, content, baseline.origin, baseline.journalRevision);
  validateRecoveryDraft(receipt, path, baseline.origin.vaultPath);
  if (!sameOrigin(receipt.origin, baseline.origin) || receipt.baselineRevision !== baseline.revision ||
    receipt.baselineRaw !== baseline.raw || receipt.draftRaw !== content) {
    throw new Error("Editor checkpoint differs from its original raw or pending draft; recovery required");
  }
  baseline.journalRevision = receipt.revision;
  baseline.journalDraft = { raw: content, version };
  if (!ownsEditorOpening(baseline) || editorBaselines.get(path) !== baseline) {
    throw new Error("Editor checkpoint acknowledgement belongs to an expired opening; draft preserved");
  }
}

// One queue per note: a slow earlier IPC must never overwrite later typing.
// Path changes wait for the current write, then retarget queued writes (or
// cancel them for a deletion) before letting the queue continue.
interface FileWrites {
  path: string | null;
  tail: Promise<void>;
  active: Promise<void> | null;
}
const fileWrites = new Map<string, FileWrites>();
const pathChanges = new Set<{ path: string; done: Promise<void> }>();

function underPath(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function invalidateFileRead(path: string): void {
  if (!fileRead || !underPath(fileRead.path, path)) return;
  fileRead = null;
  if (!useVaultStore.getState().isOpeningVault) {
    useVaultStore.setState({ isLoading: false });
  }
}

async function pauseWrites(path: string): Promise<() => void> {
  let release!: () => void;
  const change = { path, done: new Promise<void>((resolve) => { release = resolve; }) };
  pathChanges.add(change);
  await Promise.all([...new Set(fileWrites.values())]
    .filter((queue) => queue.path !== null && underPath(queue.path, path))
    .map((queue) => queue.active));
  return () => { pathChanges.delete(change); release(); };
}

function assertNoDurableDrafts(path: string): void {
  for (const [target, baseline] of editorBaselines) {
    if (underPath(target, path) && baseline.recoverySupported &&
      (pendingDrafts.has(target) || baseline.journalRevision !== null)) {
      throw new Error("Resolve the preserved editor draft before renaming, moving or deleting this path");
    }
  }
}

function retargetWrites(from: string, to: string | null): void {
  for (const [path, baseline] of [...editorBaselines]) {
    if (!underPath(path, from)) continue;
    editorBaselines.delete(path);
    if (to !== null) editorBaselines.set(rewritePrefix(path, from, to)!, baseline);
  }
  for (const queue of new Set(fileWrites.values())) {
    if (queue.path === null || !underPath(queue.path, from)) continue;
    // Existing callbacks hold this queue directly. The old name can now refer
    // to a newly created note, so it must not remain an alias for the moved one.
    for (const [key, current] of fileWrites) {
      if (current === queue) fileWrites.delete(key);
    }
    queue.path = to === null ? null : rewritePrefix(queue.path, from, to)!;
    if (queue.path !== null) fileWrites.set(queue.path, queue);
  }
}

function queueWrite(
  path: string,
  write: (target: string, isLatest: () => boolean) => Promise<boolean>,
): Promise<boolean> {
  const queue = fileWrites.get(path) ?? { path, tail: Promise.resolve(), active: null };
  fileWrites.set(path, queue);
  const result = queue.tail.then(async () => {
    // Recheck after each change: another rename can have started while waiting.
    while (queue.path !== null) {
      const target = queue.path;
      const blocked = [...pathChanges].filter((change) => underPath(target, change.path));
      if (!blocked.length) break;
      await Promise.all(blocked.map((change) => change.done));
    }
    if (queue.path === null) return false;
    const saving = write(queue.path, () => queue.tail === tail);
    queue.active = saving.then(() => undefined);
    try { return await saving; }
    finally { queue.active = null; }
  });
  const tail = result.then(() => undefined);
  queue.tail = tail;
  void tail.then(() => {
    if (queue.tail !== tail) return;
    for (const [key, current] of fileWrites) {
      if (current === queue) fileWrites.delete(key);
    }
  });
  return result;
}

export interface VaultState {
  currentVault: VaultMeta | null;
  /** Cross-window action identity; rotates even when reopening the same root. */
  vaultToken: string;
  fileTree: FileNode[];
  activeFile: FileContent | null;
  adjacency: Adjacency | null;
  /** The poll's vault fingerprint, published when it moves: a prose edit
   *  outside this pane keeps `adjacency` identical, so readers of note text
   *  (backlink sentences) re-read on this. Null before the first poll. */
  revision: number | null;
  /** Starred files, vault-relative, in star order (`.myco/favorites.json`). */
  favorites: string[];
  /** When the last note write landed (ms epoch), this run; null before any. */
  lastSavedAt: number | null;
  isLoading: boolean;
  /** Native root transition, kept separate from ordinary file reads. */
  isOpeningVault: boolean;
  error: string | null;
  /** Restore only the chosen folder; seed Documents only for a first launch. */
  restoreVault: (preferredPath?: string | null) => Promise<void>;
  openVault: (path: string) => Promise<void>;
  /** This reader's error, null after an admitted read, or undefined if superseded.
   *  File errors belong to the reader's recovery view, not the sidebar. */
  openFile: (path: string) => Promise<string | null | undefined>;
  /** Confirmed draft discard after one unchanged native read; never writes disk. */
  recoverEditorFile: (
    path: string,
    expectedDraft: string | undefined,
    isCurrent: () => boolean,
  ) => Promise<FileContent>;
  /** True only after writing successfully. `skipRefresh` defers graph rebuilds. */
  saveFile: (
    path: string,
    content: string,
    opts?: { skipRefresh?: boolean },
  ) => Promise<boolean>;
  /** Checkpoint a pending edit without granting authority to save a restored draft. */
  persistPendingEditorDraft: (path: string, content: string) => Promise<boolean>;
  /** Read → patch → saveFile({skipRefresh}) per path, one refreshLinkGraph at
   *  the end; the first failure stops the loop and lands in `error`. */
  patchPages: (
    paths: string[],
    make: (fm: Frontmatter | null) => FmPatch,
  ) => Promise<void>;
  /** `ifChanged` skips the rebuild when the vault fingerprint is unmoved and
   *  re-reads the file tree only when it moved (background poll only — a
   *  caller that just wrote should force, and refresh the tree itself). */
  refreshLinkGraph: (opts?: { ifChanged?: boolean }) => Promise<void>;
  refreshTree: () => Promise<void>;
  createFile: (parentDir: string, name: string) => Promise<string | null>;
  createFolder: (parentDir: string, name: string) => Promise<string | null>;
  deletePath: (paths: string | string[], expectedPermanent?: boolean) => Promise<void>;
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
  reset: () => Promise<void>;
}

export const useVaultStore = create<VaultState>((set, get) => ({
  currentVault: null,
  vaultToken: crypto.randomUUID(),
  fileTree: [],
  activeFile: null,
  adjacency: null,
  revision: null,
  favorites: [],
  lastSavedAt: null,
  isLoading: false,
  isOpeningVault: false,
  error: null,

  async restoreVault(preferredPath) {
    if (get().currentVault || get().isLoading) return;
    const saved = preferredPath || getLastVaultPath();
    if (saved) {
      // A disconnected drive or denied folder is recoverable. Falling back
      // would request unrelated Documents access and hide the saved choice.
      await get().openVault(saved);
      return;
    }
    const seq = ++openSeq;
    set({ vaultToken: crypto.randomUUID(), isLoading: true, isOpeningVault: true, error: null });
    try {
      const path = await ipc.ensureDefaultVault();
      if (seq !== openSeq) return;
      await get().openVault(path);
    } catch (err) {
      if (seq === openSeq) set({ error: errorMessage(err), isLoading: false, isOpeningVault: false });
    }
  },

  async openVault(path) {
    const seq = ++openSeq;
    set({ vaultToken: crypto.randomUUID(), isLoading: true, isOpeningVault: true, error: null });
    try {
      const meta = await transitionVault(() => seq === openSeq
        ? ipc.openVault(path) : Promise.resolve(null));
      if (seq !== openSeq) return;
      if (!meta) return;
      // Native confinement already points at meta.path. Publish that root
      // before fallible follow-up reads, without retaining another vault's data.
      set({
        currentVault: meta,
        fileTree: [],
        adjacency: null,
        activeFile: null,
        favorites: [],
        revision: null,
        lastSavedAt: null,
      });
      try {
        localStorage.setItem(LAST_VAULT_KEY, meta.path);
      } catch {
        /* localStorage unavailable */
      }
      const tree = await ipc.listFiles(meta.path);
      if (seq !== openSeq) return;
      const adjacency = await ipc.buildLinkGraph(meta.path);
      if (seq !== openSeq) return;
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
        lastSavedAt: null,
        isLoading: false,
        isOpeningVault: false,
      });
    } catch (err) {
      if (seq !== openSeq) return;
      set({ error: errorMessage(err), isLoading: false, isOpeningVault: false });
    }
  },

  async refreshLinkGraph(opts) {
    const { currentVault: vault, vaultToken, isOpeningVault } = get();
    if (!vault || isOpeningVault) return;
    const key = JSON.stringify([vault.path, vaultToken]);
    const ongoing = refreshFlights.get(key);
    if (opts?.ifChanged && ongoing) {
      await Promise.allSettled(ongoing);
      return;
    }
    const active = ongoing ?? new Set<Promise<void>>();
    const seq = ++refreshSeq;
    const isCurrent = () => seq === refreshSeq &&
      get().currentVault?.path === vault.path &&
      get().vaultToken === vaultToken && !get().isOpeningVault;
    const flight = (async () => {
      let moved: number | null = null;
      try {
        // The background poll stats first; local writes always rebuild because
        // mtime+len cannot see a same-length edit inside one mtime tick.
        let adjacency: Adjacency;
        if (opts?.ifChanged) {
          const revision = await ipc.vaultRevision(vault.path);
          if (!isCurrent()) return;
          const fresh =
            lastRevisionVault === vault.path &&
            lastRevisionToken === vaultToken &&
            lastRevision === revision &&
            get().adjacency !== null;
          if (fresh) return;
          moved = revision;
          // The fingerprint also covers folders and staging notes, so the tree
          // only needs re-reading when it moves. Compare its content separately:
          // a prose edit changes the revision without changing the tree.
          // Wait for both reads, including after either fails: releasing the
          // flight early would let each poll queue another blocked directory walk.
          const [tree, graph] = await Promise.allSettled([
            ipc.listFiles(vault.path),
            ipc.buildLinkGraph(vault.path),
          ]);
          if (!isCurrent()) return;
          if (tree.status === "fulfilled" && !sameJSON(get().fileTree, tree.value)) {
            set({ fileTree: tree.value });
          }
          if (tree.status === "rejected") throw tree.reason;
          if (graph.status === "rejected") throw graph.reason;
          adjacency = graph.value;
          lastRevision = revision;
          lastRevisionVault = vault.path;
          lastRevisionToken = vaultToken;
        } else {
          // A forced rebuild invalidates the poll's baseline.
          lastRevision = null;
          lastRevisionVault = null;
          lastRevisionToken = null;
          adjacency = await ipc.buildLinkGraph(vault.path);
        }
        // Only this vault session's latest-started refresh may publish.
        if (!isCurrent()) return;
        if (moved !== null) set({ revision: moved });
        // Preserve graph identity when its stable serialized content is equal.
        if (sameJSON(get().adjacency, adjacency)) return;
        set({ adjacency });
      } catch (err) {
        if (!isCurrent()) return;
        lastRevision = null;
        lastRevisionVault = null;
        lastRevisionToken = null;
        set({ error: errorMessage(err) });
      }
    })();
    active.add(flight);
    refreshFlights.set(key, active);
    try {
      await flight;
    } finally {
      active.delete(flight);
      if (active.size === 0 && refreshFlights.get(key) === active) refreshFlights.delete(key);
    }
  },

  async openFile(path) {
    const read = { path };
    fileRead = read;
    const seq = openSeq;
    const vaultPath = get().currentVault?.path ?? null;
    const vaultToken = get().vaultToken;
    const initialDraftVersion = pendingDrafts.version(path);
    const isCurrent = (): boolean => fileRead === read && seq === openSeq && !get().isOpeningVault &&
      get().vaultToken === vaultToken &&
      (get().currentVault?.path ?? null) === vaultPath;
    set({ isLoading: true, error: null });
    try {
      if (!vaultPath || get().isOpeningVault) throw new Error("Open a vault before reading an editor file");
      const attempt = await readEditorAttempt(path, vaultPath, vaultToken);
      if (!isCurrent()) return undefined;
      const snapshot = attempt.snapshot;
      let recovery: RecoveryDraft | null;
      try {
        recovery = attempt.recoverySupported ? await ipc.readEditorDraft(path, attempt.origin) : null;
        if (!isCurrent()) return undefined;
        if (recovery !== null) validateRecoveryDraft(recovery, path, vaultPath);
      } catch (error) {
        // Keep the actual file failure visible even when its separate journal is unsafe.
        if (snapshot === null) throw new Error(`${errorMessage(attempt.error)}\n${errorMessage(error)}`);
        throw error;
      }
      if (recovery !== null && !pendingDrafts.has(path) &&
        pendingDrafts.version(path) === initialDraftVersion && !fileWrites.has(path)) {
        // Loading data cannot renew its expired opening or authorize an autosave.
        pendingDrafts.set(path, recovery.draftRaw);
        editorBaselines.set(path, {
          origin: Object.freeze({ ...recovery.origin }), vaultToken,
          raw: recovery.baselineRaw, revision: recovery.baselineRevision,
          recoverySupported: true, recoveryOnly: true, journalRevision: recovery.revision,
          journalDraft: { raw: recovery.draftRaw, version: pendingDrafts.version(path) },
        });
      } else if (snapshot !== null) {
        const baseline = retainEditorBaseline(path, snapshot, vaultToken);
        if (recovery !== null && sameOrigin(recovery.origin, baseline.origin) &&
          recovery.baselineRevision === baseline.revision && recovery.baselineRaw === baseline.raw) {
          baseline.journalRevision = recovery.revision;
          // A discovery read is not acknowledgement of typing that arrived meanwhile.
          baseline.journalDraft = null;
        }
      }
      if (snapshot === null) {
        // Journal data can be copied while the file is unavailable. It cannot
        // stand in for a current read receipt or renew its expired write origin.
        set({ isLoading: false });
        return errorMessage(attempt.error);
      }
      const file = snapshot.file;
      lastLinkKey.set(path, linkKey(file.raw));
      set({ activeFile: file, isLoading: false });
      const vault = get().currentVault;
      if (vault && path.startsWith(vault.path)) {
        const rel = path.slice(vault.path.length).replace(/^\/+/, "");
        // Feeds resurface dormancy (Q4 item 10). Best-effort like the
        // history commit in saveFile: the open itself already succeeded.
        void ipc.recordPageOpen(vault.path, rel).catch(() => undefined);
      }
      return null;
    } catch (err) {
      if (!isCurrent()) return undefined;
      const error = errorMessage(err);
      set({ isLoading: false });
      return error;
    } finally {
      if (fileRead === read) fileRead = null;
    }
  },

  async recoverEditorFile(path, expectedDraft, isCurrent) {
    const { currentVault: vault, vaultToken } = get();
    if (!vault) throw new Error("Open a vault before recovering an editor file; draft preserved");
    const seq = openSeq;
    const baseline = editorBaselines.get(path);
    const revision = baseline?.revision;
    const draftVersion = pendingDrafts.version(path);
    const read = { path };
    let recoveryQueueActive = false;
    let recoveryIsLatest = (): boolean => true;
    // Do not supersede an ordinary read and strand its loading state if this
    // recovery fails. Another read starting later invalidates our own identity.
    if (fileRead !== null) throw new Error("Editor read is pending; preserve the draft and try recovery after it finishes");
    const assertCurrent = (): void => {
      if (get().isOpeningVault || nativeTransition !== null || seq !== openSeq ||
        get().currentVault?.path !== vault.path || get().vaultToken !== vaultToken || !isCurrent()) {
        throw new Error("Editor recovery belongs to an expired reader or vault opening; draft preserved");
      }
      if (fileRead !== read || pendingDrafts.get(path) !== expectedDraft ||
        pendingDrafts.version(path) !== draftVersion || editorBaselines.get(path) !== baseline ||
        baseline?.revision !== revision) {
        throw new Error("Editor recovery changed while reading; draft and original baseline preserved");
      }
      if ((!recoveryQueueActive && fileWrites.has(path)) ||
        (recoveryQueueActive && !recoveryIsLatest()) ||
        [...pathChanges].some((change) => underPath(path, change.path))) {
        throw new Error("Editor save or path change is pending; draft and original baseline preserved");
      }
    };
    fileRead = read;
    try {
      assertCurrent();
      const snapshot = await readEditorSnapshot(path, vault.path, vaultToken, assertCurrent);
      assertCurrent();
      const recovery = snapshot.recoverySupported ? await ipc.readEditorDraft(path, snapshot.origin) : null;
      assertCurrent();
      if (recovery !== null) {
        validateRecoveryDraft(recovery, path, vault.path);
        if (baseline?.journalRevision !== null && baseline?.journalRevision !== undefined &&
          baseline.journalRevision !== recovery.revision) {
          throw new Error("Editor recovery journal changed while reading; draft preserved");
        }
      }
      // Absence alone is not retirement: native must confirm any acknowledged nonce.
      const retirementRevision = snapshot.recoverySupported
        ? recovery?.revision ?? baseline?.journalRevision ?? null
        : null;
      let recovered: FileContent | undefined;
      let recoveryError: unknown;
      await queueWrite(path, async (target, isLatest) => {
        recoveryQueueActive = true;
        recoveryIsLatest = isLatest;
        try {
          if (target !== path) throw new Error("Editor recovery path changed; draft preserved");
          assertCurrent();
          if (retirementRevision !== null) {
            await ipc.retireEditorDraft(path, snapshot.origin, retirementRevision);
            // This acknowledgement describes retirement, even if view adoption is stale.
            if (baseline?.journalRevision === retirementRevision) {
              baseline.journalRevision = null;
              baseline.journalDraft = null;
            }
            assertCurrent();
          }
          // No await after the final checks: discard and baseline replacement are
          // one explicitly confirmed transition, never a pre-read deletion.
          pendingDrafts.delete(path);
          editorBaselines.set(path, {
            origin: Object.freeze({ ...snapshot.origin }),
            vaultToken,
            revision: snapshot.revision,
            raw: snapshot.file.raw,
            recoverySupported: snapshot.recoverySupported,
            recoveryOnly: false,
            journalRevision: null,
            journalDraft: null,
          });
          lastLinkKey.set(path, linkKey(snapshot.file.raw));
          set({ activeFile: snapshot.file, isLoading: false, error: null });
          recovered = snapshot.file;
          return true;
        } catch (err) {
          recoveryError = err;
          return false;
        }
      });
      if (recoveryError !== undefined) throw recoveryError;
      if (!recovered) throw new Error("Editor recovery did not complete; draft preserved");
      return recovered;
    } finally {
      if (fileRead === read) fileRead = null;
    }
  },

  async persistPendingEditorDraft(path, content) {
    const baseline = editorBaselines.get(path);
    const version = pendingDrafts.version(path);
    if (!baseline || !ownsEditorOpening(baseline) || !baseline.recoverySupported ||
      pendingDrafts.get(path) !== content) return false;
    return queueWrite(path, async (target) => {
      if (pendingDrafts.get(target) !== content || pendingDrafts.version(target) !== version) return false;
      try {
        await stageEditorCheckpoint(target, content, baseline, version);
        return pendingDrafts.get(target) === content && pendingDrafts.version(target) === version;
      } catch (err) {
        if (ownsEditorOpening(baseline)) set({ error: errorMessage(err) });
        return false;
      }
    });
  },

  async saveFile(path, content, opts) {
    const baseline = editorBaselines.get(path);
    const draftVersion = pendingDrafts.version(path);
    // A failed first read or stale opening cannot be repaired by reading the
    // current disk just before saving: that would erase a real conflict.
    if (!baseline || !ownsEditorOpening(baseline)) {
      if (!pendingDrafts.has(path)) pendingDrafts.set(path, content);
      const state = get();
      if (!state.isOpeningVault && state.currentVault && underPath(path, state.currentVault.path) &&
        (!baseline || baseline.vaultToken === state.vaultToken)) {
        set({ error: "Editor baseline unavailable or expired; the draft has been preserved" });
      }
      return false;
    }
    return queueWrite(path, async (target, isLatest) => {
      try {
        if (!ownsEditorOpening(baseline) || editorBaselines.get(target) !== baseline) {
          throw new Error("Editor save belongs to an expired file or vault opening");
        }
        await stageEditorCheckpoint(target, content, baseline, draftVersion);
        const journalRevision = baseline.journalRevision;
        const receipt = await ipc.writeEditorFile(target, content, baseline.revision, baseline.origin);
        if (!ownsEditorOpening(baseline)) {
          if (!pendingDrafts.has(target)) pendingDrafts.set(target, content);
          return false;
        }
        if (editorBaselines.get(target) !== baseline || receipt.path !== target ||
          !sameOrigin(receipt.origin, baseline.origin) || !/^[a-f0-9]{64}$/.test(receipt.revision)) {
          throw new Error("Editor save receipt does not match its captured file and opening; persisted outcome requires recovery");
        }
        if (baseline.recoverySupported) {
          if (journalRevision === null) throw new Error("Editor save has no acknowledged durable checkpoint");
          await ipc.retireEditorDraft(target, baseline.origin, journalRevision);
          if (baseline.journalRevision === journalRevision) {
            baseline.journalRevision = null;
            baseline.journalDraft = null;
          }
          if (!ownsEditorOpening(baseline) || editorBaselines.get(target) !== baseline) {
            throw new Error("Editor retirement belongs to an expired opening; draft preserved");
          }
        }
        baseline.revision = receipt.revision;
        baseline.raw = content;
        // Undo can match this text while a different later write is queued.
        if (isLatest() && pendingDrafts.get(target) === content &&
          pendingDrafts.version(target) === draftVersion) pendingDrafts.delete(target);
        const vault = get().currentVault;
        if (
          vault &&
          useSettingsStore.getState().settings?.vault_history_enabled &&
          target.startsWith(vault.path)
        ) {
          const rel = target.slice(vault.path.length).replace(/^\/+/, "");
          humanCommitter.touch(rel);
        }
        // The editor saves the full raw document, so the saved string IS the new
        // `raw`. Keep `raw` in sync (the editor re-seeds from it); the stripped
        // `content` preview field is recomputed on the next fresh read_file.
        set((state) =>
          state.activeFile?.path === target
            ? { activeFile: { ...state.activeFile, raw: content }, error: null, lastSavedAt: Date.now() }
            : { error: null, lastSavedAt: Date.now() },
        );
        // Rebuild only when this write could have MOVED the graph. A save that
        // changes prose alone leaves the same wikilinks and the same tags, so the
        // rebuild would reproduce the graph it just produced.
        // ponytail: the key covers wikilinks + frontmatter tags — body `#tags`
        // are not indexed today (index.rs::extract_tags is frontmatter-only), so
        // add them here the day they are.
        const key = linkKey(content);
        const moved = lastLinkKey.get(target) !== key;
        lastLinkKey.set(target, key);
        if (!opts?.skipRefresh && moved) void get().refreshLinkGraph();
        return true;
      } catch (err) {
        if (!pendingDrafts.has(target)) pendingDrafts.set(target, content);
        if (ownsEditorOpening(baseline)) {
          set({ error: errorMessage(err) });
        }
        return false;
      }
    });
  },

  async patchPages(paths, make) {
    let wrote = false;
    const { currentVault: vault, vaultToken } = get();
    if (!vault || get().isOpeningVault) return;
    try {
      for (const path of paths) {
        if (pendingDrafts.has(path) || fileWrites.has(path)) throw new Error("Editor draft is pending; save or resolve it before patching the page");
        const snapshot = await readEditorSnapshot(path, vault.path, vaultToken);
        if (pendingDrafts.has(path) || fileWrites.has(path)) throw new Error("Editor draft changed while reading the page patch baseline");
        retainEditorBaseline(path, snapshot, vaultToken);
        const { raw } = snapshot.file;
        const edit = patchFrontmatter(raw, make(parseFrontmatter(raw)));
        if (edit.raw === raw) continue;
        if (!(await get().saveFile(path, edit.raw, { skipRefresh: true }))) return;
        wrote = true;
      }
    } catch (err) {
      if (get().currentVault?.path === vault.path && get().vaultToken === vaultToken) set({ error: errorMessage(err) });
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

  deletePath: async (paths, expectedPermanent) => {
    set({ error: null });
    try {
      for (const path of typeof paths === "string"
        ? [paths]
        : dropNested(paths)) {
        const resume = await pauseWrites(path);
        try {
          assertNoDurableDrafts(path);
          await (expectedPermanent === undefined ? ipc.deletePath(path) : ipc.deletePath(path, expectedPermanent));
          invalidateFileRead(path);
          retargetWrites(path, null);
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
        } finally { resume(); }
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
    const resume = await pauseWrites(from);
    try {
      assertNoDurableDrafts(from);
      const newPath = await ipc.renamePath(from, toName);
      retargetWrites(from, newPath);
      const followed = afterPathChange(from, newPath);
      resume();
      await followed;
      await get().refreshTree();
      void get().refreshLinkGraph();
      return newPath;
    } catch (err) {
      set({ error: errorMessage(err) });
      return null;
    } finally { resume(); }
  },

  movePaths: async (paths, destDir) => {
    set({ error: null });
    let error: string | null = null;
    for (const p of filterMovable(paths, destDir)) {
      try {
        await movePathFollowing(p, destDir);
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

  resolveWikilink: (target: string) => resolveStem(get().fileTree, target),

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
    openSeq++;
    fileRead = null;
    const shouldCloseNative = get().currentVault !== null || get().isOpeningVault;
    const vaultToken = crypto.randomUUID();
    set({
      currentVault: null,
      vaultToken,
      fileTree: [],
      activeFile: null,
      adjacency: null,
      revision: null,
      favorites: [],
      isLoading: false,
      isOpeningVault: false,
      error: null,
    });
    if (!shouldCloseNative) return Promise.resolve();
    return transitionVault(() => ipc.closeVault()).catch((err: unknown) => {
      if (get().vaultToken === vaultToken && !get().currentVault) {
        set({ error: errorMessage(err) });
      }
    });
  },
}));

/** Move one path into `toDir` the way the sidebar does. Durable pending drafts
 *  refuse the move; otherwise queues, the open file, route and favorites follow.
 *  Returns where it landed. Refreshes nothing and rethrows a refusal, for a
 *  caller moving many pages that reports per file (Tidy). */
export async function movePathFollowing(from: string, toDir: string): Promise<string> {
  const resume = await pauseWrites(from);
  try {
    assertNoDurableDrafts(from);
    const moved = await ipc.movePath(from, toDir);
    retargetWrites(from, moved);
    const followed = afterPathChange(from, moved);
    resume();
    await followed;
    return moved;
  } finally { resume(); }
}

/** Write every pending editor draft now. Each save consumes its entry, so the
 *  reader's debounce timer then stands down instead of saving later over
 *  whatever a bulk writer (Tidy) puts there. */
export async function flushPendingDrafts(): Promise<void> {
  const { saveFile } = useVaultStore.getState();
  await Promise.all([...pendingDrafts].map(([path, draft]) => saveFile(path, draft)));
}

/** A path was renamed or moved: follow it (exact match and descendants) in the
 *  open file, the route — without a history entry, so autosave/navigation
 *  target the new path — and the favorites list. */
async function afterPathChange(from: string, to: string) {
  invalidateFileRead(from);
  const { activeFile, favorites, currentVault } = useVaultStore.getState();
  // Transfer ownership before changing the route. A failed write must remain
  // recoverable at the new path, while the old reader must not recreate it.
  const movedDrafts: string[] = [];
  for (const [path, draft] of [...pendingDrafts]) {
    const moved = rewritePrefix(path, from, to);
    if (!moved || moved === path) continue;
    pendingDrafts.delete(path);
    pendingDrafts.set(moved, draft);
    movedDrafts.push(moved);
  }
  if (activeFile) {
    const path = rewritePrefix(activeFile.path, from, to);
    if (path) useVaultStore.setState({ activeFile: { ...activeFile, path } });
  }
  const ui = useUIStore.getState();
  if (ui.route.startsWith("page:")) {
    const path = rewritePrefix(ui.route.slice("page:".length), from, to);
    if (path) ui.replaceRoute(`page:${path}`);
  }
  // Register every write before yielding; later typing queues after these
  // snapshots even when another note's disk write takes longer to finish.
  await Promise.all(movedDrafts.map((path) => {
    const draft = pendingDrafts.get(path);
    return draft === undefined ? undefined
      : useVaultStore.getState().saveFile(path, draft, { skipRefresh: true });
  }));
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
