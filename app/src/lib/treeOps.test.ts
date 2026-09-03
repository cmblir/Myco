import { describe, expect, it } from "vitest";
import type { FileNode } from "./ipc";
import {
  FAVORITES_ID,
  dropNested,
  filterMovable,
  flattenVisible,
  folderChoices,
  rangeBetween,
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
