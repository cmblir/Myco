import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyLinkSuggestions, registerLinkDraft } from "./linkActions";
import { pairKey, type LinkSuggestion } from "./linkSuggestions";
import { ipc, type VaultMeta } from "./ipc";
import { pendingDrafts, useVaultStore } from "../stores/vaultStore";
import { useLinkSuggestStore } from "../stores/linkSuggestStore";
import { useNoticeStore } from "../stores/noticeStore";

const source = "/v/wiki/a.md";
const target = "/v/wiki/b.md";
const suggestion: LinkSuggestion = { source, target, score: 1, key: pairKey(source, target) };

describe("shared link actions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    pendingDrafts.clear();
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
    useVaultStore.setState({ currentVault: { path: "/v" } as VaultMeta, refreshLinkGraph: vi.fn().mockResolvedValue(undefined) });
    useLinkSuggestStore.setState({ busy: false, dismissed: new Set() });
    useNoticeStore.setState({ notices: [], progress: null, lastProgressOk: true });
    vi.spyOn(ipc, "readFile").mockResolvedValue({ raw: "# note\n" } as Awaited<ReturnType<typeof ipc.readFile>>);
    vi.spyOn(ipc, "writeFileIfUnchanged").mockResolvedValue(null);
  });

  it("surfaces a failure and clears progress while retaining the pair", async () => {
    vi.spyOn(ipc, "writeFileIfUnchanged").mockRejectedValue(new Error("disk full"));
    expect(await applyLinkSuggestions([suggestion], { bulk: true })).toBe(false);
    const state = useNoticeStore.getState();
    expect(state.progress).toBeNull();
    expect(state.lastProgressOk).toBe(false);
    expect(state.notices.at(-1)?.sub).toBe("Error: disk full");
    expect(state.notices.at(-1)?.action).toBeDefined();
    expect(useLinkSuggestStore.getState().dismissed.size).toBe(0);
    expect(useLinkSuggestStore.getState().busy).toBe(false);
  });

  it("serializes native agenda and Overview actions", async () => {
    let release!: () => void;
    vi.spyOn(ipc, "readFile").mockImplementation(() => new Promise((resolve) => { release = () => resolve({ raw: "# note\n" } as Awaited<ReturnType<typeof ipc.readFile>>); }));
    const first = applyLinkSuggestions([suggestion], { bulk: true });
    expect(await applyLinkSuggestions([suggestion])).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(ipc.writeFileIfUnchanged).toHaveBeenCalledTimes(1);
  });

  it("routes a bulk append into the open draft instead of overwriting it", async () => {
    let draft = "# note\n\nUnsaved sentence.\n";
    const write = vi.fn((_path: string, next: string) => { draft = next; return Promise.resolve(); });
    const transformFile = vi.fn((_path: string, transform: (raw: string) => string) => {
      draft = transform(draft);
      return Promise.resolve();
    });
    const off = registerLinkDraft(source, { readFile: async () => ({ raw: draft }), writeFile: write, transformFile });
    pendingDrafts.set(source, draft);
    try {
      expect(await applyLinkSuggestions([suggestion], { bulk: true })).toBe(true);
      expect(draft).toContain("Unsaved sentence.");
      expect(draft).toContain("[[wiki/b|b]]");
      expect(transformFile).toHaveBeenCalledTimes(1);
      expect(write).not.toHaveBeenCalled();
      expect(ipc.writeFileIfUnchanged).not.toHaveBeenCalled();
    } finally { off(); }
  });

  it("stops a pending old-vault append before its write", async () => {
    vi.spyOn(ipc, "readFile").mockImplementation(async () => {
      useVaultStore.setState({ currentVault: { path: "/other" } as VaultMeta });
      return { raw: "# note\n" } as Awaited<ReturnType<typeof ipc.readFile>>;
    });
    expect(await applyLinkSuggestions([suggestion], { bulk: true })).toBe(false);
    expect(ipc.writeFileIfUnchanged).not.toHaveBeenCalled();
    expect(useLinkSuggestStore.getState().dismissed.size).toBe(0);
    expect(useNoticeStore.getState().notices.at(-1)?.sub).toContain("Vault changed");
  });

  it("stops an old-session append when the same vault path is reopened during its read", async () => {
    useVaultStore.setState({ vaultToken: "writer-open-1", isOpeningVault: false });
    vi.spyOn(ipc, "readFile").mockImplementation(async () => {
      useVaultStore.setState({ vaultToken: "writer-open-2" });
      return { raw: "# note\n" } as Awaited<ReturnType<typeof ipc.readFile>>;
    });
    expect(await applyLinkSuggestions([suggestion], { bulk: true })).toBe(false);
    expect(ipc.writeFileIfUnchanged).not.toHaveBeenCalled();
    expect(useLinkSuggestStore.getState().dismissed.size).toBe(0);
  });

  it("rejects raw and outside-vault sources before reading", async () => {
    for (const path of ["/v/raw/source.md", "/outside/wiki/a.md", "/v/../other.md"]) {
      expect(await applyLinkSuggestions([{ ...suggestion, source: path }])).toBe(false);
    }
    expect(ipc.readFile).not.toHaveBeenCalled();
    expect(ipc.writeFileIfUnchanged).not.toHaveBeenCalled();
  });

  it("keeps completed documents dismissed and retries only the remainder", async () => {
    const second = { ...suggestion, source: "/v/wiki/c.md", key: "second" };
    vi.spyOn(ipc, "writeFileIfUnchanged").mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("disk full"));
    expect(await applyLinkSuggestions([suggestion, second], { bulk: true })).toBe(false);
    expect(useLinkSuggestStore.getState().dismissed.has(suggestion.key)).toBe(true);
    expect(useLinkSuggestStore.getState().dismissed.has(second.key)).toBe(false);
    vi.mocked(ipc.writeFileIfUnchanged).mockResolvedValue(null);
    useNoticeStore.getState().notices.at(-1)?.action?.run();
    await vi.waitFor(() => expect(useLinkSuggestStore.getState().dismissed.has(second.key)).toBe(true));
    expect(vi.mocked(ipc.readFile).mock.calls.map(([path]) => path)).toEqual([source, second.source, second.source]);
  });

  it("reports a persistence failure as incomplete and retries without duplicating the disk write", async () => {
    let raw = "# note\n";
    vi.spyOn(ipc, "readFile").mockImplementation(async () => ({ raw } as Awaited<ReturnType<typeof ipc.readFile>>));
    vi.spyOn(ipc, "writeFileIfUnchanged").mockImplementation(async (_path, content) => { raw = content; return null; });
    const persist = vi.fn().mockImplementationOnce(() => { throw new Error("Synthetic quota exceeded"); });
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: persist });
    expect(await applyLinkSuggestions([suggestion], { bulk: true })).toBe(false);
    expect(useNoticeStore.getState().lastProgressOk).toBe(false);
    expect(useLinkSuggestStore.getState().dismissed.size).toBe(0);
    expect(ipc.writeFileIfUnchanged).toHaveBeenCalledTimes(1);
    expect(await applyLinkSuggestions([suggestion], { bulk: true })).toBe(true);
    expect(ipc.writeFileIfUnchanged).toHaveBeenCalledTimes(1);
    expect(raw.match(/\[\[wiki\/b\|b\]\]/g)).toHaveLength(1);
    expect(useLinkSuggestStore.getState().dismissed.has(suggestion.key)).toBe(true);
  });
});
