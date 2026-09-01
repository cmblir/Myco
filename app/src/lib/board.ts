// Overview board — the Looker-style customizable widget grid. Three layers,
// each borrowed from what real dashboards converged on (2026-08 research):
//
//   1. Layout = pure data: react-grid-layout's {i,x,y,w,h} integers on a
//      12-column grid (Grafana/Redash/Datadog's shared model).
//   2. Widget = a QUESTION, not a hardcoded kind: {source × filters ×
//      groupBy × view} (Metabase questions / Obsidian Bases), so users
//      assemble charts the developer never anticipated.
//   3. The whole board is ONE JSON document in the vault
//      (.myco/dashboards/overview.json) — a file, not app state: git, backup,
//      hand-editing and copy-sharing all come free (Grafana's JSON model).
//
// Everything here is pure or IO-thin; charts render in components/.

import { ipc } from "./ipc";
import type { Adjacency, InflowDay, TaskItem } from "./ipc";
import { stem } from "./graphData";

// --- document ----------------------------------------------------------------

export type BoardSource = "notes" | "inflow" | "tasks";
export type BoardView = "bar" | "line" | "hbar" | "stat" | "table";
/** Global range values; a widget may override with one of its own or "auto". */
export type BoardRange = "7d" | "30d" | "90d" | "all";

export interface BoardFilter {
  field: string;
  value: string;
}

export interface BoardQuery {
  source: BoardSource;
  /** Dimension. notes: type|confidence|status|tag|day · inflow: day|channel ·
   *  tasks: status. Measure is always count — the only measure this data has. */
  groupBy: string;
  filters: BoardFilter[];
  limit?: number;
}

export interface ColorRule {
  op: ">=" | ">" | "<=" | "<" | "=";
  value: number;
  /** Semantic, not decorative: maps to the app's risk/ok tokens. */
  color: "risk" | "ok";
}

export interface BoardWidget {
  id: string;
  kind: "query" | "text" | "heading";
  /** User-renamable; empty = the editor shows a generated summary. */
  title?: string;
  /** kind text/heading: the markdown / heading line. */
  text?: string;
  query?: BoardQuery;
  view?: BoardView;
  /** "auto" follows the board's global range (Grafana's one-global rule). */
  time?: "auto" | BoardRange;
  colorRules?: ColorRule[];
  /** Visibility condition (HA-style, data flavor): in view mode a widget
   *  whose total is 0 disappears and frees its grid space — the quiet board.
   *  Edit mode always shows it. */
  hideWhenZero?: boolean;
  /** Single-series color override — one of the validated hues (a CSS var).
   *  Identity colors (type/channel) still win: color follows the entity. */
  color?: string;
  /** Display aliases for row labels ("source-summary" → "요약"). Applied at
   *  render only — the underlying data keeps its real names. */
  aliases?: Record<string, string>;
}

export interface BoardLayoutItem {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BoardDoc {
  version: 1;
  range: BoardRange;
  /** vertical = gravity up (default), none = free whitespace grouping. */
  compact: "vertical" | "none";
  widgets: BoardWidget[];
  layout: BoardLayoutItem[];
}

export const BOARD_COLS = 12;
export const BOARD_ROW_PX = 48;
export const DEFAULT_BOARD = "overview";
export function boardRel(name: string): string {
  return `.myco/dashboards/${name}.json`;
}

/** Per-view floor sizes (grid units) — the widget declares what it needs to
 *  not break, the grid enforces it (Home Assistant's getGridOptions contract,
 *  static edition). */
export function minSize(w: BoardWidget): { minW: number; minH: number } {
  if (w.kind === "heading") return { minW: 3, minH: 1 };
  if (w.kind === "text") return { minW: 2, minH: 2 };
  switch (w.view) {
    case "stat":
      return { minW: 2, minH: 2 };
    case "table":
    case "hbar":
      return { minW: 3, minH: 3 };
    default:
      return { minW: 4, minH: 3 };
  }
}

export function defaultSize(w: BoardWidget): { w: number; h: number } {
  if (w.kind === "heading") return { w: 12, h: 1 };
  if (w.kind === "text") return { w: 4, h: 3 };
  switch (w.view) {
    case "stat":
      return { w: 3, h: 2 };
    case "table":
    case "hbar":
      return { w: 4, h: 4 };
    default:
      return { w: 6, h: 4 };
  }
}

export function emptyBoard(): BoardDoc {
  return { version: 1, range: "30d", compact: "vertical", widgets: [], layout: [] };
}

/** Place a new widget below everything on the left, at its declared size. */
export function appendWidget(doc: BoardDoc, w: BoardWidget): BoardDoc {
  const bottom = doc.layout.reduce((m, l) => Math.max(m, l.y + l.h), 0);
  const size = defaultSize(w);
  return {
    ...doc,
    widgets: [...doc.widgets, w],
    layout: [...doc.layout, { i: w.id, x: 0, y: bottom, ...size }],
  };
}

export function removeWidget(doc: BoardDoc, id: string): BoardDoc {
  return {
    ...doc,
    widgets: doc.widgets.filter((w) => w.id !== id),
    layout: doc.layout.filter((l) => l.i !== id),
  };
}

/** Deep-copy a widget below the board — the real customization workflow is
 *  "duplicate, then change one field", not blank-form creation (Datadog). */
export function duplicateWidget(doc: BoardDoc, id: string): BoardDoc {
  const src = doc.widgets.find((w) => w.id === id);
  if (!src) return doc;
  const copy: BoardWidget = JSON.parse(JSON.stringify(src)) as BoardWidget;
  copy.id = freshId(doc, src.kind === "query" ? (src.query?.source ?? "q") : src.kind);
  return appendWidget(doc, copy);
}

export function freshId(doc: BoardDoc, prefix: string): string {
  let n = doc.widgets.length + 1;
  let id = `${prefix}-${n}`;
  while (doc.widgets.some((w) => w.id === id)) id = `${prefix}-${(n += 1)}`;
  return id;
}

// --- presets (quick start) ---------------------------------------------------

export interface BoardPreset {
  key: string;
  widget: Omit<BoardWidget, "id">;
}

/** The add-menu's ready-made questions — an empty grid is a burden, not
 *  freedom (Home Assistant's strategy lesson); these seed it in one click and
 *  are fully editable afterwards. */
export const BOARD_PRESETS: BoardPreset[] = [
  {
    key: "mcp-daily",
    widget: {
      kind: "query",
      query: { source: "inflow", groupBy: "day", filters: [{ field: "channel", value: "mcp" }] },
      view: "bar",
      time: "auto",
    },
  },
  {
    key: "channels-daily",
    widget: {
      kind: "query",
      query: { source: "inflow", groupBy: "day", filters: [] },
      view: "bar",
      time: "auto",
    },
  },
  {
    key: "notes-by-type",
    widget: {
      kind: "query",
      query: { source: "notes", groupBy: "type", filters: [] },
      view: "hbar",
      time: "auto",
    },
  },
  {
    key: "top-tags",
    widget: {
      kind: "query",
      query: { source: "notes", groupBy: "tag", filters: [], limit: 8 },
      view: "hbar",
      time: "auto",
    },
  },
  {
    key: "edits-daily",
    widget: {
      kind: "query",
      query: { source: "notes", groupBy: "day", filters: [] },
      view: "bar",
      time: "auto",
    },
  },
  {
    key: "tasks-by-status",
    widget: {
      kind: "query",
      query: { source: "tasks", groupBy: "status", filters: [] },
      view: "hbar",
      time: "auto",
    },
  },
  {
    key: "unsourced-stat",
    widget: {
      kind: "query",
      query: { source: "notes", groupBy: "type", filters: [{ field: "sourceCount", value: "0" }] },
      view: "stat",
      time: "auto",
      colorRules: [{ op: ">=", value: 10, color: "risk" }],
    },
  },
];

// --- query engine --------------------------------------------------------------

/** Everything a board render needs, fetched once by the host component. */
export interface BoardData {
  adjacency: Adjacency | null;
  /** Wiki pages only (same scope as Views). */
  files: string[];
  /** vault-relative path → mtime secs (whole vault). */
  mtimes: Map<string, number>;
  tasks: TaskItem[];
  /** Oldest-first daily ledger, at least 365 days. */
  inflow: InflowDay[];
}

export const CHANNELS = ["mcp", "clipper", "voice", "import"] as const;
export type Channel = (typeof CHANNELS)[number];

export interface CatRow {
  label: string;
  value: number;
}

export interface DayPoint {
  day: string; // YYYY-MM-DD
  total: number;
  /** Present when the day splits by channel (stacked view). */
  parts?: { channel: Channel; value: number }[];
}

export type QueryResult =
  | { kind: "cat"; rows: CatRow[] }
  | { kind: "series"; days: DayPoint[] };

export function rangeDays(r: BoardRange): number {
  switch (r) {
    case "7d":
      return 7;
    case "30d":
      return 30;
    case "90d":
      return 90;
    case "all":
      return 365;
  }
}

/** The range a widget actually uses — its own, or the board's. */
export function effectiveRange(w: BoardWidget, board: BoardRange): BoardRange {
  return !w.time || w.time === "auto" ? board : w.time;
}

function fvalue(q: BoardQuery, field: string): string | null {
  return q.filters.find((f) => f.field === field)?.value ?? null;
}

function localDayString(secs: number): string {
  const d = new Date(secs * 1000);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Zero-filled trailing local days ending today. */
function dayWindow(days: number, nowMs: number): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    out.push(localDayString(Math.floor(nowMs / 1000) - i * 86_400));
  }
  return out;
}

export function runBoardQuery(
  data: BoardData,
  q: BoardQuery,
  range: BoardRange,
  nowMs: number,
): QueryResult {
  const days = rangeDays(range);
  if (q.source === "inflow") {
    const window = new Set(dayWindow(days, nowMs));
    const inWindow = data.inflow.filter((d) => window.has(d.day));
    const ch = fvalue(q, "channel") as Channel | null;
    if (q.groupBy === "channel") {
      return {
        kind: "cat",
        rows: CHANNELS.filter((c) => !ch || c === ch).map((c) => ({
          label: c,
          value: inWindow.reduce((s, d) => s + d[c], 0),
        })),
      };
    }
    // day series; split by channel only when no single channel is asked for.
    return {
      kind: "series",
      days: dayWindow(days, nowMs).map((day) => {
        const d = data.inflow.find((x) => x.day === day);
        if (!d) return { day, total: 0 };
        if (ch) return { day, total: d[ch] };
        return {
          day,
          total: CHANNELS.reduce((s, c) => s + d[c], 0),
          parts: CHANNELS.map((c) => ({ channel: c, value: d[c] })),
        };
      }),
    };
  }

  if (q.source === "tasks") {
    let tasks = data.tasks;
    const st = fvalue(q, "status");
    if (st) tasks = tasks.filter((x) => x.status === st);
    const order = ["todo", "doing", "blocked", "done"];
    return {
      kind: "cat",
      rows: order
        .filter((s) => !st || s === st)
        .map((s) => ({ label: s, value: tasks.filter((x) => x.status === s).length })),
    };
  }

  // notes — filter by frontmatter equality (+ tag, + mtime window), then group.
  const meta = data.adjacency?.meta ?? {};
  const tags = data.adjacency?.tags ?? {};
  const cutoff = range === "all" ? 0 : Math.floor(nowMs / 1000) - days * 86_400;
  let pages = data.files.filter((p) => (data.mtimes.get(p) ?? 0) >= cutoff);
  for (const f of q.filters) {
    if (f.field === "tag") {
      pages = pages.filter((p) => (tags[p] ?? []).includes(f.value));
    } else if (f.field === "sourceCount") {
      pages = pages.filter((p) => String(meta[p]?.sourceCount ?? 0) === f.value);
    } else if (f.field === "type" || f.field === "confidence" || f.field === "status") {
      const key = f.field as "type" | "confidence" | "status";
      pages = pages.filter((p) => (meta[p]?.[key] ?? "") === f.value);
    }
  }
  if (q.groupBy === "day") {
    const window = dayWindow(days, nowMs);
    const counts = new Map<string, number>(window.map((d) => [d, 0]));
    for (const p of pages) {
      const secs = data.mtimes.get(p);
      if (!secs) continue;
      const day = localDayString(secs);
      if (counts.has(day)) counts.set(day, (counts.get(day) ?? 0) + 1);
    }
    return {
      kind: "series",
      days: window.map((day) => ({ day, total: counts.get(day) ?? 0 })),
    };
  }
  const bump = (m: Map<string, number>, k?: string): void => {
    if (k) m.set(k, (m.get(k) ?? 0) + 1);
  };
  const counts = new Map<string, number>();
  for (const p of pages) {
    if (q.groupBy === "tag") for (const t of tags[p] ?? []) bump(counts, t);
    else if (q.groupBy === "page") bump(counts, stem(p));
    else bump(counts, meta[p]?.[q.groupBy as "type" | "confidence" | "status"]);
  }
  const rows = [...counts.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  return { kind: "cat", rows: rows.slice(0, q.limit ?? 24) };
}

/** Display aliases applied at render time (widget.aliases). */
export function aliasLabel(w: BoardWidget, label: string): string {
  return w.aliases?.[label] ?? label;
}

/** A stat widget's single number = the query's total. */
export function statValue(r: QueryResult): number {
  return r.kind === "cat"
    ? r.rows.reduce((s, x) => s + x.value, 0)
    : r.days.reduce((s, x) => s + x.total, 0);
}

/** First matching rule wins, evaluated in order (Datadog conditional_formats). */
export function ruleColor(rules: ColorRule[] | undefined, value: number): "risk" | "ok" | null {
  for (const r of rules ?? []) {
    const hit =
      r.op === ">=" ? value >= r.value
      : r.op === ">" ? value > r.value
      : r.op === "<=" ? value <= r.value
      : r.op === "<" ? value < r.value
      : value === r.value;
    if (hit) return r.color;
  }
  return null;
}

// --- persistence -----------------------------------------------------------

const LEGACY_KEY = "myco.dashboard.v1";

function isBoardDoc(v: unknown): v is BoardDoc {
  const d = v as BoardDoc;
  return (
    typeof d === "object" &&
    d !== null &&
    d.version === 1 &&
    Array.isArray(d.widgets) &&
    Array.isArray(d.layout)
  );
}

/** One-time migration from the (one-day-old) localStorage dashboard: its five
 *  hardcoded kinds map onto preset questions. Anything unrecognized is
 *  dropped — the board it came from shipped yesterday. */
export function migrateLegacy(raw: string | null): BoardDoc | null {
  if (!raw) return null;
  try {
    const old = JSON.parse(raw) as { kind?: string; dim?: string; topN?: number }[];
    if (!Array.isArray(old) || old.length === 0) return null;
    let doc = emptyBoard();
    for (const w of old) {
      const preset =
        w.kind === "activity"
          ? "edits-daily"
          : w.kind === "distribution"
            ? (w.dim === "confidence" || w.dim === "status" ? "notes-by-type" : "notes-by-type")
            : w.kind === "tags"
              ? "top-tags"
              : w.kind === "tasks"
                ? "tasks-by-status"
                : null;
      if (!preset) continue;
      const p = BOARD_PRESETS.find((x) => x.key === preset);
      if (!p) continue;
      const widget: BoardWidget = { ...JSON.parse(JSON.stringify(p.widget)), id: "" };
      if (w.kind === "distribution" && (w.dim === "confidence" || w.dim === "status")) {
        widget.query = { ...widget.query!, groupBy: w.dim };
      }
      if (w.kind === "tags" && w.topN) widget.query = { ...widget.query!, limit: w.topN };
      widget.id = freshId(doc, "w");
      doc = appendWidget(doc, widget);
    }
    return doc.widgets.length > 0 ? doc : null;
  } catch {
    return null;
  }
}

/** Clamp a saved layout back onto the 12-column grid and heal widget/layout
 *  mismatches. A hand-edited file, a corrupt save, or a future column change
 *  must degrade to a sane board — never to widgets hanging off the viewport. */
export function sanitizeBoard(doc: BoardDoc): BoardDoc {
  const ids = new Set(doc.widgets.map((w) => w.id));
  let layout = doc.layout
    .filter((l) => ids.has(l.i))
    .map((l) => {
      const w = Math.min(Math.max(1, Math.round(l.w) || 1), BOARD_COLS);
      const x = Math.min(Math.max(0, Math.round(l.x) || 0), BOARD_COLS - w);
      const y = Math.max(0, Math.round(l.y) || 0);
      const h = Math.max(1, Math.round(l.h) || 1);
      return { i: l.i, x, y, w, h };
    });
  // A widget the layout lost still needs a slot — park it at the bottom.
  const placed = new Set(layout.map((l) => l.i));
  for (const w of doc.widgets) {
    if (placed.has(w.id)) continue;
    const bottom = layout.reduce((m, l) => Math.max(m, l.y + l.h), 0);
    layout = [...layout, { i: w.id, x: 0, y: bottom, ...defaultSize(w) }];
  }
  return { ...doc, layout };
}

export async function loadBoard(vaultPath: string, name: string): Promise<BoardDoc> {
  try {
    const { raw } = await ipc.readFile(`${vaultPath}/${boardRel(name)}`);
    const parsed = JSON.parse(raw) as unknown;
    if (isBoardDoc(parsed)) return sanitizeBoard(parsed);
  } catch {
    /* no board file yet */
  }
  // The one-time localStorage migration only ever seeds the default board.
  if (name === DEFAULT_BOARD) {
    let legacy: string | null = null;
    try {
      legacy = localStorage.getItem(LEGACY_KEY);
    } catch {
      /* localStorage unavailable */
    }
    const migrated = migrateLegacy(legacy);
    if (migrated) return migrated;
  }
  return emptyBoard();
}

export async function saveBoard(name: string, doc: BoardDoc): Promise<void> {
  await ipc.saveDashboard(name, JSON.stringify(doc, null, 2));
}
