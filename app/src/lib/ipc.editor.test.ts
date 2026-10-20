// Serialization only: synthetic DTOs cannot establish native editor authority.
import { beforeEach, expect, it, vi } from "vitest";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { ipc, type EditorFileSnapshot, type EditorWriteReceipt } from "./ipc";

const origin = {
  vaultPath: "/synthetic-editor",
  openingToken: "synthetic-editor-opening",
};
const path = `${origin.vaultPath}/wiki/note.md`;
const revision = "a".repeat(64);
beforeEach(() => invoke.mockReset());

it("passes the original opening to editor read and preserves the exact raw/revision response", async () => {
  const snapshot: EditorFileSnapshot = {
    file: {
      path,
      raw: "---\ntitle: Synthetic\n---\nBody.\n",
      content: "Body.\n",
      frontmatter: { title: "Synthetic" },
    },
    origin,
    revision,
  };
  invoke.mockResolvedValue(snapshot);
  expect(await ipc.readEditorFile(path, origin)).toBe(snapshot);
  expect(invoke).toHaveBeenCalledWith("read_editor_file", { path, origin });
});

it("requires and forwards the first-read SHA and captured opening to conditional editor save", async () => {
  const receipt: EditorWriteReceipt = {
    path,
    origin,
    revision: "b".repeat(64),
  };
  invoke.mockResolvedValue(receipt);
  expect(
    await ipc.writeEditorFile(
      path,
      "Synthetic edited raw.\n",
      revision,
      origin,
    ),
  ).toBe(receipt);
  expect(invoke).toHaveBeenCalledWith("write_editor_file", {
    path,
    content: "Synthetic edited raw.\n",
    expectedSha256: revision,
    origin,
  });
});
