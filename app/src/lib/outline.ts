// Reader outline: a note body's headings from the same markdown-it parse the
// preview uses, so `#` lines inside fences and setext headings agree with what
// is rendered.

import { frontmatterLength, markdownRenderer } from "./markdown";

export interface OutlineHeading {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
  /** 0-based line in the BODY (frontmatter stripped); + bodyLineOffset = editor line. */
  line: number;
}

// Inline children whose `content` is the heading's visible text; markup tokens
// (strong_open, link_close, …) carry none.
const TEXT_TOKENS = new Set(["text", "code_inline", "wikilink"]);

export function extractHeadings(body: string): OutlineHeading[] {
  const tokens = markdownRenderer.parse(body, {});
  const out: OutlineHeading[] = [];
  tokens.forEach((token, i) => {
    if (token.type !== "heading_open" || !token.map) return;
    const text = (tokens[i + 1]?.children ?? [])
      .filter((c) => TEXT_TOKENS.has(c.type))
      .map((c) => c.content)
      .join("")
      .trim();
    out.push({
      level: Number(token.tag[1]) as OutlineHeading["level"],
      text,
      line: token.map[0],
    });
  });
  return out;
}

/** Lines removed by stripFrontmatter: "\n" count inside the leading block. */
export function bodyLineOffset(raw: string): number {
  return (raw.slice(0, frontmatterLength(raw)).match(/\n/g) ?? []).length;
}
