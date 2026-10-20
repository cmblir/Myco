// Rename, move and delete, asked the same way wherever a note offers them
// (the file tree's right-click menu first), so the surfaces cannot drift.

import type { JSX } from "react";
import type { Strings } from "./i18n";
import { stripExt } from "../components/SidebarTree";
import { dropNested, folderChoices } from "./treeOps";
import { confirmAction, pickDialog, promptText, useDialogStore } from "../stores/dialogStore";
import { useUIStore } from "../stores/uiStore";
import { getDeletionPolicy } from "../stores/settingsStore";
import { useVaultStore } from "../stores/vaultStore";

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path;

/** Ask for a new name, then rename. A note is asked by its name as the tree
 *  and header show it (no `.md`) and keeps its `.md` when the answer has none:
 *  rename_path uses the name as given, and list_files keeps only markdown. The
 *  open note, its route, pending draft and favorite follow the rename
 *  (vaultStore.renamePath). */
export async function renameNote(path: string, t: Strings): Promise<void> {
  const name = baseName(path);
  const shown = stripExt(name);
  const typed = await promptText({
    title: t.sb_rename ?? "Rename…",
    message: (t.sb_rename_msg ?? "Rename “{name}” to:").replace("{name}", shown),
    defaultValue: shown,
    confirmLabel: t.dlg_rename,
  });
  if (!typed) return;
  const newName = shown !== name && !/\.md$/i.test(typed) ? typed + name.slice(shown.length) : typed;
  if (newName === name) return;
  await useVaultStore.getState().renamePath(path, newName);
}

/** Ask for a folder, then move `paths` into it. False when nothing moved. */
export async function moveNotes(paths: string[], t: Strings): Promise<boolean> {
  const { fileTree, currentVault, movePaths } = useVaultStore.getState();
  const choices = folderChoices(fileTree, currentVault?.path ?? "", paths);
  if (choices.length === 0) return false;
  const dir = await pickDialog({
    title: (t.sb_move_title ?? "Move {n} item(s) to").replace(
      "{n}",
      String(dropNested(paths).length),
    ),
    body: <FolderList choices={choices} rootLabel={t.sb_move_root ?? "Vault root"} />,
  });
  if (!dir) return false;
  await movePaths(paths, dir);
  return true;
}

/** Ask (a destructive confirm), then delete `paths` using the selected policy. When the
 *  open note went with them the reader has nothing left to show, so the app
 *  goes Home — unless the delete failed, which the reader then reports. False
 *  on Cancel. */
export async function deleteNotes(paths: string[], t: Strings, isFolder = false): Promise<boolean> {
  const many = paths.length > 1;
  const permanent = getDeletionPolicy();
  if (permanent === null) {
    useVaultStore.setState({ error: t.delete_policy_wait });
    return false;
  }
  // A folder and its children count once: the store acts on the ancestor only.
  const n = String(dropNested(paths).length);
  const ok = await confirmAction({
    title: many
      ? (t.sb_delete_n_q ?? "Delete {n} items?").replace("{n}", n)
      : isFolder
        ? (t.sb_delete_folder_q ?? "Delete folder?")
        : (t.sb_delete_file_q ?? "Delete file?"),
    message: permanent
      ? (many ? t.delete_permanent_msg.replace("{n}", n) : t.delete_permanent_one_msg.replace("{name}", baseName(paths[0])))
      : many
      ? (t.sb_delete_msg ?? "{n} item(s) will move to the Trash.").replace("{n}", n)
      : (t.sb_delete_one_msg ?? "“{name}” will move to the Trash.").replace(
          "{name}",
          baseName(paths[0]),
        ),
    danger: true,
  });
  if (!ok) return false;
  await useVaultStore.getState().deletePath(paths, permanent);
  const { route, setRoute } = useUIStore.getState();
  const open = route.startsWith("page:") ? route.slice("page:".length) : null;
  const gone = (p: string): boolean => open === p || !!open?.startsWith(`${p}/`);
  if (!useVaultStore.getState().error && paths.some(gone)) setRoute("overview");
  return true;
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
