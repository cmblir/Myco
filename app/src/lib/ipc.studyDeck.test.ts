// IPC serialization only; public synthetic DTOs do not establish native custody.
import { beforeEach, expect, it, vi } from "vitest";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { ipc } from "./ipc";

const origin = { vaultPath: "/synthetic-study", openingToken: "synthetic-opening" };
const path = `${origin.vaultPath}/cards/deck.md`;
const context = { snapshotId: "synthetic-snapshot", origin, path };
beforeEach(() => invoke.mockReset());

it("forwards the initial opening and exact deck path to the native read", async () => {
  const snapshot = { context, raw: "", revision: null };
  invoke.mockResolvedValue(snapshot);
  expect(await ipc.readStudyDeck(path, origin)).toBe(snapshot);
  expect(invoke).toHaveBeenCalledWith("read_study_deck", { path, origin });
});

it("forwards only the issued context and exact patched bytes to native publication", async () => {
  const content = "# Synthetic human heading\r\n\r\nQuestion ?? Answer\r\n";
  const receipt = { path, origin, state: "partial", revision: null, error: "Synthetic checkpoint failed" };
  invoke.mockResolvedValue(receipt);
  expect(await ipc.writeStudyDeck(context, content)).toBe(receipt);
  expect(invoke).toHaveBeenCalledWith("write_study_deck", { context, content });
});

it("releases the exact issued snapshot without manufacturing a new origin", async () => {
  invoke.mockResolvedValue(false);
  expect(await ipc.discardStudyDeckSnapshot(context)).toBe(false);
  expect(invoke).toHaveBeenCalledWith("discard_study_deck_snapshot", { context });
});
