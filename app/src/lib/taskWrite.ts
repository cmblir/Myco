// The one write path for a task checkbox — the Tasks page and the Topbar
// activity popover both mark a task done through here, so the stale-scan guard
// lives in exactly one place.

import { ipc } from "./ipc";
import type { TaskItem } from "./ipc";
import { setLineStatus, type TaskStatus } from "./taskLine";

/** Rewrite `task`'s checkbox line to `status`. Returns "stale" when the note
 * changed since the scan (that line is no longer a checkbox), in which case
 * nothing is written and the caller must rescan. IO errors propagate. */
export async function writeTaskStatus(
  vaultPath: string,
  task: TaskItem,
  status: TaskStatus,
): Promise<"ok" | "stale"> {
  const path = `${vaultPath}/${task.page}`;
  const { raw } = await ipc.readFile(path);
  const next = setLineStatus(raw, task.line, status);
  if (next === null) return "stale";
  await ipc.writeFile(path, next);
  return "ok";
}
