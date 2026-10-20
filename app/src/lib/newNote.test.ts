import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createNoteAndOpen,
  promptNewNote,
  sanitizeNoteName,
  saveAsNewNote,
  shortDailyLine,
  shortNoteName,
} from "./newNote";
import { ipc } from "./ipc";
import { STRINGS } from "./i18n";
import { useVaultStore } from "../stores/vaultStore";
import { useUIStore } from "../stores/uiStore";
import { useDialogStore } from "../stores/dialogStore";
import { requestNoteWriting, takeNoteWritingRequest } from "./noteWriting";

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
    useUIStore.setState({ route: "overview", editorMode: "live" });
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

  // UX backlog S15: a new note lands beside the open one, not always in wiki/.
  it("creates beside the open note when its folder is mine", async () => {
    useUIStore.setState({ route: "page:/v/daily/2026-10-01.md" });
    const create = vi.spyOn(ipc, "createFile").mockResolvedValue("/v/daily/plan.md");
    await createNoteAndOpen("plan");
    expect(create).toHaveBeenCalledWith("/v/daily", "plan.md");
  });

  it("creates in wiki/ when the open note is in a folder myco manages", async () => {
    useUIStore.setState({ route: "page:/v/cards/attention-mechanism.md" });
    const create = vi.spyOn(ipc, "createFile").mockResolvedValue("/v/wiki/plan.md");
    await createNoteAndOpen("plan");
    expect(create).toHaveBeenCalledWith("/v/wiki", "plan.md");
  });

  it("creates in wiki/ when the open note sits at the vault root", async () => {
    useUIStore.setState({ route: "page:/v/welcome.md" });
    const create = vi.spyOn(ipc, "createFile").mockResolvedValue("/v/wiki/plan.md");
    await createNoteAndOpen("plan");
    expect(create).toHaveBeenCalledWith("/v/wiki", "plan.md");
  });

  it("keeps an explicit folder over the open note's", async () => {
    useUIStore.setState({ route: "page:/v/daily/2026-10-01.md" });
    const create = vi.spyOn(ipc, "createFile").mockResolvedValue("/v/projects/x.md");
    await createNoteAndOpen("x", "/v/projects");
    expect(create).toHaveBeenCalledWith("/v/projects", "x.md");
  });

  // The Read view ("preview") is gone (one editor); source is the mode left.
  it.each(["source"] as const)(
    "opens a newly created note ready to write after %s mode",
    async (editorMode) => {
      useUIStore.setState({ editorMode });
      vi.spyOn(ipc, "createFile").mockResolvedValue("/v/wiki/ready.md");

      await createNoteAndOpen("ready");

      expect(useUIStore.getState().editorMode).toBe("live");
      expect(useUIStore.getState().route).toBe("page:/v/wiki/ready.md");
      expect(takeNoteWritingRequest("/v/wiki/ready.md")).toBe(true);
      expect(takeNoteWritingRequest("/v/wiki/ready.md")).toBe(false);
    },
  );

  it("keeps the chosen mode when no note can be created", async () => {
    useUIStore.setState({ editorMode: "source" });
    useVaultStore.setState({ currentVault: null });
    requestNoteWriting("/v/previous.md");

    expect(await createNoteAndOpen("ready")).toBeNull();
    expect(useUIStore.getState().editorMode).toBe("source");
    expect(takeNoteWritingRequest("/v/previous.md")).toBe(true);
  });

  // The ⌘K "Quote in note" pick waits on this: a note made here is the pick.
  it("prompted, resolves to the note it opened, null when the name dialog is cancelled", async () => {
    vi.spyOn(ipc, "createFile").mockResolvedValue("/v/wiki/picked.md");
    const made = promptNewNote(STRINGS.en);
    useDialogStore.getState().close("picked");
    expect(await made).toBe("/v/wiki/picked.md");

    const cancelled = promptNewNote(STRINGS.en);
    useDialogStore.getState().close(null);
    expect(await cancelled).toBeNull();
  });
});

// UX S35: a short note the ingest judge turned away is kept as a note.
describe("shortNoteName", () => {
  it("takes the title, else the body's first line, cut to 40 characters", () => {
    expect(shortNoteName(" 회의 ", "본문")).toBe("회의");
    expect(shortNoteName("", "짧은 메모\n둘째 줄")).toBe("짧은 메모");
    expect(shortNoteName("", "가".repeat(50))).toBe("가".repeat(40));
    expect(shortNoteName("", "a/b")).toBe("a-b");
    expect(shortNoteName("", "  ")).toBeNull();
  });
});

// The daily path writes one line, so the title must ride along or it is lost.
describe("shortDailyLine", () => {
  it("joins the title and the body so nothing typed is dropped", () => {
    expect(shortDailyLine(" 장보기 ", "우유\n계란")).toBe("장보기 — 우유\n계란");
    expect(shortDailyLine("", " 메모 ")).toBe("메모");
    expect(shortDailyLine("제목만", "  ")).toBe("제목만");
  });
});

describe("saveAsNewNote", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useVaultStore.setState({ currentVault: { path: "/v", name: "v" }, fileTree: [] });
    useUIStore.setState({ route: "ingest" });
    vi.spyOn(ipc, "listFiles").mockResolvedValue([] as never);
    vi.spyOn(ipc, "createFolder").mockResolvedValue("/v/wiki" as never);
  });

  it("creates the note, keeps its seeded frontmatter, writes the text under it and opens it", async () => {
    vi.spyOn(ipc, "createFile").mockResolvedValue("/v/wiki/짧은 메모.md");
    vi.spyOn(ipc, "readFile").mockResolvedValue({ path: "", raw: "---\ntype: note\n---\n" } as never);
    const write = vi.spyOn(ipc, "writeFile").mockResolvedValue(undefined as never);

    expect(await saveAsNewNote("짧은 메모", "짧은 메모")).toBe("/v/wiki/짧은 메모.md");
    expect(write).toHaveBeenCalledWith("/v/wiki/짧은 메모.md", "---\ntype: note\n---\n짧은 메모\n");
    expect(useUIStore.getState().route).toBe("page:/v/wiki/짧은 메모.md");
  });

  it("never writes over a note that already has the name", async () => {
    // create_file refuses an existing file; the text must not land in it.
    vi.spyOn(ipc, "createFile").mockRejectedValue(new Error("already exists"));
    const write = vi.spyOn(ipc, "writeFile");
    await expect(saveAsNewNote("taken", "text")).rejects.toThrow("already exists");
    expect(write).not.toHaveBeenCalled();
  });
});
