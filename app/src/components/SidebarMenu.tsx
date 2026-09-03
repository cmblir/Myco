// SidebarMenu — the file tree's right-click context menu. Lifted out of
// Sidebar.tsx unchanged so the tree and its menu evolve in separate files.

import type { JSX } from "react";
import type { Strings } from "../lib/i18n";
import { useVaultStore } from "../stores/vaultStore";
import type { FileNode } from "../lib/ipc";
import { promptText, confirmAction } from "../stores/dialogStore";
import { promptNewNote } from "../lib/newNote";
import { newNoteFromTemplate } from "./TemplatePicker";

export interface ContextMenuState {
  x: number;
  y: number;
  node: FileNode;
}

export function ContextMenu({
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

  async function handleNewFromTemplate(): Promise<void> {
    onClose();
    await newNoteFromTemplate(t, parentDir());
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
      <li>
        <button type="button" onClick={() => void handleNewFromTemplate()}>
          {t.tpl_new_from ?? "New note from template…"}
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
