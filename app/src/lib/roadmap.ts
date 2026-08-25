// Roadmap pages — `wiki/roadmaps/<slug>.md`, ordinary wiki pages whose
// `## milestone` headings group checkbox items. The page IS the roadmap: its
// items reach the Tasks list/calendar through the normal scanner, the page is
// a graph node like any other, and a coding session reads/checks it over MCP.
// This module only lists, parses and seeds them; all writes go through the
// same task writers everything else uses.

import { ipc } from "./ipc";
import type { FileNode, TaskItem } from "./ipc";
import { today } from "./taskLine";

export const ROADMAPS_DIR = "wiki/roadmaps";

export interface RoadmapMilestone {
  /** `## heading` text, or "" for items above the first heading. */
  heading: string;
  /** Line numbers (1-based) of this milestone's checkbox items. */
  lines: number[];
  done: number;
  total: number;
}

export interface Roadmap {
  /** Vault-relative page path. */
  page: string;
  stem: string;
  title: string;
  milestones: RoadmapMilestone[];
  done: number;
  total: number;
}

/** `wiki/roadmaps/*.md` files in the tree, vault-relative. */
export function roadmapPages(
  tree: FileNode[],
): { path: string; stem: string }[] {
  const wiki = tree.find((n) => n.kind === "directory" && n.name === "wiki");
  if (!wiki || wiki.kind !== "directory") return [];
  const dir = wiki.children.find(
    (n) => n.kind === "directory" && n.name === "roadmaps",
  );
  if (!dir || dir.kind !== "directory") return [];
  return dir.children
    .filter((n): n is Extract<FileNode, { kind: "file" }> => n.kind === "file")
    .filter((n) => /\.md$/i.test(n.name))
    .map((n) => ({
      path: `${ROADMAPS_DIR}/${n.name}`,
      stem: n.name.replace(/\.md$/i, ""),
    }));
}

/** Parse one roadmap page's raw text. `tasks` is the scanner's rows for this
 *  page — statuses come from there so the view and the list can never
 *  disagree about what counts as done. */
export function parseRoadmap(
  page: string,
  stem: string,
  raw: string,
  tasks: TaskItem[],
): Roadmap {
  const byLine = new Map(tasks.map((x) => [x.line, x]));
  const milestones: RoadmapMilestone[] = [];
  let current: RoadmapMilestone = { heading: "", lines: [], done: 0, total: 0 };
  let title = stem;
  raw.split("\n").forEach((line, i) => {
    const h1 = /^#\s+(.+)$/.exec(line);
    if (h1) title = h1[1].trim();
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h2) {
      if (current.total > 0 || current.heading) milestones.push(current);
      current = { heading: h2[1].trim(), lines: [], done: 0, total: 0 };
      return;
    }
    const task = byLine.get(i + 1);
    if (task) {
      current.lines.push(task.line);
      current.total += 1;
      if (task.done) current.done += 1;
    }
  });
  if (current.total > 0 || current.heading) milestones.push(current);
  const done = milestones.reduce((n, m) => n + m.done, 0);
  const total = milestones.reduce((n, m) => n + m.total, 0);
  return { page, stem, title, milestones, done, total };
}

export function roadmapSlug(title: string): string {
  return (
    title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9가-힣]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "roadmap"
  );
}

/** Seed content for a new roadmap page. `type: overview` keeps it out of the
 *  wiki lint's citation rules — the same choice as the month hubs. */
export function newRoadmapContent(title: string): string {
  return [
    "---",
    `title: ${JSON.stringify(title.trim())}`,
    "type: overview",
    "source_type: primary",
    "confidence: high",
    "status: active",
    `created: ${today()}`,
    "---",
    "",
    `# ${title.trim()}`,
    "",
    "## Milestone 1",
    "",
  ].join("\n");
}

/** Create `wiki/roadmaps/<slug>.md`; returns the vault-relative path. Refuses
 *  to overwrite an existing page — two roadmaps under one title is a naming
 *  problem the user should see, not a silent merge. */
export async function createRoadmap(
  vaultPath: string,
  title: string,
): Promise<string> {
  const rel = `${ROADMAPS_DIR}/${roadmapSlug(title)}.md`;
  const exists = await ipc.readFile(`${vaultPath}/${rel}`).then(
    () => true,
    () => false,
  );
  if (exists) throw new Error(`already exists: ${rel}`);
  await ipc
    .createFolder(`${vaultPath}/wiki`, "roadmaps")
    .catch(() => undefined);
  await ipc.writeFile(`${vaultPath}/${rel}`, newRoadmapContent(title));
  return rel;
}
