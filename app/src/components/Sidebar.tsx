// Sidebar — left navigation, Notion-flavored. Renders the real vault file
// tree recursively (Obsidian-style); each folder is collapsible and remembers
// its state per absolute path.

import { useState } from "react";
import type { JSX, MouseEvent } from "react";
import { Icon, MemexMark } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import { ipc } from "../lib/ipc";
import type { FileNode } from "../lib/ipc";
import { promptText, confirmAction } from "../stores/dialogStore";

interface ContextMenuState {
  x: number;
  y: number;
  node: FileNode | "vault";
}

export default function Sidebar({ t }: { t: Strings }): JSX.Element {
  const route = useUIStore((s) => s.route);
  const setRoute = useUIStore((s) => s.setRoute);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const toggleCmd = useUIStore((s) => s.toggleCmd);
  const fileTree = useVaultStore((s) => s.fileTree);
  const currentVault = useVaultStore((s) => s.currentVault);
  const openVault = useVaultStore((s) => s.openVault);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  async function pickVault(): Promise<void> {
    const path = await ipc.pickDirectory();
    if (path) await openVault(path);
  }

  const totalFiles = countFiles(fileTree);
  const activePath = route.startsWith("page:") ? route.slice(5) : null;

  function showMenu(e: MouseEvent, node: FileNode | "vault"): void {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, node });
  }

  return (
    <aside className="sidebar" onClick={() => setMenu(null)}>
      <div className="side-head">
        <button className="brand" onClick={toggleSidebar}>
          <span className="brand-mark">
            <MemexMark size={20} />
          </span>
          <span className="brand-name">{t.app_name}</span>
          <span className="brand-caret">
            <Icon name="sidebar" size={14} />
          </span>
        </button>
        <button
          className="proj-switch"
          onClick={() => void pickVault()}
          onContextMenu={(e) => showMenu(e, "vault")}
        >
          <span className="proj-icon">
            {currentVault?.name?.charAt(0).toUpperCase() ?? "·"}
          </span>
          <span className="proj-name">{currentVault?.name ?? "No vault"}</span>
          <span className="proj-meta">{totalFiles || ""}</span>
          <Icon name="chevD" size={12} />
        </button>
      </div>

      <div className="side-quick">
        <button className="qbtn" onClick={toggleCmd}>
          <span className="qicon">
            <Icon name="search" />
          </span>
          <span>{t.quick_search}</span>
          <span className="qkbd">⌘K</span>
        </button>
        <DailyNoteButton vaultPath={currentVault?.path ?? ""} />
        <button
          className={"qbtn" + (route === "ingest" ? " active" : "")}
          onClick={() => setRoute("ingest")}
        >
          <span className="qicon">
            <Icon name="upload" />
          </span>
          <span>{t.quick_ingest}</span>
        </button>
        <button
          className={"qbtn" + (route === "query" ? " active" : "")}
          onClick={() => setRoute("query")}
        >
          <span className="qicon">
            <Icon name="msg" />
          </span>
          <span>{t.quick_ask}</span>
        </button>
      </div>

      <nav className="side-nav">
        <div className="nav-group">
          <div className="nav-group-label">{t.nav_workspace}</div>
          <NavItem
            label={t.nav_overview}
            icon="home"
            active={route === "overview"}
            onClick={() => setRoute("overview")}
          />
          <NavItem
            label={t.nav_graph}
            icon="graph"
            active={route === "graph"}
            onClick={() => setRoute("graph")}
          />
          <NavItem
            label={t.nav_history}
            icon="history"
            active={route === "history"}
            onClick={() => setRoute("history")}
          />
          <NavItem
            label={t.nav_provenance}
            icon="quote"
            active={route === "provenance"}
            onClick={() => setRoute("provenance")}
          />
        </div>

        <div className="nav-group">
          <div className="nav-group-label">
            <span>{t.nav_pages}</span>
            <NewPageButton parentDir={currentVault?.path ?? ""} />
          </div>
          {fileTree.length === 0 ? (
            <div className="muted" style={{ padding: "8px", fontSize: 12.5 }}>
              {currentVault ? "Empty vault" : "No vault selected"}
            </div>
          ) : (
            fileTree.map((node) => (
              <TreeNode
                key={node.path}
                node={node}
                depth={0}
                activePath={activePath}
                onSelect={(p) => setRoute(`page:${p}`)}
                onContextMenu={showMenu}
              />
            ))
          )}
        </div>

        <div className="nav-group">
          <div className="nav-group-label">{t.nav_tools}</div>
          <NavItem
            label={t.nav_settings}
            icon="settings"
            active={route === "settings"}
            onClick={() => setRoute("settings")}
          />
        </div>
      </nav>

      <div className="side-foot">
        <div className="status-row">
          <span className="sdot"></span>
          <span>
            Vault <b>{currentVault ? "linked" : "—"}</b>
          </span>
          {currentVault ? (
            <span className="sr-action">{totalFiles}f</span>
          ) : null}
        </div>
      </div>

      {menu ? <ContextMenu menu={menu} onClose={() => setMenu(null)} /> : null}
    </aside>
  );
}

function NavItem({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: Parameters<typeof Icon>[0]["name"];
  active: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      className={"nav-item" + (active ? " active" : "")}
      onClick={onClick}
    >
      <span className="ni-caret"></span>
      <span className="ni-icon">
        <Icon name={icon} size={15} />
      </span>
      <span className="ni-text">{label}</span>
    </button>
  );
}

function TreeNode({
  node,
  depth,
  activePath,
  onSelect,
  onContextMenu,
}: {
  node: FileNode;
  depth: number;
  activePath: string | null;
  onSelect: (path: string) => void;
  onContextMenu: (e: MouseEvent, node: FileNode) => void;
}): JSX.Element {
  if (node.kind === "file") {
    const active = activePath === node.path;
    return (
      <button
        className={"nav-leaf" + (active ? " active" : "")}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={() => onSelect(node.path)}
        onContextMenu={(e) => onContextMenu(e, node)}
      >
        <Icon name="page" size={13} />
        <span className="nl-text">{stripExt(node.name)}</span>
      </button>
    );
  }
  return (
    <DirectoryRow
      node={node}
      depth={depth}
      activePath={activePath}
      onSelect={onSelect}
      onContextMenu={onContextMenu}
    />
  );
}

function DirectoryRow({
  node,
  depth,
  activePath,
  onSelect,
  onContextMenu,
}: {
  node: Extract<FileNode, { kind: "directory" }>;
  depth: number;
  activePath: string | null;
  onSelect: (path: string) => void;
  onContextMenu: (e: MouseEvent, node: FileNode) => void;
}): JSX.Element {
  const expanded = useUIStore((s) => s.expandedFolders[node.path] ?? false);
  const toggle = useUIStore((s) => s.toggleFolder);
  return (
    <>
      <button
        className="nav-item"
        style={{ paddingLeft: `${depth * 12 + 6}px` }}
        onClick={() => toggle(node.path)}
        onContextMenu={(e) => onContextMenu(e, node)}
      >
        <span className={"ni-caret" + (expanded ? " open" : "")}>
          <Icon name="chevR" size={10} />
        </span>
        <span className="ni-icon">
          <Icon name="folder" size={14} />
        </span>
        <span className="ni-text">{node.name}</span>
      </button>
      {expanded
        ? node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              activePath={activePath}
              onSelect={onSelect}
              onContextMenu={onContextMenu}
            />
          ))
        : null}
    </>
  );
}

function NewPageButton({ parentDir }: { parentDir: string }): JSX.Element {
  const createFile = useVaultStore((s) => s.createFile);
  return (
    <button
      className="ngl-add"
      title="New note in vault root"
      disabled={!parentDir}
      onClick={async (e) => {
        e.stopPropagation();
        if (!parentDir) return;
        const name = await promptText({
          title: "New note",
          message: "File name (.md will be added automatically)",
          placeholder: "untitled",
        });
        if (!name) return;
        const finalName = name.endsWith(".md") ? name : `${name}.md`;
        await createFile(parentDir, finalName);
      }}
    >
      <Icon name="plus" size={12} />
    </button>
  );
}

function ContextMenu({
  menu,
  onClose,
}: {
  menu: ContextMenuState;
  onClose: () => void;
}): JSX.Element {
  const currentVault = useVaultStore((s) => s.currentVault);
  const createFile = useVaultStore((s) => s.createFile);
  const createFolder = useVaultStore((s) => s.createFolder);
  const deletePath = useVaultStore((s) => s.deletePath);
  const renamePath = useVaultStore((s) => s.renamePath);

  function parentDir(): string {
    if (menu.node === "vault") return currentVault?.path ?? "";
    if (menu.node.kind === "directory") return menu.node.path;
    const parts = menu.node.path.split(/[\\/]/);
    parts.pop();
    return parts.join("/");
  }

  async function handleNewFile(): Promise<void> {
    onClose();
    const name = await promptText({
      title: "New note",
      message: "File name (.md will be added automatically)",
      defaultValue: "untitled.md",
    });
    if (!name) return;
    const finalName = name.endsWith(".md") ? name : `${name}.md`;
    await createFile(parentDir(), finalName);
  }

  async function handleNewFolder(): Promise<void> {
    onClose();
    const name = await promptText({
      title: "New folder",
      message: "Folder name",
    });
    if (!name) return;
    await createFolder(parentDir(), name);
  }

  async function handleRename(): Promise<void> {
    if (menu.node === "vault") return;
    const target = menu.node;
    onClose();
    const newName = await promptText({
      title: "Rename",
      message: `Rename "${target.name}" to:`,
      defaultValue: target.name,
    });
    if (!newName || newName === target.name) return;
    await renamePath(target.path, newName);
  }

  async function handleDelete(): Promise<void> {
    if (menu.node === "vault") return;
    const target = menu.node;
    onClose();
    const ok = await confirmAction({
      title: `Delete ${target.kind === "directory" ? "folder" : "file"}?`,
      message: `"${target.name}" will be permanently removed.`,
      danger: true,
    });
    if (!ok) return;
    await deletePath(target.path);
  }

  return (
    <ul
      className="memex-menu"
      style={{ left: menu.x, top: menu.y }}
      role="menu"
      onClick={(e) => e.stopPropagation()}
    >
      <li>
        <button type="button" onClick={() => void handleNewFile()}>
          New note
        </button>
      </li>
      <li>
        <button type="button" onClick={() => void handleNewFolder()}>
          New folder
        </button>
      </li>
      {menu.node !== "vault" ? (
        <>
          <li className="memex-menu__sep" />
          <li>
            <button type="button" onClick={() => void handleRename()}>
              Rename…
            </button>
          </li>
          <li>
            <button
              type="button"
              className="memex-menu__danger"
              onClick={() => void handleDelete()}
            >
              Delete
            </button>
          </li>
        </>
      ) : null}
    </ul>
  );
}

function stripExt(name: string): string {
  return name.replace(/\.md$/i, "");
}

function DailyNoteButton({ vaultPath }: { vaultPath: string }): JSX.Element {
  const setRoute = useUIStore((s) => s.setRoute);

  async function handle(): Promise<void> {
    if (!vaultPath) return;
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const dailyDir = `${vaultPath}/daily`;
    const filePath = `${dailyDir}/${today}.md`;
    try {
      await ipc.readFile(filePath);
      // exists — just open
    } catch {
      try {
        await ipc.createFolder(vaultPath, "daily");
      } catch {
        /* exists */
      }
      try {
        await ipc.createFile(dailyDir, `${today}.md`);
        const content = `# ${today}\n\n`;
        await ipc.writeFile(filePath, content);
      } catch {
        /* race */
      }
      await useVaultStore.getState().refreshTree();
    }
    setRoute(`page:${filePath}`);
  }

  return (
    <button
      className="qbtn"
      onClick={() => void handle()}
      disabled={!vaultPath}
    >
      <span className="qicon">
        <Icon name="page" />
      </span>
      <span>Today&apos;s note</span>
    </button>
  );
}

function countFiles(tree: FileNode[]): number {
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
