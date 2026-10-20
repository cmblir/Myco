// The sidebar's synthetic groups and its reveal of the open note. The reveal is
// driven with stand-in elements as useModalFocus.test.ts does, since the node
// env has no DOM; the effects that call it are checked in the browser.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss from "postcss";
import { createElement } from "react";
import type * as ReactModule from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import Sidebar, { revealRow, sidebarGroups, workspaceOpenFor } from "./Sidebar";
import type { FileNode, VaultMeta } from "../lib/ipc";
import { STRINGS } from "../lib/i18n";
import type * as VaultStoreModule from "../stores/vaultStore";

const inventory = vi.hoisted(() => ({
  currentVault: { path: "/v", name: "Synthetic" } as VaultMeta | null,
  fileTree: [] as FileNode[],
  isOpeningVault: false,
}));

vi.mock("../stores/vaultStore", async (importOriginal) => {
  const actual = await importOriginal<typeof VaultStoreModule>();
  return {
    ...actual,
    useVaultStore: Object.assign(
      (select: (state: ReturnType<typeof actual.useVaultStore.getState>) => unknown) =>
        select({ ...actual.useVaultStore.getState(), ...inventory }),
      actual.useVaultStore,
    ),
  };
});

// The window-height hook has no server snapshot; use the same synthetic
// matchMedia snapshot for this node-only markup check.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useSyncExternalStore: (...args: Parameters<typeof actual.useSyncExternalStore>) =>
      actual.useSyncExternalStore(args[0], args[1], args[2] ?? args[1]),
  };
});

const t = STRINGS.en;

afterEach(() => {
  vi.unstubAllGlobals();
  inventory.currentVault = { path: "/v", name: "Synthetic" };
  inventory.fileTree = [];
  inventory.isOpeningVault = false;
});

function renderInventory(lang: "en" | "ko" | "ja"): string {
  vi.stubGlobal("window", {
    location: { search: "" },
    matchMedia: () => ({ matches: false }),
  });
  return renderToStaticMarkup(createElement(Sidebar, { t: STRINGS[lang] }));
}

describe("sidebar inventory readiness", () => {
  it.each(["en", "ko", "ja"] as const)(
    "shows loading instead of a real empty vault or zero count while opening (%s)",
    (lang) => {
      inventory.isOpeningVault = true;
      const strings = STRINGS[lang];
      const html = renderInventory(lang);
      expect(html).toContain(strings.st_loading);
      expect(html).toContain('aria-busy="true"');
      expect(html).not.toContain(strings.sb_empty_vault);
      expect(html).not.toContain(strings.home_notes_count.replace("{n}", "0"));
    },
  );

  it("keeps the real empty result after opening completes", () => {
    const html = renderInventory("ko");
    expect(html).toContain(STRINGS.ko.sb_empty_vault);
    expect(html).toContain(STRINGS.ko.home_notes_count.replace("{n}", "0"));
    expect(html).not.toContain(STRINGS.ko.st_loading);
  });

  it("does not present a previous vault's rows as the inventory being opened", () => {
    inventory.isOpeningVault = true;
    inventory.fileTree = [{ kind: "file", name: "previous.md", path: "/v/previous.md" }];
    expect(renderInventory("en")).not.toContain('data-path="/v/previous.md"');
  });

  it("keeps ready note rows and their measured count", () => {
    inventory.fileTree = [{ kind: "file", name: "ready.md", path: "/v/ready.md" }];
    const html = renderInventory("en");
    expect(html).toContain('data-path="/v/ready.md"');
    expect(html).toContain(STRINGS.en.home_notes_count.replace("{n}", "1"));
    expect(html).not.toContain(STRINGS.en.st_loading);
  });
});

// UX S43: at 1024x700 the open Workspace group left room for 5 tree rows; a
// short window starts it folded until the user picks.
describe("workspaceOpenFor", () => {
  it("folds by default in a short window, opens in a tall one", () => {
    expect(workspaceOpenFor(undefined, true)).toBe(false);
    expect(workspaceOpenFor(undefined, false)).toBe(true);
  });
  it("keeps the user's own choice at any height", () => {
    expect(workspaceOpenFor(true, true)).toBe(true);
    expect(workspaceOpenFor(false, false)).toBe(false);
  });
});

describe("sidebarGroups", () => {
  const tree = [{ kind: "file" as const, name: "a.md", path: "/v/a.md" }];
  const names = (groups: FileNode[]) => groups.map((g) => g.name);

  it("leaves Recently edited out until the vault's mtimes are known", () => {
    // null = not fetched yet, or the walk failed: a group reading 0 then looks
    // exactly like a vault nobody edited.
    expect(names(sidebarGroups(t, "/v", tree, [], null))).toEqual([]);
  });

  it("shows Recently edited once the mtimes arrive, even when there are none", () => {
    const [recent] = sidebarGroups(t, "/v", tree, [], [["/v/a.md", 1]]);
    expect(recent.name).toBe(t.sb_recent);
    expect(recent.kind === "directory" && recent.children.map((c) => c.path)).toEqual([
      "/v/a.md",
    ]);
    expect(names(sidebarGroups(t, "/v", tree, [], []))).toEqual([t.sb_recent]);
  });

  it("lists only what the tree shows, so the human-only filter thins Recently edited too", () => {
    // `tree` is the filtered one: b.md (an agent's note) is not in it.
    const [recent] = sidebarGroups(t, "/v", tree, [], [
      ["/v/b.md", 2],
      ["/v/a.md", 1],
    ]);
    expect(recent.kind === "directory" && recent.children.map((c) => c.path)).toEqual([
      "/v/a.md",
    ]);
  });

  it("has no groups without a vault, and stars only files that still exist", () => {
    expect(sidebarGroups(t, "", [], ["a.md"], [])).toEqual([]);
    expect(names(sidebarGroups(t, "/v", tree, ["a.md", "gone.md"], null))).toEqual([
      t.sb_favorites,
    ]);
  });
});

function fakeSidebar(rowTops: number[]) {
  const scrolled: number[] = [];
  const rows = rowTops.map((top, i) => ({
    getBoundingClientRect: () => ({ top, bottom: top + 32 }),
    scrollIntoView: () => scrolled.push(i),
  }));
  vi.stubGlobal("CSS", { escape: (s: string) => s });
  vi.stubGlobal("document", {
    querySelector: () => ({ getBoundingClientRect: () => ({ top: 100, bottom: 500 }) }),
    querySelectorAll: () => rows,
  });
  return scrolled;
}

describe("revealRow", () => {
  it("says so when the tree does not hold the row yet, so the reveal can wait", () => {
    fakeSidebar([]);
    expect(revealRow("/v/wiki/a.md")).toBe(false);
  });

  it("scrolls an off-screen tree row into view and reports it done", () => {
    const scrolled = fakeSidebar([900]);
    expect(revealRow("/v/wiki/a.md")).toBe(true);
    expect(scrolled).toEqual([0]);
  });

  it("leaves the list alone when a copy of the row is already in view", () => {
    const scrolled = fakeSidebar([120, 900]);
    expect(revealRow("/v/wiki/a.md")).toBe(true);
    expect(scrolled).toEqual([]);
  });
});

describe("the sidebar's stylesheet", () => {
  const root = postcss.parse(readFileSync(resolve(__dirname, "../styles.css"), "utf8"));
  const brand = postcss.parse(
    readFileSync(resolve(__dirname, "../styles/sidebar-brand.css"), "utf8"),
  );

  it("keeps its open width while collapsed, so a reveal measures the box shown later", () => {
    // Collapsed on desktop the sidebar is position:absolute; without a width it
    // sizes to its content (wider), its status strip wraps into fewer lines and
    // the nav ends at a different y than once the sidebar is shown again.
    const widths: string[] = [];
    root.walkRules((rule) => {
      if (rule.parent?.type !== "root" || rule.selector !== ".sidebar") return;
      rule.walkDecls("width", (d) => void widths.push(d.value));
    });
    expect(widths).toContain("var(--side-w)");
  });

  it("keeps separate Home and Settings targets large enough for touch", () => {
    const targets = new Set([".sidebar .brand", ".sidebar .side-gear"]);
    brand.walkRules((rule) => {
      if (!targets.has(rule.selector)) return;
      const declarations = Object.fromEntries(
        rule.nodes
          .filter((node) => node.type === "decl")
          .map((node) => [node.prop, node.value]),
      );
      expect(declarations["min-width"]).toBe("2.75rem");
      expect(declarations["min-height"]).toBe("2.75rem");
      targets.delete(rule.selector);
    });
    expect(targets.size).toBe(0);
  });

  it("keeps the brand's hover surface at its own width and gives both controls a focus ring", () => {
    let naturalWidth = false;
    let focusRing = false;
    brand.walkRules((rule) => {
      if (rule.selector === ".sidebar .brand") {
        rule.walkDecls("width", (declaration) => {
          naturalWidth = declaration.value === "auto";
        });
      }
      if (
        rule.selector.includes(".sidebar .brand:focus-visible") &&
        rule.selector.includes(".sidebar .side-gear:focus-visible")
      ) {
        rule.walkDecls("outline", (declaration) => {
          focusRing = declaration.value === "2px solid var(--accent)";
        });
      }
    });
    expect(naturalWidth).toBe(true);
    expect(focusRing).toBe(true);
  });
});
