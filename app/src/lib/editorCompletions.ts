// Editor completion triggers: `/` blocks, frontmatter `tags:` values and body `#tags`.
// Pure functions (no CodeMirror imports) so vitest covers them in node;
// Editor.tsx wraps them into autocompletion sources.

import type { EditorView } from "@codemirror/view";
import { BLOCKS } from "./blocks";
import { onThisDayQuery } from "./blocks/query";
import { TABLE } from "./blocks/table";
import type { Strings } from "./i18n";
import type { FileNode } from "./ipc";
import { frontmatterLength } from "./markdown";
import { normalizeQuery } from "./settingsSearch";
import { today } from "./taskLine";
import { vaultRel } from "./vaultAreas";
import { resolveStem } from "./wikilinks";

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

// Words after single spaces stay in the query (`/오늘의 과거`, `/제목 4`);
// a trailing space ends it.
const SLASH_RE = /(?:^|\s)\/(\S+(?: \S+)*)?$/;

/** `/word` at line start or after whitespace (`9/2`, `a/b`, `http://` never
 *  match); `from` = the `/`. */
export function slashQueryAt(lineBefore: string): TriggerMatch | null {
  const m = SLASH_RE.exec(lineBefore);
  const query = m?.[1] ?? "";
  return m ? { from: lineBefore.length - query.length - 1, query } : null;
}

const WIKILINK_RE = /\[\[([^\]\n|]*)$/;

/** An unclosed `[[query` before the caret; `from` = the query's start. With
 *  a `#`, `note` is the name before it (`""` = this note) and the query is
 *  the heading typed so far. An alias (`[[a|b`) is not completed. */
export function wikilinkQueryAt(
  lineBefore: string,
): (TriggerMatch & { note: string | null }) | null {
  const m = WIKILINK_RE.exec(lineBefore);
  if (!m) return null;
  const from = lineBefore.length - m[1].length;
  const hash = m[1].indexOf("#");
  return hash < 0
    ? { from, query: m[1], note: null }
    : {
        from: from + hash + 1,
        query: m[1].slice(hash + 1),
        note: m[1].slice(0, hash),
      };
}

/** The `[[` note rows for `query` (lower-cased): one per name without `.md`
 *  (a link resolves by that stem), names the query starts first, at most
 *  `limit`. `detail` is the folder of the note the link opens (UX backlog
 *  S17), left out at the vault root; `cut` = more names matched. */
export function wikilinkOptions(
  tree: FileNode[],
  root: string,
  query: string,
  limit = 30,
): { options: { label: string; detail?: string }[]; cut: boolean } {
  const files: FileNode[] = [];
  const stack = [...tree];
  while (stack.length) {
    const n = stack.pop();
    if (!n) continue;
    if (n.kind === "file") files.push(n);
    else stack.push(...n.children);
  }
  // Once over 30 matches this runs on every keystroke: dedupe in linear time.
  const byName = new Map<string, string>();
  for (const f of files) {
    const name = f.name.replace(/\.md$/i, "");
    if (!byName.has(name)) byName.set(name, f.path);
  }
  const names = [...byName.keys()];
  const starts = (s: string) => s.toLowerCase().startsWith(query);
  // Names the query starts come first: CodeMirror keeps only those for a
  // one-letter query, so cut at 30 in tree order `[[e` could show none.
  const matches = [
    ...names.filter(starts),
    ...names.filter((s) => !starts(s) && s.toLowerCase().includes(query)),
  ];
  // ponytail: one tree walk per row (30 × files); index stems once if a
  // large vault ever stutters here.
  const options = matches.slice(0, limit).map((label) => {
    const path = resolveStem(tree, label) ?? byName.get(label) ?? "";
    const dir = vaultRel(path.slice(0, path.lastIndexOf("/")), root);
    return dir && dir !== root ? { label, detail: dir } : { label };
  });
  return { options, cut: matches.length > limit };
}

/** Slash menu sections, in display order. */
export const SLASH_SECTIONS = [
  "basic",
  "media",
  "records",
  "advanced",
  "templates",
  "plugins",
] as const;
export type SlashSection = (typeof SLASH_SECTIONS)[number];

/** The sections' localized names (the `/` menu, the touch block tiles). */
export function slashSectionNames(t: Strings): Record<SlashSection, string> {
  return {
    basic: t.sl_sec_basic ?? "Basic blocks",
    media: t.sl_sec_media ?? "Media",
    records: t.sl_sec_records ?? "Records",
    advanced: t.sl_sec_advanced ?? "Advanced",
    templates: t.sl_sec_templates ?? "Templates",
    plugins: t.sl_sec_plugins ?? "Plugins",
  };
}

/** Where `item`'s section sorts while the menu is browsed (CodeMirror's
 *  section rank): SLASH_SECTIONS order; a template's own section after
 *  Templates and before Plugins, several of those by name. */
export function slashSectionRank(item: SlashItem): number {
  return item.sectionName
    ? SLASH_SECTIONS.indexOf("templates") + 0.5
    : SLASH_SECTIONS.indexOf(item.section);
}

/** Items that open a picker at the caret instead of inserting a template
 *  (`image`: the native file dialog). */
export type SlashPicker = "recall" | "onthisday" | "image" | "ask";

export interface SlashItem {
  /** The English keyword typed after `/` (`h1`, `todo`); matched by prefix. */
  label: string;
  /** Localized name — the menu's primary label; matched as a substring. */
  detail: string;
  /** More keywords, matched by prefix like `label`. */
  aliases: readonly string[];
  /** A short text glyph drawn before the name. */
  icon: string;
  section: SlashSection;
  /** A section of its own by this name, after Templates and before
   *  Plugins (a template's `slash_section`). */
  sectionName?: string;
  /** CodeMirror snippet template; `${}` = a field (the last one = final caret).
   *  Unused by block items, which rewrite the line through slashBlockEdit. */
  template: string;
  /** `template` for the note it goes into (`doc`), where that matters: a
   *  chart's sample tags its table with an id the note does not use. */
  templateFor?: (doc: string) => string;
  /** Set: `template` is plain text, not a snippet, and the caret lands this
   *  far into it (a vault template's body — CodeMirror's snippet parser
   *  misplaces a field after several brace escapes on its line). */
  caret?: number;
  /** Line prefix a block item turns the whole line into (`## `, `- [ ] `…). */
  block?: string;
  /** Inserted where typed, even mid-line (a date). */
  inline?: boolean;
  /** Opens a blank line away from text above, so no markdown reader joins it
   *  to that paragraph (`---` under text is a setext heading elsewhere). */
  apart?: boolean;
  /** Opens the completion menu again after inserting (`[[` → note names). */
  reopen?: boolean;
  /** Opens this picker where the `/query` was (components/RecallPicker). */
  picker?: SlashPicker;
  /** Opens the inserted block's own editor (blocks/live openBlockEditor):
   *  with `caret`, the block it inserts (a table's first cell); a snippet's
   *  last block otherwise (a chart's panel, under its sample table). */
  open?: boolean;
  /** Runs this once the `/query` is gone (a plugin's command). */
  run?: (view: EditorView) => void;
  /** One line beside the selected item, for names that read alike. */
  hint?: string;
}

/** The items whose names read alike (S29), and the line telling them apart. */
const HINTS: Readonly<Record<string, keyof Strings>> = {
  recall: "sl_hint_recall",
  query: "sl_hint_query",
  onthisday: "sl_hint_onthisday",
  "onthisday-query": "sl_hint_onthisday_query",
};

/** The `/` items, grouped by section in SLASH_SECTIONS order, the registry's
 *  blocks (lib/blocks) last. Callout and toggle write the `> [!note]` quote
 *  that lib/blocks/callout draws. */
export function slashItems(t: Strings, now: Date = new Date()): SlashItem[] {
  const block = (
    label: string,
    detail: string,
    icon: string,
    prefix: string,
    aliases: readonly string[] = [],
  ): SlashItem => ({
    label,
    detail,
    icon,
    aliases,
    section: "basic",
    template: prefix + "${}",
    block: prefix,
  });
  const items: SlashItem[] = [
    block("h1", t.sl_h1 ?? "Heading 1", "H1", "# ", ["heading1", "title"]),
    block("h2", t.sl_h2 ?? "Heading 2", "H2", "## ", ["heading2"]),
    block("h3", t.sl_h3 ?? "Heading 3", "H3", "### ", ["heading3"]),
    block("h4", t.sl_h4 ?? "Heading 4", "H4", "#### ", ["heading4"]),
    block("bullet", t.sl_bullet ?? "Bulleted list", "•", "- ", ["ul", "list"]),
    block("numbered", t.sl_numbered ?? "Numbered list", "1.", "1. ", [
      "ol",
      "ordered",
      "number",
    ]),
    block("todo", t.sl_todo ?? "To-do", "☐", "- [ ] ", [
      "task",
      "checkbox",
    ]),
    block("quote", t.sl_quote ?? "Quote", "❝", "> ", ["blockquote"]),
    block("callout", t.sl_callout ?? "Callout", "!", "> [!note] ", [
      "note",
      "tip",
      "warning",
      "admonition",
    ]),
    block("toggle", t.sl_toggle ?? "Toggle list", "▸", "> [!note]- ", [
      "collapse",
      "details",
      "fold",
    ]),
    // Empty cells (their header's name is CSS), the caret in the first one.
    {
      label: "table",
      detail: t.sl_table ?? "Table",
      icon: "▦",
      aliases: ["grid"],
      section: "basic",
      template: TABLE.template,
      caret: TABLE.template.length,
      open: true,
      apart: true,
    },
    {
      label: "divider",
      detail: t.sl_divider ?? "Divider",
      icon: "—",
      aliases: ["rule", "line", "separator"],
      section: "basic",
      template: "---\n${}",
      apart: true,
    },
    // Caret in the body: a caret on the info string sent typed code there.
    {
      label: "code",
      detail: t.sl_code ?? "Code block",
      icon: "</>",
      aliases: ["fence", "snippet", "pre"],
      section: "media",
      template: "```\n${}\n```",
    },
    // The file dialog; the image is copied under assets/ like a dropped one.
    {
      label: "image",
      detail: t.sl_image ?? "Image",
      icon: "▣",
      aliases: ["picture", "photo", "img", "이미지", "画像"],
      section: "media",
      template: "",
      picker: "image",
    },
    {
      label: "link",
      detail: t.sl_link ?? "Link to note",
      icon: "[[",
      aliases: ["wikilink", "page", "mention"],
      section: "records",
      template: "[[${}",
      inline: true,
      reopen: true,
    },
    // The `[[` list takes over: a note, `#` for its headings, or "In notes"
    // (which applies `stem#Section`). A block of its own, so it draws.
    {
      label: "embed",
      detail: t.sl_embed ?? "Embed a note",
      icon: "![[",
      aliases: ["transclude", "include", "section", "임베드", "埋め込み"],
      section: "records",
      template: "![[${}",
      apart: true,
      reopen: true,
    },
    {
      label: "recall",
      detail: t.sl_recall ?? "Recall a record",
      icon: "❞",
      aliases: [
        "past",
        "search",
        "find",
        "remember",
        "검색",
        "찾기",
        "불러오기",
      ],
      section: "records",
      template: "",
      picker: "recall",
    },
    // The answer is a `> [!question]` callout of verbatim vault text
    // (lib/editorRecall answerBlock), never generated prose.
    {
      label: "ask",
      detail: t.sl_ask,
      icon: "?",
      aliases: ["question", "answer", "질문", "물어보기", "답"],
      section: "records",
      template: "",
      picker: "ask",
    },
    {
      label: "onthisday",
      detail: t.sl_onthisday ?? "On this day",
      icon: "↺",
      aliases: ["anniversary", "year-ago", "otd"],
      section: "records",
      template: "",
      picker: "onthisday",
    },
    // The same days as a query block (lib/blocks/query) that stays in the note.
    {
      label: "onthisday-query",
      detail: t.sl_onthisday_query,
      icon: "↺",
      aliases: ["otd-query", "과거의 오늘"],
      section: "records",
      template: onThisDayQuery(now) + "\n${}",
    },
    {
      label: "date",
      detail: t.sl_date ?? "Today's date",
      icon: "@",
      // `/오늘` still means the date, not on-this-day ("오늘의 과거").
      aliases: ["today", "now", "오늘", "今日"],
      section: "advanced",
      template: today(now),
      inline: true,
    },
    // A block inserts its source with the caret on the line below, so it
    // draws at once.
    ...BLOCKS.flatMap(({ slash, template }) => {
      if (!slash) return [];
      const { sample } = slash;
      return [
        {
          label: slash.label,
          detail: t[slash.name],
          icon: slash.icon,
          aliases: slash.aliases,
          section: slash.section,
          template: (sample?.(t, "") ?? template) + "\n${}",
          templateFor: sample && ((doc: string) => sample(t, doc) + "\n${}"),
          apart: sample !== undefined,
          open: slash.open,
        },
      ];
    }),
  ];
  return items.map((i) => (HINTS[i.label] ? { ...i, hint: t[HINTS[i.label]] } : i));
}

// 2-beolsik (the standard Korean layout): the QWERTY key(s) under each jamo.
// Syllable parts in Unicode order; compound vowels and finals are two keys.
const INITIALS = "r R s e E f a q Q t T d w W c z x v g".split(" ");
const MEDIALS = "k o i O j p u P h hk ho hl y n nj np nl b m ml l".split(" ");
const FINALS = [
  "",
  ..."r R rt s sw sg e f fr fa fq ft fx fv fg a q qt t T d w c z x v g".split(
    " ",
  ),
];
// Compatibility jamo U+3131..U+3163: 30 consonants, then the 21 vowels.
const JAMO = [
  ..."r R rt s sw sg e E f fr fa fq ft fx fv fg a q Q qt t T d w W c z x v g".split(
    " ",
  ),
  ...MEDIALS,
];

/** Hangul as the QWERTY keys that typed it on a 2-beolsik layout (`ㅗ1` →
 *  `h1`, `새애` → `todo`): `/h1` typed with the Korean input source on still
 *  finds H1. Other characters pass through; the result is lower-cased. */
export function qwertyOf(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    const syl = c - 0xac00;
    if (syl >= 0 && syl < 11172)
      out +=
        INITIALS[Math.floor(syl / 588)] +
        MEDIALS[Math.floor((syl % 588) / 28)] +
        FINALS[syl % 28];
    else if (c >= 0x3131 && c <= 0x3163) out += JAMO[c - 0x3131];
    else out += ch;
  }
  return out.toLowerCase();
}

/** 3 = a keyword starts with `query` (typed on either layout), 2 = an alias
 *  does, 1 = a name contains it, 0 = no match. An empty query matches all. */
export function queryRank(
  query: string,
  keyword: string,
  aliases: readonly string[],
  names: readonly string[],
): number {
  const q = normalizeQuery(query);
  if (!q) return 1;
  const k = qwertyOf(q);
  const starts = (w: string): boolean => w.startsWith(q) || w.startsWith(k);
  if (starts(keyword)) return 3;
  if (aliases.some(starts)) return 2;
  return names.some((n) => normalizeQuery(n).includes(q)) ? 1 : 0;
}

// A line's existing block marks: indent, quote marks (with a callout's
// `[!type]`), then a heading, list or to-do marker.
const LINE_PREFIX_RE =
  /^(\s*)(?:(?:>\s?)+(?:\[![\w-]+\][+-]?\s*)?)?(?:#{1,6}\s+|(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)?/;

/**
 * Turn `text` (one line holding `/query` at [slashCol, caretCol)) into a
 * `prefix` block: the query goes, the line's old block marks go, its indent
 * and text stay. `caret` = column where the query was. With no query
 * (slashCol = caretCol, Turn into) the line's own spaces stay — trailing
 * ones may be a hard break.
 */
export function slashBlockEdit(
  text: string,
  slashCol: number,
  caretCol: number,
  prefix: string,
): { text: string; caret: number } {
  const before = text.slice(0, slashCol);
  const m = LINE_PREFIX_RE.exec(before);
  const indent = m?.[1] ?? "";
  let left = before.slice(m?.[0].length ?? 0);
  let right = text.slice(caretCol);
  if (slashCol < caretCol) {
    if (!right.trim()) {
      left = left.trimEnd();
      right = "";
    } else if (/\s$/.test(left)) right = right.trimStart();
  }
  const head = indent + prefix + left;
  return { text: head + right, caret: head.length };
}

/** Label or alias prefix (on either keyboard layout) OR localized detail
 *  substring, so `/h2`, `/ㅗ2`, `/checkbox`, `/표`, `/할 일` all work. Label
 *  hits rank first, then aliases, then names: Enter takes the first, and `/d`
 *  meant divider, not "Heading 1" (whose detail holds a `d`). */
export function filterSlash(items: SlashItem[], query: string): SlashItem[] {
  return items
    .map((i) => ({ i, r: queryRank(query, i.label, i.aliases, [i.detail]) }))
    .filter((x) => x.r > 0)
    .sort((a, b) => b.r - a.r)
    .map((x) => x.i);
}
