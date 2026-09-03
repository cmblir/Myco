// Editor completion triggers: `/` blocks, frontmatter `tags:` values and body `#tags`.
// Pure functions (no CodeMirror imports) so vitest covers them in node;
// Editor.tsx wraps them into autocompletion sources.

import type { Strings } from "./i18n";
import { frontmatterLength } from "./markdown";
import { normalizeQuery } from "./settingsSearch";
import { today } from "./taskLine";

export interface TriggerMatch {
  /** Offset in the passed text where the query starts. */
  from: number;
  query: string;
}

const FENCE_OPEN_RE = /^---[ \t]*\r?\n/;
// `tags: a, b|` / `tags: [x, y|` — everything after the key on the cursor line.
const TAGS_INLINE_RE = /(?:^|\n)tags:(?:[ \t]+\[?|\[)([^\n]*)$/;
// `  - fo|` under a `tags:` line, past any number of finished `  - x` lines.
const TAGS_LIST_RE =
  /(?:^|\n)tags:[ \t]*\r?\n(?:[ \t]+-[ \t][^\n]*\n)*[ \t]+-[ \t]+([^\n]*)$/;

/** Cursor is inside a still-open frontmatter block (fence started, not closed). */
function inOpenFrontmatter(prefix: string): boolean {
  return FENCE_OPEN_RE.test(prefix) && frontmatterLength(prefix) === 0;
}

/** `prefix` = doc text up to the cursor. Frontmatter only: the block must be
 *  open — body `#tag`s are handled by {@link bodyTagQueryAt}. */
export function tagQueryAt(prefix: string): TriggerMatch | null {
  if (!inOpenFrontmatter(prefix)) {
    return null;
  }
  const inline = TAGS_INLINE_RE.exec(prefix);
  if (inline) {
    const items = inline[1];
    const query = items.slice(items.lastIndexOf(",") + 1).replace(/^\s+/, "");
    return { from: prefix.length - query.length, query };
  }
  const list = TAGS_LIST_RE.exec(prefix);
  return list
    ? { from: prefix.length - list[1].length, query: list[1] }
    : null;
}

// `#tag` at line start or after whitespace, no space after `#` (so `# ` and
// `## ` headings never trigger); the query excludes the `#`.
const BODY_TAG_RE = /(?:^|\s)#([^\s#]*)$/;

/** Body `#tag` completion. `prefix` = doc text up to the cursor; only the
 *  cursor line matters, except that an open frontmatter block is skipped
 *  (tagQueryAt owns it). `from` = the char after `#`, so applying a bare
 *  tag keeps the `#`. */
export function bodyTagQueryAt(prefix: string): TriggerMatch | null {
  if (inOpenFrontmatter(prefix)) return null;
  const lineBefore = prefix.slice(prefix.lastIndexOf("\n") + 1);
  const m = BODY_TAG_RE.exec(lineBefore);
  return m ? { from: prefix.length - m[1].length, query: m[1] } : null;
}

const SLASH_RE = /(?:^|\s)\/(\S*)$/;

/** `/word` at line start or after whitespace (`9/2`, `a/b`, `http://` never
 *  match); `from` = the `/`. */
export function slashQueryAt(lineBefore: string): TriggerMatch | null {
  const m = SLASH_RE.exec(lineBefore);
  return m
    ? { from: lineBefore.length - m[1].length - 1, query: m[1] }
    : null;
}

export interface SlashItem {
  label: string;
  detail: string;
  /** CodeMirror snippet template; `${}` = a field (the last one = final caret). */
  template: string;
}

/** The 11 `/` blocks (no `link` — `[[` already completes). */
export function slashItems(t: Strings, now: Date = new Date()): SlashItem[] {
  return [
    { label: "h1", detail: t.sl_h1 ?? "Heading 1", template: "# ${}" },
    { label: "h2", detail: t.sl_h2 ?? "Heading 2", template: "## ${}" },
    { label: "h3", detail: t.sl_h3 ?? "Heading 3", template: "### ${}" },
    {
      label: "bullet",
      detail: t.sl_bullet ?? "Bulleted list",
      template: "- ${}",
    },
    {
      label: "numbered",
      detail: t.sl_numbered ?? "Numbered list",
      template: "1. ${}",
    },
    { label: "todo", detail: t.sl_todo ?? "To-do", template: "- [ ] ${}" },
    {
      label: "code",
      detail: t.sl_code ?? "Code block",
      template: "```${lang}\n${}\n```",
    },
    { label: "quote", detail: t.sl_quote ?? "Quote", template: "> ${}" },
    {
      label: "table",
      detail: t.sl_table ?? "Table",
      template: "| ${Column} | Column |\n| --- | --- |\n| ${} |  |",
    },
    {
      label: "divider",
      detail: t.sl_divider ?? "Divider",
      template: "---\n${}",
    },
    { label: "date", detail: t.sl_date ?? "Today's date", template: today(now) },
  ];
}

/** Label prefix OR localized detail substring, so `/h2`, `/표`, `/할 일` all work. */
export function filterSlash(items: SlashItem[], query: string): SlashItem[] {
  const q = normalizeQuery(query);
  return items.filter(
    (i) => i.label.startsWith(q) || normalizeQuery(i.detail).includes(q),
  );
}
