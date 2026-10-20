// SidebarMenu — the file tree's right-click context menu. Keyboard-operable;
// the bulk items (Move to…, Delete) act on `menu.paths`, which the Sidebar
// fills with the selection when the clicked row is part of it.

import { useEffect } from "react";
import type { JSX, KeyboardEvent } from "react";
import type { Strings } from "../lib/i18n";
import { useUIStore } from "../stores/uiStore";
import { useVaultStore } from "../stores/vaultStore";
import type { FileNode } from "../lib/ipc";
import { promptText } from "../stores/dialogStore";
import { dropNested } from "../lib/treeOps";
import { deleteNotes, moveNotes, renameNote } from "../lib/noteActions";
import { promptNewNote } from "../lib/newNote";
import { newNoteFromTemplate } from "./TemplatePicker";
import { Sheet, useSheetMode } from "./ui";
import { stripExt } from "./SidebarTree";

export interface ContextMenuState {
  x: number;
  y: number;
  node: FileNode;
  /** Paths the bulk items act on: the selection when `node` is in it, else `[node.path]`. */
  paths: string[];
  /** Element focused before the menu opened; focus returns to it on close. */
  opener: HTMLElement | null;
}

/** "Edited {date}" for a sheet's head; nothing for an unknown time. */
export function editedLine(t: Strings, lang: string, secs: number | undefined): string | undefined {
  if (!secs) return undefined;
  let date: string;
  try {
    date = new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(secs * 1000),
    );
  } catch {
    date = new Date(secs * 1000).toISOString().slice(0, 16).replace("T", " ");
  }
  return t.sb_edited.replace("{date}", date);
}

export function ContextMenu({
  menu,
  edited,
  onClose,
  clearSelection,
  t,
}: {
  menu: ContextMenuState;
  /** The row's last change (unix seconds), shown in the sheet's head. */
  edited?: number;
  onClose: () => void;
  /** Called after a move or delete, so a stale selection never lingers. */
  clearSelection: () => void;
  t: Strings;
}): JSX.Element {
  const createFolder = useVaultStore((s) => s.createFolder);
  const toggleFavorite = useVaultStore((s) => s.toggleFavorite);
  const favorites = useVaultStore((s) => s.favorites);
  const root = useVaultStore((s) => s.currentVault?.path ?? "");
  const { node, paths } = menu;
  const many = paths.length > 1;
  // A folder and its children count once: the store acts on the ancestor only.
  const n = String(dropNested(paths).length);
  const starred = favorites.includes(node.path.slice(root.length + 1));
  const lang = useUIStore((s) => s.lang);
  // A phone width or a touch screen: the same items rise as a sheet (UX S49).
  const sheet = useSheetMode();

  useEffect(() => () => menu.opener?.focus(), [menu.opener]);

  function parentDir(): string {
    if (node.kind === "directory") return node.path;
    const parts = node.path.split(/[\\/]/);
    parts.pop();
    return parts.join("/");
  }

  function onKey(e: KeyboardEvent<HTMLUListElement>): void {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(e.currentTarget.querySelectorAll("button"));
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const len = items.length;
    items[e.key === "ArrowDown" ? (i + 1) % len : (i - 1 + len) % len].focus();
  }

  async function handleNewFile(): Promise<void> {
    onClose();
    await promptNewNote(t, parentDir());
  }

  async function handleNewFolder(): Promise<void> {
    onClose();
    const name = await promptText({
      title: t.sb_new_folder ?? "New folder",
      message: t.sb_new_folder_msg ?? "Folder name",
    });
    if (!name) return;
    await createFolder(parentDir(), name);
  }

  async function handleNewFromTemplate(): Promise<void> {
    onClose();
    await newNoteFromTemplate(t, parentDir());
  }

  function handleFavorite(): void {
    onClose();
    void toggleFavorite(node.path);
  }

  async function handleMove(): Promise<void> {
    onClose();
    if (await moveNotes(paths, t)) clearSelection();
  }

  async function handleRename(): Promise<void> {
    onClose();
    await renameNote(node.path, t);
  }

  async function handleDelete(): Promise<void> {
    onClose();
    if (await deleteNotes(paths, t, node.kind === "directory")) clearSelection();
  }

  const list = (
    <ul
      className="myco-menu"
      style={sheet ? undefined : { left: menu.x, top: menu.y }}
      role="menu"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={onKey}
    >
      <li>
        <button type="button" autoFocus onClick={() => void handleNewFile()}>
          {t.sb_new_note ?? "New note"}
        </button>
      </li>
      <li>
        <button type="button" onClick={() => void handleNewFromTemplate()}>
          {t.tpl_new_from ?? "New note from template…"}
        </button>
      </li>
      <li>
        <button type="button" onClick={() => void handleNewFolder()}>
          {t.sb_new_folder ?? "New folder"}
        </button>
      </li>
      <li className="myco-menu__sep" />
      {/* Favorites lists markdown only (flattenMarkdown), so a starred other file would be invisible. */}
      {node.kind === "file" && /\.md$/i.test(node.name) ? (
        <li>
          <button type="button" onClick={handleFavorite}>
            {starred
              ? (t.sb_fav_remove ?? "Remove from favorites")
              : (t.sb_fav_add ?? "Add to favorites")}
          </button>
        </li>
      ) : null}
      <li>
        <button type="button" onClick={() => void handleMove()}>
          {t.sb_move_to ?? "Move to…"}
        </button>
      </li>
      {many ? null : (
        <li>
          <button type="button" onClick={() => void handleRename()}>
            {t.sb_rename ?? "Rename…"}
          </button>
        </li>
      )}
      <li>
        <button
          type="button"
          className="myco-menu__danger"
          onClick={() => void handleDelete()}
        >
          {many ? (t.sb_delete_n ?? "Delete {n} items").replace("{n}", n) : t.dlg_delete}
        </button>
      </li>
    </ul>
  );
  if (!sheet) return list;
  return (
    <Sheet
      title={many ? t.sb_n_items.replace("{n}", n) : stripExt(node.name)}
      meta={many ? undefined : editedLine(t, lang, edited)}
      closeLabel={t.ui_close}
      onClose={onClose}
    >
      {list}
    </Sheet>
  );
}
