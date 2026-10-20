// Query block: ```myco-query holds one line of ⌘K's operators ("phrase",
// tag:, type:, status:, confidence:, path: — lib/searchQuery) plus sort:,
// limit: and view: list|table|count, and draws the vault's pages that match
// it, the page it is written on left out. Free words match page names, a
// "phrase" the page text, as in ⌘K. The pages come from the host
// (BlockCtx.runQuery, lib/queryLoad.ts: runView over the link scan's index,
// kept there so its graph library stays out of every view that renders
// markdown); Preview writes an empty box that the Viewer fills the same way
// (hydrateBlocks), so both views draw one DOM. In Live a "bake" button
// writes the pages as a plain link list between `<!-- myco:query … -->`
// markers under the fence — links only, never quotes — replacing the last
// bake in place; Preview reads the markers as comments (nothing). No
// CodeMirror at runtime: Preview's bundle has none.

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { HBars, TYPE_COLORS, type HBarRow } from "../../components/DashCharts";
import type { ViewRow, ViewSort } from "../queryViews";
import { parseSearchQuery, type ParsedQuery } from "../searchQuery";
import { today } from "../taskLine";
import { escapeHtml } from "../wikilinks";
import type { BlockCtx, BlockEdit, BlockSpec } from "./index";
import { fenced } from "./fencePanel";
import { queryFields } from "./queryPanel";

export type QueryView = "list" | "table" | "count";

export interface QueryModel {
  /** The fence's body as one line (its lines joined), as the bake's marker
   *  names it. */
  query: string;
  /** Its ⌘K part; `terms` = the free words left. */
  search: ParsedQuery;
  sort: ViewSort;
  desc: boolean;
  limit: number;
  view: QueryView;
  /** The first option it could not read (`view:pie`), else null. */
  bad: string | null;
}

/** A matching page: runView's row and the name it is shown by. */
export interface QueryRow extends ViewRow {
  label: string;
}

// Each sort key's natural order (a `-` reverses it): names A→Z, the newest
// first, the most links or sources first.
const SORTS: Record<string, [ViewSort, boolean]> = {
  name: ["name", false],
  type: ["type", false],
  modified: ["modified", true],
  updated: ["modified", true],
  sources: ["sources", true],
  links: ["links", true],
};
const VIEWS = new Set<string>(["list", "table", "count"]);
const OPTION_RE = /^(sort|limit|view):(.*)$/i;

/** Pure: a query fence's body → its query. Never null: whatever is in the
 *  fence is the query, an unreadable option included (the block says so). */
export function parseQuery(body: string): QueryModel {
  const query = body
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ");
  const search = parseSearchQuery(query);
  const q: QueryModel = {
    query,
    search,
    sort: "name",
    desc: false,
    limit: 50,
    view: "list",
    bad: null,
  };
  const words: string[] = [];
  for (const word of search.terms.split(" ").filter(Boolean)) {
    const m = OPTION_RE.exec(word);
    if (!m) {
      words.push(word);
      continue;
    }
    const key = m[1].toLowerCase();
    const value = m[2].toLowerCase();
    const sort = SORTS[value.replace(/^-/, "")];
    if (key === "sort" && sort)
      [q.sort, q.desc] = [sort[0], sort[1] !== value.startsWith("-")];
    else if (key === "limit" && /^[1-9]\d{0,2}$/.test(value))
      q.limit = Number(value);
    else if (key === "view" && VIEWS.has(value)) q.view = value as QueryView;
    else q.bad ??= word;
  }
  search.terms = words.join(" ");
  return q;
}

/** Pure: `view:count`'s bars — pages per type, the most first; the untyped
 *  share one bar named `untyped`. */
export function countGroups(
  rows: readonly QueryRow[],
  untyped: string,
): HBarRow[] {
  const counts = new Map<string, number>();
  for (const r of rows)
    counts.set(r.type ?? "", (counts.get(r.type ?? "") ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([type, count]) =>
      type
        ? { label: type, count, color: TYPE_COLORS[type] }
        : { label: untyped, count },
    );
}

const CLOSE = "<!-- /myco:query -->";
/** A `-->` in the query would close its marker early. */
const opening = (query: string) =>
  `<!-- myco:query ${query.replace(/-{2,}>/g, "->")} -->`;

/** Pure: the bake — `- [[stem]]` lines between the query's markers. */
export function bakeText(query: string, stems: readonly string[]): string {
  return [opening(query), ...stems.map((s) => `- [[${s}]]`), CLOSE].join("\n");
}

/** A line's container marks (`> `, an item's indent). */
const MARKS_RE = /^[ \t>]*/;
/** A fence line past container marks. */
const FENCE_RE = /^[ \t>]*(`{3,}|~{3,})/;

/** Whether `line` closes the fence `open` opened: its character, at least
 *  as many, nothing after them. */
function closes(line: string, open: string): boolean {
  const m = /^[ \t>]*(`{3,}|~{3,})[ \t]*$/.exec(line);
  return !!m && m[1][0] === open[0] && m[1].length >= open.length;
}

/** Pure: the fences' first and closing lines (an unclosed fence's close
 *  is past the end), and which lines are fenced code, the fence lines
 *  included. A marker in code is text, not a bake. */
function fencesOf(lines: readonly string[]) {
  const code = lines.map(() => false);
  const spans: [number, number][] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE_RE.exec(lines[i])?.[1];
    if (!open) continue;
    const start = i;
    while (++i < lines.length && !closes(lines[i], open));
    spans.push([start, i]);
    code.fill(true, start, i + 1);
  }
  return { code, spans };
}

const QUERY_FENCE_RE = /^[ \t>]*(`{3,}|~{3,})[ \t]*myco-query(\s|$)/;
const MARKER_RE = /^<!-- myco:query .*-->$/;

/** A line a bake writes between its markers. */
const LINK_LINE_RE = /^- \[\[.+\]\]$/;

/** Pure: the edit a bake makes for the fence whose first line starts at
 *  `from`. The block's own bake is replaced in place: the one right under
 *  the fence whatever query it names (the query was edited since), unless
 *  another query block names it; else the bake of the same query, the one
 *  below the fence first. Otherwise a new bake goes a blank line under the
 *  fence. A bake is its opening marker, link lines only, then its close,
 *  outside fenced code; with anything else between (a close deleted, the
 *  user's text) it is no bake, so the edit never reaches past one. Null
 *  when no closing line ends the fence. */
export function bakeEdit(
  doc: string,
  from: number,
  query: string,
  stems: readonly string[],
): { from: number; to: number; insert: string } | null {
  const lines = doc.split("\n");
  const starts: number[] = [];
  let pos = 0;
  for (const l of lines) {
    starts.push(pos);
    pos += l.length + 1;
  }
  const first = starts.findIndex(
    (s, i) => from >= s && from < s + lines[i].length + 1,
  );
  const open = FENCE_RE.exec(lines[first] ?? "")?.[1];
  if (!open) return null;
  const close = lines.findIndex((l, i) => i > first && closes(l, open));
  if (close < 0) return null;
  const text = bakeText(query, stems);
  const marker = opening(query);
  const { code, spans } = fencesOf(lines);
  // A line past its container marks; null in code or past the end.
  const bare = (i: number) =>
    code[i] !== false ? null : lines[i].replace(MARKS_RE, "").trim();
  /** The close of the bake opening at line `at`, else -1. */
  const closeOf = (at: number) => {
    let i = at + 1;
    while (i < lines.length && LINK_LINE_RE.test(bare(i) ?? "")) i++;
    return i < lines.length && bare(i) === CLOSE ? i : -1;
  };
  const isBake = (i: number) => bare(i) === marker && closeOf(i) >= 0;
  // The other query blocks' markers: a bake one of them names is theirs.
  const others = new Set(
    spans
      .filter(
        ([s, e]) =>
          s !== first && e < lines.length && QUERY_FENCE_RE.test(lines[s]),
      )
      .map(([s, e]) =>
        opening(
          parseQuery(
            lines
              .slice(s + 1, e)
              .map((l) => l.replace(MARKS_RE, ""))
              .join("\n"),
          ).query,
        ),
      ),
  );
  let at = close + 1;
  while (at < lines.length && bare(at) === "") at++;
  const own = bare(at) ?? "";
  if (
    !MARKER_RE.test(own) ||
    closeOf(at) < 0 ||
    (own !== marker && others.has(own))
  )
    at = lines.findIndex((_, i) => i > close && isBake(i));
  if (at < 0) at = lines.findIndex((_, i) => isBake(i));
  // Every line written carries the container marks it sits in (a blank
  // one `>`), so a callout, quote or list item keeps going past the bake.
  const inside = (lead: string) =>
    text
      .split("\n")
      .map((l) => lead + l)
      .join("\n");
  if (at >= 0) {
    const end = closeOf(at);
    return {
      from: starts[at],
      to: starts[end] + lines[end].length,
      insert: inside(MARKS_RE.exec(lines[at])![0]),
    };
  }
  const lead = MARKS_RE.exec(lines[first])![0];
  const blank = "\n" + lead.trimEnd();
  const fenceEnd = starts[close] + lines[close].length;
  const below = lines[close + 1]?.replace(MARKS_RE, "").trim() ? blank : "";
  return {
    from: fenceEnd,
    to: fenceEnd,
    insert: blank + "\n" + inside(lead) + below,
  };
}

/** `/onthisday` as a query: the `daily/` pages (its archive too) whose name
 *  holds `now`'s `-MM-DD`, newest first, the page it is on left out. Unlike
 *  the picker, that includes this year's note and a suffixed one
 *  (`2025-09-30-standup`): ⌘K's operators match names by substring. */
export function onThisDayQuery(now: Date): string {
  return (
    "```myco-query\npath:daily/ " + today(now).slice(4) + " sort:-name\n```"
  );
}

function textRow(body: HTMLElement, state: string, text: string): void {
  body.className = `md-query-body ${state}`;
  body.textContent = text;
}

function pageLink(r: QueryRow): HTMLAnchorElement {
  const a = document.createElement("a");
  a.className = "myco-wikilink";
  a.href = "#";
  a.dataset.link = r.name;
  a.textContent = r.label;
  if (r.label !== r.name) a.title = r.name;
  return a;
}

function drawRows(
  body: HTMLElement,
  q: QueryModel,
  rows: QueryRow[],
  t: BlockCtx["t"],
): void {
  body.className = "md-query-body";
  if (q.view === "count") {
    const bars = document.createElement("div");
    body.append(bars);
    // DashCharts' bars, as the dashboard draws them; sync, so the widget
    // has its height when mount resolves.
    flushSync(() =>
      createRoot(bars).render(
        createElement(HBars, {
          rows: countGroups(rows, t?.qb_untyped ?? "No type"),
        }),
      ),
    );
    return;
  }
  const shown = rows.slice(0, q.limit);
  if (q.view === "list") {
    const ul = document.createElement("ul");
    for (const r of shown) {
      const li = document.createElement("li");
      li.append(pageLink(r));
      ul.append(li);
    }
    body.append(ul);
    return;
  }
  const table = document.createElement("table");
  const head = table.createTHead().insertRow();
  for (const label of [
    t?.qb_col_name ?? "Name",
    t?.qb_col_type ?? "Type",
    t?.qb_col_status ?? "Status",
    t?.qb_col_updated ?? "Updated",
  ]) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = label;
    head.append(th);
  }
  const tbody = table.createTBody();
  for (const r of shown) {
    const tr = tbody.insertRow();
    tr.insertCell().append(pageLink(r));
    tr.insertCell().textContent = r.type ?? "—";
    tr.insertCell().textContent = r.status ?? "—";
    tr.insertCell().textContent = r.modified
      ? today(new Date(r.modified * 1000))
      : "—";
  }
  body.append(table);
}

/** Fill a query's box (Live's widget, Preview's placeholder): the query as
 *  written (Viewer only: Live shows no markdown, its panel has the line
 *  under 고급), then loading, the pages, "no pages" or the error. With
 *  `edit` (Live), a bake button writes the pages shown into the note. */
export async function fillQuery(
  el: HTMLElement,
  q: QueryModel,
  { t, runQuery }: Pick<BlockCtx, "t" | "runQuery">,
  edit?: BlockEdit,
): Promise<void> {
  el.classList.add("md-query");
  const head = document.createElement("div");
  head.className = "md-query-head";
  const code = document.createElement("code");
  code.textContent = q.query;
  if (!edit) head.append(code);
  const body = document.createElement("div");
  el.replaceChildren(head, body);
  if (!q.query) return textRow(body, "is-empty", t?.qb_hint ?? "Write a query");
  if (q.bad)
    return textRow(
      body,
      "is-error",
      (t?.qb_bad ?? "Unknown option: {token}").replace("{token}", q.bad),
    );
  textRow(body, "is-loading", t?.qb_loading ?? "Running the query…");
  let rows: QueryRow[];
  try {
    if (!runQuery) throw new Error("no vault");
    rows = await runQuery(q);
  } catch (err) {
    console.warn(`query "${q.query}" failed`, err);
    return textRow(
      body,
      "is-error",
      (t?.qb_failed ?? "The query could not run: {error}").replace(
        "{error}",
        String(err),
      ),
    );
  }
  if (!rows.length)
    textRow(body, "is-empty", t?.qb_empty ?? "No pages match this query.");
  else {
    body.textContent = "";
    drawRows(body, q, rows, t);
  }
  if (!edit) return;
  const bake = document.createElement("button");
  bake.type = "button";
  bake.className = "md-query-bake";
  bake.textContent = t?.qb_bake ?? "Bake links";
  bake.title =
    t?.qb_bake_title ??
    "Write these pages into the note as links (replaces the last bake)";
  const stems = rows.slice(0, q.limit).map((r) => r.name);
  bake.addEventListener("click", () =>
    edit((doc, from) => bakeEdit(doc, from, q.query, stems)),
  );
  head.append(bake);
}

const ROW_PX = 30;

export const QUERY: BlockSpec<QueryModel> = {
  id: "query",
  match: { fence: "myco-query" },
  slash: {
    label: "query",
    name: "sl_query",
    icon: "⌕",
    aliases: ["dataview", "filter", "쿼리", "クエリ"],
    section: "advanced",
    open: true,
  },
  template: "```myco-query\npath:wiki/ sort:modified limit:10\n```",
  parse: parseQuery,
  renderStatic: (q) =>
    `<div class="md-query" data-query="${escapeHtml(q.query)}"></div>\n`,
  // The form for the query's common terms, its whole line under 고급.
  ...fenced<QueryModel>({
    name: (t) => t?.sl_query ?? "Query",
    draw(box, q, ctx, edit) {
      // `prose`: the list and the table read as in Preview.
      box.classList.add("prose");
      return fillQuery(box, q, ctx, edit);
    },
    form: (body, ctx) => queryFields(body, ctx),
  }),
  estimatedHeight: (q) => ROW_PX * (1 + Math.min(q.limit, 10)),
};
