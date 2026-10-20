import { beforeEach, expect, it, vi } from "vitest";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { ipc, type ArchiveOptions } from "./ipc";
import { roleFixture } from "./modelRoles.testSupport";

const origin = { vaultPath: "/synthetic", openingToken: "synthetic-opening" };
const publication = { path: "daily/2026-08-10.md", revision: "a".repeat(64), created: true };
const options: ArchiveOptions = { origin, manifestId: "llm-123", publications: [publication], publicationIds: ["b".repeat(64)] };
beforeEach(() => invoke.mockReset().mockResolvedValue(null));

it("serializes the native issuer contract rather than an arbitrary target path", async () => {
  const roleSnapshot = roleFixture("organization", "builtin-local", undefined, origin);
  await ipc.publishDistillNote(origin, "llm-123", { kind: "daily", key: "2026-08-10" }, "synthetic body", null, roleSnapshot);
  expect(invoke).toHaveBeenCalledWith("publish_distill_note", { origin, operationId: "llm-123", artifact: { kind: "daily", key: "2026-08-10" }, content: "synthetic body", expectedSha256: null, roleSnapshot });
});

it("does not issue managed publication without its captured organization grant", async () => {
  await expect(ipc.publishDistillNote(origin, "llm-123", { kind: "daily", key: "2026-08-10" }, "body", null)).rejects.toThrow("role snapshot");
  expect(invoke).not.toHaveBeenCalled();
});

it("does not invoke an issuer with a missing opening token", async () => {
  await expect(ipc.publishDistillNote({ ...origin, openingToken: "" }, "llm-123", { kind: "map", key: "synthetic" }, "body", null)).rejects.toThrow("opening identity");
  expect(invoke).not.toHaveBeenCalled();
});

it("forwards opaque publication identities on both archive adapters", async () => {
  await ipc.archiveDigestedSessions(origin.vaultPath, "2026-08-10", [], [], options);
  await ipc.archiveRolled(origin.vaultPath, "weekly", "2026-W33", [], [], options);
  for (const call of invoke.mock.calls) expect(call[1]).toMatchObject(options);
  expect(invoke.mock.calls.map(call => call[0])).toEqual(["archive_digested_sessions", "archive_rolled"]);
});

it("rejects SHA-only archive options before any native mutation", async () => {
  await expect(ipc.archiveDigestedSessions(origin.vaultPath, "2026-08-10", [], [], { ...options, publicationIds: [] })).rejects.toThrow("manual recovery");
  await expect(ipc.archiveRolled(origin.vaultPath, "weekly", "2026-W33", [], [], { ...options, origin: { ...origin, openingToken: "" } })).rejects.toThrow("manual recovery");
  expect(invoke).not.toHaveBeenCalled();
});

it("requires native IDs when appending created-note claims", async () => {
  await expect(ipc.appendDistillManifest(origin.vaultPath, "llm-123", [], [publication.path], origin, [publication])).rejects.toThrow("manual recovery");
  expect(invoke).not.toHaveBeenCalled();
  await ipc.appendDistillManifest(origin.vaultPath, "llm-123", [], [publication.path], origin, [publication], options.publicationIds);
  expect(invoke).toHaveBeenCalledWith("append_distill_manifest", { vault: origin.vaultPath, id: "llm-123", moves: [], created: [publication.path], origin, createdRevisions: [publication], publicationIds: options.publicationIds });
});

it("captures the opening before undo and supplies it to the native authority guard", async () => {
  invoke.mockResolvedValueOnce(origin).mockResolvedValueOnce(1);
  expect(await ipc.undoDistillRun(origin.vaultPath, "llm-123")).toBe(1);
  expect(invoke.mock.calls).toEqual([["agent_vault_session", {}], ["undo_distill_run", { vault: origin.vaultPath, id: "llm-123", origin }]]);
});

it("does not dispatch undo after an opening mismatch", async () => {
  invoke.mockResolvedValueOnce({ vaultPath: "/other", openingToken: "synthetic-other" });
  await expect(ipc.undoDistillRun(origin.vaultPath, "llm-123")).rejects.toThrow("manual recovery");
  expect(invoke.mock.calls).toEqual([["agent_vault_session", {}]]);
});
