// Lossless line-based YAML-subset frontmatter: parse, patch, serialize.
// Every writer of frontmatter in the app goes through here so a property edit
// changes exactly one line and leaves the rest of the block byte-identical.

import { frontmatterLength } from "./markdown";

export type FmScalar = string | number | boolean | null;
export type FmValue = FmScalar | string[];
/** `src` = exact source text of the key line + continuations (each with its
 *  eol); untouched entries are re-emitted from it — that is the lossless round
 *  trip. `value` undefined = nested map / block scalar (read-only). */
export interface FmEntry {
  key: string;
  value: FmValue | undefined;
  src: string;
}
export interface Frontmatter {
  head: string;
  entries: FmEntry[];
  end: number;
  eol: "\n" | "\r\n";
}
/** undefined = remove the key. */
export type FmPatch = Record<string, FmValue | undefined>;
/** Replace raw[0, to) with insert; `raw` is the whole document after the edit. */
export interface FmEdit {
  raw: string;
  to: number;
  insert: string;
}

// local_llm.rs WIKI_TYPES + validator.rs META_TYPES
export const FM_TYPES = [
  "concept",
  "entity",
  "technique",
  "source-summary",
  "analysis",
  "map",
  "overview",
  "meta",
] as const;
// validator.rs STATUS / CONFIDENCE
export const FM_STATUS = ["active", "superseded", "disputed"] as const;
export const FM_CONFIDENCE = ["high", "medium", "low"] as const;

const KEY_LINE_RE = /^([A-Za-z0-9_][\w.-]*):(?:[ \t]+(.*?))?[ \t]*$/;
const LIST_ITEM_RE = /^\s*-(?:\s+(.*))?$/;
const IGNORED_LINE_RE = /^\s*(#.*)?$/;
const FLOW_LIST_RE = /^\[(.*?)\][ \t]*(#.*)?$/;
const RESERVED_RE = /^(true|false|null|yes|no|on|off|~)$/i;
const NUMBER_RE = /^-?\d+(\.\d+)?$/;
const BARE_RE = /^[\p{L}\p{N}_][\p{L}\p{N}_ ./-]*$/u;

export function parseScalar(text: string): FmScalar {
  const s = text.trim();
  const dq = /^"((?:[^"\\]|\\.)*)"/.exec(s);
  if (dq) {
    try {
      return JSON.parse(dq[0]) as string;
    } catch {
      return dq[1];
    }
  }
  const sq = /^'((?:[^']|'')*)'/.exec(s);
  if (sq) return sq[1].replace(/''/g, "'");
  const bare = s.replace(/(^|\s)#.*$/, "").trim();
  if (bare === "" || bare === "~" || bare === "null") return null;
  if (bare === "true") return true;
  if (bare === "false") return false;
  if (NUMBER_RE.test(bare)) return Number(bare);
  return bare;
}

function classify(
  inline: string | undefined,
  cont: string[],
): FmValue | undefined {
  // A block scalar owns every continuation, `#`-led content lines included.
  if (inline && /^[|>]/.test(inline) && cont.length) return undefined;
  const meaningful = cont.filter((l) => !IGNORED_LINE_RE.test(l));
  if (inline) {
    if (meaningful.length) return undefined;
    const flow = FLOW_LIST_RE.exec(inline);
    if (!flow) return parseScalar(inline);
    return flow[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => String(parseScalar(s) ?? ""));
  }
  if (!meaningful.length) return null;
  const items = meaningful.map((l) => LIST_ITEM_RE.exec(l));
  if (items.some((m) => !m)) return undefined;
  return items.map((m) => String(parseScalar(m![1] ?? "") ?? ""));
}

export function parseFrontmatter(raw: string): Frontmatter | null {
  const end = frontmatterLength(raw);
  if (!end) return null;
  const block = raw.slice(0, end);
  const eol = /^---[ \t]*\r\n/.test(block) ? "\r\n" : "\n";
  const lines = block.split(/\r?\n/);
  lines.shift(); // opening fence
  if (lines[lines.length - 1] === "") lines.pop();
  lines.pop(); // closing fence
  // Group lines first: classification needs a key line and all its continuations.
  let head = "";
  const groups: { line: string; cont: string[] }[] = [];
  for (const line of lines) {
    if (KEY_LINE_RE.test(line)) groups.push({ line, cont: [] });
    else if (groups.length) groups[groups.length - 1].cont.push(line);
    else head += line + eol;
  }
  const entries = groups.map((g): FmEntry => {
    const m = KEY_LINE_RE.exec(g.line)!;
    return {
      key: m[1],
      value: classify(m[2] && !m[2].startsWith("#") ? m[2] : undefined, g.cont),
      src: [g.line, ...g.cont].map((l) => l + eol).join(""),
    };
  });
  return { head, entries, end, eol };
}

export function getValue(
  fm: Frontmatter | null,
  key: string,
): FmValue | undefined {
  return fm?.entries.find((e) => e.key === key)?.value;
}

/** `tags` as index.rs extract_tags sees it: array, or a comma string split. */
export function tagsOf(fm: Frontmatter | null): string[] {
  const v = getValue(fm, "tags");
  const items = Array.isArray(v)
    ? v
    : typeof v === "string"
      ? v.split(",")
      : [];
  return items.map((s) => s.trim()).filter(Boolean);
}

function scalarText(v: FmScalar): string {
  if (v === null) return "";
  if (typeof v !== "string") return String(v);
  const bare =
    BARE_RE.test(v) &&
    v === v.trim() &&
    !RESERVED_RE.test(v) &&
    // Digit-led strings other than ISO dates: YAML core reads 1e3 / 0x1F /
    // 1_000 as numbers where NUMBER_RE would not.
    !(/^\d/.test(v) && !/^\d{4}-\d{2}-\d{2}$/.test(v));
  return bare ? v : JSON.stringify(v);
}

function serializeEntry(key: string, value: FmValue, eol: string): string {
  if (Array.isArray(value)) {
    if (!value.length) return `${key}: []${eol}`;
    return `${key}:${eol}${value.map((t) => `  - ${scalarText(t)}${eol}`).join("")}`;
  }
  const text = scalarText(value);
  return `${key}:${text ? ` ${text}` : ""}${eol}`;
}

/** "" when head and entries are both empty. */
export function serializeFrontmatter(fm: Frontmatter): string {
  if (!fm.head && !fm.entries.length) return "";
  const body = fm.entries.map((e) => e.src).join("");
  return `---${fm.eol}${fm.head}${body}---${fm.eol}`;
}

export function patchFrontmatter(raw: string, patch: FmPatch): FmEdit {
  const cur: Frontmatter = parseFrontmatter(raw) ?? {
    head: "",
    entries: [],
    end: 0,
    eol: raw.includes("\r\n") ? "\r\n" : "\n",
  };
  const entries = [...cur.entries];
  for (const [key, value] of Object.entries(patch)) {
    const i = entries.findIndex((e) => e.key === key);
    if (value === undefined) {
      if (i >= 0) entries.splice(i, 1);
      continue;
    }
    // Blank and comment lines grouped under the old entry survive the rewrite.
    const keep =
      i >= 0
        ? entries[i].src
            .split(/\r?\n/)
            .slice(1, -1)
            .filter((l) => IGNORED_LINE_RE.test(l))
            .map((l) => l + cur.eol)
            .join("")
        : "";
    const entry: FmEntry = {
      key,
      value,
      src: serializeEntry(key, value, cur.eol) + keep,
    };
    if (i >= 0) entries[i] = entry;
    else entries.push(entry);
  }
  const insert = serializeFrontmatter({ ...cur, entries });
  return { raw: insert + raw.slice(cur.end), to: cur.end, insert };
}

/** Trim, drop a leading '#'; null for empty / whitespace / ',' / '[' / ']'. */
export function normalizeTag(input: string): string | null {
  const t = input.trim().replace(/^#/, "");
  return t && !/[\s,[\]]/.test(t) ? t : null;
}
