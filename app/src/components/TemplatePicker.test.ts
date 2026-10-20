import { beforeEach, describe, expect, it, vi } from "vitest";
import { newNoteFromTemplate } from "./TemplatePicker";
import { ipc } from "../lib/ipc";
import { STRINGS } from "../lib/i18n";
import { useDialogStore } from "../stores/dialogStore";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";

/** Answer the dialog of `kind` once it opens (each opens after an await). */
async function answer(kind: "pick" | "prompt", value: string | null): Promise<void> {
  await vi.waitFor(() => expect(useDialogStore.getState().request?.kind).toBe(kind));
  useDialogStore.getState().close(value);
}

describe("newNoteFromTemplate", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useVaultStore.setState({ currentVault: { path: "/v", name: "v" }, fileTree: [], adjacency: null });
    useUIStore.setState({ route: "overview" });
    vi.spyOn(ipc, "buildLinkGraph").mockResolvedValue({
      forward: {},
      backward: {},
      unresolved: {},
      tags: {},
    } as never);
    vi.spyOn(ipc, "listFiles").mockResolvedValue([] as never);
    vi.spyOn(ipc, "createFolder").mockResolvedValue("/v/wiki" as never);
  });

  // The ⌘K "Quote in note" pick waits on this: a note made here is the pick.
  it("resolves to the note it made", async () => {
    vi.spyOn(ipc, "readFile").mockResolvedValue({ raw: "# {{title}}\n" } as never);
    vi.spyOn(ipc, "createFile").mockResolvedValue("/v/wiki/Plan.md");
    vi.spyOn(ipc, "writeFile").mockResolvedValue(null);
    const made = newNoteFromTemplate(STRINGS.en);
    await answer("pick", "/v/templates/note.md");
    await answer("prompt", "Plan");
    expect(await made).toBe("/v/wiki/Plan.md");
  });

  it("resolves to null when either dialog is cancelled", async () => {
    const atPick = newNoteFromTemplate(STRINGS.en);
    await answer("pick", null);
    expect(await atPick).toBeNull();

    const atName = newNoteFromTemplate(STRINGS.en);
    await answer("pick", "/v/templates/note.md");
    await answer("prompt", null);
    expect(await atName).toBeNull();
  });
});
