// SidebarTree — the recursive vault file tree rows rendered by Sidebar
// (Obsidian-style); each folder is collapsible and remembers its state per
// absolute path. Nothing here closes over Sidebar's own state: selection and
// menu behaviour arrive through RowProps.

import type { JSX, KeyboardEvent, MouseEvent } from "react";
import { Icon } from "../lib/icons";
import type { IconName } from "../lib/icons";
import { useUIStore } from "../stores/uiStore";
import type { FileNode } from "../lib/ipc";
import { FAVORITES_ID, RECENT_ID } from "../lib/treeOps";

// Synthetic group rows above the file tree: never selectable, no context menu.
const GROUP_ICON: Partial<Record<string, IconName>> = {
  [FAVORITES_ID]: "star",
  [RECENT_ID]: "history",
};

export type RowClick = (e: MouseEvent, node: FileNode) => "handled" | "pass";

// Space toggles selection on keydown; some engines fire a button's click on
// keyup, so that must be prevented too or the row would also open/expand.
function preventSpaceClick(e: KeyboardEvent<HTMLButtonElement>): void {
  if (e.key === " ") e.preventDefault();
}
export type RowKey = (e: KeyboardEvent<HTMLButtonElement>, node: FileNode) => void;

export interface RowProps {
  depth: number;
  activePath: string | null;
  selected: ReadonlySet<string>;
  onSelect: (path: string) => void;
  onRowClick: RowClick;
  onRowKey: RowKey;
  onContextMenu: (e: MouseEvent, node: FileNode) => void;
}

export function TreeNode({ node, ...row }: RowProps & { node: FileNode }): JSX.Element {
  if (node.kind === "file") {
    const active = row.activePath === node.path;
    const isSel = row.selected.has(node.path);
    return (
      <button
        className={
          "nav-leaf" + (active ? " active" : "") + (isSel ? " is-selected" : "")
        }
        style={{ paddingLeft: `${row.depth * 12 + 8}px` }}
        aria-pressed={isSel}
        onClick={(e) => {
          if (row.onRowClick(e, node) === "pass") row.onSelect(node.path);
        }}
        onKeyDown={(e) => row.onRowKey(e, node)}
        onKeyUp={preventSpaceClick}
        onContextMenu={(e) => row.onContextMenu(e, node)}
      >
        <Icon name={isSel ? "check" : "page"} size={13} />
        <span className="nl-text">{stripExt(node.name)}</span>
      </button>
    );
  }
  return <DirectoryRow node={node} {...row} />;
}

export function DirectoryRow({
  node,
  ...row
}: RowProps & { node: Extract<FileNode, { kind: "directory" }> }): JSX.Element {
  const expanded = useUIStore((s) => s.expandedFolders[node.path] ?? false);
  const toggle = useUIStore((s) => s.toggleFolder);
  const groupIcon = GROUP_ICON[node.path];
  const isSel = row.selected.has(node.path);
  return (
    <>
      <button
        className={"nav-item" + (isSel ? " is-selected" : "")}
        style={{ paddingLeft: `${row.depth * 12 + 6}px` }}
        aria-pressed={groupIcon ? undefined : isSel}
        onClick={(e) => {
          if (row.onRowClick(e, node) === "pass") toggle(node.path);
        }}
        onKeyDown={(e) => row.onRowKey(e, node)}
        onKeyUp={preventSpaceClick}
        onContextMenu={(e) => row.onContextMenu(e, node)}
      >
        <span className={"ni-caret" + (expanded ? " open" : "")}>
          <Icon name="chevR" size={10} />
        </span>
        <span className="ni-icon">
          <Icon name={isSel ? "check" : (groupIcon ?? "folder")} size={14} />
        </span>
        <span className="ni-text">{node.name}</span>
        {/* How many notes a folder hides, so a row that detonates into 985 says
            so before it is clicked. `.ni-count` and countFiles both already
            exist — this is the badge the nav items use. */}
        <span className="ni-count">{countFiles([node]).toLocaleString()}</span>
      </button>
      {expanded
        ? node.children.map((child) => (
            <TreeNode key={child.path} node={child} {...row} depth={row.depth + 1} />
          ))
        : null}
    </>
  );
}

export function stripExt(name: string): string {
  return name.replace(/\.md$/i, "");
}

/** Every file and directory path in the tree. */
export function allPaths(tree: FileNode[]): Set<string> {
  const out = new Set<string>();
  const stack = [...tree];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    out.add(node.path);
    if (node.kind === "directory") stack.push(...node.children);
  }
  return out;
}

export function countFiles(tree: FileNode[]): number {
  let n = 0;
  const stack = [...tree];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (node.kind === "file") n++;
    else stack.push(...node.children);
  }
  return n;
}
