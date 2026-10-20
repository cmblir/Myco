// A chart's panel (./fencePanel): 종류 (막대 / 선 / 원), 제목, and its data
// — a table in this note tagged `^id` (a picker of the note's tagged
// tables, or 새 표 만들기: a sample table tagged above the chart) read by
// 방향 (columns or rows), or inline labels and series. The table itself is
// edited as a Notion table and the chart redraws as its cells change. The
// fence's other keys (obsidian-charts' width, …) stay as written
// (chartSource writeChart).

import type { Strings } from "../i18n";
import type { TaggedTables } from "./chart";
import type { BlockCtx } from "./index";
import {
  SAMPLE_TABLE,
  chartForm,
  freeId,
  writeChart,
  type ChartSource,
  type ChartType,
} from "./chartSource";
import { fenceBody, ledLines, withBody } from "./fenceSource";
import { button, field, type PanelForm, type PanelHooks } from "./fencePanel";

/** The picker's "new table" value: no tag id holds a space. */
const NEW = " new";

type Layout = ChartSource["layout"];
type Series = ChartSource["series"];

/** One pressed button of `items`, under its name. */
function segment<T extends string>(
  label: string,
  items: readonly (readonly [T, string])[],
  pick: (v: T) => void,
): { el: HTMLElement; set(v: T): void } {
  const el = document.createElement("div");
  el.className = "fb-field";
  const name = document.createElement("span");
  name.className = "fb-label";
  name.textContent = label;
  const seg = document.createElement("div");
  seg.className = "u-segment fb-seg";
  seg.setAttribute("role", "group");
  seg.setAttribute("aria-label", label);
  const set = (v: T) => {
    for (const b of seg.children)
      b.setAttribute(
        "aria-pressed",
        String((b as HTMLElement).dataset.v === v),
      );
  };
  for (const [v, text] of items) {
    const b = button("u-segment__btn", text, () => {
      set(v);
      pick(v);
    });
    b.dataset.v = v;
    seg.append(b);
  }
  el.append(name, seg);
  return { el, set };
}

function input(value: string, placeholder = ""): HTMLInputElement {
  const i = document.createElement("input");
  i.type = "text";
  i.className = "fb-input";
  i.spellcheck = false;
  i.value = value;
  i.placeholder = placeholder;
  return i;
}

/** `a, b, c` → its items; `keepEmpty`: an empty one in the middle stays
 *  (a value read as 0), trailing ones go. */
function items(text: string, keepEmpty = false): string[] {
  const out = text.split(",").map((s) => s.trim());
  if (!keepEmpty) return out.filter(Boolean);
  while (out.length && !out[out.length - 1]) out.pop();
  return out;
}

/** What the fields hold, as values: the title, the labels and the series'
 *  names as typed. */
export interface ChartFields {
  type: ChartType;
  title: string;
  mode: "table" | "inline";
  /** The table picked, or the one the picker offers first. */
  table: string | null;
  layout: Layout;
  labels: string;
  series: Series;
}

/** Pure: the fields as `body` says them — the panel opening, or the note
 *  changing under it (⌘Z, an outside edit) — `table` the one picked
 *  before, else the note's first tagged table. No `id:` is inline data,
 *  the body's own labels and series, never a sample: a panel opened and
 *  closed untouched writes nothing (decision 7). */
export function fieldsFor(body: string, table: string | null): ChartFields {
  const form = chartForm(body);
  return {
    type: form.type,
    title: form.title,
    mode: form.id === null ? "inline" : "table",
    table: form.id ?? table,
    layout: form.layout,
    labels: form.labels.join(", "),
    series: form.series,
  };
}

/** Pure: `f` turned to inline data, with a chart to start from when it
 *  has none. */
export function toInline(f: ChartFields): ChartFields {
  const none = !f.series.length && !items(f.labels).length;
  return {
    ...f,
    mode: "inline",
    ...(none
      ? { labels: "A, B", series: [{ title: "", data: ["1", "2"] }] }
      : {}),
  };
}

/** `typed` trimmed, or `was` as written when the two differ only in the
 *  spaces at their ends (a quoted " 공백 "). */
const trimmed = (typed: string, was: string): string =>
  typed.trim() === was.trim() ? was : typed.trim();

/** Pure: the chart `f` says, over the body `now` holds. */
export function chartOf(now: string, f: ChartFields): ChartSource {
  const was = chartForm(now);
  const out = { ...was, type: f.type, title: trimmed(f.title, was.title) };
  if (f.mode === "inline")
    return {
      ...out,
      id: null,
      labels: items(f.labels),
      series: f.series.map((s, i) => ({
        ...s,
        title: trimmed(s.title, was.series[i]?.title ?? ""),
      })),
    };
  // No table chosen yet: the data stays as it is.
  return f.table === null ? out : { ...out, id: f.table, layout: f.layout };
}

/** Pure: the table picker's [value, label] options — the note's tagged
 *  tables by place and header row (표 1 · A, B), the chart's own when the
 *  note has none of it, then 새 표 만들기. A value is the table's tag; a
 *  label never shows it (decision 6). */
export function tableOptions(
  tables: TaggedTables | undefined,
  table: string | null,
  t: Strings | undefined,
): [string, string][] {
  const opts = [...(tables ?? [])].map(([id, rows], i): [string, string] => {
    const name = (t?.ch_f_table_n ?? "Table {n}").replace("{n}", String(i + 1));
    const head = (rows[0] ?? []).filter(Boolean).join(", ");
    return [id, head ? `${name} · ${head}` : name];
  });
  if (table !== null && !tables?.has(table))
    opts.push([table, t?.ch_f_missing ?? "A table not in this note"]);
  opts.push([NEW, t?.ch_f_new_table ?? "New table"]);
  return opts;
}

export function chartFields(
  body: string,
  ctx: BlockCtx,
  hooks: PanelHooks,
): PanelForm {
  const t = ctx.t;
  let tables = ctx.tables;
  let f = fieldsFor(body, tables?.keys().next().value ?? null);
  const el = document.createElement("div");
  el.className = "fb-fields fb-chart";

  const typeSeg = segment<ChartType>(
    t?.ch_f_type ?? "Type",
    [
      ["bar", t?.ch_f_bar ?? "Bar"],
      ["line", t?.ch_f_line ?? "Line"],
      ["pie", t?.ch_f_pie ?? "Pie"],
    ],
    (v) => {
      f.type = v;
      hooks.changed();
    },
  );
  const title = input(f.title);
  const dataSeg = segment<"table" | "inline">(
    t?.ch_f_data ?? "Data",
    [
      ["table", t?.ch_f_from_table ?? "A table in this note"],
      ["inline", t?.ch_f_inline ?? "Inline data"],
    ],
    (v) => {
      if (v === "inline" && f.mode === "table") {
        f = toInline(fields());
        labels.value = f.labels;
        fillSeries();
      }
      f.mode = v;
      show();
      hooks.changed();
    },
  );

  const pick = document.createElement("select");
  pick.className = "fb-input";
  pick.addEventListener("change", () => {
    if (pick.value === NEW) newTable();
    else f.table = pick.value;
  });
  const dirSeg = segment<Layout>(
    t?.ch_f_layout ?? "Layout",
    [
      ["columns", t?.ch_f_columns ?? "Columns"],
      ["rows", t?.ch_f_rows ?? "Rows"],
    ],
    (v) => {
      f.layout = v;
      hooks.changed();
    },
  );
  const tablePart = document.createElement("div");
  tablePart.className = "fb-row";
  tablePart.append(field(t?.ch_f_table ?? "Table", pick), dirSeg.el);

  const labels = input(f.labels, "A, B, C");
  const list = document.createElement("div");
  list.className = "fb-series";
  const add = button(
    "u-btn u-btn--quiet fb-add",
    `+ ${t?.ch_f_add_series ?? "Add series"}`,
    () => {
      f.series = [...readSeries(), { title: "", data: [] }];
      fillSeries();
      list
        .querySelector<HTMLInputElement>(".fb-series-row:last-child input")
        ?.focus();
      hooks.changed();
    },
  );
  const inlinePart = document.createElement("div");
  inlinePart.className = "fb-fields";
  inlinePart.append(field(t?.ch_f_labels ?? "Labels", labels), list, add);

  el.append(
    typeSeg.el,
    field(t?.ch_f_title ?? "Title", title),
    dataSeg.el,
    tablePart,
    inlinePart,
  );

  function fillTables(): void {
    const { table } = f;
    const opts = tableOptions(tables, table, t);
    pick.replaceChildren(
      ...opts.map(([v, text]) => new Option(text, v, false, v === table)),
    );
    if (table === null) {
      const none = new Option(t?.ch_f_pick ?? "Choose a table", "", true, true);
      none.disabled = true;
      pick.prepend(none);
    }
  }

  function readSeries(): Series {
    return [...list.children].map((row) => {
      const [name, values] = row.querySelectorAll("input");
      return { title: name.value, data: items(values.value, true) };
    });
  }

  function fillSeries(): void {
    list.replaceChildren(
      ...f.series.map((s, i) => {
        const n = String(i + 1);
        const row = document.createElement("div");
        row.className = "fb-series-row";
        const name = input(
          s.title,
          (t?.ch_f_series ?? "Series {n}").replace("{n}", n),
        );
        name.setAttribute("aria-label", name.placeholder);
        const values = input(s.data.join(", "), "1, 2, 3");
        values.setAttribute(
          "aria-label",
          `${name.placeholder} · ${t?.ch_f_values ?? "Values"}`,
        );
        const remove = button("u-btn u-btn--quiet fb-x", "×", () => {
          f.series = readSeries().filter((_, k) => k !== i);
          fillSeries();
          hooks.changed();
        });
        remove.setAttribute(
          "aria-label",
          (t?.ch_f_remove_series ?? "Remove series {n}").replace("{n}", n),
        );
        remove.disabled = f.series.length < 2;
        row.append(name, values, remove);
        return row;
      }),
    );
  }

  function show(): void {
    dataSeg.set(f.mode);
    tablePart.hidden = f.mode !== "table";
    inlinePart.hidden = f.mode !== "inline";
  }

  /** The fields with what is typed in them now. */
  function fields(): ChartFields {
    return {
      ...f,
      title: title.value,
      labels: labels.value,
      series: readSeries(),
    };
  }

  /** The chart the fields say, over the body `now` holds. */
  const next = (now: string): ChartSource => chartOf(now, fields());

  /** A sample table tagged with a new id above the chart, which reads it;
   *  then the chart's panel opens again. */
  function newTable(): void {
    hooks.edit((doc, from) => {
      const { source, lead } = hooks.block();
      const id = freeId(doc);
      const body = fenceBody(source, lead);
      const fence = withBody(
        source,
        lead,
        writeChart(body, { ...next(body), id, layout: "columns" }),
      );
      // Apart from a paragraph right above, which would run into the table.
      const above = doc.slice(doc.lastIndexOf("\n", from - 2) + 1, from - 1);
      const gap = from > 0 && /[^\s>]/.test(above) ? [""] : [];
      const insert =
        ledLines(lead, [
          ...gap,
          ...SAMPLE_TABLE.split("\n"),
          "",
          `^${id}`,
          "",
        ]) +
        "\n" +
        fence;
      return {
        from,
        to: from + source.length,
        insert,
        open: insert.length - fence.length,
      };
    });
  }

  typeSeg.set(f.type);
  dirSeg.set(f.layout);
  fillTables();
  fillSeries();
  show();
  return {
    el,
    body: (now) => writeChart(now, next(now)),
    sync(b, c) {
      tables = c.tables;
      // No `id:` is inline data, whatever the panel showed before (⌘Z
      // took the table back): the next edit writes what the fence says.
      f = fieldsFor(b, f.table);
      const active = el.ownerDocument.activeElement;
      if (title !== active) title.value = f.title;
      if (f.mode === "inline" && labels !== active) labels.value = f.labels;
      typeSeg.set(f.type);
      dirSeg.set(f.layout);
      fillTables();
      if (!list.contains(active)) fillSeries();
      show();
    },
  };
}
