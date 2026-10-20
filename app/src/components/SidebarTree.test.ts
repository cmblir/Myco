// The tree rows' accessibility semantics. Sidebar makes the tree one Tab stop
// walked with the arrows (UX S28), so a screen reader has to hear a tree and
// its items, or it meets one plain button and no hint the arrows go further.

import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TreeNode } from "./SidebarTree";
import type { FileNode } from "../lib/ipc";
import { FAVORITES_ID } from "../lib/treeOps";

// Static rendering reads a zustand store's initial state, never setState's,
// so the folder-open flag comes from a stand-in store.
const ui = vi.hoisted(() => ({
  expandedFolders: {} as Record<string, boolean>,
  toggleFolder: () => undefined,
}));
vi.mock("../stores/uiStore", () => ({
  useUIStore: <T>(pick: (s: typeof ui) => T): T => pick(ui),
}));

const folder: FileNode = {
  kind: "directory",
  name: "wiki",
  path: "/v/wiki",
  children: [{ kind: "file", name: "a.md", path: "/v/wiki/a.md" }],
};

const render = (selected: string[] = [], node: FileNode = folder, onMore?: () => void) =>
  renderToStaticMarkup(
    h(TreeNode, {
      node,
      onMore,
      moreLabel: "{name} menu",
      depth: 0,
      activePath: null,
      selected: new Set(selected),
      onSelect: () => undefined,
      onRowClick: () => "pass" as const,
      onRowKey: () => undefined,
      onContextMenu: () => undefined,
    }),
  );

afterEach(() => {
  ui.expandedFolders = {};
});

describe("TreeNode", () => {
  it("is a tree item with its level, and a folder says whether it is open", () => {
    const html = render();
    expect(html).toContain('role="treeitem"');
    expect(html).toContain('aria-level="1"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("aria-pressed");
  });

  it("puts an open folder's rows in a group one level down", () => {
    ui.expandedFolders = { "/v/wiki": true };
    const html = render(["/v/wiki/a.md"]);
    expect(html).toMatch(/<div role="group">.*aria-level="2".*<\/div>$/);
    expect(html).toMatch(/aria-level="2"[^>]*aria-selected="true"/);
  });
});

// UX S49: a visible ⋯ on every row is the touch path to the row's menu (a
// finger has no right-click), named for its row so a screen reader can find it.
describe("TreeNode ⋯ button", () => {
  const more = () => undefined;

  it("gives a file row and a folder row a named menu button beside the row", () => {
    ui.expandedFolders = { "/v/wiki": true };
    const html = render([], folder, more);
    expect(html).toContain('aria-label="wiki menu"');
    expect(html).toContain('aria-label="a menu"');
    // A sibling, never nested: a button inside the row button is invalid.
    expect(html).not.toMatch(/<button[^>]*role="treeitem"(?:(?!<\/button>).)*<button/);
  });

  it("stays out of the row-to-row Tab order the tree walks with arrows", () => {
    const html = render([], folder, more);
    expect(html).toMatch(/<button[^>]*class="tree-more"[^>]*tabindex="-1"|<button[^>]*tabindex="-1"[^>]*class="tree-more"/);
  });

  it("gives a synthetic group row (Favorites) none", () => {
    const group: FileNode = { kind: "directory", name: "Favorites", path: FAVORITES_ID, children: [] };
    expect(render([], group, more)).not.toContain("tree-more");
  });

  it("renders no button when the host offers no menu", () => {
    expect(render()).not.toContain("tree-more");
  });
});
