// Sidebar tree helpers: rendered row order, range selection, move filtering,
// synthetic groups (Favorites / Recently edited). Pure.

import type { FileNode } from "./ipc";

export const FAVORITES_ID = "__favorites";
export const RECENT_ID = "__recent";

type DirNode = Extract<FileNode, { kind: "directory" }>;

/** Paths in rendered row order: a collapsed directory contributes only itself. */
export function flattenVisible(
  tree: FileNode[],
  expanded: Record<string, boolean>,
): string[] {
  const out: string[] = [];
  const walk = (nodes: FileNode[]) => {
    for (const n of nodes) {
      out.push(n.path);
      if (n.kind === "directory" && expanded[n.path]) walk(n.children);
    }
  };
  walk(tree);
  return out;
}

/** Inclusive range between anchor and target in `order`, either direction;
 *  `[target]` when the anchor is absent or not in the order. */
export function rangeBetween(
  order: string[],
  anchor: string | null,
  target: string,
): string[] {
  const a = anchor === null ? -1 : order.indexOf(anchor);
  const t = order.indexOf(target);
  if (a < 0 || t < 0) return [target];
  return order.slice(Math.min(a, t), Math.max(a, t) + 1);
}

/** Drops paths whose ancestor is also listed: acting on the ancestor already covers them
 *  (a shift-range over an expanded folder selects the folder and its children). */
export function dropNested(paths: string[]): string[] {
  return paths.filter(
    (p) => !paths.some((q) => q !== p && p.startsWith(`${q}/`)),
  );
}

/** Drops no-ops (already in destDir) and impossible moves (destDir equals or is inside a path),
 *  then paths nested under another movable one (the ancestor's move carries them). */
export function filterMovable(paths: string[], destDir: string): string[] {
  return dropNested(
    paths.filter(
      (p) =>
        p.slice(0, p.lastIndexOf("/")) !== destDir &&
        destDir !== p &&
        !destDir.startsWith(`${p}/`),
    ),
  );
}

/** `to + rest` when `path` is `from` or under it, else null. */
export function rewritePrefix(path: string, from: string, to: string): string | null {
  if (path === from) return to;
  return path.startsWith(`${from}/`) ? to + path.slice(from.length) : null;
}

export function syntheticGroup(id: string, name: string, paths: string[]): DirNode {
  return {
    kind: "directory",
    name,
    path: id,
    children: paths.map((p) => ({
      kind: "file",
      name: p.slice(p.lastIndexOf("/") + 1),
      path: p,
    })),
  };
}

/** Move-to choices: root + every directory except raw/ (and below), synthetic
 *  ids, `moving` + descendants, and a directory that already holds every
 *  moving path. Labels are vault-relative; the root's is "" (caller names it). */
export function folderChoices(
  tree: FileNode[],
  root: string,
  moving: string[],
): { path: string; label: string }[] {
  const holdsAll = (dir: string) =>
    moving.every((m) => m.slice(0, m.lastIndexOf("/")) === dir);
  const out: { path: string; label: string }[] = [];
  const walk = (nodes: FileNode[]) => {
    for (const n of nodes) {
      if (
        n.kind !== "directory" ||
        n.path === FAVORITES_ID ||
        n.path === RECENT_ID ||
        n.path === `${root}/raw` ||
        moving.some((m) => n.path === m || n.path.startsWith(`${m}/`))
      )
        continue;
      if (!holdsAll(n.path)) out.push({ path: n.path, label: n.path.slice(root.length + 1) });
      walk(n.children);
    }
  };
  walk(tree);
  return holdsAll(root) ? out : [{ path: root, label: "" }, ...out];
}
