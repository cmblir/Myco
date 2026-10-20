// The store-side halves of a Tidy run that the sheet and Settings' undo both
// need: the vault as Tidy touches it, and the re-read after it wrote. Kept out
// of tidyStore, which the eager ⌘K palette imports, so lib/tidy* load only
// with the (lazy) sheet and Settings.

import { ipcTidyFs, type TidyFs } from "../lib/tidyRun";
import { useUIStore } from "./uiStore";
import { movePathFollowing, useVaultStore } from "./vaultStore";

/** The IPC, except that a move follows the page the way the sidebar's does
 *  (a pending draft, the route and favorites go with it), for apply and undo. */
export function tidyFs(vault: string): TidyFs {
  return {
    ...ipcTidyFs(vault),
    move: async (from, toDir) => {
      await movePathFollowing(`${vault}/${from}`, `${vault}/${toDir}`);
    },
  };
}

/** Re-read what Tidy changed: tree, graph, and the open page (at its new path
 *  if it moved), so an open editor adopts the new text instead of saving
 *  over it. */
export async function afterTidyWrite(
  vault: string,
  moved: { from: string; to: string }[],
): Promise<void> {
  const vs = useVaultStore.getState();
  await vs.refreshTree();
  await vs.refreshLinkGraph();
  const active = useVaultStore.getState().activeFile?.path;
  const hit = moved.find((m) => `${vault}/${m.from}` === active || `${vault}/${m.to}` === active);
  if (!hit) return;
  const now = `${vault}/${hit.to}`;
  if (now === active) await vs.openFile(now);
  else useUIStore.getState().setRoute(`page:${now}`);
}
