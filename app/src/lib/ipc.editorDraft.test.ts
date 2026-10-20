// Synthetic serialization controls; these DTOs do not grant native authority.
import { beforeEach, expect, it, vi } from "vitest";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { ipc, type RecoveryDraft } from "./ipc";

const origin = { vaultPath: "/synthetic-draft", openingToken: "synthetic-opening" };
const path = `${origin.vaultPath}/wiki/note.md`;
const recovery: RecoveryDraft = { path, baselineRaw: "---\r\noriginal A\r\n", baselineRevision: "a".repeat(64),
  draftRaw: "", revision: "b".repeat(32), origin };
beforeEach(() => invoke.mockReset());

it("forwards exact draft, original SHA/opening and nullable journal precondition", async () => {
  invoke.mockResolvedValue(recovery);
  for (const expectedJournalRevision of [null, recovery.revision]) {
    expect(await ipc.stageEditorDraft(path, recovery.baselineRevision, "", origin, expectedJournalRevision)).toBe(recovery);
    expect(invoke).toHaveBeenLastCalledWith("stage_editor_draft", {
      path, expectedSha256: recovery.baselineRevision, draft: "", origin, expectedJournalRevision,
    });
  }
});

it("keeps recovered original provenance and forwards exact retirement nonce", async () => {
  const current = { ...origin, openingToken: "synthetic-current-opening" };
  invoke.mockResolvedValueOnce(recovery).mockResolvedValueOnce(undefined);
  expect(await ipc.readEditorDraft(path, current)).toBe(recovery);
  expect(invoke).toHaveBeenNthCalledWith(1, "read_editor_draft", { path, origin: current });
  await ipc.retireEditorDraft(path, current, recovery.revision);
  expect(invoke).toHaveBeenNthCalledWith(2, "retire_editor_draft", { path, origin: current, expectedJournalRevision: recovery.revision });
});

it("distinguishes actual native unsupported capability from an invocation failure", async () => {
  invoke.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("Synthetic native capability error"));
  expect(await ipc.editorRecoverySupported()).toBe(false);
  await expect(ipc.editorRecoverySupported()).rejects.toThrow("capability error");
  expect(invoke).toHaveBeenCalledWith("editor_recovery_supported");
});
