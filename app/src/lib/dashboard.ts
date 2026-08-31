// Chart dashboard — widget list + the pure data derivations behind each
// chart. Same architecture as the Views page: everything computes over data
// already in memory (adjacency.meta/tags, file mtimes, the task scan), no
// backend, and the user's composition persists in localStorage. Charts render
// in components/DashCharts.tsx; nothing here touches the DOM.

import type { Adjacency, TaskItem } from "./ipc";
import { runView } from "./queryViews";

export type DashDim = "types" | "confidence" | "status";

export type DashWidget =
  | { id: string; kind: "stats" }
  | { id: string; kind: "activity"; weeks: number }
  | { id: string; kind: "distribution"; dim: DashDim }
  | { id: string; kind: "tags"; topN: number }
  | { id: string; kind: "tasks" };

export type DashKind = DashWidget["kind"];

/** The default board a fresh vault opens with — one of each. */
export function defaultWidgets(): DashWidget[] {
  return [
    { id: "stats", kind: "stats" },
    { id: "activity", kind: "activity", weeks: 12 },
    { id: "dist-types", kind: "distribution", dim: "types" },
    { id: "tags", kind: "tags", topN: 8 },
    { id: "tasks", kind: "tasks" },
  ];
}

/** Fresh widget of `kind` with an id no existing widget carries. */
export function newWidget(kind: DashKind, existing: DashWidget[]): DashWidget {
  let n = existing.length + 1;
  let id = `${kind}-${n}`;
  while (existing.some((w) => w.id === id)) id = `${kind}-${(n += 1)}`;
  switch (kind) {
    case "activity":
      return { id, kind, weeks: 12 };
    case "distribution":
      return { id, kind, dim: "types" };
    case "tags":
      return { id, kind, topN: 8 };
    default:
      return { id, kind };
  }
}

// --- weekly activity ---------------------------------------------------------

export interface WeekBucket {
  /** Local-midnight Monday the bucket starts on (ms epoch). */
  startMs: number;
  count: number;
}

const WEEK_MS = 7 * 86_400_000;

/** Local-midnight Monday of the week containing `ms`. */
export function weekStartMs(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

/** Notes touched per week over the trailing `weeks` weeks (current week
 * last), zero-filled so a quiet week is a visible gap rather than a missing
 * bar. Mtimes are modification times — the honest label is "edits", not
 * "created". Bucket index rounds rather than floors: a DST shift makes two
 * Mondays 167 or 169 hours apart, and flooring would leak those weeks into a
 * neighbor. */
export function weeklyActivity(
  mtimesSecs: Iterable<number>,
  weeks: number,
  nowMs: number,
): WeekBucket[] {
  const first = weekStartMs(nowMs) - (weeks - 1) * WEEK_MS;
  const buckets: WeekBucket[] = Array.from({ length: weeks }, (_, i) => ({
    startMs: first + i * WEEK_MS,
    count: 0,
  }));
  for (const secs of mtimesSecs) {
    const idx = Math.round((weekStartMs(secs * 1000) - first) / WEEK_MS);
    if (idx >= 0 && idx < weeks) buckets[idx].count += 1;
  }
  return buckets;
}

// --- stat tiles ----------------------------------------------------------------

export interface DashStats {
  pages: number;
  openTasks: number;
  /** Pages citing nothing — the same count the Views "No sources" lens shows
   *  (runView's unsourcedOnly, structural pages excluded). */
  unsourced: number;
  editedThisWeek: number;
}

export function computeStats(
  adj: Adjacency,
  files: string[],
  tasks: TaskItem[],
  mtimes: Map<string, number>,
  nowMs: number,
): DashStats {
  const thisWeek = weekStartMs(nowMs);
  const wiki = new Set(files);
  let editedThisWeek = 0;
  for (const [path, secs] of mtimes) {
    if (wiki.has(path) && secs * 1000 >= thisWeek) editedThisWeek += 1;
  }
  return {
    pages: files.length,
    openTasks: tasks.filter((x) => !x.done).length,
    unsourced: runView(adj, files, { unsourcedOnly: true }).length,
    editedThisWeek,
  };
}

// --- tasks by status -----------------------------------------------------------

export interface StatusCount {
  status: TaskItem["status"];
  count: number;
}

/** Open states first, done last — the actionable rows lead. */
export function taskStatusCounts(tasks: TaskItem[]): StatusCount[] {
  const order: TaskItem["status"][] = ["todo", "doing", "blocked", "done"];
  return order.map((status) => ({
    status,
    count: tasks.filter((x) => x.status === status).length,
  }));
}

// --- persistence -----------------------------------------------------------

const KEY = "myco.dashboard.v1";
const KINDS: DashKind[] = ["stats", "activity", "distribution", "tags", "tasks"];

export function loadWidgets(): DashWidget[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultWidgets();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return defaultWidgets();
    const valid = parsed.filter(
      (w): w is DashWidget =>
        typeof w === "object" &&
        w !== null &&
        typeof (w as DashWidget).id === "string" &&
        KINDS.includes((w as DashWidget).kind),
    );
    // An emptied board stays empty on purpose — the user removed everything.
    return valid;
  } catch {
    return defaultWidgets();
  }
}

export function saveWidgets(widgets: DashWidget[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(widgets));
  } catch {
    /* localStorage unavailable — the board just doesn't persist */
  }
}
