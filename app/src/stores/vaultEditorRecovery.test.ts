// Synthetic recovery regressions. No fixture can issue native authority.
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentVaultSession,
  EditorFileSnapshot,
  FileContent,
  RecoveryDraft,
} from "../lib/ipc";

const boundary = vi.hoisted(() => ({
  closeVault: vi.fn().mockResolvedValue(undefined),
  openVault: vi.fn(),
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
  buildLinkGraph: vi
    .fn()
    .mockResolvedValue({ forward: {}, backward: {}, unresolved: {}, tags: {} }),
  recordPageOpen: vi.fn().mockResolvedValue(null),
  renamePath: vi.fn(),
  saveFavorites: vi.fn().mockResolvedValue(null),
}));
vi.mock("../lib/ipc", () => ({ ipc: boundary }));

import { pendingDrafts, useVaultStore } from "./vaultStore";
import { useUIStore } from "./uiStore";

// The initial RED is the absent recovery capability, not a fake unsafe
// recovery implementation. Negative cases must not pass on that TypeError.
type RecoveryState = ReturnType<typeof useVaultStore.getState> & {
  recoverEditorFile: (
    path: string,
    expectedDraft: string | undefined,
    isCurrent: () => boolean,
  ) => Promise<FileContent>;
};
function recoveryAction(): RecoveryState["recoverEditorFile"] {
  const recover = (useVaultStore.getState() as RecoveryState).recoverEditorFile;
  expect(recover).toBeTypeOf("function");
  return recover;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const original = "# Synthetic recovery\n\nOriginal A.\n";
const external = "# Synthetic recovery\n\nExternal B.\n";
const third = "# Synthetic recovery\n\nExternal C.\n";
const draft = "# Synthetic recovery\n\nDraft A.\n";
const merged = "# Synthetic recovery\n\nManually merged M.\n";
let serial = 0;
let root: string;
let path: string;
let origin: AgentVaultSession;
let disk: Map<string, string>;
let persistedWrites: number;
let attempts: { path: string; expected: string; origin: AgentVaultSession }[];
let originGate: Promise<void> | undefined;
let readGate: Promise<void> | undefined;
let writeGate: Promise<void> | undefined;
let renameGate: Promise<void> | undefined;
let snapshotOverride:
  | ((snapshot: EditorFileSnapshot) => EditorFileSnapshot)
  | undefined;
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
function checkOrigin(captured: AgentVaultSession): void {
  if (
    captured.vaultPath !== origin.vaultPath ||
    captured.openingToken !== origin.openingToken
  ) {
    throw new Error("Synthetic stale recovery opening");
  }
}
async function conflictDraft(): Promise<void> {
  expect(await useVaultStore.getState().openFile(path)).toBeNull();
  disk.set(path, external);
  pendingDrafts.set(path, draft);
  boundary.readEditorFile.mockClear();
  boundary.agentVaultSession.mockClear();
}
async function assertOriginalBaseline(): Promise<void> {
  expect(await useVaultStore.getState().saveFile(path, merged)).toBe(false);
  expect(attempts.at(-1)).toMatchObject({ path, expected: sha(original) });
  expect(disk.get(path)).toBe(external);
}

beforeEach(async () => {
  vi.clearAllMocks();
  await useVaultStore.getState().reset();
  pendingDrafts.clear();
  root = `/synthetic-recovery-${++serial}`;
  path = `${root}/wiki/note.md`;
  origin = { vaultPath: root, openingToken: `synthetic-native-${serial}` };
  disk = new Map([[path, original]]);
  persistedWrites = 0;
  attempts = [];
  originGate = readGate = writeGate = renameGate = undefined;
  snapshotOverride = undefined;
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
    if ((journal.get(target)?.revision ?? null) !== expectedJournal) throw new Error("Synthetic journal conflict");
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
    currentVault: { path: root, name: "Synthetic recovery" },
    vaultToken: `synthetic-ui-${serial}`,
    activeFile: null,
    isLoading: false,
    isOpeningVault: false,
    error: null,
    favorites: [],
    lastSavedAt: null,
  });
  useUIStore.setState({
    route: `page:${path}`,
    splitRoute: null,
    navHistory: { entries: [`page:${path}`], idx: 0 },
  });
  boundary.agentVaultSession.mockImplementation(async () => {
    const captured = { ...origin };
    await originGate;
    return captured;
  });
  boundary.openVault.mockImplementation(async (target: string) => {
    origin = {
      vaultPath: target,
      openingToken: `${origin.openingToken}-reopened`,
    };
    return { path: target, name: "Reopened synthetic recovery" };
  });
  boundary.readFile.mockImplementation(async (target: string) => file(target));
  boundary.writeFile.mockImplementation(
    async (target: string, content: string) => {
      persistedWrites++;
      disk.set(target, content);
      return null;
    },
  );
  boundary.readEditorFile.mockImplementation(
    async (target: string, captured: AgentVaultSession) => {
      checkOrigin(captured);
      const current = file(target);
      registerSnapshot(target, current.raw);
      const snapshot = {
        file: current,
        origin: { ...captured },
        revision: sha(current.raw),
      };
      await readGate;
      // Deliberately allow a held old DTO through: FE ownership must reject it.
      return snapshotOverride?.(snapshot) ?? snapshot;
    },
  );
  boundary.writeEditorFile.mockImplementation(
    async (
      target: string,
      content: string,
      expected: string,
      captured: AgentVaultSession,
    ) => {
      attempts.push({ path: target, expected, origin: { ...captured } });
      await writeGate;
      checkOrigin(captured);
      if (target.startsWith(`${root}/raw/`))
        throw new Error("refused: raw/ is immutable");
      if (sha(file(target).raw) !== expected)
        throw new Error("write conflict: synthetic bytes changed");
      disk.set(target, content);
      registerSnapshot(target, content);
      persistedWrites++;
      return { path: target, origin: { ...captured }, revision: sha(content) };
    },
  );
  boundary.renamePath.mockImplementation(async (from: string, name: string) => {
    await renameGate;
    const destination = `${root}/wiki/${name}`;
    disk.set(destination, file(from).raw);
    disk.delete(from);
    return destination;
  });
});

describe("explicit editor recovery admission", () => {
  it("reads B and clears only the confirmed draft without a disk write", async () => {
    const recover = recoveryAction();
    await conflictDraft();
    const current = vi.fn(() => true);
    const loaded = await recover(path, draft, current);
    expect(loaded).toEqual(file(path));
    expect(loaded.raw).toBe(external);
    expect(boundary.readEditorFile).toHaveBeenCalledTimes(1);
    expect(boundary.readEditorFile).toHaveBeenCalledWith(path, origin);
    expect(current).toHaveBeenCalled();
    expect(pendingDrafts.has(path)).toBe(false);
    expect(useVaultStore.getState().activeFile).toEqual(loaded);
    expect(useVaultStore.getState().lastSavedAt).toBeNull();
    expect(boundary.writeEditorFile).not.toHaveBeenCalled();
    expect(boundary.writeFile).not.toHaveBeenCalled();
    expect(persistedWrites).toBe(0);
    expect(disk.get(path)).toBe(external);
  });

  it("uses SHA(B) for a manually merged draft only after explicit recovery", async () => {
    const recover = recoveryAction();
    await conflictDraft();
    await recover(path, draft, () => true);
    pendingDrafts.set(path, merged);
    expect(await useVaultStore.getState().saveFile(path, merged)).toBe(true);
    expect(attempts).toEqual([{ path, expected: sha(external), origin }]);
    expect(disk.get(path)).toBe(merged);
    expect(pendingDrafts.has(path)).toBe(false);
    expect(persistedWrites).toBe(1);
  });

  it("preserves third-party C and manual draft M after a post-recovery conflict", async () => {
    const recover = recoveryAction();
    await conflictDraft();
    await recover(path, draft, () => true);
    disk.set(path, third);
    pendingDrafts.set(path, merged);
    expect(await useVaultStore.getState().saveFile(path, merged)).toBe(false);
    expect(attempts[0]).toMatchObject({ expected: sha(external), origin });
    expect(disk.get(path)).toBe(third);
    expect(pendingDrafts.get(path)).toBe(merged);
    expect(persistedWrites).toBe(0);
  });

  it.each([draft, undefined])(
    "can recover after an unreadable initial baseline with pending draft %s",
    async (expectedDraft) => {
      const recover = recoveryAction();
      boundary.readEditorFile.mockRejectedValueOnce(
        new Error("Synthetic initial read denied"),
      );
      expect(await useVaultStore.getState().openFile(path)).toContain(
        "initial read denied",
      );
      disk.set(path, external);
      if (expectedDraft !== undefined) pendingDrafts.set(path, expectedDraft);
      expect((await recover(path, expectedDraft, () => true)).raw).toBe(
        external,
      );
      expect(pendingDrafts.has(path)).toBe(false);
      pendingDrafts.set(path, merged);
      expect(await useVaultStore.getState().saveFile(path, merged)).toBe(true);
      expect(attempts[0]).toMatchObject({ expected: sha(external), origin });
    },
  );

  it("reads raw recovery text without enabling original writes", async () => {
    const recover = recoveryAction();
    const raw = `${root}/raw/original.md`;
    disk.set(raw, original);
    pendingDrafts.set(raw, draft);
    expect((await recover(raw, draft, () => true)).raw).toBe(original);
    expect(boundary.writeEditorFile).not.toHaveBeenCalled();
    expect(persistedWrites).toBe(0);
    pendingDrafts.set(raw, merged);
    expect(await useVaultStore.getState().saveFile(raw, merged)).toBe(false);
    expect(disk.get(raw)).toBe(original);
    expect(pendingDrafts.get(raw)).toBe(merged);
  });

  it("refuses the wrong confirmed draft or an already stale reader before native capture", async () => {
    const recover = recoveryAction();
    await conflictDraft();
    await expect(recover(path, merged, () => true)).rejects.toThrow();
    await expect(recover(path, draft, () => false)).rejects.toThrow();
    expect(boundary.agentVaultSession).not.toHaveBeenCalled();
    expect(boundary.readEditorFile).not.toHaveBeenCalled();
    expect(pendingDrafts.get(path)).toBe(draft);
    expect(persistedWrites).toBe(0);
    await assertOriginalBaseline();
  });

  it("rejects a foreign native opening without reading or replacing its baseline", async () => {
    const recover = recoveryAction();
    await conflictDraft();
    boundary.agentVaultSession.mockResolvedValueOnce({
      vaultPath: `${root}-foreign`,
      openingToken: "synthetic-foreign",
    });
    await expect(recover(path, draft, () => true)).rejects.toThrow();
    expect(boundary.readEditorFile).not.toHaveBeenCalled();
    expect(pendingDrafts.get(path)).toBe(draft);
    await assertOriginalBaseline();
  });
});

describe("recovery keeps the original baseline until an unchanged native read succeeds", () => {
  it("preserves its draft and baseline when native read fails", async () => {
    const recover = recoveryAction();
    await conflictDraft();
    const active = useVaultStore.getState().activeFile;
    boundary.readEditorFile.mockRejectedValueOnce(
      new Error("Synthetic recovery read denied"),
    );
    await expect(recover(path, draft, () => true)).rejects.toThrow(
      "recovery read denied",
    );
    expect(useVaultStore.getState().activeFile).toBe(active);
    expect(pendingDrafts.get(path)).toBe(draft);
    expect(persistedWrites).toBe(0);
    await assertOriginalBaseline();
  });

  it.each(["path", "origin", "revision"] as const)(
    "refuses an invalid native read %s receipt",
    async (mismatch) => {
      const recover = recoveryAction();
      await conflictDraft();
      const active = useVaultStore.getState().activeFile;
      snapshotOverride = (snapshot) =>
        mismatch === "path"
          ? {
              ...snapshot,
              file: { ...snapshot.file, path: `${root}/wiki/other.md` },
            }
          : mismatch === "origin"
            ? {
                ...snapshot,
                origin: { ...origin, openingToken: "synthetic-wrong-token" },
              }
            : { ...snapshot, revision: "malformed" };
      await expect(recover(path, draft, () => true)).rejects.toThrow();
      expect(boundary.readEditorFile).toHaveBeenCalledTimes(1);
      expect(useVaultStore.getState().activeFile).toBe(active);
      expect(pendingDrafts.get(path)).toBe(draft);
      expect(persistedWrites).toBe(0);
      await assertOriginalBaseline();
    },
  );

  it.each(["set", "delete", "clear"] as const)(
    "detects public draft A-to-C-to-A changes through Map.%s",
    async (mutation) => {
      const recover = recoveryAction();
      await conflictDraft();
      const held = deferred<void>();
      readGate = held.promise;
      const recovering = recover(path, draft, () => true);
      const rejected = expect(recovering).rejects.toThrow();
      await vi.waitFor(() =>
        expect(boundary.readEditorFile).toHaveBeenCalledTimes(1),
      );
      if (mutation === "set") pendingDrafts.set(path, merged);
      else if (mutation === "delete") pendingDrafts.delete(path);
      else pendingDrafts.clear();
      pendingDrafts.set(path, draft);
      held.resolve();
      await rejected;
      expect(pendingDrafts.get(path)).toBe(draft);
      expect(useVaultStore.getState().activeFile?.raw).toBe(original);
      expect(persistedWrites).toBe(0);
      await assertOriginalBaseline();
    },
  );

  it("does not invalidate recovery for another path's independent draft mutation", async () => {
    const recover = recoveryAction();
    await conflictDraft();
    const held = deferred<void>();
    readGate = held.promise;
    const recovering = recover(path, draft, () => true);
    await vi.waitFor(() =>
      expect(boundary.readEditorFile).toHaveBeenCalledTimes(1),
    );
    const other = `${root}/wiki/other.md`;
    pendingDrafts.set(other, merged);
    held.resolve();
    expect((await recovering).raw).toBe(external);
    expect(pendingDrafts.has(path)).toBe(false);
    expect(pendingDrafts.get(other)).toBe(merged);
    expect(persistedWrites).toBe(0);
  });

  it("checks reader ownership after native origin capture before requesting file bytes", async () => {
    const recover = recoveryAction();
    await conflictDraft();
    const held = deferred<void>();
    originGate = held.promise;
    let current = true;
    const recovering = recover(path, draft, () => current);
    const rejected = expect(recovering).rejects.toThrow();
    await vi.waitFor(() =>
      expect(boundary.agentVaultSession).toHaveBeenCalledTimes(1),
    );
    current = false;
    held.resolve();
    await rejected;
    expect(boundary.readEditorFile).not.toHaveBeenCalled();
    expect(pendingDrafts.get(path)).toBe(draft);
    expect(persistedWrites).toBe(0);
  });

  it.each(["reader", "navigation", "same-root-reopen"] as const)(
    "preserves its draft when %s invalidates a held read",
    async (scope) => {
      const recover = recoveryAction();
      await conflictDraft();
      const held = deferred<void>();
      readGate = held.promise;
      let current = true;
      const expectedRoute = `page:${path}`;
      const recovering = recover(
        path,
        draft,
        () => current && useUIStore.getState().route === expectedRoute,
      );
      const rejected = expect(recovering).rejects.toThrow();
      await vi.waitFor(() =>
        expect(boundary.readEditorFile).toHaveBeenCalledTimes(1),
      );
      if (scope === "reader") current = false;
      else if (scope === "navigation")
        useUIStore.getState().setRoute("overview");
      else await useVaultStore.getState().openVault(root);
      const active = useVaultStore.getState().activeFile;
      held.resolve();
      await rejected;
      expect(useVaultStore.getState().activeFile).toBe(active);
      expect(useVaultStore.getState().error).toBeNull();
      expect(pendingDrafts.get(path)).toBe(draft);
      expect(disk.get(path)).toBe(external);
      expect(persistedWrites).toBe(0);
    },
  );

  it("does not replace a newer normal openFile result", async () => {
    const recover = recoveryAction();
    await conflictDraft();
    const held = deferred<void>();
    readGate = held.promise;
    const recovering = recover(path, draft, () => true);
    const rejected = expect(recovering).rejects.toThrow();
    await vi.waitFor(() =>
      expect(boundary.readEditorFile).toHaveBeenCalledTimes(1),
    );
    readGate = undefined;
    const nextPath = `${root}/wiki/next.md`;
    disk.set(nextPath, "# Synthetic next note\n");
    expect(await useVaultStore.getState().openFile(nextPath)).toBeNull();
    const active = useVaultStore.getState().activeFile;
    held.resolve();
    await rejected;
    expect(useVaultStore.getState().activeFile).toBe(active);
    expect(pendingDrafts.get(path)).toBe(draft);
    expect(disk.get(path)).toBe(external);
  });
});

describe("recovery does not bypass native save or path mutation ownership", () => {
  it("refuses a pending save before native read admission", async () => {
    const recover = recoveryAction();
    await conflictDraft();
    const held = deferred<void>();
    writeGate = held.promise;
    const saving = useVaultStore.getState().saveFile(path, draft);
    await vi.waitFor(() => expect(attempts).toHaveLength(1));
    try {
      await expect(recover(path, draft, () => true)).rejects.toThrow();
      expect(boundary.readEditorFile).not.toHaveBeenCalled();
      expect(pendingDrafts.get(path)).toBe(draft);
    } finally {
      held.resolve();
      await saving;
    }
    expect(persistedWrites).toBe(0);
    expect(disk.get(path)).toBe(external);
  });

  it("refuses a save that starts while its recovery read is held", async () => {
    const recover = recoveryAction();
    await conflictDraft();
    const reading = deferred<void>();
    const writing = deferred<void>();
    readGate = reading.promise;
    writeGate = writing.promise;
    const recovering = recover(path, draft, () => true);
    const rejected = expect(recovering).rejects.toThrow();
    await vi.waitFor(() =>
      expect(boundary.readEditorFile).toHaveBeenCalledTimes(1),
    );
    const saving = useVaultStore.getState().saveFile(path, draft);
    await vi.waitFor(() => expect(attempts).toHaveLength(1));
    try {
      reading.resolve();
      await rejected;
      expect(pendingDrafts.get(path)).toBe(draft);
      expect(useVaultStore.getState().activeFile?.raw).toBe(original);
    } finally {
      writing.resolve();
      await saving;
    }
    expect(persistedWrites).toBe(0);
    expect(disk.get(path)).toBe(external);
  });

  it("refuses a pending path change before native read admission", async () => {
    // Keep the existing path-race admission contract on the legacy CAS branch.
    boundary.editorRecoverySupported.mockResolvedValue(false);
    const recover = recoveryAction();
    await conflictDraft();
    const held = deferred<void>();
    renameGate = held.promise;
    const renaming = useVaultStore.getState().renamePath(path, "renamed.md");
    await vi.waitFor(() =>
      expect(boundary.renamePath).toHaveBeenCalledTimes(1),
    );
    try {
      await expect(recover(path, draft, () => true)).rejects.toThrow();
      expect(boundary.readEditorFile).not.toHaveBeenCalled();
      expect(pendingDrafts.get(path)).toBe(draft);
    } finally {
      held.resolve();
      await renaming;
    }
    expect(disk.get(`${root}/wiki/renamed.md`)).toBe(external);
    expect(persistedWrites).toBe(0);
  });

  it("does not restore the old path when rename completes during a held recovery read", async () => {
    // Durable supported paths refuse this mutation before native rename.
    boundary.editorRecoverySupported.mockResolvedValue(false);
    const recover = recoveryAction();
    await conflictDraft();
    const held = deferred<void>();
    readGate = held.promise;
    const recovering = recover(path, draft, () => true);
    const rejected = expect(recovering).rejects.toThrow();
    await vi.waitFor(() =>
      expect(boundary.readEditorFile).toHaveBeenCalledTimes(1),
    );
    const destination = `${root}/wiki/renamed.md`;
    expect(await useVaultStore.getState().renamePath(path, "renamed.md")).toBe(
      destination,
    );
    const active = useVaultStore.getState().activeFile;
    held.resolve();
    await rejected;
    expect(useVaultStore.getState().activeFile).toBe(active);
    expect(disk.has(path)).toBe(false);
    expect(disk.get(destination)).toBe(external);
    expect(pendingDrafts.has(path)).toBe(false);
    expect(pendingDrafts.get(destination)).toBe(draft);
    expect(attempts).toEqual([
      { path: destination, expected: sha(original), origin },
    ]);
    expect(persistedWrites).toBe(0);
  });
});

describe("recovery preserves an active ordinary read", () => {
  it("refuses admission without replacing the ordinary read or stranding its loading state", async () => {
    const recover = recoveryAction();
    await conflictDraft();
    const held = deferred<void>();
    readGate = held.promise;
    const reading = useVaultStore.getState().openFile(path);
    await vi.waitFor(() =>
      expect(boundary.readEditorFile).toHaveBeenCalledTimes(1),
    );
    const active = useVaultStore.getState().activeFile;
    try {
      await expect(recover(path, draft, () => true)).rejects.toThrow(
        "read is pending",
      );
      expect(boundary.readEditorFile).toHaveBeenCalledTimes(1);
      expect(useVaultStore.getState().activeFile).toBe(active);
      expect(useVaultStore.getState().isLoading).toBe(true);
      expect(pendingDrafts.get(path)).toBe(draft);
      expect(persistedWrites).toBe(0);
    } finally {
      held.resolve();
      expect(await reading).toBeNull();
    }
    expect(useVaultStore.getState().isLoading).toBe(false);
    expect(useVaultStore.getState().activeFile?.raw).toBe(external);
    expect(pendingDrafts.get(path)).toBe(draft);
    await assertOriginalBaseline();
  });
});
