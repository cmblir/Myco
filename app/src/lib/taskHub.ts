// Month hub pages — `wiki/tasks/<YYYY-MM>.md`, one generated page per month
// with dated tasks. Scheduling is app state until it is a page: a hub node
// wikilinked from a task's own `[[project]]` link is what puts "what is due in
// August" next to the project in the graph, and it stays readable in Obsidian
// or on GitHub with myco closed.
//
// Rendering is pure and tested; only `writeTaskHubs` touches the vault.

import { ipc } from "./ipc";
import type { FileNode, TaskItem } from "./ipc";
import { parseTaskMeta } from "./taskLine";

/** Strings for the generated page. Passed in rather than read from a global so
 *  the hub is written in the app's language without this module importing the
 *  UI's i18n table. */
export interface HubLabels {
  /** e.g. `(m) => `${m} 일정`` */
  heading: (month: string) => string;
  empty: string;
}

const FRONTMATTER = [
  "---",
  "type: overview",
  "source_type: primary",
  "confidence: high",
  "status: active",
  "---",
].join("\n");

/** The guard that says myco owns this file. A hub a user has taken over (marker
 *  deleted) is never rewritten. */
export function hubMarker(month: string): string {
  return `<!-- myco:task-hub ${month} -->`;
}

export function hubPath(month: string): string {
  return `wiki/tasks/${month}.md`;
}

/** The dates a task sits on, in the order the hub reads them. */
function datesOf(task: TaskItem): {
  start: string;
  due: string;
  scheduled: string;
} {
  const { start, due, scheduled } = parseTaskMeta(task.text);
  return { start, due: due.slice(0, 10), scheduled };
}

/** `YYYY-MM` for every month any dated task touches, sorted. */
export function monthsWithTasks(tasks: TaskItem[]): string[] {
  const months = new Set<string>();
  for (const task of tasks) {
    const { start, due, scheduled } = datesOf(task);
    for (const iso of [start, due, scheduled]) {
      if (iso) months.add(iso.slice(0, 7));
    }
  }
  return [...months].sort();
}

interface Entry {
  sort: string;
  heading: string;
  line: string;
}

function entryOf(task: TaskItem): Entry | null {
  const { start, due, scheduled } = datesOf(task);
  const meta = parseTaskMeta(task.text);
  // Only wiki pages are in the graph, so only they become wikilinks: a
  // `[[daily/2026-08-24]]` would resolve to nothing and land in the citation
  // lint as a dangling link.
  const source = task.page.startsWith("wiki/")
    ? `[[${task.stem}]]`
    : task.page.replace(/\.md$/i, "");
  const from = start || due || scheduled;
  if (!from) return null;
  const to = start && due ? due : "";
  const day = (iso: string): string => iso.slice(5);
  const heading = to && to !== from ? `${day(from)} → ${day(to)}` : day(from);
  const done = meta.doneAt ? ` ✅ ${meta.doneAt}` : "";
  return {
    sort: `${from}-${to}`,
    heading,
    line: `- ${meta.title} — ${source}${done}`,
  };
}

/** The whole file for one month. Whole-file, because a hub is derived data:
 *  patching it in place would mean reconciling a user's edits with a
 *  regeneration, and the marker already says which files are ours to replace. */
export function renderTaskHub(
  month: string,
  tasks: TaskItem[],
  labels: HubLabels,
): string {
  const entries = tasks
    .filter((task) => {
      const { start, due, scheduled } = datesOf(task);
      return [start, due, scheduled].some((iso) => iso.startsWith(month));
    })
    .map(entryOf)
    .filter((e): e is Entry => e !== null)
    .sort(
      (a, b) => a.sort.localeCompare(b.sort) || a.line.localeCompare(b.line),
    );

  const head = `${FRONTMATTER}\n\n# ${labels.heading(month)}\n\n${hubMarker(month)}\n`;
  if (entries.length === 0) return `${head}\n${labels.empty}\n`;

  let out = head;
  let heading = "";
  for (const entry of entries) {
    if (entry.heading !== heading) {
      heading = entry.heading;
      out += `\n## ${heading}\n`;
    }
    out += `${entry.line}\n`;
  }
  return out;
}

/** `wiki/tasks/*.md` in the tree, as `YYYY-MM` month names. */
function existingHubMonths(tree: FileNode[]): string[] {
  const wiki = tree.find((n) => n.kind === "directory" && n.name === "wiki");
  if (!wiki || wiki.kind !== "directory") return [];
  const dir = wiki.children.find(
    (n) => n.kind === "directory" && n.name === "tasks",
  );
  if (!dir || dir.kind !== "directory") return [];
  return dir.children
    .filter((n) => n.kind === "file" && /^\d{4}-\d{2}\.md$/.test(n.name))
    .map((n) => n.name.replace(/\.md$/, ""));
}

export interface HubWriteResult {
  /** Vault-relative paths written. */
  written: string[];
  /** Paths left alone because their marker is gone — a user owns them now. */
  kept: string[];
}

/** Write the hub for each month in `months` (default: every month with a dated
 *  task, plus every hub already on disk, so a month that emptied is rewritten
 *  to its empty state instead of keeping a stale list).
 *
 *  A month with no tasks and no existing page writes nothing — an empty file
 *  per empty month would be noise in the vault and in the graph. */
export async function writeTaskHubs(
  vaultPath: string,
  tasks: TaskItem[],
  labels: HubLabels,
  months?: string[],
): Promise<HubWriteResult> {
  const onDisk = months
    ? []
    : existingHubMonths(await ipc.listFiles(vaultPath).catch(() => []));
  const wanted = [
    ...new Set([...(months ?? monthsWithTasks(tasks)), ...onDisk]),
  ].sort();
  const result: HubWriteResult = { written: [], kept: [] };
  if (wanted.length === 0) return result;

  for (const month of wanted) {
    const rel = hubPath(month);
    const body = renderTaskHub(month, tasks, labels);
    const existing = await ipc
      .readFile(`${vaultPath}/${rel}`)
      .catch(() => null);
    if (existing) {
      if (!existing.raw.includes(hubMarker(month))) {
        result.kept.push(rel);
        continue;
      }
    } else if (!body.includes("\n## ")) {
      // Nothing scheduled and no page to correct.
      continue;
    }
    // `create_folder` takes one name, not a path, and materializes a missing
    // parent — so `wiki/` is created on the way to `wiki/tasks/` if a vault
    // somehow has neither. Already-exists is the common case, hence the catch.
    await ipc.createFolder(`${vaultPath}/wiki`, "tasks").catch(() => undefined);
    await ipc.writeFile(`${vaultPath}/${rel}`, body);
    result.written.push(rel);
  }
  return result;
}
