// A query block's panel form (./queryPanel) and its query line, kept in
// sync: the form edits the first term of each of its keys in place, and
// every other term — a "phrase", status:, view:, a free word — stays as
// written. Terms split on spaces outside quotes, as lib/searchQuery reads a
// phrase. Pure (vitest, node).

export type QueryField = "path" | "tag" | "type" | "sort" | "limit";

export type QueryFormValue = Record<QueryField, string>;

const FIELDS: readonly QueryField[] = ["path", "tag", "type", "sort", "limit"];

/** ⌘K's operators are lower case (searchQuery); the block's own options
 *  take any case (query.ts OPTION_RE). */
const termRe = (key: QueryField): RegExp =>
  new RegExp(`^${key}:`, key === "sort" || key === "limit" ? "i" : "");

/** The line's terms: runs of non-space text, a quoted phrase one piece. */
const terms = (line: string): string[] =>
  line.match(/(?:[^\s"]+|"[^"]*"?)+/g) ?? [];

/** Pure: each field's value — its key's first term — or "". */
export function queryForm(line: string): QueryFormValue {
  const all = terms(line);
  const out = {} as QueryFormValue;
  for (const key of FIELDS) {
    const re = termRe(key);
    const t = all.find((x) => re.test(x));
    out[key] = t ? t.slice(key.length + 1) : "";
  }
  return out;
}

/** Pure: the line with `key`'s first term set to `value` (spaces taken
 *  out: they would split the term), appended when it has none, taken out
 *  when `value` is empty. */
export function setQueryTerm(
  line: string,
  key: QueryField,
  value: string,
): string {
  const all = terms(line);
  const v = value.replace(/\s+/g, "");
  const re = termRe(key);
  const i = all.findIndex((x) => re.test(x));
  if (i < 0) {
    if (v) all.push(`${key}:${v}`);
  } else if (v) all[i] = `${key}:${v}`;
  else all.splice(i, 1);
  return all.join(" ");
}
