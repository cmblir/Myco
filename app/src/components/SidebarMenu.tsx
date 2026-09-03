// SidebarMenu — the file tree's right-click context menu. Keyboard-operable;
// the bulk items (Move to…, Delete) act on `menu.paths`, which the Sidebar
// fills with the selection when the clicked row is part of it.

import { useEffect } from "react";
import type { JSX, KeyboardEvent } from "react";
import type { Strings } from "../lib/i18n";
import { useVaultStore } from "../stores/vaultStore";
import type { FileNode } from "../lib/ipc";
import {
  confirmAction,
  pickDialog,
  promptText,
  useDialogStore,
} from "../stores/dialogStore";
import { dropNested, folderChoices } from "../lib/treeOps";
import { promptNewNote } from "../lib/newNote";
import { newNoteFromTemplate } from "./TemplatePicker";

export interface ContextMenuState {
  x: number;
  y: number;
  node: FileNode;
  /** Paths the bulk items act on: the selection when `node` is in it, else `[node.path]`. */
  paths: string[];
  /** Element focused before the menu opened; focus returns to it on close. */
  opener: HTMLElement | null;
}

export function ContextMenu({
  menu,
  onClose,
  clearSelection,
  t,
}: {
  menu: ContextMenuState;
  onClose: () => void;
  /** Called after a move or delete, so a stale selection never lingers. */
  clearSelection: () => void;
  t: Strings;
}): JSX.Element {
  const createFolder = useVaultStore((s) => s.createFolder);
  const deletePath = useVaultStore((s) => s.deletePath);
  const renamePath = useVaultStore((s) => s.renamePath);
  const movePaths = useVaultStore((s) => s.movePaths);
  const toggleFavorite = useVaultStore((s) => s.toggleFavorite);
  const favorites = useVaultStore((s) => s.favorites);
  const root = useVaultStore((s) => s.currentVault?.path ?? "");
  const { node, paths } = menu;
  const many = paths.length > 1;
  // A folder and its children count once: the store acts on the ancestor only.
  const n = String(dropNested(paths).length);
  const starred = favorites.includes(node.path.slice(root.length + 1));

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
    const choices = folderChoices(useVaultStore.getState().fileTree, root, paths);
    if (choices.length === 0) return;
    const dir = await pickDialog({
      title: (t.sb_move_title ?? "Move {n} item(s) to").replace("{n}", n),
      body: <FolderList choices={choices} rootLabel={t.sb_move_root ?? "Vault root"} />,
    });
    if (!dir) return;
    await movePaths(paths, dir);
    clearSelection();
  }

  async function handleRename(): Promise<void> {
    onClose();
    const newName = await promptText({
      title: t.sb_rename ?? "Rename…",
      message: (t.sb_rename_msg ?? "Rename “{name}” to:").replace("{name}", node.name),
      defaultValue: node.name,
    });
    if (!newName || newName === node.name) return;
    await renamePath(node.path, newName);
  }

  async function handleDelete(): Promise<void> {
    onClose();
    const ok = await confirmAction({
      title: many
        ? (t.sb_delete_n_q ?? "Delete {n} items?").replace("{n}", n)
        : node.kind === "directory"
          ? (t.sb_delete_folder_q ?? "Delete folder?")
          : (t.sb_delete_file_q ?? "Delete file?"),
      // delete_path trashes (vault.rs), so say so instead of "permanently".
      message: many
        ? (t.sb_delete_msg ?? "{n} item(s) will move to the Trash.").replace("{n}", n)
        : (t.sb_delete_one_msg ?? "“{name}” will move to the Trash.").replace(
            "{name}",
            node.name,
          ),
      danger: true,
    });
    if (!ok) return;
    await deletePath(paths);
    clearSelection();
  }

  return (
    <ul
      className="myco-menu"
      style={{ left: menu.x, top: menu.y }}
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
}

/** Move-to destinations as full-width buttons; picking one closes the dialog with its path. */
function FolderList({
  choices,
  rootLabel,
}: {
  choices: { path: string; label: string }[];
  rootLabel: string;
}): JSX.Element {
  const close = useDialogStore((s) => s.close);
  return (
    <div style={{ display: "grid", gap: "0.35rem" }}>
      {choices.map((c) => (
        <button
          key={c.path}
          type="button"
          className="myco-modal__btn"
          style={{ width: "100%", textAlign: "left" }}
          onClick={() => close(c.path)}
        >
          {c.label || rootLabel}
        </button>
      ))}
    </div>
  );
}
