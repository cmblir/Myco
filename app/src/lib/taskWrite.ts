// The one write path for a task checkbox — the Tasks page and the Topbar
// activity popover both mark a task done through here, so the stale-scan guard
// lives in exactly one place.

import { ipc } from "./ipc";
import type { TaskItem } from "./ipc";
import {
  setLineFields,
  type TaskField,
  type TaskMeta,
  type TaskStatus,
} from "./taskLine";
import { setLineStatusWithRecurrence } from "./taskRecurrence";

/** Rewrite `task`'s checkbox line to `status`, stamping the `✅` done date and
 * repeating a recurring task onto its next occurrence. Returns "stale" when the
 * note changed since the scan (that line is no longer a checkbox), in which
 * case nothing is written and the caller must rescan. IO errors propagate. */
export async function writeTaskStatus(
  vaultPath: string,
  task: TaskItem,
  status: TaskStatus,
): Promise<"ok" | "stale"> {
  const path = `${vaultPath}/${task.page}`;
  const { raw } = await ipc.readFile(path);
  const next = setLineStatusWithRecurrence(raw, task.line, status);
  if (next === null) return "stale";
  await ipc.writeFile(path, next);
  return "ok";
}

/** Rewrite `task`'s scheduling fields (an empty string clears one), leaving its
 * checkbox mark and every other line alone. Same "stale" contract as
 * `writeTaskStatus`: nothing is written and the caller must rescan. */
export async function writeTaskFields(
  vaultPath: string,
  task: TaskItem,
  patch: Partial<Pick<TaskMeta, TaskField>>,
): Promise<"ok" | "stale"> {
  const path = `${vaultPath}/${task.page}`;
  const { raw } = await ipc.readFile(path);
  const next = setLineFields(raw, task.line, patch);
  if (next === null) return "stale";
  await ipc.writeFile(path, next);
  return "ok";
}
