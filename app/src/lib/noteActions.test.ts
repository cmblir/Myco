import { beforeEach, describe, expect, it, vi } from "vitest";
import { deleteNotes, renameNote } from "./noteActions";
import { STRINGS } from "./i18n";
import { useDialogStore } from "../stores/dialogStore";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import { useSettingsStore } from "../stores/settingsStore";

const t = STRINGS.ko;

/** Answer the dialog of `kind` once it opens. */
async function answer(kind: "confirm" | "prompt", value: string | null): Promise<void> {
  await vi.waitFor(() => expect(useDialogStore.getState().request?.kind).toBe(kind));
  useDialogStore.getState().close(value);
}

describe("deleteNotes", () => {
  const deletePath = vi.fn(async () => undefined);
  beforeEach(() => {
    deletePath.mockClear();
    useSettingsStore.setState({ settings: { permanent_delete: false } as never, loading: false, saving: false });
    useVaultStore.setState({ currentVault: { path: "/v", name: "v" } as never, deletePath, error: null });
    useUIStore.setState({ route: "page:/v/wiki/a.md" });
  });

  it("asks first, then trashes", async () => {
    const done = deleteNotes(["/v/wiki/a.md"], t);
    expect(useDialogStore.getState().request?.danger).toBe(true);
    await answer("confirm", "ok");
    expect(await done).toBe(true);
    expect(deletePath).toHaveBeenCalledWith(["/v/wiki/a.md"], false);
  });

  it("warns about irreversible deletion when the permanent policy is enabled", async () => {
    useSettingsStore.setState({ settings: { permanent_delete: true } as never });
    const done = deleteNotes(["/v/wiki/a.md"], t);
    expect(useDialogStore.getState().request?.message).toContain("영구 삭제");
    expect(useDialogStore.getState().request?.message).toContain("복원할 수 없");
    await answer("confirm", null);
    expect(await done).toBe(false);
    expect(deletePath).not.toHaveBeenCalled();
  });

  it("refuses a confirmation while the policy save is pending", async () => {
    useSettingsStore.setState({ saving: true });
    expect(await deleteNotes(["/v/wiki/a.md"], t)).toBe(false);
    expect(deletePath).not.toHaveBeenCalled();
    expect(useVaultStore.getState().error).toBe(t.delete_policy_wait);
  });

  it("sends the policy shown by the confirmation even if another window changes it", async () => {
    useSettingsStore.setState({ settings: { permanent_delete: true } as never });
    const done = deleteNotes(["/v/wiki/a.md"], t);
    useSettingsStore.setState({ settings: { permanent_delete: false } as never });
    await answer("confirm", "ok");
    await done;
    expect(deletePath).toHaveBeenCalledWith(["/v/wiki/a.md"], true);
  });

  it("names a folder as a folder", async () => {
    const done = deleteNotes(["/v/wiki"], t, true);
    expect(useDialogStore.getState().request?.title).toBe(t.sb_delete_folder_q);
    await answer("confirm", "ok");
    await done;
  });

  it("leaves the deleted open note for Home", async () => {
    const done = deleteNotes(["/v/wiki/a.md"], t);
    await answer("confirm", "ok");
    await done;
    expect(useUIStore.getState().route).toBe("overview");
  });

  it("leaves for Home too when a folder holding the open note goes", async () => {
    const done = deleteNotes(["/v/other.md", "/v/wiki"], t);
    await answer("confirm", "ok");
    await done;
    expect(useUIStore.getState().route).toBe("overview");
  });

  it("stays on the open note when another one is deleted", async () => {
    const done = deleteNotes(["/v/wiki/ab.md", "/v/wiki/a"], t);
    await answer("confirm", "ok");
    await done;
    expect(useUIStore.getState().route).toBe("page:/v/wiki/a.md");
  });

  it("stays when the delete failed, so the reader can say so", async () => {
    deletePath.mockImplementationOnce(async () => {
      useVaultStore.setState({ error: "EACCES" });
    });
    const done = deleteNotes(["/v/wiki/a.md"], t);
    await answer("confirm", "ok");
    await done;
    expect(useUIStore.getState().route).toBe("page:/v/wiki/a.md");
  });

  it("does nothing on Cancel", async () => {
    const done = deleteNotes(["/v/wiki/a.md"], t);
    await answer("confirm", null);
    expect(await done).toBe(false);
    expect(deletePath).not.toHaveBeenCalled();
  });
});

describe("renameNote", () => {
  const renamePath = vi.fn(async () => "/v/wiki/b.md");
  beforeEach(() => {
    renamePath.mockClear();
    useVaultStore.setState({ renamePath });
  });

  it("offers the note's name and renames under a Rename button", async () => {
    const done = renameNote("/v/wiki/a.md", t);
    await vi.waitFor(() => expect(useDialogStore.getState().request?.kind).toBe("prompt"));
    const req = useDialogStore.getState().request;
    // The name as the tree and the header show it, without .md.
    expect(req?.defaultValue).toBe("a");
    expect(req?.message).toContain("“a”");
    expect(req?.confirmLabel).toBe(t.dlg_rename);
    useDialogStore.getState().close("b.md");
    await done;
    expect(renamePath).toHaveBeenCalledWith("/v/wiki/a.md", "b.md");
  });

  // A name typed the way the header reads keeps the note a note: without the
  // .md, list_files drops it and every rewritten [[link]] misses.
  it("keeps the .md when the new name has none", async () => {
    const done = renameNote("/v/wiki/attention-mechanism.md", t);
    await answer("prompt", "attention basics");
    await done;
    expect(renamePath).toHaveBeenCalledWith("/v/wiki/attention-mechanism.md", "attention basics.md");
  });

  it("does nothing for an unchanged name", async () => {
    for (const same of ["a.md", "a"]) {
      const done = renameNote("/v/wiki/a.md", t);
      await answer("prompt", same);
      await done;
    }
    expect(renamePath).not.toHaveBeenCalled();
  });

  it("renames a folder by its full name", async () => {
    const done = renameNote("/v/wiki/v2.0", t);
    await vi.waitFor(() => expect(useDialogStore.getState().request?.kind).toBe("prompt"));
    expect(useDialogStore.getState().request?.defaultValue).toBe("v2.0");
    useDialogStore.getState().close("v3");
    await done;
    expect(renamePath).toHaveBeenCalledWith("/v/wiki/v2.0", "v3");
  });
});
