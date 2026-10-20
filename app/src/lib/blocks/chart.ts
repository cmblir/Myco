// ```chart: a chart drawn from its fence (./chartSource: obsidian-charts'
// flat YAML, inline series or a table tagged `^id` in the note). The marks
// are DashCharts' (0 KB); anything it cannot read is a message in the box,
// never a throw. In Live the fence is edited in its panel (./chartPanel).

import type Token from "markdown-it/lib/token.mjs";
import {
  SERIES_COLORS,
  donutHtml,
  hbarsHtml,
  legendHtml,
  linesHtml,
} from "../../components/DashCharts";
import type { Strings } from "../i18n";
import { escapeHtml } from "../wikilinks";
import type { BlockCtx, BlockSpec } from "./index";
import { inlineText } from "./math";
import { chartFields } from "./chartPanel";
import { fenced } from "./fencePanel";
import {
  SAMPLE_TABLE,
  freeId,
  parseChart,
  type ChartError,
  type ChartModel,
  type ChartType,
} from "./chartSource";

export { freeId } from "./chartSource";
export type {
  ChartError,
  ChartModel,
  ChartSource,
  ChartType,
} from "./chartSource";

export interface ChartData {
  type: ChartType;
  title: string;
  labels: string[];
  series: { title: string; data: number[] }[];
}

/** A table: its rows' visible cell text, the header first. */
export type TaggedTables = ReadonlyMap<string, readonly (readonly string[])[]>;

/** Pure: the numbers a chart draws — its inline series, or the tagged
 *  table's cells — padded or cut to the labels. An empty cell is 0; a
 *  thousands comma is dropped (`1,100`); anything else not a number is an
 *  error naming it. */
export function chartData(
  m: ChartModel,
  tables: TaggedTables | undefined,
): ChartData | ChartError {
  if ("error" in m) return m;
  let { labels, series } = m;
  if (m.id !== null) {
    const rows = tables?.get(m.id);
    if (!rows) return { error: "table", arg: m.id };
    const [head = [], ...body] = rows;
    if (m.layout === "rows") {
      labels = head.slice(1);
      series = body.map((r) => ({ title: r[0] ?? "", data: r.slice(1) }));
    } else {
      labels = body.map((r) => r[0] ?? "");
      series = head
        .slice(1)
        .map((title, c) => ({ title, data: body.map((r) => r[c + 1] ?? "") }));
    }
  }
  if (!labels.length || !series.length) return { error: "data", arg: "" };
  const out: ChartData["series"] = [];
  for (const s of series) {
    const data: number[] = [];
    for (let i = 0; i < labels.length; i++) {
      const cell = s.data[i] ?? "";
      const text = cell.replace(/[,\s]/g, "");
      const v = text === "" ? 0 : Number(text);
      if (!Number.isFinite(v)) return { error: "number", arg: cell };
      data.push(v);
    }
    out.push({ title: s.title, data });
  }
  return { type: m.type, title: m.title, labels, series: out };
}

const TAG_RE = /^\^([\w-]+)$/;

/** Pure: the id a paragraph's text tags a table with (`^id` alone), else
 *  null. Live reads a paragraph right under a Table node through it. */
export const tableTag = (text: string): string | null =>
  TAG_RE.exec(text.trim())?.[1] ?? null;

/** Pure: the id when tokens[i] opens the `^id` paragraph right under a
 *  table, the one tag both a chart's data (taggedTables) and Preview's
 *  muted line read. */
export function tableTagAt(tokens: readonly Token[], i: number): string | null {
  return tokens[i]?.type === "paragraph_open" &&
    tokens[i - 1]?.type === "table_close" &&
    tokens[i + 1]?.type === "inline"
    ? tableTag(tokens[i + 1].content)
    : null;
}

/** Pure: every table in a parse tagged by a `^id` paragraph right under it
 *  (a blank line between, as Obsidian writes it), by id; the first of a
 *  repeated id wins. */
export function taggedTables(
  tokens: readonly Token[],
): Map<string, string[][]> {
  const out = new Map<string, string[][]>();
  let rows: string[][] | null = null;
  tokens.forEach((t, i) => {
    if (t.type === "table_open") rows = [];
    else if (t.type === "tr_open") rows?.push([]);
    else if (
      t.type === "inline" &&
      rows &&
      (tokens[i - 1].type === "th_open" || tokens[i - 1].type === "td_open")
    )
      // A cell's text as written, as the outline reads a heading.
      rows[rows.length - 1].push(
        (t.children ?? []).map(inlineText).join("").trim(),
      );
    else if (t.type === "table_close") {
      const tag = tableTagAt(tokens, i + 1);
      if (tag && rows && !out.has(tag)) out.set(tag, rows);
      rows = null;
    }
  });
  return out;
}

function message(e: ChartError, t: Partial<Strings> | undefined): string {
  switch (e.error) {
    case "type":
      return t?.ch_err_type ?? "Chart type must be bar, line or pie";
    case "line":
      return (t?.ch_err_line ?? "Line {n} is not “key: value”").replace(
        "{n}",
        e.arg,
      );
    case "data":
      return (
        t?.ch_err_data ??
        "This chart has no data: under Edit, choose a table or type the values"
      );
    case "table":
      // The tag is metadata (decision 6): never named.
      return (
        t?.ch_err_table ?? "The table this chart reads is not in this note"
      );
    case "number":
      return (t?.ch_err_number ?? "“{value}” is not a number").replace(
        "{value}",
        e.arg,
      );
  }
}

/** A value as a note chart shows it: digits grouped, every decimal kept.
 *  ponytail: "en", not the UI's language — en, ko and ja group digits
 *  alike, and BlockCtx carries no language. */
const NUM = new Intl.NumberFormat("en", { maximumFractionDigits: 20 });
const num = (v: number): string => NUM.format(v);

/** Pure: the chart's HTML, every piece of vault text escaped. */
export function chartHtml(
  c: ChartData | ChartError,
  t: Partial<Strings> | undefined,
): string {
  if ("error" in c)
    return `<div class="md-chart is-error" role="note">${escapeHtml(message(c, t))}</div>\n`;
  const color = (k: number) =>
    c.series.length > 1
      ? SERIES_COLORS[k % SERIES_COLORS.length]
      : "var(--accent)";
  let marks: string;
  let style = "";
  if (c.type === "pie") {
    // ponytail: the first series only; obsidian-charts rings every series.
    const [s] = c.series;
    marks = donutHtml(
      c.labels.map((label, i) => ({
        label,
        value: s.data[i],
        color: SERIES_COLORS[i % SERIES_COLORS.length],
      })),
    );
  } else {
    const series = c.series.map((s, k) => ({ ...s, color: color(k) }));
    if (c.type === "bar") {
      const rows = c.labels.flatMap((label, i) =>
        series.map((s, k) => ({
          // Grouped: the label once, over its series' bars.
          label: k ? "" : label,
          count: s.data[i],
          num: num(s.data[i]),
          color: s.color,
          title:
            series.length > 1
              ? `${label} · ${s.title}: ${num(s.data[i])}`
              : undefined,
        })),
      );
      // Each row is a grid of its own, so every row's value column takes
      // the widest value's width (styles.css): one length for every track.
      style = ` style="--num-w:${Math.max(...rows.map((r) => r.num.length))}ch"`;
      marks = hbarsHtml(rows);
    } else marks = linesHtml(c.labels, series, num);
    if (series.length > 1)
      marks += legendHtml(
        series.map((s) => ({
          // A line's values show nowhere else: each series' last one.
          label:
            c.type === "line"
              ? `${s.title} · ${num(s.data[s.data.length - 1])}`
              : s.title,
          color: s.color,
        })),
      );
  }
  const title = c.title
    ? `<div class="md-chart-title">${escapeHtml(c.title)}</div>`
    : "";
  return `<div class="md-chart" data-chart="${c.type}"${style}>${title}${marks}</div>\n`;
}

/** The note's tagged tables, read only by a chart that names one: the
 *  getter parses the whole note (live.ts noteParse). */
const tablesFor = (p: ChartModel, ctx: BlockCtx): TaggedTables | undefined =>
  "error" in p || p.id === null ? undefined : ctx.tables;

const html = (p: ChartModel, ctx: BlockCtx): string =>
  chartHtml(chartData(p, tablesFor(p, ctx)), ctx.t ?? ctx.env?.strings);

export const CHART: BlockSpec<ChartModel> = {
  id: "chart",
  match: { fence: "chart" },
  slash: {
    label: "chart",
    name: "sl_chart",
    icon: "▤",
    aliases: ["graph", "plot", "차트", "그래프", "グラフ"],
    section: "advanced",
    open: true,
    // A table to edit and the fence that draws it, as obsidian-charts reads
    // them, under an id the note does not use yet: a second sample drew the
    // first one's table.
    sample: (t, doc) => {
      const id = freeId(doc);
      return `${SAMPLE_TABLE}\n\n^${id}\n\n\`\`\`chart\ntype: bar\nid: ${id}\ntitle: ${t.ch_sample_title}\n\`\`\``;
    },
  },
  template:
    "```chart\ntype: bar\nlabels: [A, B]\nseries:\n  - data: [1, 2]\n```",
  parse: parseChart,
  renderStatic: html,
  ...fenced<ChartModel>({
    name: (t) => t?.sl_chart ?? "Chart",
    draw(box, p, ctx) {
      // chartHtml's output, vault text escaped — the HTML Preview sets.
      box.innerHTML = html(p, ctx);
    },
    form: chartFields,
  }),
  estimatedHeight(p, ctx) {
    const c = chartData(p, tablesFor(p, ctx));
    if ("error" in c) return 48;
    const chrome = (c.title ? 32 : 0) + (c.series.length > 1 ? 24 : 0) + 40;
    if (c.type === "bar")
      return chrome + c.labels.length * c.series.length * 24;
    return chrome + 180;
  },
  // The tagged table's cells (and the UI language) are drawn too.
  key: html,
};
