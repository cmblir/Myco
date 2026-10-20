// Synthetic editor boundary regressions. These mocks cannot issue native authority.
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentVaultSession, FileContent, RecoveryDraft } from "../lib/ipc";

const boundary = vi.hoisted(() => ({
  closeVault: vi.fn().mockResolvedValue(undefined),
  openVault: vi.fn(),
  createFile: vi.fn(),
  agentVaultSession: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  readEditorFile: vi.fn(),
  writeEditorFile: vi.fn(),
  editorRecoverySupported: vi.fn().mockResolvedValue(true),
  readEditorDraft: vi.fn(),
  stageEditorDraft: vi.fn(),
  retireEditorDraft: vi.fn(),
  listFiles: vi.fn().mockResolvedValue([]),
  buildLinkGraph: vi.fn().mockResolvedValue({ forward: {}, backward: {}, unresolved: {}, tags: {} }),
  recordPageOpen: vi.fn().mockResolvedValue(null),
  renamePath: vi.fn(),
  movePath: vi.fn(),
  saveFavorites: vi.fn().mockResolvedValue(null),
}));
vi.mock("../lib/ipc", () => ({ ipc: boundary }));

import { pendingDrafts, useVaultStore } from "./vaultStore";
import { useUIStore } from "./uiStore";

interface EditorReceipt {
  path: string;
  origin: AgentVaultSession;
  revision: string;
}
interface WriteAttempt {
  path: string;
  content: string;
  expected?: string;
  origin?: AgentVaultSession;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const original = "# Synthetic editor note\n\nOriginal A.\n";
const outsideEdit = "# Synthetic editor note\n\nExternal B.\n";
const draft = "# Synthetic editor note\n\nDraft A.\n";
const newer = "# Synthetic editor note\n\nNewer draft A.\n";
let serial = 0;
let root: string;
let path: string;
let origin: AgentVaultSession;
let disk: Map<string, string>;
let attempts: WriteAttempt[];
let beforeWrite: (() => Promise<void>) | undefined;
let afterWrite: (() => Promise<void>) | undefined;
let receiptOverride: ((receipt: EditorReceipt) => EditorReceipt) | undefined;
let journal: Map<string, RecoveryDraft>;
let snapshots: Map<string, Map<string, string>>;
let journalSerial = 0;

function registerSnapshot(target: string, raw: string): void {
  const revisions = snapshots.get(target) ?? new Map<string, string>();
  revisions.set(sha(raw), raw);
  snapshots.set(target, revisions);
}

function file(target: string): FileContent {
  const raw = disk.get(target);
  if (raw === undefined) throw new Error(`no such file: ${target}`);
  return { path: target, raw, content: raw, frontmatter: null };
}
function checkOrigin(supplied: AgentVaultSession): void {
  if (supplied.vaultPath !== origin.vaultPath || supplied.openingToken !== origin.openingToken) {
    throw new Error("Synthetic stale editor opening");
  }
}

beforeEach(async () => {
  vi.clearAllMocks();
  await useVaultStore.getState().reset();
  pendingDrafts.clear();
  root = `/synthetic-editor-${++serial}`;
  path = `${root}/wiki/note.md`;
  origin = { vaultPath: root, openingToken: `synthetic-opening-${serial}` };
  disk = new Map([[path, original]]);
  attempts = [];
  beforeWrite = undefined;
  afterWrite = undefined;
  receiptOverride = undefined;
  journal = new Map();
  snapshots = new Map();
  boundary.editorRecoverySupported.mockResolvedValue(true);
  boundary.readEditorDraft.mockImplementation(async (target: string, captured: AgentVaultSession) => {
    checkOrigin(captured);
    return journal.get(target) ?? null;
  });
  boundary.stageEditorDraft.mockImplementation(async (target: string, expected: string, content: string,
    captured: AgentVaultSession, expectedJournal: string | null) => {
    checkOrigin(captured);
    const previous = journal.get(target);
    if ((previous?.revision ?? null) !== expectedJournal) throw new Error("Synthetic journal conflict");
    const raw = snapshots.get(target)?.get(expected);
    if (raw === undefined) throw new Error("Synthetic registered baseline unavailable");
    const recovery: RecoveryDraft = { path: target, baselineRaw: raw, baselineRevision: expected,
      draftRaw: content, revision: (++journalSerial).toString(16).padStart(32, "0"), origin: { ...captured } };
    journal.set(target, recovery);
    return recovery;
  });
  boundary.retireEditorDraft.mockImplementation(async (target: string, captured: AgentVaultSession, expected: string) => {
    checkOrigin(captured);
    if (journal.get(target)?.revision !== expected) throw new Error("Synthetic journal retirement conflict");
    journal.delete(target);
  });
  useVaultStore.setState({
    currentVault: { path: root, name: "Synthetic editor" },
    vaultToken: `synthetic-ui-${serial}`,
    activeFile: null,
    isOpeningVault: false,
    isLoading: false,
    favorites: [],
    lastSavedAt: null,
    error: null,
  });
  useUIStore.setState({ route: `page:${path}`, navHistory: { entries: [`page:${path}`], idx: 0 } });
  boundary.agentVaultSession.mockImplementation(async () => ({ ...origin }));
  boundary.openVault.mockImplementation(async (target: string) => {
    origin = { vaultPath: target, openingToken: `${origin.openingToken}-reopened` };
    return { path: target, name: "Reopened synthetic editor" };
  });
  boundary.createFile.mockImplementation(async (parent: string, name: string) => {
    const target = `${parent}/${name}`;
    if (disk.has(target)) throw new Error("already exists: synthetic creation target");
    disk.set(target, "# Synthetic checked creation\n");
    return target;
  });
  boundary.readFile.mockImplementation(async (target: string) => file(target));
  // The RED must reach the existing destructive operation, not fail merely
  // because an additive IPC method has not been implemented yet.
  boundary.writeFile.mockImplementation(async (target: string, content: string) => {
    attempts.push({ path: target, content });
    await beforeWrite?.();
    disk.set(target, content);
    await afterWrite?.();
    return null;
  });
  boundary.readEditorFile.mockImplementation(async (target: string, captured: AgentVaultSession) => {
    checkOrigin(captured);
    const current = file(target);
    registerSnapshot(target, current.raw);
    return { file: current, origin: { ...captured }, revision: sha(current.raw) };
  });
  boundary.writeEditorFile.mockImplementation(async (
    target: string, content: string, expected: string, captured: AgentVaultSession,
  ) => {
    attempts.push({ path: target, content, expected, origin: { ...captured } });
    await beforeWrite?.();
    checkOrigin(captured);
    if (sha(file(target).raw) !== expected) throw new Error("write conflict: synthetic file changed before save");
    disk.set(target, content);
    registerSnapshot(target, content);
    const receipt = { path: target, origin: { ...captured }, revision: sha(content) };
    await afterWrite?.();
    return receiptOverride?.(receipt) ?? receipt;
  });
  const move = async (from: string, destination: string): Promise<string> => {
    disk.set(destination, file(from).raw);
    disk.delete(from);
    return destination;
  };
  boundary.renamePath.mockImplementation((from: string, name: string) => move(from, `${root}/wiki/${name}`));
  boundary.movePath.mockImplementation((from: string, directory: string) => move(from, `${directory}/note.md`));
});

describe("editor reopening and creation boundaries", () => {
  it.each(["same-root", "other-vault"] as const)("preserves a first-opening draft through actual reset and %s reopen", async (scope) => {
    await useVaultStore.getState().openFile(path);
    const firstOrigin = { ...origin };
    pendingDrafts.set(path, draft);
    await useVaultStore.getState().reset();
    expect(pendingDrafts.get(path)).toBe(draft);
    const nextRoot = scope === "same-root" ? root : `${root}-other`;
    await useVaultStore.getState().openVault(nextRoot);
    expect(useVaultStore.getState().currentVault?.path).toBe(nextRoot);
    expect(origin.openingToken).not.toBe(firstOrigin.openingToken);
    if (scope === "same-root") {
      disk.set(path, outsideEdit);
      // A successful fresh read must not attach the old draft to the new origin.
      expect(await useVaultStore.getState().openFile(path)).toBeNull();
    }
    expect(await useVaultStore.getState().saveFile(path, draft)).toBe(false);
    expect(attempts).toHaveLength(0);
    expect(useVaultStore.getState().error).toBeNull();
    expect(disk.get(path)).toBe(scope === "same-root" ? outsideEdit : original);
    expect(pendingDrafts.get(path)).toBe(draft);
  });

  it("keeps an unsent draft without a baseline when reopening and refuses automatic rebinding", async () => {
    pendingDrafts.set(path, draft);
    await useVaultStore.getState().reset();
    await useVaultStore.getState().openVault(root);
    expect(await useVaultStore.getState().openFile(path)).toContain("baseline unavailable");
    expect(await useVaultStore.getState().saveFile(path, draft)).toBe(false);
    expect(attempts).toHaveLength(0);
    expect(disk.get(path)).toBe(original);
    expect(pendingDrafts.get(path)).toBe(draft);
  });

  it("admits a created note by its first native read before saving it", async () => {
    const created = await useVaultStore.getState().createFile(`${root}/wiki`, "created.md");
    expect(created).toBe(`${root}/wiki/created.md`);
    const seeded = disk.get(created!);
    expect(seeded).toBe("# Synthetic checked creation\n");
    expect(await useVaultStore.getState().openFile(created!)).toBeNull();
    pendingDrafts.set(created!, draft);
    expect(await useVaultStore.getState().saveFile(created!, draft)).toBe(true);
    expect(attempts[0]).toMatchObject({ path: created, expected: sha(seeded!), origin });
    expect(disk.get(created!)).toBe(draft);
    expect(pendingDrafts.has(created!)).toBe(false);
  });

  it("preserves direct save content when its persisted receipt arrives after actual reset", async () => {
    await useVaultStore.getState().openFile(path);
    const held = deferred<void>();
    afterWrite = () => held.promise;
    const saving = useVaultStore.getState().saveFile(path, draft);
    await vi.waitFor(() => expect(disk.get(path)).toBe(draft));
    await useVaultStore.getState().reset();
    await useVaultStore.getState().openVault(root);
    held.resolve();
    expect(await saving).toBe(false);
    expect(useVaultStore.getState()).toMatchObject({ activeFile: null, error: null, lastSavedAt: null });
    expect(pendingDrafts.get(path)).toBe(draft);
    expect(disk.get(path)).toBe(draft);
  });
});

describe("native editor baseline and save receipts", () => {
  it("refuses a save with no admitted first read without rereading to bypass its missing baseline", async () => {
    pendingDrafts.set(path, draft);
    const saved = await useVaultStore.getState().saveFile(path, draft);
    expect(saved).toBe(false);
    expect(attempts).toHaveLength(0);
    expect(boundary.readEditorFile).not.toHaveBeenCalled();
    expect(disk.get(path)).toBe(original);
    expect(pendingDrafts.get(path)).toBe(draft);
  });

  it("preserves disk B when a draft based on read A conflicts", async () => {
    expect(await useVaultStore.getState().openFile(path)).toBeNull();
    disk.set(path, outsideEdit);
    pendingDrafts.set(path, draft);
    const saved = await useVaultStore.getState().saveFile(path, draft);
    expect(attempts).toHaveLength(1);
    expect(saved).toBe(false);
    expect(disk.get(path)).toBe(outsideEdit);
    expect(pendingDrafts.get(path)).toBe(draft);
    expect(useVaultStore.getState().activeFile?.raw).toBe(original);
    expect(useVaultStore.getState().lastSavedAt).toBeNull();
    expect(useVaultStore.getState().error).toContain("conflict");
    expect(attempts[0]).toMatchObject({ expected: sha(original), origin });
  });

  it("does not refresh a dirty draft's baseline through reread or navigation", async () => {
    await useVaultStore.getState().openFile(path);
    pendingDrafts.set(path, draft);
    disk.set(path, outsideEdit);
    await useVaultStore.getState().openFile(path);
    const other = `${root}/wiki/other.md`;
    disk.set(other, "# Other synthetic note\n");
    await useVaultStore.getState().openFile(other);
    await useVaultStore.getState().openFile(path);
    const saved = await useVaultStore.getState().saveFile(path, draft);
    expect(attempts).toHaveLength(1);
    expect(saved).toBe(false);
    expect(attempts[0].expected).toBe(sha(original));
    expect(disk.get(path)).toBe(outsideEdit);
    expect(pendingDrafts.get(path)).toBe(draft);
  });

  it("keeps the first baseline after a conflict for every already queued save", async () => {
    await useVaultStore.getState().openFile(path);
    const held = deferred<void>();
    beforeWrite = () => held.promise;
    pendingDrafts.set(path, draft);
    const first = useVaultStore.getState().saveFile(path, draft);
    await vi.waitFor(() => expect(attempts).toHaveLength(1));
    pendingDrafts.set(path, newer);
    const next = useVaultStore.getState().saveFile(path, newer);
    disk.set(path, outsideEdit);
    held.resolve();
    const results = await Promise.all([first, next]);
    expect(attempts).toHaveLength(2);
    expect(results).toEqual([false, false]);
    expect(attempts.map((attempt) => attempt.expected)).toEqual([sha(original), sha(original)]);
    expect(disk.get(path)).toBe(outsideEdit);
    expect(pendingDrafts.get(path)).toBe(newer);
  });

  it("advances a queued save only from its own accepted write receipt", async () => {
    await useVaultStore.getState().openFile(path);
    const held = deferred<void>();
    beforeWrite = () => held.promise;
    pendingDrafts.set(path, draft);
    const first = useVaultStore.getState().saveFile(path, draft);
    await vi.waitFor(() => expect(attempts).toHaveLength(1));
    pendingDrafts.set(path, newer);
    const next = useVaultStore.getState().saveFile(path, newer);
    held.resolve();
    expect(await Promise.all([first, next])).toEqual([true, true]);
    expect(attempts.map((attempt) => attempt.expected)).toEqual([sha(original), sha(draft)]);
    expect(attempts.every((attempt) => attempt.origin?.openingToken === origin.openingToken)).toBe(true);
    expect(disk.get(path)).toBe(newer);
    expect(pendingDrafts.has(path)).toBe(false);
  });

  it.each(["path", "origin"] as const)("rejects a persisted write's mismatching %s receipt without advancing baseline", async (mismatch) => {
    await useVaultStore.getState().openFile(path);
    receiptOverride = (receipt) => mismatch === "path"
      ? { ...receipt, path: `${root}/wiki/unrelated.md` }
      : { ...receipt, origin: { ...origin, openingToken: "synthetic-wrong-opening" } };
    pendingDrafts.set(path, draft);
    const saved = await useVaultStore.getState().saveFile(path, draft);
    expect(attempts).toHaveLength(1);
    expect(disk.get(path)).toBe(draft);
    expect(saved).toBe(false);
    expect(pendingDrafts.get(path)).toBe(draft);
    expect(useVaultStore.getState().activeFile?.raw).toBe(original);
    receiptOverride = undefined;
    expect(await useVaultStore.getState().saveFile(path, newer)).toBe(false);
    expect(attempts[1].expected).toBe(sha(original));
    expect(disk.get(path)).toBe(draft);
  });

  it.each(["rename", "move"] as const)("retargets a dirty draft's original baseline after %s without rereading changed bytes", async (operation) => {
    // Preserve legacy CAS coverage on platforms without durable recovery.
    boundary.editorRecoverySupported.mockResolvedValue(false);
    await useVaultStore.getState().openFile(path);
    pendingDrafts.set(path, draft);
    disk.set(path, outsideEdit);
    const destination = operation === "rename" ? `${root}/wiki/renamed.md` : `${root}/notes/note.md`;
    if (operation === "rename") await useVaultStore.getState().renamePath(path, "renamed.md");
    else await useVaultStore.getState().movePaths([path], `${root}/notes`);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ path: destination, expected: sha(original), origin });
    expect(disk.has(path)).toBe(false);
    expect(disk.get(destination)).toBe(outsideEdit);
    expect(pendingDrafts.get(destination)).toBe(draft);
    expect(useVaultStore.getState().activeFile).toMatchObject({ path: destination, raw: original });
  });

  it.each(["same-root", "other-vault"] as const)("rejects an old opening's delayed result after %s opens", async (scope) => {
    await useVaultStore.getState().openFile(path);
    const held = deferred<void>();
    afterWrite = () => held.promise;
    pendingDrafts.set(path, draft);
    const saving = useVaultStore.getState().saveFile(path, draft);
    await vi.waitFor(() => expect(disk.get(path)).toBe(draft));
    origin = { ...origin, openingToken: "synthetic-reopened-native" };
    const nextRoot = scope === "same-root" ? root : "/synthetic-other-editor";
    const reopened = { path: `${nextRoot}/wiki/note.md`, raw: outsideEdit, content: outsideEdit, frontmatter: null };
    useVaultStore.setState({ currentVault: { path: nextRoot, name: "Reopened synthetic" }, vaultToken: "synthetic-reopened-ui", activeFile: reopened, lastSavedAt: null, error: null });
    held.resolve();
    expect(await saving).toBe(false);
    expect(useVaultStore.getState().activeFile).toBe(reopened);
    expect(useVaultStore.getState().lastSavedAt).toBeNull();
    expect(useVaultStore.getState().error).toBeNull();
    expect(pendingDrafts.get(path)).toBe(draft);
  });
});
