// A query block's panel (./fencePanel): 폴더 (path:), 태그 (tag:), 종류
// (type:), 정렬 (sort:) and 개수 (limit:) as fields, and under 고급 the whole
// query line as text for every term the form does not cover. The two stay
// in sync (./queryForm); the bake button stays on the result.

import { TYPE_COLORS } from "../../components/DashCharts";
import type { Strings } from "../i18n";
import type { BlockCtx } from "./index";
import { field, type PanelForm } from "./fencePanel";
import { queryForm, setQueryTerm, type QueryField } from "./queryForm";

/** The fence's body as one line, as parseQuery joins it. */
const joined = (body: string): string =>
  body
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ");

/** 정렬's choices: none (by name), then each sort key's natural order and
 *  its reverse where both read naturally. */
function sorts(t: Strings | undefined): [string, string][] {
  return [
    ["", t?.qb_sort_default ?? "Default (name)"],
    ["name", t?.qb_sort_name ?? "Name A→Z"],
    ["-name", t?.qb_sort_name_desc ?? "Name Z→A"],
    ["modified", t?.qb_sort_modified ?? "Recently modified"],
    ["-modified", t?.qb_sort_modified_asc ?? "Least recently modified"],
    ["links", t?.qb_sort_links ?? "Most links"],
    ["sources", t?.qb_sort_sources ?? "Most sources"],
    ["type", t?.qb_sort_type ?? "By type"],
  ];
}

let lists = 0;

export function queryFields(body: string, ctx: BlockCtx): PanelForm {
  const t = ctx.t;
  let line = joined(body);
  const text = (placeholder: string): HTMLInputElement => {
    const i = document.createElement("input");
    i.type = "text";
    i.className = "fb-input";
    i.spellcheck = false;
    i.placeholder = placeholder;
    return i;
  };
  const types = document.createElement("datalist");
  types.id = `fb-types-${++lists}`;
  types.append(...Object.keys(TYPE_COLORS).map((k) => new Option(k)));
  const type = text("concept");
  type.setAttribute("list", types.id);
  const sort = document.createElement("select");
  sort.className = "fb-input";
  const limit = document.createElement("input");
  limit.type = "number";
  limit.className = "fb-input fb-num";
  limit.min = "1";
  limit.max = "999";
  limit.step = "1";
  const fields: Record<QueryField, HTMLInputElement | HTMLSelectElement> = {
    path: text("wiki/"),
    tag: text(""),
    type,
    sort,
    limit,
  };
  const advanced = text("");
  advanced.classList.add("fb-mono");

  const el = document.createElement("div");
  el.className = "fb-fields fb-query";
  const row = document.createElement("div");
  row.className = "fb-row";
  row.append(
    field(t?.qb_f_path ?? "Folder", fields.path),
    field(t?.qb_f_tag ?? "Tag", fields.tag),
    field(t?.qb_f_type ?? "Type", type),
    field(t?.qb_f_sort ?? "Sort", sort),
    field(t?.qb_f_limit ?? "Max results", limit),
  );
  const more = document.createElement("details");
  more.className = "fb-more";
  const summary = document.createElement("summary");
  summary.textContent = t?.qb_f_advanced ?? "Advanced";
  more.append(summary, field(t?.qb_f_line ?? "Query", advanced));
  el.append(row, types, more);

  /** Every field but the one being typed in shows `line`. */
  function fill(): void {
    const active = el.ownerDocument.activeElement;
    const f = queryForm(line);
    const options = sorts(t);
    if (!options.some(([v]) => v === f.sort)) options.push([f.sort, f.sort]);
    sort.replaceChildren(
      ...options.map(([v, label]) => new Option(label, v, false, v === f.sort)),
    );
    for (const key of Object.keys(fields) as QueryField[])
      if (fields[key] !== active && key !== "sort") fields[key].value = f[key];
    if (advanced !== active) advanced.value = line;
  }

  for (const key of Object.keys(fields) as QueryField[])
    fields[key].addEventListener("input", () => {
      line = setQueryTerm(line, key, fields[key].value);
      advanced.value = line;
    });
  advanced.addEventListener("input", () => {
    line = advanced.value;
    fill();
  });
  fill();
  return {
    el,
    // A body over several lines stays as written until the query changes.
    body: (now) => (joined(now) === line.trim() ? now : line.trim()),
    sync(b) {
      line = joined(b);
      fill();
    },
  };
}
