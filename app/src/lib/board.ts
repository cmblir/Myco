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

export const CHANNELS = ["mcp", "clipper", "voice", "import", "harvest"] as const;
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

/** Fold a daily series into Monday-led weekly buckets — the "all" range's
 *  365 one-day columns are unreadable and unrenderable in a card; ~52 weekly
 *  bars say the same thing legibly. */
export function bucketWeekly(days: DayPoint[]): DayPoint[] {
  const out: DayPoint[] = [];
  for (const d of days) {
    // Monday of d's week, from the date string alone (no TZ surprises).
    const date = new Date(`${d.day}T00:00:00`);
    date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const wk = `${date.getFullYear()}-${m}-${String(date.getDate()).padStart(2, "0")}`;
    const last = out[out.length - 1];
    if (last && last.day === wk) {
      last.total += d.total;
      if (d.parts) {
        const parts = last.parts ?? [];
        for (const p of d.parts) {
          const hit = parts.find((x) => x.channel === p.channel);
          if (hit) hit.value += p.value;
          else parts.push({ ...p });
        }
        last.parts = parts;
      }
    } else {
      out.push({ day: wk, total: d.total, parts: d.parts?.map((p) => ({ ...p })) });
    }
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
    const series = dayWindow(days, nowMs).map((day) => {
      const d = data.inflow.find((x) => x.day === day);
      if (!d) return { day, total: 0 } as DayPoint;
      if (ch) return { day, total: d[ch] } as DayPoint;
      return {
        day,
        total: CHANNELS.reduce((s, c) => s + d[c], 0),
        parts: CHANNELS.map((c) => ({ channel: c, value: d[c] })),
      } as DayPoint;
    });
    return { kind: "series", days: days > 120 ? bucketWeekly(series) : series };
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
    const series = window.map((day) => ({ day, total: counts.get(day) ?? 0 }));
    return { kind: "series", days: days > 120 ? bucketWeekly(series) : series };
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

// --- overview layout ---------------------------------------------------------
//
// The Overview page's own blocks, arrangeable the way the board's widgets are.
// A SIBLING document type rather than a second BoardDoc, because a panel is not
// a widget: the nine blocks are a closed set the user cannot create or delete,
// their height is intrinsic (the harvest hero is a hero, a rail row is one
// line) so there is no `h` in 48px rows to give them, and they carry no query.
// A BoardDoc here would mean `widgets: []` forever plus x/y/h values the
// renderer ignores — a document that lies about itself. What IS shared: the
// 12-column vocabulary (BOARD_COLS), the `.myco/dashboards/<name>.json` path
// (boardRel) and the same ipc write path (saveDashboard), so this is one more
// file in the folder the board already owns.
//
// The rail STAYS a rail — but which blocks are in it is now data. The default
// has to be identical to the fixed stack that shipped before (a vault that
// never edited must see no change), and the rail's 248px measure is what makes
// MorningBand's two-line rows correct. Membership-as-data still gives the
// freedom that was asked for: any block can leave the rail, any can join it.

/** Which of AppPage's slots a block sits in. */
export type OverviewZone = "main" | "rail";

/** Every block the Overview can place, in default order. */
export const OVERVIEW_BLOCKS = [
  "pulse",
  "harvest",
  "links",
  "recent",
  "board",
  "since",
  "suspect",
  "contradictions",
  "reunions",
] as const;
export type OverviewBlockId = (typeof OVERVIEW_BLOCKS)[number];

export interface OverviewItem {
  id: OverviewBlockId;
  zone: OverviewZone;
  /** Columns of BOARD_COLS the block spans in the main grid. Kept while the
   *  block visits the rail (which is one column wide) so moving it back
   *  restores the width the user chose. */
  span: number;
}

export interface OverviewLayout {
  version: 1;
  /** Flat and ordered: the array IS the order, and each item names its zone.
   *  One list rather than one per zone so "move one step" can walk a block out
   *  of the rail into the main column with no special case. */
  items: OverviewItem[];
}

/** The spans the arrange-mode control offers: a third, a half, full width. */
export const OVERVIEW_SPANS = [4, 6, BOARD_COLS] as const;
/** `.myco/dashboards/overview-layout.json` — boardRel gives the path. */
export const OVERVIEW_LAYOUT = "overview-layout";

const RAIL_BY_DEFAULT: ReadonlySet<string> = new Set([
  "since",
  "suspect",
  "contradictions",
  "reunions",
]);

/** Today's arrangement, exactly: five blocks stacked full-width in the main
 *  column, the four report panels stacked in the right rail. */
export function defaultOverviewLayout(): OverviewLayout {
  return {
    version: 1,
    items: OVERVIEW_BLOCKS.map((id) => ({
      id,
      zone: RAIL_BY_DEFAULT.has(id) ? "rail" : "main",
      span: BOARD_COLS,
    })),
  };
}

function isBlockId(v: unknown): v is OverviewBlockId {
  return (
    typeof v === "string" && (OVERVIEW_BLOCKS as readonly string[]).includes(v)
  );
}

function clampSpan(span: unknown): number {
  const n = Math.round(Number(span));
  if (!Number.isFinite(n)) return BOARD_COLS;
  return Math.min(Math.max(1, n), BOARD_COLS);
}

/** A stored document healed back into something renderable. A hand-edited
 *  file, a save from a newer build, or a block this version dropped must
 *  degrade to a sane page — never to a crash or a block that renders nowhere.
 *  Unknown ids are dropped, duplicates collapse, spans clamp to the grid, and
 *  a block the file never mentioned is appended at its default position. */
export function sanitizeOverviewLayout(value: unknown): OverviewLayout {
  const raw = (value as OverviewLayout | null)?.items;
  const items: OverviewItem[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const it = entry as Partial<OverviewItem> | null;
      if (!isBlockId(it?.id) || seen.has(it.id)) continue;
      seen.add(it.id);
      items.push({
        id: it.id,
        zone: it.zone === "rail" ? "rail" : "main",
        span: clampSpan(it.span),
      });
    }
  }
  // A block the file never mentioned still needs a home — its default one.
  for (const item of defaultOverviewLayout().items) {
    if (!seen.has(item.id)) items.push(item);
  }
  return { version: 1, items };
}

/** The blocks in one zone, in order. */
export function zoneItems(
  layout: OverviewLayout,
  zone: OverviewZone,
): OverviewItem[] {
  return layout.items.filter((i) => i.zone === zone);
}

/** One step earlier (-1) or later (+1) in the flat order, adopting the zone of
 *  the block it swaps past — which is how a keyboard walks a block out of the
 *  rail without a separate "change zone" key. */
export function moveOverviewItem(
  layout: OverviewLayout,
  id: string,
  delta: number,
): OverviewLayout {
  const i = layout.items.findIndex((x) => x.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= layout.items.length) return layout;
  const items = [...layout.items];
  const [item] = items.splice(i, 1);
  items.splice(j, 0, { ...item, zone: layout.items[j].zone });
  return { ...layout, items };
}

/** Drop onto another block: take its place, and its zone. */
export function moveOverviewItemBefore(
  layout: OverviewLayout,
  id: string,
  targetId: string,
): OverviewLayout {
  if (id === targetId) return layout;
  const target = layout.items.find((x) => x.id === targetId);
  const item = layout.items.find((x) => x.id === id);
  if (!target || !item) return layout;
  const rest = layout.items.filter((x) => x.id !== id);
  const at = rest.findIndex((x) => x.id === targetId);
  return {
    ...layout,
    items: [
      ...rest.slice(0, at),
      { ...item, zone: target.zone },
      ...rest.slice(at),
    ],
  };
}

/** Drop onto a zone's trailing strip — the only way back into a rail the user
 *  emptied. */
export function moveOverviewItemToZone(
  layout: OverviewLayout,
  id: string,
  zone: OverviewZone,
): OverviewLayout {
  const item = layout.items.find((x) => x.id === id);
  if (!item || item.zone === zone) return layout;
  const rest = layout.items.filter((x) => x.id !== id);
  const last = rest.reduce((m, x, k) => (x.zone === zone ? k : m), -1);
  return {
    ...layout,
    items: [
      ...rest.slice(0, last + 1),
      { ...item, zone },
      ...rest.slice(last + 1),
    ],
  };
}

export function setOverviewSpan(
  layout: OverviewLayout,
  id: string,
  span: number,
): OverviewLayout {
  return {
    ...layout,
    items: layout.items.map((x) =>
      x.id === id ? { ...x, span: clampSpan(span) } : x,
    ),
  };
}

/** 1-based position within the block's own zone, for the aria-live line. */
export function overviewPosition(
  layout: OverviewLayout,
  id: string,
): { index: number; total: number; zone: OverviewZone } | null {
  const item = layout.items.find((x) => x.id === id);
  if (!item) return null;
  const peers = zoneItems(layout, item.zone);
  return {
    index: peers.findIndex((x) => x.id === id) + 1,
    total: peers.length,
    zone: item.zone,
  };
}

export async function loadOverviewLayout(
  vaultPath: string,
): Promise<OverviewLayout> {
  try {
    const { raw } = await ipc.readFile(
      `${vaultPath}/${boardRel(OVERVIEW_LAYOUT)}`,
    );
    return sanitizeOverviewLayout(JSON.parse(raw));
  } catch {
    // No file yet, or a file that is not this document — the default stack.
    return defaultOverviewLayout();
  }
}

export async function saveOverviewLayout(
  layout: OverviewLayout,
): Promise<void> {
  await ipc.saveDashboard(OVERVIEW_LAYOUT, JSON.stringify(layout, null, 2));
}
