// Renderer module restart controls with synthetic native state, not native authority.
import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import type { AgentVaultSession, RecoveryDraft } from "../lib/ipc";
import type * as StoreModule from "./vaultStore";

const boundary = vi.hoisted(() => ({
  agentVaultSession: vi.fn(), editorRecoverySupported: vi.fn(),
  readEditorFile: vi.fn(), readEditorDraft: vi.fn(), stageEditorDraft: vi.fn(),
  retireEditorDraft: vi.fn(), writeEditorFile: vi.fn(),
  openVault: vi.fn(), closeVault: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn(), listFiles: vi.fn().mockResolvedValue([]),
  buildLinkGraph: vi.fn().mockResolvedValue({ forward: {}, backward: {}, unresolved: {}, tags: {} }),
  recordPageOpen: vi.fn().mockResolvedValue(null), renamePath: vi.fn(), movePath: vi.fn(), deletePath: vi.fn(),
}));
vi.mock("../lib/ipc", () => ({ ipc: boundary }));

const root = "/synthetic-durable-editor";
const path = `${root}/wiki/note.md`;
const A = "---\r\ntitle: Synthetic\r\n---\r\nOriginal A.\r\n";
const B = "---\ntitle: Synthetic\n---\nExternal B.\n";
const D = "---\r\ntitle: Synthetic\r\n---\r\nLocal draft D.\r\n";
const E = "---\ntitle: Synthetic\n---\nLatest draft E.\n";
const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");
let store: typeof StoreModule;
let origin: AgentVaultSession;
let disk: string;
let journal: RecoveryDraft | null;
// Synthetic fallback persistence is a fixture contract, not native filesystem evidence.
let fallback: RecoveryDraft | null;
// A retained synthetic commit receipt confirms retirement, never a note-write origin.
let committed: RecoveryDraft | null;
let snapshots: Map<string, string>;
let supported: boolean;
let nonce: number;
let stageGate: Promise<void> | undefined;
let writeGate: Promise<void> | undefined;
let retireGate: Promise<void> | undefined;
let stageError: Error | undefined;
let retireError: Error | undefined;
let postUnlinkRetireError: Error | undefined;
let postCommitConfirmationError: Error | undefined;
let stageOverride: ((value: RecoveryDraft) => RecoveryDraft) | undefined;
let events: string[];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function checkOrigin(captured: AgentVaultSession): void {
  if (captured.vaultPath !== origin.vaultPath || captured.openingToken !== origin.openingToken) {
    throw new Error("Synthetic stale native opening");
  }
}
function snapshotKey(captured: AgentVaultSession, revision: string): string {
  return `${captured.openingToken}:${revision}`;
}
async function freshModule(): Promise<void> {
  vi.resetModules();
  store = await import("./vaultStore");
  store.useVaultStore.setState({ currentVault: { path: root, name: "Synthetic" },
    vaultToken: `ui-${origin.openingToken}`, isOpeningVault: false, isLoading: false,
    activeFile: null, error: null, lastSavedAt: null, favorites: [] });
}
async function opened(): Promise<void> {
  expect(await store.useVaultStore.getState().openFile(path)).toBeNull();
}

beforeEach(async () => {
  vi.clearAllMocks();
  origin = { vaultPath: root, openingToken: "synthetic-first-opening" };
  disk = A;
  journal = null;
  fallback = null;
  committed = null;
  snapshots = new Map();
  supported = true;
  nonce = 0;
  stageGate = writeGate = retireGate = undefined;
  stageError = retireError = undefined;
  postUnlinkRetireError = undefined;
  postCommitConfirmationError = undefined;
  stageOverride = undefined;
  events = [];
  boundary.agentVaultSession.mockImplementation(async () => ({ ...origin }));
  boundary.editorRecoverySupported.mockImplementation(async () => supported);
  boundary.readEditorFile.mockImplementation(async (target: string, captured: AgentVaultSession) => {
    checkOrigin(captured);
    snapshots.set(snapshotKey(captured, sha(disk)), disk);
    return { file: { path: target, raw: disk, content: disk, frontmatter: null },
      origin: { ...captured }, revision: sha(disk) };
  });
  boundary.readEditorDraft.mockImplementation(async (_target: string, captured: AgentVaultSession) => {
    checkOrigin(captured);
    const checkpoint = journal ?? fallback;
    return checkpoint ? structuredClone(checkpoint) : null;
  });
  boundary.stageEditorDraft.mockImplementation(async (target: string, expected: string, draft: string,
    captured: AgentVaultSession, expectedJournal: string | null) => {
    events.push("stage");
    await stageGate;
    checkOrigin(captured);
    if (stageError) throw stageError;
    if (((journal ?? fallback)?.revision ?? null) !== expectedJournal) throw new Error("Synthetic journal conflict");
    const raw = snapshots.get(snapshotKey(captured, expected));
    if (raw === undefined) throw new Error("No registered native baseline");
    journal = { path: target, baselineRaw: raw, baselineRevision: expected, draftRaw: draft,
      revision: (++nonce).toString(16).padStart(32, "0"), origin: { ...captured } };
    fallback = null;
    const receipt = structuredClone(journal);
    return stageOverride?.(receipt) ?? receipt;
  });
  boundary.writeEditorFile.mockImplementation(async (target: string, content: string, expected: string,
    captured: AgentVaultSession) => {
    events.push("write");
    await writeGate;
    checkOrigin(captured);
    if (sha(disk) !== expected) throw new Error("Synthetic native CAS conflict");
    disk = content;
    snapshots.set(snapshotKey(captured, sha(content)), content);
    return { path: target, origin: { ...captured }, revision: sha(content) };
  });
  boundary.retireEditorDraft.mockImplementation(async (_target: string, captured: AgentVaultSession, expected: string) => {
    events.push("retire");
    await retireGate;
    checkOrigin(captured);
    if (retireError) throw retireError;
    const checkpoint = journal ?? fallback;
    if (!checkpoint && committed?.revision === expected) return;
    if (checkpoint?.revision !== expected) throw new Error("Synthetic retirement conflict");
    if (postUnlinkRetireError) {
      // The primary is gone; a verified same-nonce copy remains discoverable.
      fallback = structuredClone(checkpoint);
      journal = null;
      throw postUnlinkRetireError;
    }
    journal = null;
    fallback = null;
    committed = structuredClone(checkpoint);
    if (postCommitConfirmationError) throw postCommitConfirmationError;
  });
  boundary.readFile.mockImplementation(async (target: string) => ({ path: target, raw: "[]", content: "[]", frontmatter: null }));
  await freshModule();
});

it("restores exact D/full A after failed CAS in a fresh module without rebinding old authority", async () => {
  await opened();
  store.pendingDrafts.set(path, D);
  disk = B;
  expect(await store.useVaultStore.getState().saveFile(path, D)).toBe(false);
  expect(events).toEqual(["stage", "write"]);
  expect(journal).toMatchObject({ baselineRaw: A, baselineRevision: sha(A), draftRaw: D, origin });
  origin = { vaultPath: root, openingToken: "synthetic-restarted-opening" };
  boundary.writeEditorFile.mockClear();
  boundary.stageEditorDraft.mockClear();
  await freshModule();
  expect(store.pendingDrafts.size).toBe(0);
  await opened();
  expect(store.pendingDrafts.get(path)).toBe(D);
  expect(store.getEditorRecoveryBaseline(path)).toBe(A);
  expect(store.useVaultStore.getState().activeFile?.raw).toBe(B);
  expect(await store.useVaultStore.getState().saveFile(path, D)).toBe(false);
  expect(await store.useVaultStore.getState().persistPendingEditorDraft(path, D)).toBe(false);
  expect(boundary.stageEditorDraft).not.toHaveBeenCalled();
  expect(boundary.writeEditorFile).not.toHaveBeenCalled();
  expect(disk).toBe(B);
});

it("awaits the durable checkpoint before CAS and reuses the acknowledged current checkpoint", async () => {
  await opened();
  store.pendingDrafts.set(path, D);
  expect(await store.useVaultStore.getState().persistPendingEditorDraft(path, D)).toBe(true);
  expect(await store.useVaultStore.getState().saveFile(path, D)).toBe(true);
  expect(events).toEqual(["stage", "write", "retire"]);
  expect(journal).toBeNull();
  expect(store.pendingDrafts.has(path)).toBe(false);
});

it("never invokes CAS before a held checkpoint acknowledges exact D", async () => {
  await opened();
  const gate = deferred();
  stageGate = gate.promise;
  store.pendingDrafts.set(path, D);
  const saving = store.useVaultStore.getState().saveFile(path, D);
  await vi.waitFor(() => expect(boundary.stageEditorDraft).toHaveBeenCalledTimes(1));
  expect(boundary.writeEditorFile).not.toHaveBeenCalled();
  gate.resolve();
  expect(await saving).toBe(true);
});

it("keeps acknowledged A/D and later E when accepted D retirement fails", async () => {
  await opened();
  const gate = deferred();
  retireGate = gate.promise;
  retireError = new Error("Synthetic retirement failure");
  store.pendingDrafts.set(path, D);
  const saving = store.useVaultStore.getState().saveFile(path, D);
  await vi.waitFor(() => expect(boundary.retireEditorDraft).toHaveBeenCalledTimes(1));
  store.pendingDrafts.set(path, E);
  gate.resolve();
  expect(await saving).toBe(false);
  expect(disk).toBe(D);
  expect(journal).toMatchObject({ baselineRaw: A, draftRaw: D });
  expect(store.pendingDrafts.get(path)).toBe(E);
  expect(store.getEditorRecoveryBaseline(path)).toBe(A);
});

it("retires only D then checkpoints newer E against the accepted native D baseline", async () => {
  await opened();
  const gate = deferred();
  writeGate = gate.promise;
  store.pendingDrafts.set(path, D);
  const saving = store.useVaultStore.getState().saveFile(path, D);
  await vi.waitFor(() => expect(boundary.writeEditorFile).toHaveBeenCalledTimes(1));
  store.pendingDrafts.set(path, E);
  const checkpoint = store.useVaultStore.getState().persistPendingEditorDraft(path, E);
  gate.resolve();
  expect(await saving).toBe(true);
  expect(await checkpoint).toBe(true);
  expect(events).toEqual(["stage", "write", "retire", "stage"]);
  expect(store.pendingDrafts.get(path)).toBe(E);
  expect(journal).toMatchObject({ baselineRaw: D, baselineRevision: sha(D), draftRaw: E });
  expect(disk).toBe(D);
  expect(await store.useVaultStore.getState().saveFile(path, E)).toBe(true);
  expect(disk).toBe(E);
});

it("does not clear equal-text ABA typing when an older save completes", async () => {
  await opened();
  const gate = deferred();
  writeGate = gate.promise;
  store.pendingDrafts.set(path, D);
  const saving = store.useVaultStore.getState().saveFile(path, D);
  await vi.waitFor(() => expect(boundary.writeEditorFile).toHaveBeenCalledTimes(1));
  store.pendingDrafts.set(path, E);
  store.pendingDrafts.set(path, D);
  gate.resolve();
  expect(await saving).toBe(true);
  expect(store.pendingDrafts.get(path)).toBe(D);
});

it("serializes retirement with newer typing and retains A/E when view adoption becomes stale", async () => {
  await opened();
  store.pendingDrafts.set(path, D);
  expect(await store.useVaultStore.getState().persistPendingEditorDraft(path, D)).toBe(true);
  disk = B;
  const gate = deferred();
  retireGate = gate.promise;
  const recovering = store.useVaultStore.getState().recoverEditorFile(path, D, () => true);
  const rejected = expect(recovering).rejects.toThrow();
  await vi.waitFor(() => expect(boundary.retireEditorDraft).toHaveBeenCalledTimes(1));
  store.pendingDrafts.set(path, E);
  const checkpoint = store.useVaultStore.getState().persistPendingEditorDraft(path, E);
  gate.resolve();
  await rejected;
  expect(await checkpoint).toBe(true);
  expect(store.pendingDrafts.get(path)).toBe(E);
  expect(store.getEditorRecoveryBaseline(path)).toBe(A);
  expect(journal).toMatchObject({ baselineRaw: A, draftRaw: E });
  expect(disk).toBe(B);
  expect(boundary.writeEditorFile).not.toHaveBeenCalled();
});

it.each(["rename", "move", "delete"] as const)("blocks supported pending-draft %s before native path mutation", async (operation) => {
  await opened();
  store.pendingDrafts.set(path, D);
  expect(await store.useVaultStore.getState().persistPendingEditorDraft(path, D)).toBe(true);
  const saved = structuredClone(journal);
  if (operation === "rename") expect(await store.useVaultStore.getState().renamePath(path, "other.md")).toBeNull();
  else if (operation === "move") await expect(store.movePathFollowing(path, `${root}/notes`)).rejects.toThrow("preserved editor draft");
  else await store.useVaultStore.getState().deletePath(path);
  expect(boundary.renamePath).not.toHaveBeenCalled();
  expect(boundary.movePath).not.toHaveBeenCalled();
  expect(boundary.deletePath).not.toHaveBeenCalled();
  expect(journal).toEqual(saved);
  expect(store.pendingDrafts.get(path)).toBe(D);
  expect(store.getEditorRecoveryBaseline(path)).toBe(A);
  expect(disk).toBe(A);
});

it("keeps native CAS behavior only when the actual recovery capability is false", async () => {
  supported = false;
  await opened();
  store.pendingDrafts.set(path, D);
  expect(await store.useVaultStore.getState().saveFile(path, D)).toBe(true);
  expect(boundary.readEditorDraft).not.toHaveBeenCalled();
  expect(boundary.stageEditorDraft).not.toHaveBeenCalled();
  expect(boundary.retireEditorDraft).not.toHaveBeenCalled();
  expect(boundary.writeEditorFile).toHaveBeenCalledWith(path, D, sha(A), origin);
});

it("does not bypass supported checkpoint errors or accept a malformed nonce", async () => {
  await opened();
  store.pendingDrafts.set(path, D);
  stageError = new Error("Synthetic journal I/O failure");
  expect(await store.useVaultStore.getState().saveFile(path, D)).toBe(false);
  stageError = undefined;
  stageOverride = (value) => ({ ...value, revision: "x".repeat(32) });
  expect(await store.useVaultStore.getState().saveFile(path, D)).toBe(false);
  expect(boundary.writeEditorFile).not.toHaveBeenCalled();
  expect(store.pendingDrafts.get(path)).toBe(D);
  expect(disk).toBe(A);
});

it.each(["path", "baselineRaw", "baselineRevision", "draftRaw", "openingToken"] as const)(
  "rejects a checkpoint with mismatched %s before CAS", async (field) => {
    await opened();
    store.pendingDrafts.set(path, D);
    stageOverride = (value) => field === "openingToken"
      ? { ...value, origin: { ...value.origin, openingToken: "synthetic-foreign-opening" } }
      : { ...value, [field]: field === "baselineRevision" ? sha(B) : "synthetic-mismatch" };
    expect(await store.useVaultStore.getState().saveFile(path, D)).toBe(false);
    expect(boundary.writeEditorFile).not.toHaveBeenCalled();
    expect(store.pendingDrafts.get(path)).toBe(D);
    expect(store.getEditorRecoveryBaseline(path)).toBe(A);
    expect(disk).toBe(A);
  },
);

it("keeps D/full A when explicitly confirmed retirement fails", async () => {
  await opened();
  store.pendingDrafts.set(path, D);
  expect(await store.useVaultStore.getState().persistPendingEditorDraft(path, D)).toBe(true);
  const acknowledged = structuredClone(journal);
  disk = B;
  retireError = new Error("Synthetic confirmed retirement failure");
  await expect(store.useVaultStore.getState().recoverEditorFile(path, D, () => true)).rejects.toThrow("retirement failure");
  expect(journal).toEqual(acknowledged);
  expect(store.pendingDrafts.get(path)).toBe(D);
  expect(store.getEditorRecoveryBaseline(path)).toBe(A);
  expect(store.useVaultStore.getState().activeFile?.raw).toBe(A);
  expect(disk).toBe(B);
});

it("does not publish a replacement baseline when supported journal discovery fails", async () => {
  boundary.readEditorDraft.mockRejectedValueOnce(new Error("Synthetic journal read failure"));
  expect(await store.useVaultStore.getState().openFile(path)).toContain("journal read failure");
  store.pendingDrafts.set(path, D);
  expect(await store.useVaultStore.getState().saveFile(path, D)).toBe(false);
  expect(boundary.stageEditorDraft).not.toHaveBeenCalled();
  expect(boundary.writeEditorFile).not.toHaveBeenCalled();
  expect(store.pendingDrafts.get(path)).toBe(D);
  expect(disk).toBe(A);
});

it("reads immutable raw sources without editor journal discovery", async () => {
  const rawPath = `${root}/raw/source.md`;
  expect(await store.useVaultStore.getState().openFile(rawPath)).toBeNull();
  expect(store.useVaultStore.getState().activeFile?.raw).toBe(A);
  expect(boundary.readEditorDraft).not.toHaveBeenCalled();
  expect(boundary.stageEditorDraft).not.toHaveBeenCalled();
});

it("restores and retires an empty draft without treating it as journal absence", async () => {
  await opened();
  store.pendingDrafts.set(path, "");
  disk = B;
  expect(await store.useVaultStore.getState().saveFile(path, "")).toBe(false);
  origin = { vaultPath: root, openingToken: "synthetic-empty-restart" };
  await freshModule();
  await opened();
  expect(store.pendingDrafts.get(path)).toBe("");
  expect(store.getEditorRecoveryBaseline(path)).toBe(A);
  expect((await store.useVaultStore.getState().recoverEditorFile(path, "", () => true)).raw).toBe(B);
  expect(store.pendingDrafts.has(path)).toBe(false);
  expect(journal).toBeNull();
  expect(disk).toBe(B);
});

it("restores same-nonce fallback D/full A after post-unlink failure in a fresh module", async () => {
  await opened();
  store.pendingDrafts.set(path, D);
  expect(await store.useVaultStore.getState().persistPendingEditorDraft(path, D)).toBe(true);
  const checkpoint = structuredClone(journal);
  postUnlinkRetireError = new Error("Synthetic sync failure after primary unlink");
  expect(await store.useVaultStore.getState().saveFile(path, D)).toBe(false);
  expect(journal).toBeNull();
  expect(fallback).toEqual(checkpoint);
  expect(disk).toBe(D);
  expect(store.pendingDrafts.get(path)).toBe(D);
  expect(store.getEditorRecoveryBaseline(path)).toBe(A);
  origin = { vaultPath: root, openingToken: "synthetic-post-unlink-restart" };
  await freshModule();
  await opened();
  expect(boundary.readEditorDraft).toHaveBeenLastCalledWith(path, origin);
  expect(store.pendingDrafts.get(path)).toBe(D);
  expect(store.getEditorRecoveryBaseline(path)).toBe(A);
  expect(store.useVaultStore.getState().activeFile?.raw).toBe(D);
  boundary.stageEditorDraft.mockClear();
  boundary.writeEditorFile.mockClear();
  expect(await store.useVaultStore.getState().persistPendingEditorDraft(path, D)).toBe(false);
  expect(await store.useVaultStore.getState().saveFile(path, D)).toBe(false);
  expect(boundary.stageEditorDraft).not.toHaveBeenCalled();
  expect(boundary.writeEditorFile).not.toHaveBeenCalled();
  expect(fallback).toEqual(checkpoint);
});

it("keeps expected A on save retry after accepted D and failed post-unlink retirement", async () => {
  await opened();
  store.pendingDrafts.set(path, D);
  postUnlinkRetireError = new Error("Synthetic sync failure after primary unlink");
  expect(await store.useVaultStore.getState().saveFile(path, D)).toBe(false);
  const checkpoint = structuredClone(fallback);
  postUnlinkRetireError = undefined;
  expect(await store.useVaultStore.getState().saveFile(path, D)).toBe(false);
  expect(boundary.stageEditorDraft).toHaveBeenCalledTimes(1);
  expect(boundary.writeEditorFile).toHaveBeenNthCalledWith(2, path, D, sha(A), origin);
  expect(boundary.retireEditorDraft).toHaveBeenCalledTimes(1);
  expect(fallback).toEqual(checkpoint);
  expect(journal).toBeNull();
  expect(store.pendingDrafts.get(path)).toBe(D);
  expect(store.getEditorRecoveryBaseline(path)).toBe(A);
  expect(store.useVaultStore.getState().activeFile?.raw).toBe(A);
  expect(store.useVaultStore.getState().lastSavedAt).toBeNull();
  expect(disk).toBe(D);
});

it("preserves A/E and original nonce when recovery retirement fails after unlink during typing", async () => {
  await opened();
  store.pendingDrafts.set(path, D);
  expect(await store.useVaultStore.getState().persistPendingEditorDraft(path, D)).toBe(true);
  const checkpoint = structuredClone(journal);
  disk = B;
  const gate = deferred();
  retireGate = gate.promise;
  postUnlinkRetireError = new Error("Synthetic recovery sync failure after primary unlink");
  const recovering = store.useVaultStore.getState().recoverEditorFile(path, D, () => true);
  const rejected = expect(recovering).rejects.toThrow("sync failure after primary unlink");
  await vi.waitFor(() => expect(boundary.retireEditorDraft).toHaveBeenCalledTimes(1));
  store.pendingDrafts.set(path, E);
  gate.resolve();
  await rejected;
  expect(store.pendingDrafts.get(path)).toBe(E);
  expect(store.getEditorRecoveryBaseline(path)).toBe(A);
  expect(store.useVaultStore.getState().activeFile?.raw).toBe(A);
  expect(journal).toBeNull();
  expect(fallback).toEqual(checkpoint);
  expect(boundary.writeEditorFile).not.toHaveBeenCalled();
  expect(disk).toBe(B);
  // E has only renderer acknowledgement here; the durable fixture still holds D.
  postUnlinkRetireError = undefined;
  expect((await store.useVaultStore.getState().recoverEditorFile(path, E, () => true)).raw).toBe(B);
  expect(boundary.retireEditorDraft).toHaveBeenLastCalledWith(path, origin, checkpoint?.revision);
  expect(store.pendingDrafts.has(path)).toBe(false);
  expect(store.getEditorRecoveryBaseline(path)).toBeUndefined();
  expect(journal).toBeNull();
  expect(fallback).toBeNull();
  expect(disk).toBe(B);
});

it("requires exact native commit acknowledgement before explicit recovery adopts a fresh snapshot", async () => {
  await opened();
  store.pendingDrafts.set(path, D);
  expect(await store.useVaultStore.getState().persistPendingEditorDraft(path, D)).toBe(true);
  const checkpoint = structuredClone(journal);
  postCommitConfirmationError = new Error("Synthetic retirement committed but confirmation failed");
  expect(await store.useVaultStore.getState().saveFile(path, D)).toBe(false);
  expect(journal).toBeNull();
  expect(fallback).toBeNull();
  expect(committed).toEqual(checkpoint);
  expect(store.pendingDrafts.get(path)).toBe(D);
  expect(store.getEditorRecoveryBaseline(path)).toBe(A);
  expect(store.useVaultStore.getState().activeFile?.raw).toBe(A);
  expect(await boundary.readEditorDraft(path, origin)).toBeNull();
  expect(await store.useVaultStore.getState().saveFile(path, D)).toBe(false);
  expect(boundary.writeEditorFile).toHaveBeenNthCalledWith(2, path, D, sha(A), origin);
  expect(boundary.retireEditorDraft).toHaveBeenCalledTimes(1);
  expect((await store.useVaultStore.getState().recoverEditorFile(path, D, () => true)).raw).toBe(D);
  expect(boundary.retireEditorDraft).toHaveBeenNthCalledWith(2, path, origin, checkpoint?.revision);
  expect(committed).toEqual(checkpoint);
  expect(store.pendingDrafts.has(path)).toBe(false);
  expect(store.getEditorRecoveryBaseline(path)).toBeUndefined();
  expect(boundary.writeEditorFile).toHaveBeenCalledTimes(2);
  expect(disk).toBe(D);
});

it("refuses unknown journal absence unless native confirms the exact acknowledged nonce", async () => {
  await opened();
  store.pendingDrafts.set(path, D);
  expect(await store.useVaultStore.getState().persistPendingEditorDraft(path, D)).toBe(true);
  const acknowledgedNonce = journal?.revision;
  // This disappearance has no native committed receipt; absence is not permission.
  journal = null;
  disk = B;
  await expect(store.useVaultStore.getState().recoverEditorFile(path, D, () => true)).rejects.toThrow("Synthetic retirement conflict");
  expect(boundary.retireEditorDraft).toHaveBeenCalledWith(path, origin, acknowledgedNonce);
  expect(store.pendingDrafts.get(path)).toBe(D);
  expect(store.getEditorRecoveryBaseline(path)).toBe(A);
  expect(store.useVaultStore.getState().activeFile?.raw).toBe(A);
  expect(boundary.writeEditorFile).not.toHaveBeenCalled();
  expect(committed).toBeNull();
  expect(disk).toBe(B);
});

it("clears only a confirmed old nonce when newer E makes commit-ack recovery adoption stale", async () => {
  await opened();
  store.pendingDrafts.set(path, D);
  postCommitConfirmationError = new Error("Synthetic retirement committed but confirmation failed");
  expect(await store.useVaultStore.getState().saveFile(path, D)).toBe(false);
  const receipt = structuredClone(committed);
  const gate = deferred();
  retireGate = gate.promise;
  const outcome = store.useVaultStore.getState().recoverEditorFile(path, D, () => true)
    .then(() => null, (error: unknown) => error);
  try {
    await vi.waitFor(() => expect(boundary.retireEditorDraft).toHaveBeenCalledTimes(2));
    store.pendingDrafts.set(path, E);
  } finally {
    gate.resolve();
  }
  expect(await outcome).toBeInstanceOf(Error);
  expect(boundary.retireEditorDraft).toHaveBeenNthCalledWith(2, path, origin, receipt?.revision);
  expect(store.pendingDrafts.get(path)).toBe(E);
  expect(store.getEditorRecoveryBaseline(path)).toBe(A);
  expect(store.useVaultStore.getState().activeFile?.raw).toBe(A);
  expect(committed).toEqual(receipt);
  expect(disk).toBe(D);
  // No hidden rebase: the next acknowledged checkpoint still carries registered A.
  expect(await store.useVaultStore.getState().persistPendingEditorDraft(path, E)).toBe(true);
  expect(boundary.stageEditorDraft).toHaveBeenLastCalledWith(path, sha(A), E, origin, null);
  expect(journal).toMatchObject({ baselineRaw: A, baselineRevision: sha(A), draftRaw: E });
  expect(disk).toBe(D);
});


// These controls simulate permanent file-read errors at the IPC boundary.
// Actual missing/invalid-UTF8 native files are checked separately in native tests.
async function acknowledgedBeforeUnreadableRestart(draft = D): Promise<RecoveryDraft> {
  await opened();
  store.pendingDrafts.set(path, draft);
  expect(await store.useVaultStore.getState().persistPendingEditorDraft(path, draft)).toBe(true);
  const checkpoint = structuredClone(journal);
  expect(checkpoint).not.toBeNull();
  origin = { vaultPath: root, openingToken: "synthetic-unreadable-restart" };
  await freshModule();
  boundary.stageEditorDraft.mockClear();
  boundary.writeEditorFile.mockClear();
  boundary.retireEditorDraft.mockClear();
  boundary.readEditorDraft.mockClear();
  events = [];
  return checkpoint!;
}

it.each([
  ["canonicalize failed: No such file or directory (os error 2)", D],
  ["read failed: stream did not contain valid UTF-8", D],
  ["canonicalize failed: No such file or directory (os error 2)", ""],
] as const)("restores ACKed data only in a fresh module while file reads permanently fail: %s", async (readError, draft) => {
  const checkpoint = await acknowledgedBeforeUnreadableRestart(draft);
  boundary.readEditorFile.mockRejectedValue(new Error(readError));
  expect(await store.useVaultStore.getState().openFile(path)).toBe(readError);
  expect(boundary.readEditorDraft).toHaveBeenCalledWith(path, origin);
  expect(store.pendingDrafts.get(path)).toBe(draft);
  expect(store.getEditorRecoveryBaseline(path)).toBe(A);
  expect(store.useVaultStore.getState().activeFile).toBeNull();
  expect(store.useVaultStore.getState().lastSavedAt).toBeNull();
  expect(store.useVaultStore.getState().isLoading).toBe(false);
  expect([...snapshots.keys()].some((key) => key.startsWith(`${origin.openingToken}:`))).toBe(false);
  expect(await store.useVaultStore.getState().saveFile(path, draft)).toBe(false);
  expect(await store.useVaultStore.getState().persistPendingEditorDraft(path, draft)).toBe(false);
  await expect(store.useVaultStore.getState().recoverEditorFile(path, draft, () => true)).rejects.toThrow(readError);
  expect(store.pendingDrafts.get(path)).toBe(draft);
  expect(store.getEditorRecoveryBaseline(path)).toBe(A);
  expect(journal).toEqual(checkpoint);
  expect(boundary.stageEditorDraft).not.toHaveBeenCalled();
  expect(boundary.writeEditorFile).not.toHaveBeenCalled();
  expect(boundary.retireEditorDraft).not.toHaveBeenCalled();
  expect(events).toEqual([]);
});

it("preserves the real read failure when journal discovery itself refuses unsafe custody", async () => {
  const checkpoint = await acknowledgedBeforeUnreadableRestart();
  const readError = "read failed: Permission denied (os error 13)";
  boundary.readEditorFile.mockRejectedValue(new Error(readError));
  boundary.readEditorDraft.mockRejectedValueOnce(new Error("Synthetic unsafe recovery custody"));
  const result = await store.useVaultStore.getState().openFile(path);
  expect(result).toContain(readError);
  expect(result).toContain("unsafe recovery custody");
  expect(store.pendingDrafts.has(path)).toBe(false);
  expect(store.getEditorRecoveryBaseline(path)).toBeUndefined();
  expect(store.useVaultStore.getState().activeFile).toBeNull();
  expect(journal).toEqual(checkpoint);
  expect(events).toEqual([]);
});

it.each(["path", "vaultPath", "revision"] as const)("does not restore an unreadable file's mismatched journal %s", async (field) => {
  const checkpoint = await acknowledgedBeforeUnreadableRestart();
  boundary.readEditorFile.mockRejectedValue(new Error("Synthetic permanent read failure"));
  let invalid = structuredClone(checkpoint);
  if (field === "path") invalid.path = `${root}/wiki/foreign.md`;
  else if (field === "vaultPath") invalid = { ...invalid, origin: { ...invalid.origin, vaultPath: "/synthetic-foreign-vault" } };
  else invalid.revision = "invalid-nonce";
  boundary.readEditorDraft.mockResolvedValueOnce(invalid);
  expect(await store.useVaultStore.getState().openFile(path)).toContain("permanent read failure");
  expect(store.pendingDrafts.has(path)).toBe(false);
  expect(store.getEditorRecoveryBaseline(path)).toBeUndefined();
  expect(store.useVaultStore.getState().activeFile).toBeNull();
  expect(journal).toEqual(checkpoint);
  expect(events).toEqual([]);
});

it.each(["unsupported", "raw"] as const)("does not discover a journal after file-read failure on the %s branch", async (kind) => {
  const checkpoint = await acknowledgedBeforeUnreadableRestart();
  supported = kind !== "unsupported";
  const target = kind === "raw" ? `${root}/raw/source.md` : path;
  boundary.readEditorFile.mockRejectedValue(new Error("Synthetic permanent read failure"));
  expect(await store.useVaultStore.getState().openFile(target)).toBe("Synthetic permanent read failure");
  expect(boundary.readEditorDraft).not.toHaveBeenCalled();
  expect(store.pendingDrafts.has(target)).toBe(false);
  expect(store.getEditorRecoveryBaseline(target)).toBeUndefined();
  expect(store.useVaultStore.getState().activeFile).toBeNull();
  expect(journal).toEqual(checkpoint);
  expect(events).toEqual([]);
});

it("keeps the missing-file error when no acknowledged journal exists", async () => {
  boundary.readEditorFile.mockRejectedValue(new Error("no such file: synthetic missing note"));
  expect(await store.useVaultStore.getState().openFile(path)).toBe("no such file: synthetic missing note");
  expect(boundary.readEditorDraft).toHaveBeenCalledWith(path, origin);
  expect(store.pendingDrafts.has(path)).toBe(false);
  expect(store.getEditorRecoveryBaseline(path)).toBeUndefined();
  expect(store.useVaultStore.getState().activeFile).toBeNull();
  expect(events).toEqual([]);
});

it("does not adopt a journal after its reader opening expires during discovery", async () => {
  const checkpoint = await acknowledgedBeforeUnreadableRestart();
  const gate = deferred();
  boundary.readEditorFile.mockRejectedValue(new Error("Synthetic permanent read failure"));
  boundary.readEditorDraft.mockImplementationOnce(async () => {
    await gate.promise;
    return structuredClone(checkpoint);
  });
  const opening = store.useVaultStore.getState().openFile(path);
  await vi.waitFor(() => expect(boundary.readEditorDraft).toHaveBeenCalledTimes(1));
  store.useVaultStore.setState({ vaultToken: "synthetic-newer-ui-opening" });
  gate.resolve();
  expect(await opening).toBeUndefined();
  expect(store.pendingDrafts.has(path)).toBe(false);
  expect(store.getEditorRecoveryBaseline(path)).toBeUndefined();
  expect(store.useVaultStore.getState().activeFile).toBeNull();
  expect(journal).toEqual(checkpoint);
  expect(events).toEqual([]);
});

it.each(["newer", "equal-text ABA"] as const)("preserves %s typing against late unreadable-file discovery", async (kind) => {
  const checkpoint = await acknowledgedBeforeUnreadableRestart();
  const gate = deferred();
  boundary.readEditorFile.mockRejectedValue(new Error("Synthetic permanent read failure"));
  boundary.readEditorDraft.mockImplementationOnce(async () => {
    await gate.promise;
    return structuredClone(checkpoint);
  });
  const opening = store.useVaultStore.getState().openFile(path);
  await vi.waitFor(() => expect(boundary.readEditorDraft).toHaveBeenCalledTimes(1));
  store.pendingDrafts.set(path, E);
  if (kind === "equal-text ABA") {
    store.pendingDrafts.delete(path);
    store.pendingDrafts.set(path, D);
  }
  gate.resolve();
  expect(await opening).toBe("Synthetic permanent read failure");
  expect(store.pendingDrafts.get(path)).toBe(kind === "newer" ? E : D);
  // A local edit that arrived after capture cannot borrow an old journal's baseline.
  expect(store.getEditorRecoveryBaseline(path)).toBeUndefined();
  expect(store.useVaultStore.getState().activeFile).toBeNull();
  expect(journal).toEqual(checkpoint);
  expect(events).toEqual([]);
});

it("keeps full A with newer E when a restored unreadable draft is read again", async () => {
  const checkpoint = await acknowledgedBeforeUnreadableRestart();
  boundary.readEditorFile.mockRejectedValue(new Error("Synthetic permanent read failure"));
  expect(await store.useVaultStore.getState().openFile(path)).toBe("Synthetic permanent read failure");
  store.pendingDrafts.set(path, E);
  expect(await store.useVaultStore.getState().openFile(path)).toBe("Synthetic permanent read failure");
  expect(store.pendingDrafts.get(path)).toBe(E);
  expect(store.getEditorRecoveryBaseline(path)).toBe(A);
  expect(await store.useVaultStore.getState().saveFile(path, E)).toBe(false);
  expect(journal).toEqual(checkpoint);
  expect(events).toEqual([]);
});

it.each(["success", "error"] as const)("distinguishes a superseded read's %s from a successful current read", async (result) => {
  await opened();
  store.pendingDrafts.set(path, D);
  expect(await store.useVaultStore.getState().persistPendingEditorDraft(path, D)).toBe(true);
  const checkpoint = structuredClone(journal);
  const read = boundary.readEditorFile.getMockImplementation();
  if (!read) throw new Error("Synthetic native-like reader is required");
  const gate = deferred();
  boundary.readEditorFile.mockClear();
  boundary.readEditorFile.mockImplementationOnce(async (target: string, captured: AgentVaultSession) => {
    await gate.promise;
    if (result === "error") throw new Error("Synthetic held read unavailable");
    return read(target, captured);
  });
  const held = store.useVaultStore.getState().openFile(path);
  await vi.waitFor(() => expect(boundary.readEditorFile).toHaveBeenCalledTimes(1));
  const otherPath = `${root}/wiki/other.md`;
  boundary.readEditorDraft.mockResolvedValueOnce(null);
  expect(await store.useVaultStore.getState().openFile(otherPath)).toBeNull();
  gate.resolve();
  expect(await held).toBeUndefined();
  expect(store.useVaultStore.getState().activeFile?.path).toBe(otherPath);
  expect(store.pendingDrafts.get(path)).toBe(D);
  expect(store.getEditorRecoveryBaseline(path)).toBe(A);
  expect(journal).toEqual(checkpoint);
});
