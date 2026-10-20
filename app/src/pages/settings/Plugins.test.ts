// Settings → Plugins as static markup (node, no DOM), as ui.test.ts does.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Blocks from "../../lib/blocks";
import type * as PluginStore from "../../stores/pluginStore";

// persist() resolves its storage when the module loads (see uiStore.test).
vi.hoisted(() => {
  const m = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  });
});
// Server rendering reads a zustand store's initial state: read the live one.
vi.mock("../../stores/pluginStore", async (load) => {
  const m = await load<typeof PluginStore>();
  const store = m.usePluginStore;
  const hook = Object.assign(
    (select: (s: ReturnType<typeof store.getState>) => unknown) =>
      select(store.getState()),
    store,
  );
  return { ...m, usePluginStore: hook };
});
// Every renderer the manifest schema names is in this build, so the tab's
// "not in this version" is reached with a registry missing a block: the
// ids in `dropped` (empty = the real registry).
const dropped = vi.hoisted(() => new Set<string>());
vi.mock("../../lib/blocks", async (load) => {
  const m = await load<typeof Blocks>();
  return {
    ...m,
    rendererBlock: (lang: string, renderer: Blocks.FenceRenderer) =>
      m.rendererBlock(
        lang,
        renderer,
        m.BLOCKS.filter((b) => !dropped.has(b.id)),
      ),
  };
});
vi.mock("../../stores/vaultStore", () => ({
  useVaultStore: (select: (s: unknown) => unknown) =>
    select({ currentVault: { path: "/v", name: "v" } }),
}));

import { SettingsPlugins } from "./Plugins";
import { STRINGS } from "../../lib/i18n";
import { readPlugin } from "../../lib/plugins";
import { usePluginStore } from "../../stores/pluginStore";

const t = STRINGS.ko;
const plugin = (m: object) =>
  readPlugin({
    dir: (m as { id: string }).id,
    raw: JSON.stringify(m),
    error: null,
  });
const KIT = plugin({
  id: "meeting-kit",
  name: "회의 키트",
  version: "1.0.0",
  contributes: { slash: [{ label: "agenda", detail: "안건", template: "x" }] },
});
const render = (): string =>
  renderToStaticMarkup(createElement(SettingsPlugins, { t }));

describe("Settings → Plugins", () => {
  afterEach(() => {
    dropped.clear();
    usePluginStore.setState({
      vault: null,
      entries: [],
      loading: false,
      loadError: null,
      trusted: [],
      disabled: {},
    });
  });

  it("Read again stays focusable and says it is reading while plugins are listed", () => {
    usePluginStore.setState({ vault: "/v", entries: [KIT], loading: true });
    const html = render();
    const button = html
      .match(/<button[^>]*>[^<]*<\/button>/g)
      ?.find((b) => b.includes(t.pl_reload));
    // A disabled button drops keyboard focus to <body> mid-read.
    expect(button).toBeDefined();
    expect(button).not.toMatch(/\sdisabled/);
    expect(button).toMatch(/aria-busy="true"/);
    expect(html).toContain(t.pl_loading);
    expect(html).toContain("회의 키트");
  });

  it("marks a fence the app does not draw with this plugin's renderer", () => {
    const toc = plugin({
      id: "toc-kit",
      name: "TOC kit",
      version: "1",
      contributes: {
        fences: [
          { lang: "toc", renderer: "builtin:code" },
          { lang: "graph", renderer: "builtin:code" },
        ],
      },
    });
    const graphKit = plugin({
      id: "graph-kit",
      name: "Graph kit",
      version: "1",
      contributes: { fences: [{ lang: "graph", renderer: "builtin:mermaid" }] },
    });
    usePluginStore.setState({
      vault: "/v",
      entries: [graphKit, toc],
      trusted: ["/v"],
    });
    dropped.add("mermaid");
    const html = render();
    expect(html).toContain(`\`\`\`toc → builtin:code (${t.pl_fence_builtin})`);
    expect(html).toContain(
      `\`\`\`graph → builtin:code (${t.pl_fence_taken.replace("{id}", "graph-kit")})`,
    );
    // graph-kit's own ```graph is drawn by it: only the missing renderer.
    expect(html).toContain(
      `\`\`\`graph → builtin:mermaid (${t.pl_renderer_absent})`,
    );
  });

  it("notes nothing for a renderer this build has", () => {
    const kit = plugin({
      id: "draw-kit",
      name: "Draw kit",
      version: "1",
      contributes: {
        fences: [
          { lang: "graph", renderer: "builtin:mermaid" },
          { lang: "plot", renderer: "builtin:chart" },
          { lang: "pages", renderer: "builtin:query" },
        ],
      },
    });
    usePluginStore.setState({ vault: "/v", entries: [kit], trusted: ["/v"] });
    const html = render();
    expect(html).toContain(
      "```graph → builtin:mermaid, ```plot → builtin:chart, ```pages → builtin:query</span>",
    );
    expect(html).not.toContain(t.pl_renderer_absent);
  });

  it("says in plain words that a plugin did not load, the check under Details", () => {
    const broken = plugin({
      id: "web-embed",
      name: "Web embed",
      version: "1",
      contributes: { fences: [{ lang: "iframe", renderer: "builtin:iframe" }] },
    });
    usePluginStore.setState({ vault: "/v", entries: [broken] });
    const html = render();
    expect(html).toContain(t.pl_load_one_failed);
    const details = html.match(/<details[^>]*>.*?<\/details>/)?.[0] ?? "";
    expect(details).toContain(`<summary`);
    expect(details).toContain(t.pl_details);
    // The validator's own words stay, folded away.
    expect(details).toContain("contributes.fences[0].renderer");
  });

  it("says nothing about reading once the read is done", () => {
    usePluginStore.setState({ vault: "/v", entries: [KIT], loading: false });
    const html = render();
    expect(html).not.toContain(t.pl_loading);
    expect(html).not.toContain(t.pl_empty);
    expect(html).not.toMatch(/aria-busy="true"/);
  });
});
