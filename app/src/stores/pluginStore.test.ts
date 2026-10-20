import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// persist() resolves its storage when the module loads (see uiStore.test).
const storage = vi.hoisted(() => {
  const m = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  });
  return m;
});
import {
  enabledPlugins,
  pluginFenceKey,
  pluginSlash,
  usePluginStore,
} from "./pluginStore";
import { fenceBlock } from "../lib/blocks";
import { MERMAID } from "../lib/blocks/mermaid";
import { ipc, type PluginFile } from "../lib/ipc";

const KIT = {
  id: "kit",
  name: "Kit",
  version: "1.0.0",
  contributes: {
    slash: [{ label: "graph", detail: "Graph", fence: "graph" }],
    fences: [{ lang: "graph", renderer: "builtin:mermaid" }],
  },
};
const files = (...m: unknown[]): PluginFile[] =>
  m.map((x) => ({
    dir: (x as { id: string }).id,
    raw: JSON.stringify(x),
    error: null,
  }));

describe("pluginStore", () => {
  beforeEach(() => {
    usePluginStore.setState({
      trusted: [],
      disabled: {},
      granted: {},
      vault: null,
      entries: [],
      loadError: null,
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("draws a vault's fences and lists its slash items only once it is trusted", async () => {
    vi.spyOn(ipc, "listPlugins").mockResolvedValue(files(KIT));
    const s = usePluginStore.getState;
    await s().load("/v");
    expect(s().entries.map((e) => e.manifest?.id)).toEqual(["kit"]);
    expect(fenceBlock("graph")).toBeUndefined();
    expect(pluginSlash("note")).toEqual([]);

    s().setTrusted("/v", true);
    expect(fenceBlock("graph")).toBe(MERMAID);
    expect(pluginSlash("note").map((i) => i.label)).toEqual(["graph"]);

    // Off in this vault only; back on; then trust revoked.
    s().setEnabled("/v", "kit", false);
    expect(fenceBlock("graph")).toBeUndefined();
    expect(pluginFenceKey(s())).toBe("[]");
    s().setEnabled("/v", "kit", true);
    expect(fenceBlock("graph")).toBe(MERMAID);
    s().setTrusted("/v", false);
    expect(fenceBlock("graph")).toBeUndefined();
    expect(pluginSlash("note")).toEqual([]);
  });

  it("trust and on/off persist per device; the manifests do not", () => {
    usePluginStore.getState().setTrusted("/v", true);
    usePluginStore.getState().setEnabled("/v", "kit", false);
    expect(JSON.parse(storage.get("myco-plugins")!).state).toEqual({
      trusted: ["/v"],
      disabled: { "/v": ["kit"] },
      granted: {},
    });
  });

  it("a slower load for a vault no longer open is dropped", async () => {
    let finish!: (f: PluginFile[]) => void;
    vi.spyOn(ipc, "listPlugins")
      .mockReturnValueOnce(new Promise((r) => (finish = r)))
      .mockResolvedValueOnce([]);
    const first = usePluginStore.getState().load("/a");
    await usePluginStore.getState().load("/b");
    finish(files(KIT));
    await first;
    expect(usePluginStore.getState()).toMatchObject({
      vault: "/b",
      entries: [],
    });
  });

  it("a failed read says so and lists nothing", async () => {
    vi.spyOn(ipc, "listPlugins").mockRejectedValue(
      new Error("no vault is open"),
    );
    await usePluginStore.getState().load("/v");
    expect(usePluginStore.getState()).toMatchObject({
      entries: [],
      loadError: "Error: no vault is open",
    });
  });

  // Stage 6: a plugin that runs code needs its calls granted as well.
  const WC = {
    id: "wc",
    name: "Word count",
    version: "1.0.0",
    permissions: ["editor.selection", "editor.insertAtCursor"],
    contributes: {
      slash: [{ label: "wc", detail: "Count", command: "count" }],
    },
  };
  const on = () => enabledPlugins(usePluginStore.getState()).map((p) => p.id);

  it("a code plugin is on only while its calls are granted", async () => {
    vi.spyOn(ipc, "listPlugins").mockResolvedValue(files(WC, KIT));
    const s = usePluginStore.getState;
    await s().load("/v");
    s().setTrusted("/v", true);
    expect(on()).toEqual(["kit"]);
    s().grant("/v", "wc", ["editor.selection", "editor.insertAtCursor"]);
    expect(on()).toEqual(["wc", "kit"]);
    expect(JSON.parse(storage.get("myco-plugins")!).state.granted).toEqual({
      "/v": { wc: ["editor.selection", "editor.insertAtCursor"] },
    });
    s().revoke("/v", "wc");
    expect(on()).toEqual(["kit"]);
    expect(s().granted).toEqual({ "/v": {} });
  });

  it("granting turns a plugin switched off earlier back on", async () => {
    vi.spyOn(ipc, "listPlugins").mockResolvedValue(files(WC));
    const s = usePluginStore.getState;
    await s().load("/v");
    s().setTrusted("/v", true);
    s().setEnabled("/v", "wc", false);
    s().grant("/v", "wc", WC.permissions);
    expect(on()).toEqual(["wc"]);
  });

  it("taking back a vault's trust takes back its grants", async () => {
    vi.spyOn(ipc, "listPlugins").mockResolvedValue(files(WC));
    const s = usePluginStore.getState;
    await s().load("/v");
    s().setTrusted("/v", true);
    s().grant("/v", "wc", WC.permissions);
    s().grant("/w", "wc", WC.permissions);
    s().setTrusted("/v", false);
    s().setTrusted("/v", true);
    expect(on()).toEqual([]);
    expect(s().granted).toEqual({ "/w": { wc: WC.permissions } });
  });

  it("a hand-edited grant store keeps only lists of text", async () => {
    const p = usePluginStore.persist;
    storage.set(
      "myco-plugins",
      JSON.stringify({
        state: {
          trusted: ["/v"],
          disabled: {},
          granted: { "/v": { wc: ["recall", 3], bad: "all" }, "/w": 7 },
        },
        version: 1,
      }),
    );
    await p.rehydrate();
    expect(usePluginStore.getState().granted).toEqual({
      "/v": { wc: ["recall"], bad: [] },
      "/w": {},
    });
  });
});
