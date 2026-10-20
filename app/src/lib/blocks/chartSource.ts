// A ```chart fence's body as flat YAML with obsidian-charts' keys — `type`
// bar | line | pie (doughnut reads as pie), `title`, and either inline
// `labels` + `series` (`- title:` / `data:`, lists as `[a, b]` or as `- a`
// lines, as Obsidian's YAML reads both) or `id` naming the table tagged
// `^id` in the note (the `^id` paragraph right under it, as Obsidian tags a
// table) read by `layout`: columns (obsidian-charts' default — the first
// column labels, each other column a series) or rows. Keys it does not draw
// (width, beginAtZero, …) are ignored, so an obsidian-charts block
// round-trips; the chart's panel writes its form back (writeChart) without
// touching them. Pure (vitest, node); ./chart.ts draws it.

export type ChartType = "bar" | "line" | "pie";

/** The fence as written; data still text (numbers are read in chartData). */
export interface ChartSource {
  type: ChartType;
  title: string;
  id: string | null;
  layout: "rows" | "columns";
  labels: string[];
  series: { title: string; data: string[] }[];
}

export interface ChartError {
  error: "type" | "line" | "data" | "table" | "number";
  /** The bad type, line number, table id or value ("" = none). */
  arg: string;
}

export type ChartModel = ChartSource | ChartError;

const TYPES: Record<string, ChartType> = {
  bar: "bar",
  line: "line",
  pie: "pie",
  doughnut: "pie",
};
const KEY_RE = /^([A-Za-z_][\w-]*)[ \t]*:(?:[ \t]+(.*?))?[ \t]*$/;
const ITEM_RE = /^([ \t]*)-(?:[ \t]+(.*?))?[ \t]*$/;
const SKIP_RE = /^[ \t]*(?:#.*)?$/;

/** A YAML scalar's text: quoted as written, or bare up to a ` #` comment.
 *  Not frontmatter.ts parseScalar: that module imports markdown.ts, which
 *  imports the block registry (a cycle leaves CHART undefined in BLOCKS). */
function scalar(v: string | undefined): string {
  const s = (v ?? "").trim();
  const dq = /^"((?:[^"\\]|\\.)*)"/.exec(s);
  if (dq) return dq[1].replace(/\\(.)/g, "$1");
  const sq = /^'((?:[^']|'')*)'/.exec(s);
  if (sq) return sq[1].replace(/''/g, "'");
  return s.replace(/(^|\s)#.*$/, "").trim();
}

/** `[a, b]` (or a bare `a, b`) → its items. ponytail: a comma inside quotes
 *  splits too, as in the frontmatter reader. */
function list(v: string | undefined): string[] {
  const s = (v ?? "").replace(/(^|\s)#.*$/, "").trim();
  const inner = /^\[(.*)\]$/.exec(s)?.[1] ?? s;
  return inner.trim() ? inner.split(",").map(scalar) : [];
}

interface Read {
  src: ChartSource;
  /** `type:` as written, lower-cased. */
  type: string;
  /** The first line that is not `key: value` (1-based), 0 for none. */
  bad: number;
}

/** The body's keys, every line read: a line that is not `key: value` is
 *  skipped (and named in `bad`). */
function read(body: string): Read {
  const src: ChartSource = {
    type: "bar",
    title: "",
    id: null,
    layout: "columns",
    labels: [],
    series: [],
  };
  let type = "";
  let bad = 0;
  let key = "";
  // The indent of the `- ` that opened each series, -1 before the first,
  // and whether `- x` lines now are the last series' block-style `data:`.
  let seriesAt = -1;
  let inData = false;
  const lines = body.split("\n");
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    if (SKIP_RE.test(line)) continue;
    // An indented line or a `- ` item belongs to the key above it; only
    // labels' and series' are read.
    const item = ITEM_RE.exec(line);
    if (item || /^[ \t]/.test(line)) {
      if (key === "labels" && item) src.labels.push(scalar(item[2]));
      if (key !== "series") continue;
      const at = item?.[1].length ?? -1;
      let kv: RegExpExecArray | null = null;
      if (item && (seriesAt < 0 || at <= seriesAt)) {
        src.series.push({ title: "", data: [] });
        seriesAt = at;
        kv = KEY_RE.exec(item[2] ?? "");
      } else if (item) {
        if (inData)
          src.series[src.series.length - 1].data.push(scalar(item[2]));
        continue;
      } else kv = KEY_RE.exec(line.trim());
      const s = src.series[src.series.length - 1];
      inData = kv?.[1] === "data" && kv[2] === undefined;
      if (s && kv?.[1] === "title") s.title = scalar(kv[2]);
      else if (s && kv?.[1] === "data") s.data = list(kv[2]);
      continue;
    }
    const kv = KEY_RE.exec(line);
    if (!kv) {
      bad ||= n + 1;
      key = "";
      continue;
    }
    key = kv[1];
    const v = kv[2];
    if (key === "type") type = scalar(v).toLowerCase();
    else if (key === "title") src.title = scalar(v);
    else if (key === "id") src.id = scalar(v).replace(/^\^/, "") || null;
    else if (key === "layout")
      src.layout = scalar(v).toLowerCase() === "rows" ? "rows" : "columns";
    else if (key === "labels") src.labels = list(v);
  }
  return { src, type, bad };
}

/** Pure: the fence's body → the chart, or the first thing it cannot read. */
export function parseChart(body: string): ChartModel {
  const { src, type, bad } = read(body);
  if (bad) return { error: "line", arg: String(bad) };
  const t = TYPES[type];
  if (!t) return { error: "type", arg: type };
  return { ...src, type: t };
}

/** Pure: the chart panel's form for a body — whatever it can read, a type
 *  it cannot read as bar. */
export function chartForm(body: string): ChartSource {
  const { src, type } = read(body);
  return { ...src, type: TYPES[type] ?? "bar" };
}

/** A scalar as YAML reads it back (scalar, list): quoted where a bare one
 *  would be read otherwise — a quote, `#` or bracket first, a comment, a
 *  `: ` that Obsidian's YAML reads as a mapping, a bracket in a list. */
function yaml(s: string, item = false): string {
  const plain =
    s !== "" &&
    !/^[\s"'#[\]{}&*!|>%@`]|\s$|: |\s#/.test(s) &&
    !(item && /[[\]]/.test(s));
  return plain ? s : `"${s.replace(/[\\"]/g, "\\$&")}"`;
}

const flow = (xs: readonly string[]): string =>
  `[${xs.map((x) => yaml(x, true)).join(", ")}]`;

const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/** The keys the form writes, in the order a missing one is added. */
const FORM_KEYS = ["type", "title", "id", "layout", "labels", "series"];

/** Pure: `body` with the form `next` written into it — only the keys whose
 *  value changed, each in place (a missing one after the form's last key);
 *  a key that no longer applies goes (inline data once a table is chosen,
 *  and back). Every other line stays as written, so an untouched form
 *  writes the body back byte for byte. */
export function writeChart(body: string, next: ChartSource): string {
  const r = read(body);
  const now = { ...r.src, type: TYPES[r.type] ?? "bar" };
  // A key's new lines; null takes it out.
  const want = new Map<string, string[] | null>();
  if (!TYPES[r.type] || next.type !== now.type)
    want.set("type", [`type: ${next.type}`]);
  if (next.title !== now.title)
    want.set("title", next.title ? [`title: ${yaml(next.title)}`] : null);
  if (next.id !== null) {
    if (next.id !== now.id) want.set("id", [`id: ${next.id}`]);
    if (next.layout !== now.layout || now.id === null)
      want.set("layout", next.layout === "rows" ? ["layout: rows"] : null);
    if (now.id === null) {
      want.set("labels", null);
      want.set("series", null);
    }
  } else {
    if (now.id !== null) {
      want.set("id", null);
      want.set("layout", null);
    }
    if (now.id !== null || !same(next.labels, now.labels))
      want.set(
        "labels",
        next.labels.length ? [`labels: ${flow(next.labels)}`] : null,
      );
    if (now.id !== null || !same(next.series, now.series))
      want.set(
        "series",
        next.series.length
          ? [
              "series:",
              ...next.series.flatMap((s) => [
                ...(s.title ? [`  - title: ${yaml(s.title)}`] : []),
                `${s.title ? "   " : "  -"} data: ${flow(s.data)}`,
              ]),
            ]
          : null,
      );
  }
  const out: string[] = [];
  const wrote = new Set<string>();
  // Where a key the body lacks goes: after the form's last key.
  let after = -1;
  let owner: string | null = null;
  for (const line of body ? body.split("\n") : []) {
    let key: string | null = owner;
    let head = false;
    if (SKIP_RE.test(line)) key = null;
    else if (!ITEM_RE.test(line) && !/^[ \t]/.test(line)) {
      owner = key = KEY_RE.exec(line)?.[1] ?? null;
      head = true;
    }
    const mine = key !== null && FORM_KEYS.includes(key);
    if (mine && want.has(key!)) {
      if (head && !wrote.has(key!)) {
        wrote.add(key!);
        out.push(...(want.get(key!) ?? []));
        after = out.length;
      }
      continue;
    }
    out.push(line);
    if (mine) after = out.length;
  }
  const added = FORM_KEYS.flatMap((k) =>
    wrote.has(k) ? [] : (want.get(k) ?? []),
  );
  out.splice(after < 0 ? out.length : after, 0, ...added);
  return out.join("\n");
}

/** The table `/chart` and a chart panel's "new table" insert, tagged. */
export const SAMPLE_TABLE =
  "|  | A | B |\n| --- | --- | --- |\n| Q1 | 12 | 8 |\n| Q2 | 19 | 11 |\n| Q3 | 15 | 9 |";

/** Pure: the first of chart-data, chart-data-2, … that no `^id` tag or
 *  chart `id:` in `doc` names. */
export function freeId(doc: string): string {
  const id = (n: number) => (n > 1 ? `chart-data-${n}` : "chart-data");
  const used = (x: string) =>
    new RegExp(`(?:\\^|^[ \\t>]*id:[ \\t]*\\^?)${x}(?![\\w-])`, "m").test(doc);
  let n = 1;
  while (used(id(n))) n++;
  return id(n);
}
