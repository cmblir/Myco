// SidebarTree — the recursive vault file tree rows rendered by Sidebar
// (Obsidian-style); each folder is collapsible and remembers its state per
// absolute path. Nothing here closes over Sidebar's own state: selection and
// menu behaviour arrive through RowProps. Rows are not Tab stops of their
// own: Sidebar keeps one of them at tabIndex 0 and moves focus with the
// arrow keys (`data-tree-row`, UX S28), so they carry the WAI-ARIA tree
// roles inside Sidebar's role="tree".

import type { JSX, KeyboardEvent, MouseEvent } from "react";
import { listedName } from "../lib/displayName";
import { Icon } from "../lib/icons";
import { useLongPress } from "../lib/longPress";
import type { IconName } from "../lib/icons";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
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
  /** A short tag after a file's name ("by myco"), or null for none. */
  mark?: (path: string) => string | null;
  /** Opens the row's menu from its ⋯ button or a long press (UX S49);
   *  `row` is the tree item, where focus returns. No ⋯ without it. */
  onMore?: (node: FileNode, row: HTMLElement) => void;
  /** The ⋯ button's name, `{name}` standing for the row's ("{name} menu"). */
  moreLabel?: string;
}

/** The row's ⋯ button: a sibling of the tree item (a button cannot hold one),
 *  out of the Tab order the tree walks with arrows; keyboards have Shift+F10.
 *  Always shown to a finger, on hover or focus to a mouse (styles.css). */
function MoreButton({
  node,
  name,
  row,
}: {
  node: FileNode;
  name: string;
  row: RowProps;
}): JSX.Element | null {
  if (!row.onMore) return null;
  const onMore = row.onMore;
  return (
    <button
      type="button"
      className="tree-more"
      tabIndex={-1}
      aria-label={(row.moreLabel ?? "{name}").replace("{name}", name)}
      onClick={(e) => {
        e.stopPropagation();
        const item = e.currentTarget.previousElementSibling;
        if (item instanceof HTMLElement) onMore(node, item);
      }}
    >
      <Icon name="dotMore" size={14} />
    </button>
  );
}

/** Long press on a tree item opens the same menu as its ⋯ (touch only). */
function useRowPress(node: FileNode, row: RowProps) {
  return useLongPress((el) => row.onMore?.(node, el));
}

export function TreeNode({ node, ...row }: RowProps & { node: FileNode }): JSX.Element {
  const title = useVaultStore((s) => s.adjacency?.meta?.[node.path]?.title);
  const press = useRowPress(node, row);
  if (node.kind === "file") {
    const active = row.activePath === node.path;
    const isSel = row.selected.has(node.path);
    const mark = row.mark?.(node.path);
    const name = listedName(stripExt(node.name), title);
    return (
      <div className="tree-row" role="none">
        <button
          {...press}
          className={
            "nav-leaf" + (active ? " active" : "") + (isSel ? " is-selected" : "")
          }
          style={{ paddingLeft: `${row.depth * 12 + 8}px` }}
          data-path={node.path}
          data-tree-row
          data-depth={row.depth}
          tabIndex={-1}
          role="treeitem"
          aria-level={row.depth + 1}
          aria-selected={isSel}
          onClick={(e) => {
            if (row.onRowClick(e, node) === "pass") row.onSelect(node.path);
          }}
          onKeyDown={(e) => row.onRowKey(e, node)}
          onKeyUp={preventSpaceClick}
          onContextMenu={(e) => row.onContextMenu(e, node)}
        >
          <Icon name={isSel ? "check" : "page"} size={13} />
          <span className="nl-text" title={stripExt(node.name)}>
            {name}
          </span>
          {mark ? <span className="ni-count nl-mark">{mark}</span> : null}
        </button>
        <MoreButton node={node} name={name} row={row} />
      </div>
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
  const press = useRowPress(node, row);
  return (
    <>
      <div className="tree-row" role="none">
        <button
          {...(groupIcon ? {} : press)}
          className={"nav-item" + (isSel ? " is-selected" : "")}
          style={{ paddingLeft: `${row.depth * 12 + 6}px` }}
          data-tree-row
          data-depth={row.depth}
          data-folder={node.path}
          tabIndex={-1}
          role="treeitem"
          aria-level={row.depth + 1}
          aria-expanded={expanded}
          aria-selected={groupIcon ? undefined : isSel}
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
        {groupIcon ? null : <MoreButton node={node} name={node.name} row={row} />}
      </div>
      {expanded ? (
        <div role="group">
          {node.children.map((child) => (
            <TreeNode key={child.path} node={child} {...row} depth={row.depth + 1} />
          ))}
        </div>
      ) : null}
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
