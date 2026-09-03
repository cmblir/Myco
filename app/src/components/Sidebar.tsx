// Sidebar — left navigation, Notion-flavored. Renders the real vault file
// tree recursively (Obsidian-style); each folder is collapsible and remembers
// its state per absolute path.

import { useEffect, useState } from "react";
import type { JSX, MouseEvent } from "react";
import { Icon, MycoMark } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { useUIStore } from "../stores/uiStore";
import type { RouteId } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import { useStudyStore } from "../stores/studyStore";
import { useDistillStore } from "../stores/distillStore";
import { ipc } from "../lib/ipc";
import type { AuthorshipIndex, FileNode } from "../lib/ipc";
import { filterHumanTree } from "../lib/authorship";
import { promptText, confirmAction } from "../stores/dialogStore";
import { promptNewNote } from "../lib/newNote";
import { today } from "../lib/taskLine";

interface ContextMenuState {
  x: number;
  y: number;
  node: FileNode;
}

// Routes folded under the sidebar's Tools disclosure.
const TOOL_ROUTES: RouteId[] = [
  "history",
  "provenance",
  "tags",
  "study",
  "feedback",
  "schedules",
];

export default function Sidebar({ t }: { t: Strings }): JSX.Element {
  const route = useUIStore((s) => s.route);
  const setRoute = useUIStore((s) => s.setRoute);
  const toggleCmd = useUIStore((s) => s.toggleCmd);
  const toolsOpen = useUIStore((s) => s.toolsOpen);
  const toggleTools = useUIStore((s) => s.toggleTools);
  const fileTree = useVaultStore((s) => s.fileTree);
  const currentVault = useVaultStore((s) => s.currentVault);
  const dueTotal = useStudyStore((s) => s.dueTotal);
  const refreshStudy = useStudyStore((s) => s.refresh);
  const pendingProposals = useDistillStore((s) => s.status?.pending_proposals ?? 0);
  const refreshDistill = useDistillStore((s) => s.refresh);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  // Human-only page filter (Q4 item 16): commit-granularity — hides pages the
  // agent author ever committed. Untracked pages stay (unknown, not agent),
  // hence the honest pill label "on record".
  const [humanOnly, setHumanOnly] = useState(false);
  const [agentTouched, setAgentTouched] = useState<AuthorshipIndex>({});

  // Keep the sidebar due badge current: refresh when the vault's files change
  // (a review or generation rewrites cards/<deck>.md, which refreshes the tree).
  useEffect(() => {
    void refreshStudy();
  }, [refreshStudy, fileTree]);

  // Same trigger for the feedback badge — a distill run (or an apply/dismiss,
  // both of which write under work/feedback/) changes the vault's file set too.
  useEffect(() => {
    void refreshDistill();
  }, [refreshDistill, fileTree]);

  // Refetch the index when the tree changes (a distill run or agent edit lands
  // as file changes, which refreshes the tree) — but only while the filter is on.
  useEffect(() => {
    if (!humanOnly || !currentVault) return;
    let cancelled = false;
    ipc.authorshipIndex(currentVault.path).then(
      (idx) => {
        if (!cancelled) setAgentTouched(idx);
      },
      // No repo / lookup failure ⇒ empty index: the filter keeps everything.
      () => {
        if (!cancelled) setAgentTouched({});
      },
    );
    return () => {
      cancelled = true;
    };
  }, [humanOnly, currentVault, fileTree]);

  const totalFiles = countFiles(fileTree);
  const visibleTree =
    humanOnly && currentVault
      ? filterHumanTree(fileTree, agentTouched, currentVault.path)
      : fileTree;
  const activePath = route.startsWith("page:") ? route.slice(5) : null;
  // Collapsed Tools row carries the badges of the rows it hides, summed.
  const toolsBadge = dueTotal + pendingProposals;
  const toolsBadgeLabel = `${t.nav_study} ${dueTotal} · ${t.nav_feedback ?? "Feedback"} ${pendingProposals}`;

  function showMenu(e: MouseEvent, node: FileNode): void {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, node });
  }

  return (
    <aside className="sidebar" onClick={() => setMenu(null)}>
      <div className="side-head">
        {/* The mark goes HOME. It used to toggle the sidebar, duplicating the
            Topbar's collapse button — two controls for one action, and the
            caret made this one look like the canonical one. */}
        <button
          className="brand"
          onClick={() => setRoute("overview")}
          title={t.nav_overview}
        >
          <span className="brand-mark">
            <MycoMark size={24} />
          </span>
          <span className="brand-name">{t.app_name}</span>
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
        <DailyNoteButton vaultPath={currentVault?.path ?? ""} t={t} />
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
            label={t.nav_query}
            icon="msg"
            active={route === "query"}
            onClick={() => setRoute("query")}
          />
          <NavItem
            label={t.nav_ingest}
            icon="upload"
            active={route === "ingest"}
            onClick={() => setRoute("ingest")}
          />
          <NavItem
            label={t.nav_graph}
            icon="graph"
            active={route === "graph"}
            onClick={() => setRoute("graph")}
          />
          <NavItem
            label={t.nav_tasks ?? "Tasks"}
            icon="check"
            active={route === "tasks"}
            onClick={() => setRoute("tasks")}
          />
          <NavItem
            label={t.nav_views ?? "Views"}
            icon="eye"
            active={route === "views"}
            onClick={() => setRoute("views")}
          />
        </div>

        <div className="nav-group">
          {/* Folder-row disclosure. Collapsed, it stands in for the routes it
              hides: active when one is open, badged with their summed counts. */}
          <button
            className={
              "nav-item" +
              (!toolsOpen && TOOL_ROUTES.includes(route) ? " active" : "")
            }
            aria-expanded={toolsOpen}
            onClick={toggleTools}
          >
            <span className={"ni-caret" + (toolsOpen ? " open" : "")}>
              <Icon name="chevR" size={10} />
            </span>
            <span className="ni-icon">
              <Icon name="dotMore" size={15} />
            </span>
            <span className="ni-text">{t.nav_tools}</span>
            {!toolsOpen && toolsBadge > 0 ? (
              <span
                className="nav-badge"
                title={toolsBadgeLabel}
                aria-label={toolsBadgeLabel}
              >
                {toolsBadge}
              </span>
            ) : null}
          </button>
          {toolsOpen ? (
            <>
              <NavItem
                indent
                label={t.nav_history}
                icon="history"
                active={route === "history"}
                onClick={() => setRoute("history")}
              />
              <NavItem
                indent
                label={t.nav_provenance}
                icon="quote"
                active={route === "provenance"}
                onClick={() => setRoute("provenance")}
              />
              <NavItem
                indent
                label={t.nav_tags}
                icon="book"
                active={route === "tags"}
                onClick={() => setRoute("tags")}
              />
              <NavItem
                indent
                label={t.nav_study}
                icon="sparkles"
                active={route === "study"}
                onClick={() => setRoute("study")}
                badge={dueTotal > 0 ? String(dueTotal) : undefined}
              />
              <NavItem
                indent
                label={t.nav_feedback ?? "Feedback"}
                icon="inbox"
                active={route === "feedback"}
                onClick={() => setRoute("feedback")}
                badge={
                  pendingProposals > 0 ? String(pendingProposals) : undefined
                }
              />
              <NavItem
                indent
                label={t.nav_schedules}
                icon="history"
                active={route === "schedules"}
                onClick={() => setRoute("schedules")}
              />
            </>
          ) : null}
        </div>

        <div className="nav-group">
          <div className="nav-group-label">
            <span>{t.nav_pages}</span>
            <NewPageButton disabled={!currentVault} t={t} />
            <button
              className={"pill auth-filter" + (humanOnly ? " is-active" : "")}
              disabled={!currentVault}
              aria-pressed={humanOnly}
              onClick={() => setHumanOnly((v) => !v)}
            >
              {t.auth_filter_pill ?? "Human only (on record)"}
            </button>
          </div>
          {visibleTree.length === 0 ? (
            <div className="muted" style={{ padding: "8px", fontSize: 12.5 }}>
              {currentVault ? "Empty vault" : "No vault selected"}
            </div>
          ) : (
            visibleTree.map((node) => (
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

      </nav>

      {/* Pinned OUTSIDE the scrolling nav: these used to sit below the page
          tree, so a 1121-file vault put 설정 an endless scroll away. */}
      <div className="side-tools">
        <NavItem
          label={t.nav_settings}
          icon="settings"
          active={route === "settings"}
          onClick={() => setRoute("settings")}
        />
      </div>

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

      {menu ? (
        <ContextMenu menu={menu} onClose={() => setMenu(null)} t={t} />
      ) : null}
    </aside>
  );
}

function NavItem({
  label,
  icon,
  active,
  onClick,
  badge,
  indent,
}: {
  label: string;
  icon: Parameters<typeof Icon>[0]["name"];
  active: boolean;
  onClick: () => void;
  badge?: string;
  // Depth-1 tree indent, for rows nested under the Tools disclosure.
  indent?: boolean;
}): JSX.Element {
  return (
    <button
      className={"nav-item" + (active ? " active" : "")}
      style={indent ? { paddingLeft: 18 } : undefined}
      onClick={onClick}
    >
      <span className="ni-caret"></span>
      <span className="ni-icon">
        <Icon name={icon} size={15} />
      </span>
      <span className="ni-text">{label}</span>
      {badge ? <span className="nav-badge">{badge}</span> : null}
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
        {/* How many notes a folder hides, so a row that detonates into 985 says
            so before it is clicked. `.ni-count` and countFiles both already
            exist — this is the badge the nav items use. */}
        <span className="ni-count">{countFiles([node]).toLocaleString()}</span>
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

function NewPageButton({
  disabled,
  t,
}: {
  disabled: boolean;
  t: Strings;
}): JSX.Element {
  return (
    <button
      className="ngl-add"
      title={t.sb_new_note ?? "New note"}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        void promptNewNote(t);
      }}
    >
      <Icon name="plus" size={13} />
      <span className="ngl-add__label">{t.sb_new_note ?? "New note"}</span>
    </button>
  );
}

function ContextMenu({
  menu,
  onClose,
  t,
}: {
  menu: ContextMenuState;
  onClose: () => void;
  t: Strings;
}): JSX.Element {
  const createFolder = useVaultStore((s) => s.createFolder);
  const deletePath = useVaultStore((s) => s.deletePath);
  const renamePath = useVaultStore((s) => s.renamePath);

  function parentDir(): string {
    if (menu.node.kind === "directory") return menu.node.path;
    const parts = menu.node.path.split(/[\\/]/);
    parts.pop();
    return parts.join("/");
  }

  async function handleNewFile(): Promise<void> {
    onClose();
    await promptNewNote(t, parentDir());
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
    const target = menu.node;
    onClose();
    const ok = await confirmAction({
      title:
        target.kind === "directory"
          ? (t.sb_delete_folder_q ?? "Delete folder?")
          : (t.sb_delete_file_q ?? "Delete file?"),
      message: `"${target.name}" will be permanently removed.`,
      danger: true,
    });
    if (!ok) return;
    await deletePath(target.path);
  }

  return (
    <ul
      className="myco-menu"
      style={{ left: menu.x, top: menu.y }}
      role="menu"
      onClick={(e) => e.stopPropagation()}
    >
      <li>
        <button type="button" onClick={() => void handleNewFile()}>
          {t.sb_new_note ?? "New note"}
        </button>
      </li>
      <li>
        <button type="button" onClick={() => void handleNewFolder()}>
          {t.sb_new_folder ?? "New folder"}
        </button>
      </li>
      <li className="myco-menu__sep" />
      <li>
        <button type="button" onClick={() => void handleRename()}>
          {t.sb_rename ?? "Rename…"}
        </button>
      </li>
      <li>
        <button
          type="button"
          className="myco-menu__danger"
          onClick={() => void handleDelete()}
        >
          {t.dlg_delete}
        </button>
      </li>
    </ul>
  );
}

function stripExt(name: string): string {
  return name.replace(/\.md$/i, "");
}

function DailyNoteButton({
  vaultPath,
  t,
}: {
  vaultPath: string;
  t: Strings;
}): JSX.Element {
  const setRoute = useUIStore((s) => s.setRoute);

  async function handle(): Promise<void> {
    if (!vaultPath) return;
    const day = today();
    const dailyDir = `${vaultPath}/daily`;
    const filePath = `${dailyDir}/${day}.md`;
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
        await ipc.createFile(dailyDir, `${day}.md`);
        const content = `# ${day}\n\n`;
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
      <span>{t.sb_today_note ?? "Today's note"}</span>
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
