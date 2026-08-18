import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNoteAndOpen, sanitizeNoteName } from "./newNote";
import { ipc } from "./ipc";
import { useVaultStore } from "../stores/vaultStore";
import { useUIStore } from "../stores/uiStore";

describe("sanitizeNoteName", () => {
  it("rejects empty and whitespace-only names", () => {
    expect(sanitizeNoteName("")).toBeNull();
    expect(sanitizeNoteName("   ")).toBeNull();
  });

  it("folds path separators so a name cannot escape its folder", () => {
    expect(sanitizeNoteName("a/b")).toBe("a-b");
    expect(sanitizeNoteName("a\\b")).toBe("a-b");
    expect(sanitizeNoteName("../etc")).toBe("-etc");
  });

  it("strips leading dots (no hidden files) and rejects dot-only names", () => {
    expect(sanitizeNoteName(".hidden")).toBe("hidden");
    expect(sanitizeNoteName("...")).toBeNull();
  });

  it("drops a typed .md suffix — create re-adds it", () => {
    expect(sanitizeNoteName("note.md")).toBe("note");
    expect(sanitizeNoteName("Note.MD")).toBe("Note");
  });

  it("passes unicode through untouched", () => {
    expect(sanitizeNoteName("어텐션 메커니즘")).toBe("어텐션 메커니즘");
  });
});

describe("createNoteAndOpen", () => {
  const VAULT = { path: "/v", name: "v" };
  const ADJ = { forward: {}, backward: {}, unresolved: {}, tags: {} };

  beforeEach(() => {
    vi.restoreAllMocks();
    useVaultStore.setState({
      currentVault: VAULT,
      fileTree: [],
      adjacency: null,
      error: null,
    });
    useUIStore.setState({ route: "overview" });
    vi.spyOn(ipc, "buildLinkGraph").mockResolvedValue(ADJ as never);
    vi.spyOn(ipc, "listFiles").mockResolvedValue([] as never);
    vi.spyOn(ipc, "createFolder").mockResolvedValue("/v/wiki" as never);
  });

  it("creates in wiki/ by default and routes into the editor", async () => {
    const create = vi
      .spyOn(ipc, "createFile")
      .mockResolvedValue("/v/wiki/아이디어.md");
    const p = await createNoteAndOpen("아이디어");
    expect(create).toHaveBeenCalledWith("/v/wiki", "아이디어.md");
    expect(p).toBe("/v/wiki/아이디어.md");
    expect(useUIStore.getState().route).toBe("page:/v/wiki/아이디어.md");
  });

  it("opens the existing note for a duplicate stem instead of erroring", async () => {
    useVaultStore.setState({
      fileTree: [
        { kind: "file", name: "attention.md", path: "/v/wiki/attention.md" },
      ] as never,
    });
    const create = vi.spyOn(ipc, "createFile");
    const p = await createNoteAndOpen("Attention");
    expect(create).not.toHaveBeenCalled();
    expect(p).toBe("/v/wiki/attention.md");
    expect(useUIStore.getState().route).toBe("page:/v/wiki/attention.md");
  });

  it("does nothing for a name that sanitizes to nothing", async () => {
    const create = vi.spyOn(ipc, "createFile");
    expect(await createNoteAndOpen("   ")).toBeNull();
    expect(await createNoteAndOpen("...")).toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(useUIStore.getState().route).toBe("overview");
  });

  it("targets an explicit folder (context-menu create)", async () => {
    const create = vi
      .spyOn(ipc, "createFile")
      .mockResolvedValue("/v/projects/x.md");
    await createNoteAndOpen("x", "/v/projects");
    expect(create).toHaveBeenCalledWith("/v/projects", "x.md");
    expect(useUIStore.getState().route).toBe("page:/v/projects/x.md");
  });
});
