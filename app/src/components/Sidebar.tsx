// Sidebar — left navigation, Notion-flavored. Renders the real vault file
// tree recursively (Obsidian-style); each folder is collapsible and remembers
// its state per absolute path.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { JSX, KeyboardEvent, MouseEvent } from "react";
import { Icon, MycoMark } from "../lib/icons";
import "../styles/sidebar-brand.css";
import type { Strings } from "../lib/i18n";
import { useUIStore } from "../stores/uiStore";
import type { RouteId } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import { useStudyStore } from "../stores/studyStore";
import { useDistillStore } from "../stores/distillStore";
import { useHomeNotices, useNoticesStore } from "../stores/noticesStore";
import { useSettingsStore } from "../stores/settingsStore";
import { ipc } from "../lib/ipc";
import type { AuthorshipIndex, FileNode } from "../lib/ipc";
import { filterHumanTree } from "../lib/authorship";
import { flattenMarkdown } from "../lib/graphData";
import { openDailyNote } from "../lib/dailyNote";
import { promptNewNote } from "../lib/newNote";
import { today } from "../lib/taskLine";
import {
  FAVORITES_ID,
  RECENT_ID,
  ancestorDirs,
  flattenVisible,
  rangeBetween,
  syntheticGroup,
  treeKeyMove,
} from "../lib/treeOps";
import { noticeBadge } from "../lib/overviewReport";
import { recentAuthored } from "../lib/vaultPulse";
import { classifyTopLevel, vaultRel } from "../lib/vaultAreas";
import StatusStrip from "./StatusStrip";
import { ContextMenu } from "./SidebarMenu";
import type { ContextMenuState } from "./SidebarMenu";
import { TreeNode, allPaths, countFiles } from "./SidebarTree";
import type { RowClick, RowKey } from "./SidebarTree";
import SidebarTags from "./SidebarTags";

// Routes folded under the sidebar's Tools disclosure. Graph and Tasks are
// primary rows again: the graph is what the product is named for, and behind
// the disclosure it was two clicks away (UX backlog S3).
const TOOL_ROUTES: RouteId[] = ["study", "history", "provenance"];

// Synthetic group rows above the file tree: never selectable, no context menu.
const isGroup = (path: string): boolean => path === FAVORITES_ID || path === RECENT_ID;

// The collapsed area holding the folders myco keeps (UX backlog S15). Its
// open state lives with the folders' (uiStore.expandedFolders), closed by default.
const MANAGED_ID = "__managed";
// The Workspace group's fold (UX S43). Until the user picks, it starts folded
// in a short window: open, it left a 1024x700 window room for 5 tree rows.
const WORKSPACE_ID = "__workspace";
const SHORT_WINDOW_QUERY = "(max-height: 760px)";

/** The Workspace group's open state: the user's choice, else open unless the
 *  window is short. */
export function workspaceOpenFor(stored: boolean | undefined, shortWindow: boolean): boolean {
  return stored ?? !shortWindow;
}

function useShortWindow(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(SHORT_WINDOW_QUERY);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(SHORT_WINDOW_QUERY).matches,
  );
}

export default function Sidebar({ t }: { t: Strings }): JSX.Element {
  const route = useUIStore((s) => s.route);
  const setRoute = useUIStore((s) => s.setRoute);
  const toggleCmd = useUIStore((s) => s.toggleCmd);
  const toolsOpen = useUIStore((s) => s.toolsOpen);
  const toggleTools = useUIStore((s) => s.toggleTools);
  const expandFolders = useUIStore((s) => s.expandFolders);
  const fileTree = useVaultStore((s) => s.fileTree);
  const currentVault = useVaultStore((s) => s.currentVault);
  const isOpeningVault = useVaultStore((s) => s.isOpeningVault);
  const favorites = useVaultStore((s) => s.favorites);
  const error = useVaultStore((s) => s.error);
  const dueTotal = useStudyStore((s) => s.dueTotal);
  const refreshStudy = useStudyStore((s) => s.refresh);
  const pendingProposals = useDistillStore((s) => s.status?.pending_proposals ?? 0);
  const refreshDistill = useDistillStore((s) => s.refresh);
  // Home's notices badge the Home row: the bell's own value (noticeBadge),
  // loaded here too so the badge exists before Home is ever visited.
  const lang = useUIStore((s) => s.lang);
  const homeNotices = useHomeNotices();
  const homeNoticeCount = homeNotices.length;
  const homeBadge = noticeBadge(homeNotices, t, lang);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  // null until the first file_mtimes answer (or when it failed): Recently
  // edited is left out then, rather than reading 0 like a vault nobody edited.
  const [mtimes, setMtimes] = useState<[string, number][] | null>(null);
  // Human-only page filter (Q4 item 16): commit-granularity — hides pages the
  // agent author ever committed. Untracked pages stay (unknown, not agent),
  // hence the honest pill label "on record".
  const [humanOnly, setHumanOnly] = useState(false);
  const [agentTouched, setAgentTouched] = useState<AuthorshipIndex>({});
  const managedOpen = useUIStore((s) => s.expandedFolders[MANAGED_ID] ?? false);
  const shortWindow = useShortWindow();
  const workspaceOpen = workspaceOpenFor(
    useUIStore((s) => s.expandedFolders[WORKSPACE_ID]),
    shortWindow,
  );
  const toggleFolder = useUIStore((s) => s.toggleFolder);
  // Off on record: the hint says how to tell myco's notes apart. Unknown
  // (settings not loaded yet) shows nothing rather than a wrong hint.
  const historyOff = useSettingsStore((s) => s.settings?.vault_history_enabled === false);

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

  // A distill run or a fix lands as file changes, which refresh the tree.
  useEffect(() => {
    if (currentVault) void useNoticesStore.getState().load(currentVault.path);
  }, [currentVault, fileTree]);

  // Refetch the index when the tree changes (a distill run or agent edit lands
  // as file changes, which refreshes the tree). Always on: the tree marks the
  // pages myco wrote (S15), not only the filter.
  useEffect(() => {
    if (!currentVault) return;
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
  }, [currentVault, fileTree]);

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

  // Recently edited is fed by file mtimes, fetched even while the group is
  // collapsed so its count is real before the first click.
  // ponytail: Overview fetches the same list; hoist to vaultStore if the
  // double fetch per tree change ever shows in a profile.
  useEffect(() => {
    if (!currentVault) return;
    let cancelled = false;
    ipc
      .fileMtimes(currentVault.path)
      .catch(() => null)
      .then((m) => {
        if (!cancelled) setMtimes(m);
      });
    return () => {
      cancelled = true;
    };
  }, [currentVault, fileTree]);

  const visibleTree =
    humanOnly && currentVault
      ? filterHumanTree(fileTree, agentTouched, currentVault.path)
      : fileTree;
  const activePath = route.startsWith("page:") ? route.slice(5) : null;
  // Files stay where they are; only the drawing splits (S15).
  const mine = visibleTree.filter((n) => classifyTopLevel(n.name) === "mine");
  const managed = visibleTree.filter((n) => classifyTopLevel(n.name) === "managed");
  // Collapsed Tools row carries the badges of the rows it hides, summed —
  // only Study carries one now that the proposal queue is a primary row.
  const toolsBadge = dueTotal;
  const toolsBadgeLabel = `${t.nav_study} ${dueTotal}`;
  const proposalsLabel = (t.sb_proposals_badge ?? "{n} proposals awaiting review").replace(
    "{n}",
    String(pendingProposals),
  );

  const workspaceBadge = homeNoticeCount + pendingProposals;
  const workspaceBadgeLabel = [
    homeBadge ? homeBadge.label : "",
    pendingProposals > 0 ? proposalsLabel : "",
  ]
    .filter(Boolean)
    .join(", ");

  const root = currentVault?.path ?? "";
  // "by myco" on a page the agent committed; no row (no history) = no mark.
  const agentMark = (path: string): string | null =>
    agentTouched[vaultRel(path, root)] === true ? t.sb_agent_mark : null;

  // Reveal the open note wherever it was opened from (⌘K, Home, a citation):
  // expand its folders, then bring its row into view once they render. A note
  // just moved or renamed has no row until the refreshed tree lands, so the
  // reveal stays pending and the next tree change retries it — once only, so
  // later polls and agent writes never pull the list back to the note.
  const pendingReveal = useRef<string | null>(null);
  useEffect(() => {
    pendingReveal.current = activePath;
    if (!activePath) return;
    expandFolders(ancestorDirs(activePath, root));
    if (classifyTopLevel(vaultRel(activePath, root).split("/")[0]) === "managed")
      expandFolders([MANAGED_ID]);
    const raf = requestAnimationFrame(() => {
      if (revealRow(activePath)) pendingReveal.current = null;
    });
    return () => cancelAnimationFrame(raf);
  }, [activePath, root, expandFolders]);
  useEffect(() => {
    if (!pendingReveal.current) return;
    const raf = requestAnimationFrame(() => {
      const p = pendingReveal.current;
      if (p && revealRow(p)) pendingReveal.current = null;
    });
    return () => cancelAnimationFrame(raf);
  }, [fileTree]);

  // One Tab stop for the whole tree (UX S28): rows mount at tabIndex -1 and
  // this keeps exactly one at 0 as folders open and close. Done on the DOM
  // because a folder's rows re-render on their own (DirectoryRow subscribes
  // to its expanded flag), and React leaves an unchanged -1 prop alone.
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    syncTabStop(nav);
    const mo = new MutationObserver(() => syncTabStop(nav));
    mo.observe(nav, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, []);

  function onTreeKey(e: KeyboardEvent<HTMLElement>): void {
    const el = e.target;
    const nav = navRef.current;
    if (!nav || !(el instanceof HTMLElement) || !el.matches("[data-tree-row]")) return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const rows = treeRows(nav);
    const move = treeKeyMove(
      rows.map((r) => ({
        depth: Number(r.dataset.depth),
        expanded: r.hasAttribute("aria-expanded")
          ? r.getAttribute("aria-expanded") === "true"
          : null,
      })),
      rows.indexOf(el),
      e.key,
    );
    if (!move) return;
    e.preventDefault();
    if ("focus" in move) rows[move.focus].focus();
    else toggleFolder(rows[move.toggle].dataset.folder ?? "");
  }

  // Favorites and Recently edited follow the human-only filter too: built from
  // the whole tree, they kept the agent's notes in view, so turning it on
  // looked like it did nothing (UX S29).
  const displayTree = isOpeningVault
    ? []
    : [...sidebarGroups(t, root, visibleTree, favorites, mtimes), ...mine];

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
      const order = flattenVisible(
        [...mine, ...(managedOpen ? managed : [])],
        useUIStore.getState().expandedFolders,
      );
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

  // The ⋯ button or a long press (UX S49). Focus goes to the row first, so the
  // menu (a sheet on touch) hands it back there on close.
  function moreMenu(node: FileNode, row: HTMLElement): void {
    if (isGroup(node.path)) return;
    row.focus();
    const r = row.getBoundingClientRect();
    openMenu(r.right - 180, r.bottom, node, row);
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
          type="button"
          className="brand"
          onClick={() => setRoute("overview")}
          title={t.nav_overview}
          aria-label={t.nav_overview}
        >
          <span className="brand-mark" aria-hidden="true">
            <MycoMark size={32} />
          </span>
          <span className="brand-name">{t.app_name}</span>
        </button>
        {/* Settings rides the head row: as its own pinned row under the nav it
            cost the tree a line in a 700px window (UX S43). */}
        <button
          type="button"
          className={"icon-btn side-gear" + (route === "settings" ? " active" : "")}
          onClick={() => setRoute("settings")}
          title={t.nav_settings}
          aria-label={t.nav_settings}
          aria-current={route === "settings" ? "page" : undefined}
        >
          <Icon name="settings" size={15} />
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

      <nav
        className="side-nav"
        ref={navRef}
        onKeyDown={onTreeKey}
        onFocus={(e) => {
          const nav = navRef.current;
          if (nav && e.target instanceof HTMLElement && e.target.matches("[data-tree-row]"))
            syncTabStop(nav, e.target);
        }}
      >
        <div className={"nav-group" + (workspaceOpen ? "" : " is-folded")}>
          {/* Folds so a short window has room for the tree (UX S43); the
              state is remembered with the folders'. Folded, it carries the
              badges of the rows it hides, summed, like Tools below. */}
          <button
            className="nav-group-label nav-group-toggle"
            aria-expanded={workspaceOpen}
            onClick={() => toggleFolder(WORKSPACE_ID, !shortWindow)}
          >
            <span className={"ni-caret" + (workspaceOpen ? " open" : "")}>
              <Icon name="chevR" size={10} />
            </span>
            <span>{t.nav_workspace}</span>
            {!workspaceOpen && workspaceBadge > 0 ? (
              <span
                className="nav-badge"
                title={workspaceBadgeLabel}
                aria-label={workspaceBadgeLabel}
              >
                {workspaceBadge}
              </span>
            ) : null}
          </button>
          {/* Primary rows, one per verb: see / ask / put in / promote, then
              the graph and the task list. Badges mark what waits on a person — Home's
              notices (violet outline, the bell's count) and the proposal queue (violet fill),
              the one queue only a human decision shrinks. */}
          <NavItem
            label={t.nav_overview}
            icon="home"
            active={route === "overview"}
            onClick={() => setRoute("overview")}
            badge={homeBadge?.count}
            badgeTone="alert"
            badgeLabel={homeBadge?.label}
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
            label={t.nav_feedback ?? "Harvest box"}
            icon="inbox"
            active={route === "feedback"}
            onClick={() => setRoute("feedback")}
            badge={pendingProposals > 0 ? String(pendingProposals) : undefined}
            badgeTone="fill"
            badgeLabel={proposalsLabel}
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
                label={t.nav_study}
                icon="sparkles"
                active={route === "study"}
                onClick={() => setRoute("study")}
                badge={dueTotal > 0 ? String(dueTotal) : undefined}
              />
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
              title={t.auth_filter_hint ?? "Hide the notes myco has edited, going by their history"}
              onClick={() => setHumanOnly((v) => !v)}
            >
              {t.auth_filter_pill ?? "Human only (on record)"}
            </button>
          </div>
          {/* One composite widget for the arrow-key tree (UX S28): only the
              rows, so the pill buttons above stay plain Tab stops. */}
          <div
            role="tree"
            aria-label={t.sb_tree}
            aria-multiselectable="true"
            aria-busy={isOpeningVault}
          >
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
                onMore={moreMenu}
                moreLabel={t.sb_row_menu}
                mark={agentMark}
              />
            ))}
            {/* The folders myco writes and keeps, folded under one row so they
                stop weighing the same as the user's notes (S15). */}
            {!isOpeningVault && managed.length > 0 ? (
              <div role="none" style={{ marginTop: "0.5rem" }}>
                <button
                  className="nav-item"
                  data-tree-row
                  data-depth={0}
                  data-folder={MANAGED_ID}
                  tabIndex={-1}
                  role="treeitem"
                  aria-level={1}
                  aria-expanded={managedOpen}
                  onClick={() => toggleFolder(MANAGED_ID)}
                >
                  <span className={"ni-caret" + (managedOpen ? " open" : "")}>
                    <Icon name="chevR" size={10} />
                  </span>
                  <span className="ni-icon">
                    <Icon name="folder" size={14} />
                  </span>
                  <span className="ni-text">{t.sb_managed}</span>
                  <span className="ni-count">{countFiles(managed).toLocaleString()}</span>
                </button>
                {managedOpen ? (
                  <div role="group">
                    {historyOff ? (
                      <div className="muted" style={{ padding: "4px 8px 6px 18px", fontSize: 12.5 }}>
                        {t.sb_managed_hint}
                      </div>
                    ) : null}
                    {managed.map((node) => (
                      <TreeNode
                        key={node.path}
                        node={node}
                        depth={1}
                        activePath={activePath}
                        selected={selected}
                        onSelect={(p) => setRoute(`page:${p}`)}
                        onRowClick={onRowClick}
                        onRowKey={onRowKey}
                        onContextMenu={showMenu}
                        onMore={moreMenu}
                        moreLabel={t.sb_row_menu}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
          {isOpeningVault || visibleTree.length === 0 ? (
            <div
              className="muted"
              role={isOpeningVault ? "status" : undefined}
              style={{ padding: "8px", fontSize: 12.5 }}
            >
              {isOpeningVault
                ? t.st_loading
                : currentVault
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


        <SidebarTags t={t} />
      </nav>

      <StatusStrip t={t} />

      {menu ? (
        <ContextMenu
          key={menu.node.path}
          menu={menu}
          edited={mtimes?.find(([p]) => p === menu.node.path)?.[1]}
          onClose={() => setMenu(null)}
          clearSelection={clearSelection}
          t={t}
        />
      ) : null}
    </aside>
  );
}

/** Favorites (starred files that still exist, star order) and Recently edited
 *  (5 newest mtimes) as directory nodes, so TreeNode renders them like folders.
 *  Both list only files `fileTree` holds (the human-only filter's tree).
 *  A group with nothing true to show is left out: Favorites with no star,
 *  Recently edited without a vault or before its mtimes are known (`null`). */
export function sidebarGroups(
  t: Strings,
  root: string,
  fileTree: FileNode[],
  favorites: string[],
  mtimes: [string, number][] | null,
): FileNode[] {
  const existing = new Set(flattenMarkdown(fileTree));
  const favPaths = favorites
    .map((rel) => `${root}/${rel}`)
    .filter((p) => existing.has(p));
  const groups: FileNode[] = [];
  if (favPaths.length > 0) {
    groups.push(syntheticGroup(FAVORITES_ID, t.sb_favorites ?? "Favorites", favPaths));
  }
  if (root && mtimes) {
    groups.push(
      syntheticGroup(
        RECENT_ID,
        t.sb_recent ?? "Recently edited",
        recentAuthored(
          mtimes.filter(([p]) => existing.has(p)),
          root,
          5,
        ).map((r) => `${root}/${r.rel}`),
      ),
    );
  }
  return groups;
}

/** The tree's rows (pages and myco's folders) in rendered order. */
function treeRows(nav: HTMLElement): HTMLElement[] {
  return Array.from(nav.querySelectorAll<HTMLElement>("[data-tree-row]"));
}

/** Leave exactly one tree row reachable by Tab: `to`, else the one that
 *  already was, else the open note's row, else the first. */
function syncTabStop(nav: HTMLElement, to?: HTMLElement): void {
  const rows = treeRows(nav);
  const stop =
    to ??
    rows.find((r) => r.tabIndex === 0) ??
    rows.find((r) => r.classList.contains("active")) ??
    rows[0];
  for (const r of rows) {
    const want = r === stop ? 0 : -1;
    if (r.tabIndex !== want) r.tabIndex = want;
  }
}

/** Scroll the tree row for `path` into the sidebar's view, unless a row for it
 *  is already in view — a click on its Favorites / Recently edited copy must
 *  not yank the list away. The tree's own row is the last match: the groups
 *  render above it. False when no row exists yet, so the caller can retry. */
export function revealRow(path: string): boolean {
  const nav = document.querySelector(".sidebar .side-nav")?.getBoundingClientRect();
  const rows = Array.from(
    document.querySelectorAll(`.sidebar [data-path="${CSS.escape(path)}"]`),
  );
  if (!nav || rows.length === 0) return false;
  const inView = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    return r.top >= nav.top && r.bottom <= nav.bottom;
  };
  if (!rows.some(inView)) rows[rows.length - 1].scrollIntoView({ block: "nearest" });
  return true;
}

function NavItem({
  label,
  icon,
  active,
  onClick,
  badge,
  badgeTone,
  badgeLabel,
  indent,
}: {
  label: string;
  icon: Parameters<typeof Icon>[0]["name"];
  active: boolean;
  onClick: () => void;
  badge?: string;
  // fill = a queue only a human decision shrinks; alert = a count worth a
  // look; unset = the neutral sum a collapsed row carries.
  badgeTone?: "fill" | "alert";
  // What the number means, for the tooltip and the screen reader.
  badgeLabel?: string;
  // Depth-1 tree indent, for rows nested under the Tools disclosure.
  indent?: boolean;
}): JSX.Element {
  return (
    <button
      className={"nav-item" + (active ? " active" : "")}
      style={indent ? { paddingLeft: 18 } : undefined}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
    >
      <span className="ni-caret"></span>
      <span className="ni-icon">
        <Icon name={icon} size={15} />
      </span>
      <span className="ni-text">{label}</span>
      {badge ? (
        <span
          className={"nav-badge" + (badgeTone ? ` ${badgeTone}` : "")}
          title={badgeLabel}
          aria-label={badgeLabel}
        >
          {badge}
        </span>
      ) : null}
    </button>
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

function DailyNoteButton({
  vaultPath,
  t,
}: {
  vaultPath: string;
  t: Strings;
}): JSX.Element {
  return (
    <button
      className="qbtn"
      onClick={() => void openDailyNote(vaultPath, today())}
      disabled={!vaultPath}
    >
      <span className="qicon">
        <Icon name="page" />
      </span>
      <span>{t.sb_today_note ?? "Today's note"}</span>
    </button>
  );
}
