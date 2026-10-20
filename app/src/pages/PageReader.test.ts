// What the reader shows before its note is in hand (node env): a read that
// failed is a missing note, never an endless "Loading…".
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readerView } from "./PageReader";
import { ipc } from "../lib/ipc";
import { pendingDrafts, useVaultStore } from "../stores/vaultStore";

describe("readerView", () => {
  const path = "/v/wiki/a.md";

  it("shows the note once the open file is this one", () => {
    expect(readerView(path, path, null)).toBe("ready");
  });

  it("is loading while the read is in flight", () => {
    expect(readerView(undefined, path, null)).toBe("loading");
    expect(readerView("/v/wiki/previous.md", path, null)).toBe("loading");
  });

  it("keeps an empty error distinct from successful or superseded reads", () => {
    expect(readerView(path, path, "")).toBe("unreadable");
    expect(readerView(undefined, path, undefined)).toBe("loading");
  });

  it("is missing when the read failed", () => {
    expect(readerView(undefined, path, "no such file: /v/wiki/a.md")).toBe("missing");
    expect(readerView("/v/wiki/previous.md", path, "no such file")).toBe("missing");
  });

  // vault.rs's own messages: canonicalize (confine_path or read_file) on a
  // gone path, and read_file on a folder.
  it("is missing only when the file is gone", () => {
    expect(
      readerView(undefined, path, "canonicalize failed for /v/wiki/a.md: No such file or directory (os error 2)"),
    ).toBe("missing");
    expect(readerView(undefined, path, "not a file: /v/wiki/a.md")).toBe("missing");
  });

  it("is unreadable when the note is there but cannot be opened", () => {
    expect(readerView(undefined, path, "file too large to open: 20000000 bytes (limit 16 MB)")).toBe(
      "unreadable",
    );
    expect(readerView(undefined, path, "read failed: stream did not contain valid UTF-8")).toBe(
      "unreadable",
    );
    expect(readerView(undefined, path, "path is outside the open vault")).toBe("unreadable");
    // ENOTDIR (os error 20) is not os error 2.
    expect(readerView(undefined, path, "read failed: Not a directory (os error 20)")).toBe("unreadable");
  });

  it.each([
    ["canonicalize failed for /v/wiki/a.md: No such file or directory (os error 2)", "missing"],
    ["read failed: Permission denied (os error 13)", "unreadable"],
  ] as const)("shows the current read's failure even when the same path is cached: %s", (error, view) => {
    expect(readerView(path, path, error)).toBe(view);
  });
});

describe("the reader's own read", () => {
  const path = "/v/daily/2001-01-01.md";
  beforeEach(() => {
    vi.restoreAllMocks();
    pendingDrafts.clear();
    useVaultStore.setState({ currentVault: { path: "/v", name: "Synthetic" }, isOpeningVault: false });
    const origin = { vaultPath: "/v", openingToken: "synthetic-reader" };
    vi.spyOn(ipc, "agentVaultSession").mockResolvedValue(origin);
    // These read-state fixtures do not simulate the native recovery journal.
    vi.spyOn(ipc, "editorRecoverySupported").mockResolvedValue(false);
    vi.spyOn(ipc, "readEditorFile").mockImplementation(async (target) => {
      const file = await ipc.readFile(target);
      return { file, origin, revision: createHash("sha256").update(file.raw).digest("hex"), mockOnly: true as const };
    });
  });

  // The store's error is shared: the previous note's unmount flush, a favorite
  // toggle or any other openFile clears it. The reader keeps what its read said.
  it("stays missing after something else clears the store's error", async () => {
    vi.spyOn(ipc, "readFile").mockRejectedValueOnce(new Error(`no such file: ${path}`));
    useVaultStore.setState({ activeFile: null, error: null });
    const readError = await useVaultStore.getState().openFile(path);
    useVaultStore.setState({ error: null });
    expect(readerView(useVaultStore.getState().activeFile?.path, path, readError)).toBe("missing");
  });

  it("is null once the read succeeded", async () => {
    vi.spyOn(ipc, "readFile").mockResolvedValueOnce({ path, raw: "# a\n", content: "# a\n", frontmatter: null });
    vi.spyOn(ipc, "recordPageOpen").mockResolvedValue(null);
    useVaultStore.setState({ activeFile: null, error: "left by an earlier save" });
    expect(await useVaultStore.getState().openFile(path)).toBeNull();
  });

  it("reports a failed reread without discarding the cached file or pending draft", async () => {
    const cached = { path, raw: "# Cached note\n", content: "# Cached note\n", frontmatter: null };
    const draft = "# Cached note\n\nUnsaved synthetic edit.\n";
    useVaultStore.setState({ activeFile: cached });
    pendingDrafts.set(path, draft);
    vi.spyOn(ipc, "readFile").mockRejectedValueOnce(new Error("read failed: Permission denied (os error 13)"));
    const readError = await useVaultStore.getState().openFile(path);
    expect(useVaultStore.getState().activeFile).toBe(cached);
    expect(pendingDrafts.get(path)).toBe(draft);
    pendingDrafts.delete(path);
    expect(readerView(cached.path, path, readError)).toBe("unreadable");
  });
});

// The note info sheet's wiring (node env has no DOM, so the source is checked;
// the behaviour itself was reproduced in WebKit).
describe("the note info sheet", () => {
  const src = readFileSync(resolve(__dirname, "PageReader.tsx"), "utf8");

  // Open at a narrow width, widen (inline rail), close it, narrow again: a
  // sheet left open from before must not come back as a modal by itself.
  it("forgets an open sheet when the rail switches between sheet and inline", () => {
    expect(src).toMatch(/useEffect\(\(\) => setSheetOpen\(false\), \[path, railSheet\]\)/);
  });

  // WebKit (Tauri's engine) does not focus a clicked <button>, so the sheet
  // took <body> as its opener and focus fell there on close.
  it("focuses the Note info button on click, so closing the sheet returns focus to it", () => {
    expect(src).toMatch(/onClick=\{\(e\) => \{\s*e\.currentTarget\.focus\(\);\s*toggleRail\(\);/);
  });
});

// Effect/event wiring only; native journal restart is a separate real IPC gate.
describe("restored reader draft wiring", () => {
  const src = readFileSync(resolve(__dirname, "PageReader.tsx"), "utf8");

  it("seeds restored text from D while retaining full original A rather than current disk B", () => {
    const seed = src.slice(src.indexOf("const restored = pendingDrafts.get(path);"),
      src.indexOf("} else if (activeFile.raw === draftRef.current"));
    expect(seed).toContain("setDraft(restored ?? activeFile.raw)");
    expect(seed).toMatch(/seededRawRef\.current = restored !== undefined\s*\? getEditorRecoveryBaseline\(path\) \?\? activeFile\.raw : activeFile\.raw/);
    expect(seed).toContain("setSaveFailed(restored !== undefined)");
    expect(seed).not.toMatch(/persistPendingEditorDraft|saveFile|persistDraft\(/);
  });

  it("stages actual typing separately from vault autosave and retains recovery freshness checks", () => {
    const schedule = src.slice(src.indexOf("function scheduleSave(c: string)"),
      src.indexOf("async function flushSave(c: string)"));
    expect(schedule.indexOf("pendingDrafts.set(path, c)")).toBeLessThan(
      schedule.indexOf("persistPendingEditorDraft(path, c)"),
    );
    expect(schedule.indexOf("persistPendingEditorDraft(path, c)")).toBeLessThan(
      schedule.indexOf("setTimeout("),
    );
    expect(src).toContain("pendingDrafts.version(path) === draftVersion");
    expect(src).toContain("getEditorRecoveryBaseline(path) === originalBaseline");
    expect(src).toContain("originalBaseline={getEditorRecoveryBaseline(path)}");
    expect(src).toContain("currentFile={readError === null && activeFile?.path === path ? activeFile.raw : undefined}");
  });
});

// Source wiring complements the static controls without invoking native recovery.
describe("failed-read recovery wiring", () => {
  const src = readFileSync(resolve(__dirname, "PageReader.tsx"), "utf8");

  it("keeps missing and unreadable recovery read-only and shows only captured recovery D and A", () => {
    const controls = src.slice(src.indexOf("const recoveryControls = ("), src.indexOf("const recoveryMessage ="));
    expect(controls).toContain("readOnly={isRaw || readError !== null}");
    expect(controls).toContain("originalBaseline={getEditorRecoveryBaseline(path)}");
    expect(controls).toContain("currentFile={readError === null && activeFile?.path === path ? activeFile.raw : undefined}");
    expect(controls).toContain("recoveryDraft={readError !== null ? pendingDrafts.get(path) : undefined}");
    expect(controls).toContain("onRetryRead={readError !== null ? readCurrentFile : undefined}");
    expect(controls).not.toMatch(/recoverEditorFile|saveFile|persistPendingEditorDraft/);
  });

  it("never uses a cached file as a draft-copy fallback after a failed read", () => {
    const capture = src.slice(src.indexOf("function captureRecovery()"), src.indexOf("const ownsView ="));
    expect(capture).toMatch(/const text = expectedDraft \?\? \(readError === null[\s\S]*?: undefined\);/);
  });

  it("retains failure through a retry until its genuine file read succeeds", () => {
    const read = src.slice(src.indexOf("const readCurrentFile = useCallback("),
      src.indexOf("// Wait for the native root"));
    expect(read).toContain("const error = await openFile(path)");
    expect(read).toContain("readFailedRef.current = error !== null");
    expect(read).toContain("error === undefined) return;");
    expect(read).toContain("setReadFailure(error !== null ? { path, vaultToken, error } : null)");
    expect(read).not.toContain("readFailedRef.current = false");
    expect(read).not.toContain("setReadFailure(null)");
    expect(read).not.toMatch(/recoverEditorFile|saveFile|persistPendingEditorDraft/);
  });

  it("does not flush even an empty recovered D on unmount or from a queued save after a failed read", () => {
    const cleanup = src.slice(src.indexOf("// Flush unsaved edits on navigation/unmount"),
      src.indexOf("async function persistDraft(c: string)"));
    expect(cleanup).toContain("if (!readFailedRef.current && pendingDrafts.get(path) === draftRef.current)");
    const persist = src.slice(src.indexOf("async function persistDraft(c: string)"),
      src.indexOf("function scheduleSave(c: string)"));
    expect(persist).toMatch(/async function persistDraft\(c: string\): Promise<void> \{\s*if \(readFailedRef.current\) return;/);
    expect(persist.indexOf("if (readFailedRef.current) return")).toBeLessThan(persist.indexOf("saveFile(path, c)"));
    const schedule = src.slice(src.indexOf("function scheduleSave(c: string)"),
      src.indexOf("async function flushSave(c: string)"));
    expect(schedule).toMatch(/function scheduleSave\(c: string\): void \{\s*if \(readFailedRef.current\) return;/);
    expect(schedule.indexOf("if (readFailedRef.current) return")).toBeLessThan(schedule.indexOf("pendingDrafts.set(path, c)"));
    expect(schedule).toContain("if (pendingDrafts.get(path) === c) void persistDraft(c)");
  });
});
