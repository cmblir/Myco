// Sidebar — left navigation, Notion-flavored. Renders the real vault file
// tree recursively (Obsidian-style); each folder is collapsible and remembers
// its state per absolute path.

import { useEffect, useState } from "react";
import type { JSX, KeyboardEvent, MouseEvent } from "react";
import { Icon, MycoMark } from "../lib/icons";
import type { IconName } from "../lib/icons";
import type { Strings } from "../lib/i18n";
import { useUIStore } from "../stores/uiStore";
import type { RouteId } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import { useStudyStore } from "../stores/studyStore";
import { useDistillStore } from "../stores/distillStore";
import { ipc } from "../lib/ipc";
import type { AuthorshipIndex, FileNode } from "../lib/ipc";
import { filterHumanTree } from "../lib/authorship";
import { flattenMarkdown } from "../lib/graphData";
import { promptNewNote } from "../lib/newNote";
import { today } from "../lib/taskLine";
import {
  FAVORITES_ID,
  RECENT_ID,
  flattenVisible,
  rangeBetween,
  syntheticGroup,
} from "../lib/treeOps";
import { recentAuthored } from "../lib/vaultPulse";
import { ContextMenu } from "./SidebarMenu";
import type { ContextMenuState } from "./SidebarMenu";

// Routes folded under the sidebar's Tools disclosure.
const TOOL_ROUTES: RouteId[] = [
  "history",
  "provenance",
  "tags",
  "study",
  "feedback",
  "schedules",
];

// Synthetic group rows above the file tree: never selectable, no context menu.
const GROUP_ICON: Partial<Record<string, IconName>> = {
  [FAVORITES_ID]: "star",
  [RECENT_ID]: "history",
};
const isGroup = (path: string): boolean => path === FAVORITES_ID || path === RECENT_ID;

type RowClick = (e: MouseEvent, node: FileNode) => "handled" | "pass";

// Space toggles selection on keydown; some engines fire a button's click on
// keyup, so that must be prevented too or the row would also open/expand.
function preventSpaceClick(e: KeyboardEvent<HTMLButtonElement>): void {
  if (e.key === " ") e.preventDefault();
}
type RowKey = (e: KeyboardEvent<HTMLButtonElement>, node: FileNode) => void;

export default function Sidebar({ t }: { t: Strings }): JSX.Element {
  const route = useUIStore((s) => s.route);
  const setRoute = useUIStore((s) => s.setRoute);
  const toggleCmd = useUIStore((s) => s.toggleCmd);
  const toolsOpen = useUIStore((s) => s.toolsOpen);
  const toggleTools = useUIStore((s) => s.toggleTools);
  const recentOpen = useUIStore((s) => s.expandedFolders[RECENT_ID] ?? false);
  const fileTree = useVaultStore((s) => s.fileTree);
  const currentVault = useVaultStore((s) => s.currentVault);
  const favorites = useVaultStore((s) => s.favorites);
  const error = useVaultStore((s) => s.error);
  const dueTotal = useStudyStore((s) => s.dueTotal);
  const refreshStudy = useStudyStore((s) => s.refresh);
  const pendingProposals = useDistillStore((s) => s.status?.pending_proposals ?? 0);
  const refreshDistill = useDistillStore((s) => s.refresh);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [mtimes, setMtimes] = useState<[string, number][]>([]);
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

  // Selection is per vault.
  useEffect(() => {
    setSelected(new Set());
    setAnchor(null);
  }, [currentVault]);

  // Drop selected paths the tree no longer holds (moved, deleted, external edit).
  useEffect(() => {
    const live = allPaths(fileTree);
    setSelected((s) => {
      const next = new Set(Array.from(s).filter((p) => live.has(p)));
      return next.size === s.size ? s : next;
    });
  }, [fileTree]);

  // Recently edited is fed by file mtimes, fetched only while the group is
  // open so a collapsed group never walks the vault.
  useEffect(() => {
    if (!recentOpen || !currentVault) return;
    let cancelled = false;
    ipc
      .fileMtimes(currentVault.path)
      .catch(() => [])
      .then((m) => {
        if (!cancelled) setMtimes(m);
      });
    return () => {
      cancelled = true;
    };
  }, [recentOpen, currentVault, fileTree]);

  const totalFiles = countFiles(fileTree);
  const visibleTree =
    humanOnly && currentVault
      ? filterHumanTree(fileTree, agentTouched, currentVault.path)
      : fileTree;
  const activePath = route.startsWith("page:") ? route.slice(5) : null;
  // Collapsed Tools row carries the badges of the rows it hides, summed.
  const toolsBadge = dueTotal + pendingProposals;
  const toolsBadgeLabel = `${t.nav_study} ${dueTotal} · ${t.nav_feedback ?? "Feedback"} ${pendingProposals}`;

  // Favorites (starred files that still exist, star order) and Recently edited
  // (5 newest mtimes) as directory nodes, so TreeNode renders them like folders.
  const root = currentVault?.path ?? "";
  const existing = new Set(flattenMarkdown(fileTree));
  const favPaths = favorites
    .map((rel) => `${root}/${rel}`)
    .filter((p) => existing.has(p));
  const groups: FileNode[] = [];
  if (favPaths.length > 0) {
    groups.push(syntheticGroup(FAVORITES_ID, t.sb_favorites ?? "Favorites", favPaths));
  }
  if (currentVault) {
    groups.push(
      syntheticGroup(
        RECENT_ID,
        t.sb_recent ?? "Recently edited",
        recentAuthored(mtimes, root, 5).map((r) => `${root}/${r.rel}`),
      ),
    );
  }
  const displayTree = [...groups, ...visibleTree];

  function clearSelection(): void {
    setSelected(new Set());
    setAnchor(null);
  }

  function toggleSelected(path: string): void {
    setSelected((s) => {
      const next = new Set(s);
      if (!next.delete(path)) next.add(path);
      return next;
    });
    setAnchor(path);
  }

  // Modifier clicks select; a plain click clears the selection and lets the
  // row's own behaviour (open / expand) run. Group rows never select.
  const onRowClick: RowClick = (e, node) => {
    if (isGroup(node.path)) return "pass";
    if (e.metaKey || e.ctrlKey) {
      toggleSelected(node.path);
      return "handled";
    }
    if (e.shiftKey) {
      // Rendered order of the real tree only, so a collapsed folder's children
      // are never included and a starred/recent copy of a file never aliases
      // the range to the group row. A Shift-click on a group leaf yields [target].
      const order = flattenVisible(visibleTree, useUIStore.getState().expandedFolders);
      setSelected(new Set(rangeBetween(order, anchor, node.path)));
      return "handled";
    }
    setSelected(new Set());
    setAnchor(node.path);
    return "pass";
  };

  const onRowKey: RowKey = (e, node) => {
    if (isGroup(node.path)) return;
    if (e.key === " ") {
      e.preventDefault();
      toggleSelected(node.path);
    } else if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") {
      e.preventDefault();
      const r = e.currentTarget.getBoundingClientRect();
      openMenu(r.left + 12, r.bottom, node, e.currentTarget);
    }
  };

  function openMenu(x: number, y: number, node: FileNode, opener: Element | null): void {
    setMenu({
      x,
      y,
      node,
      // The bulk items act on the selection only when the row is part of it.
      paths: selected.has(node.path) ? Array.from(selected) : [node.path],
      opener: opener instanceof HTMLElement ? opener : null,
    });
  }

  function showMenu(e: MouseEvent, node: FileNode): void {
    e.preventDefault();
    e.stopPropagation();
    if (isGroup(node.path)) return;
    // Re-targeting from inside the open menu: keep the original opener so focus
    // returns to the row, not to a menu button that is about to unmount.
    const inMenu = document.activeElement?.closest(".myco-menu");
    openMenu(e.clientX, e.clientY, node, inMenu ? (menu?.opener ?? null) : document.activeElement);
  }

  return (
    <aside
      className="sidebar"
      onClick={() => setMenu(null)}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          setMenu(null);
          clearSelection();
        }
      }}
    >
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
            {selected.size > 0 ? (
              <button
                className="pill sb-sel"
                title={t.sb_clear_selection ?? "Clear selection"}
                aria-label={t.sb_clear_selection ?? "Clear selection"}
                onClick={clearSelection}
              >
                {(t.sb_selected ?? "{n} selected").replace("{n}", String(selected.size))} ×
              </button>
            ) : null}
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
          {displayTree.map((node) => (
            <TreeNode
              key={node.path}
              node={node}
              depth={0}
              activePath={activePath}
              selected={selected}
              onSelect={(p) => setRoute(`page:${p}`)}
              onRowClick={onRowClick}
              onRowKey={onRowKey}
              onContextMenu={showMenu}
            />
          ))}
          {visibleTree.length === 0 ? (
            <div className="muted" style={{ padding: "8px", fontSize: 12.5 }}>
              {currentVault
                ? (t.sb_empty_vault ?? "Empty vault")
                : (t.sb_no_vault ?? "No vault selected")}
            </div>
          ) : null}
          {error ? (
            <div className="sb-error" role="alert">
              {error}
            </div>
          ) : null}
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
        <ContextMenu
          key={menu.node.path}
          menu={menu}
          onClose={() => setMenu(null)}
          clearSelection={clearSelection}
          t={t}
        />
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

interface RowProps {
  depth: number;
  activePath: string | null;
  selected: ReadonlySet<string>;
  onSelect: (path: string) => void;
  onRowClick: RowClick;
  onRowKey: RowKey;
  onContextMenu: (e: MouseEvent, node: FileNode) => void;
}

function TreeNode({ node, ...row }: RowProps & { node: FileNode }): JSX.Element {
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

function DirectoryRow({
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

/** Every file and directory path in the tree. */
function allPaths(tree: FileNode[]): Set<string> {
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
