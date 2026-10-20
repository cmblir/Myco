import { describe, expect, it } from "vitest";
import type { FileNode } from "./ipc";
import {
  FAVORITES_ID,
  ancestorDirs,
  dropNested,
  filterMovable,
  flattenVisible,
  folderChoices,
  rangeBetween,
  treeKeyMove,
  rewritePrefix,
  syntheticGroup,
} from "./treeOps";

const file = (path: string): FileNode => ({
  kind: "file",
  name: path.slice(path.lastIndexOf("/") + 1),
  path,
});
const dir = (path: string, children: FileNode[]): FileNode => ({
  kind: "directory",
  name: path.slice(path.lastIndexOf("/") + 1),
  path,
  children,
});

const R = "/v";
const tree: FileNode[] = [
  dir(`${R}/raw`, [file(`${R}/raw/src.md`), dir(`${R}/raw/x`, [])]),
  dir(`${R}/wiki`, [
    dir(`${R}/wiki/sub`, [file(`${R}/wiki/sub/deep.md`)]),
    file(`${R}/wiki/a.md`),
    file(`${R}/wiki/b.md`),
  ]),
  file(`${R}/welcome.md`),
];

describe("flattenVisible", () => {
  it("lists a collapsed directory as one row and an expanded one with its children", () => {
    expect(flattenVisible(tree, {})).toEqual([`${R}/raw`, `${R}/wiki`, `${R}/welcome.md`]);
    expect(flattenVisible(tree, { [`${R}/wiki`]: true })).toEqual([
      `${R}/raw`,
      `${R}/wiki`,
      `${R}/wiki/sub`,
      `${R}/wiki/a.md`,
      `${R}/wiki/b.md`,
      `${R}/welcome.md`,
    ]);
  });

  it("recurses into nested expanded directories only", () => {
    expect(flattenVisible(tree, { [`${R}/wiki`]: true, [`${R}/wiki/sub`]: true })).toContain(
      `${R}/wiki/sub/deep.md`,
    );
    // An expanded child under a collapsed parent stays hidden.
    expect(flattenVisible(tree, { [`${R}/wiki/sub`]: true })).not.toContain(
      `${R}/wiki/sub/deep.md`,
    );
  });
});

describe("rangeBetween", () => {
  const order = ["a", "b", "c", "d"];
  it("is inclusive in either direction", () => {
    expect(rangeBetween(order, "b", "d")).toEqual(["b", "c", "d"]);
    expect(rangeBetween(order, "d", "b")).toEqual(["b", "c", "d"]);
    expect(rangeBetween(order, "c", "c")).toEqual(["c"]);
  });
  it("falls back to the target alone without a usable anchor", () => {
    expect(rangeBetween(order, null, "c")).toEqual(["c"]);
    expect(rangeBetween(order, "zzz", "c")).toEqual(["c"]);
  });
});

describe("filterMovable", () => {
  it("drops paths already in the destination, the destination itself and its ancestors", () => {
    expect(
      filterMovable(
        [`${R}/wiki/a.md`, `${R}/wiki/sub/deep.md`, `${R}/wiki/sub`, `${R}/wiki`, `${R}/welcome.md`],
        `${R}/wiki/sub`,
      ),
    ).toEqual([`${R}/wiki/a.md`, `${R}/welcome.md`]);
  });

  it("drops a path whose ancestor is also listed", () => {
    expect(
      dropNested([`${R}/wiki`, `${R}/wiki/a.md`, `${R}/welcome.md`]),
    ).toEqual([`${R}/wiki`, `${R}/welcome.md`]);
    expect(
      filterMovable([`${R}/wiki`, `${R}/wiki/a.md`], `${R}/notes`),
    ).toEqual([`${R}/wiki`]);
  });
});

describe("rewritePrefix", () => {
  it("rewrites an exact match and descendants, not a sibling sharing a prefix", () => {
    expect(rewritePrefix("/a/b", "/a/b", "/x/b")).toBe("/x/b");
    expect(rewritePrefix("/a/b/c.md", "/a/b", "/x/b")).toBe("/x/b/c.md");
    expect(rewritePrefix("/a/bc", "/a/b", "/x/b")).toBeNull();
    expect(rewritePrefix("/q/r", "/a/b", "/x/b")).toBeNull();
  });
});

describe("syntheticGroup", () => {
  it("builds a directory node whose leaves are the real files", () => {
    expect(syntheticGroup(FAVORITES_ID, "Favorites", [`${R}/wiki/a.md`])).toEqual({
      kind: "directory",
      name: "Favorites",
      path: FAVORITES_ID,
      children: [{ kind: "file", name: "a.md", path: `${R}/wiki/a.md` }],
    });
  });
});

describe("folderChoices", () => {
  it("offers root first, then every directory except raw/ and its subtree, with vault-relative labels", () => {
    expect(folderChoices(tree, R, [`${R}/welcome.md`])).toEqual([
      { path: `${R}/wiki`, label: "wiki" },
      { path: `${R}/wiki/sub`, label: "wiki/sub" },
    ]);
    expect(folderChoices(tree, R, [`${R}/wiki/a.md`])).toEqual([
      { path: R, label: "" },
      { path: `${R}/wiki/sub`, label: "wiki/sub" },
    ]);
  });

  it("excludes a moving folder, its descendants and the folder all paths already sit in", () => {
    expect(folderChoices(tree, R, [`${R}/wiki`])).toEqual([]);
    expect(folderChoices(tree, R, [`${R}/wiki/sub`])).toEqual([{ path: R, label: "" }]);
    // Mixed parents: neither parent holds every path, so both stay offered.
    expect(folderChoices(tree, R, [`${R}/wiki/a.md`, `${R}/welcome.md`])).toEqual([
      { path: R, label: "" },
      { path: `${R}/wiki`, label: "wiki" },
      { path: `${R}/wiki/sub`, label: "wiki/sub" },
    ]);
  });

  it("skips synthetic group rows", () => {
    const withGroups = [syntheticGroup(FAVORITES_ID, "Favorites", [`${R}/wiki/a.md`]), ...tree];
    expect(folderChoices(withGroups, R, [`${R}/welcome.md`]).map((c) => c.path)).not.toContain(
      FAVORITES_ID,
    );
  });
});

describe("ancestorDirs", () => {
  it("lists every folder between the vault root and the file, outermost first", () => {
    expect(ancestorDirs(`${R}/wiki/sub/deep.md`, R)).toEqual([`${R}/wiki`, `${R}/wiki/sub`]);
    expect(ancestorDirs(`${R}/welcome.md`, R)).toEqual([]);
  });

  it("opens nothing for a file outside the vault or a sibling sharing its prefix", () => {
    expect(ancestorDirs("/elsewhere/notes/x.md", R)).toEqual([]);
    expect(ancestorDirs("/vault2/wiki/x.md", "/vault")).toEqual([]);
    expect(ancestorDirs(`${R}/wiki/a.md`, "")).toEqual([]);
  });
});

// UX S28: the sidebar tree is one Tab stop walked with the arrow keys (WAI-ARIA
// tree pattern). Rows are the rendered ones, top to bottom; null = a file.
describe("treeKeyMove", () => {
  const rows = [
    { depth: 0, expanded: true }, //  0 wiki/ (open)
    { depth: 1, expanded: null }, //  1   a
    { depth: 1, expanded: false }, // 2   sub/ (closed)
    { depth: 1, expanded: null }, //  3   b
    { depth: 0, expanded: null }, //  4 top
  ];

  it("moves up and down one row and stops at either end", () => {
    expect(treeKeyMove(rows, 1, "ArrowDown")).toEqual({ focus: 2 });
    expect(treeKeyMove(rows, 1, "ArrowUp")).toEqual({ focus: 0 });
    expect(treeKeyMove(rows, 4, "ArrowDown")).toBeNull();
    expect(treeKeyMove(rows, 0, "ArrowUp")).toBeNull();
  });

  it("jumps to the first and last row with Home and End", () => {
    expect(treeKeyMove(rows, 2, "Home")).toEqual({ focus: 0 });
    expect(treeKeyMove(rows, 2, "End")).toEqual({ focus: 4 });
  });

  it("opens a closed folder with Right, then steps into its first child", () => {
    expect(treeKeyMove(rows, 2, "ArrowRight")).toEqual({ toggle: 2 });
    expect(treeKeyMove(rows, 0, "ArrowRight")).toEqual({ focus: 1 });
    // An open folder with nothing in it, and a file, go nowhere.
    expect(treeKeyMove([{ depth: 0, expanded: true }, { depth: 0, expanded: null }], 0, "ArrowRight")).toBeNull();
    expect(treeKeyMove(rows, 1, "ArrowRight")).toBeNull();
  });

  it("closes an open folder with Left, else goes to the parent folder", () => {
    expect(treeKeyMove(rows, 0, "ArrowLeft")).toEqual({ toggle: 0 });
    expect(treeKeyMove(rows, 3, "ArrowLeft")).toEqual({ focus: 0 });
    expect(treeKeyMove(rows, 2, "ArrowLeft")).toEqual({ focus: 0 });
    // A top-level row has no parent.
    expect(treeKeyMove(rows, 4, "ArrowLeft")).toBeNull();
  });

  it("leaves every other key to the row", () => {
    expect(treeKeyMove(rows, 1, "Enter")).toBeNull();
    expect(treeKeyMove(rows, 1, " ")).toBeNull();
    expect(treeKeyMove([], 0, "ArrowDown")).toBeNull();
  });
});
