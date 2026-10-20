// Browser demo memory only; no native file identity, disk receipt, or model run.
import { createHash } from "node:crypto";
import { beforeAll, beforeEach, expect, it } from "vitest";
import type { AgentVaultSession, StudyDeckSnapshot, StudyDeckWriteReceipt } from "./ipc";
import { installTauriMock } from "./devMock";

function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const surface = window as unknown as {
    __TAURI_INTERNALS__: { invoke: (name: string, args: unknown) => Promise<T> };
  };
  return surface.__TAURI_INTERNALS__.invoke(command, args);
}
const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");
let serial = 0;
let origin: AgentVaultSession;
let path: string;
beforeAll(() => {
  (globalThis as unknown as { window?: unknown }).window ??= globalThis;
  installTauriMock();
});
beforeEach(async () => {
  await invoke("open_vault", { path: "/myco" });
  origin = await invoke<AgentVaultSession>("agent_vault_session");
  path = `/myco/cards/synthetic-study-${++serial}.md`;
});

it("distinguishes a truly missing demo deck from an existing empty deck", async () => {
  const absent = await invoke<StudyDeckSnapshot>("read_study_deck", { path, origin });
  expect(absent).toMatchObject({ raw: "", revision: null, mockOnly: true });
  await invoke("write_file", { path, content: "" });
  const empty = await invoke<StudyDeckSnapshot>("read_study_deck", { path, origin });
  expect(empty).toMatchObject({ raw: "", revision: sha(""), mockOnly: true });
});

it("preserves exact submitted bytes and marks its successful receipt as mock only", async () => {
  const snapshot = await invoke<StudyDeckSnapshot>("read_study_deck", { path, origin });
  const content = "# Synthetic heading\r\n\r\nQ ?? A\r\n";
  const receipt = await invoke<StudyDeckWriteReceipt>("write_study_deck", { context: snapshot.context, content });
  expect(receipt).toEqual({ path, origin, state: "persisted", revision: sha(content), error: null, mockOnly: true });
  expect((await invoke<{ raw: string }>("read_file", { path })).raw).toBe(content);
  await expect(invoke("write_study_deck", { context: snapshot.context, content: "Changed" })).rejects.toThrow("SNAPSHOT");
});

it("refuses a competing read baseline without overwriting the first writer", async () => {
  const first = await invoke<StudyDeckSnapshot>("read_study_deck", { path, origin });
  const second = await invoke<StudyDeckSnapshot>("read_study_deck", { path, origin });
  await invoke("write_study_deck", { context: first.context, content: "First ?? Answer\n" });
  await expect(invoke("write_study_deck", { context: second.context, content: "Second ?? Answer\n" })).rejects.toThrow("conflict");
  expect((await invoke<{ raw: string }>("read_file", { path })).raw).toBe("First ?? Answer\n");
});

it("rejects forged context fields and stale openings", async () => {
  const snapshot = await invoke<StudyDeckSnapshot>("read_study_deck", { path, origin });
  await expect(invoke("write_study_deck", {
    context: { ...snapshot.context, path: "/myco/cards/forged.md" }, content: "Forged",
  })).rejects.toThrow("SNAPSHOT");
  await invoke("open_vault", { path: "/myco" });
  await expect(invoke("write_study_deck", { context: snapshot.context, content: "Stale" })).rejects.toThrow("OPENING");
  await expect(invoke("read_study_deck", { path, origin })).rejects.toThrow("OPENING");
});

it("releases only the matching issued snapshot and refuses paths outside direct decks", async () => {
  const snapshot = await invoke<StudyDeckSnapshot>("read_study_deck", { path, origin });
  expect(await invoke("discard_study_deck_snapshot", { context: snapshot.context })).toBe(true);
  expect(await invoke("discard_study_deck_snapshot", { context: snapshot.context })).toBe(false);
  await expect(invoke("write_study_deck", { context: snapshot.context, content: "Discarded" })).rejects.toThrow("SNAPSHOT");
  for (const outside of ["/myco/raw/deck.md", "/myco/cards/../outside.md", "/myco/cards/archive/deck.md", "/outside/cards/deck.md"]) {
    await expect(invoke("read_study_deck", { path: outside, origin })).rejects.toThrow("PATH");
  }
});
