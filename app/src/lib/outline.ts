// Reader outline: a note body's headings from the same markdown-it parse the
// preview uses, so `#` lines inside fences agree with what is rendered (and,
// like the editor, a setext underline is not a heading).

import {
  frontmatterLength,
  headingsOf,
  markdownRenderer,
  type OutlineHeading,
} from "./markdown";
import { matchHeading } from "./pendingAnchor";

export type { OutlineHeading };

export function extractHeadings(body: string): OutlineHeading[] {
  return headingsOf(markdownRenderer.parse(body, {}));
}

/** Lines removed by stripFrontmatter: line breaks inside the leading block,
 *  a lone CR counted as markdown-it and the editor count it. */
export function bodyLineOffset(raw: string): number {
  return (raw.slice(0, frontmatterLength(raw)).match(/\r\n?|\n/g) ?? []).length;
}

/**
 * The section `![[note#anchor]]` embeds: the lines under the first heading
 * matching `anchor` (as `[[note#…]]` links match: case and slug), up to the
 * next heading of its level or above, blank edges trimmed. Null when no
 * heading matches; `^block-id` anchors are not supported.
 */
export function sectionBody(body: string, anchor: string): string | null {
  if (anchor.startsWith("^")) return null;
  const headings = extractHeadings(body);
  const h = matchHeading(headings, anchor);
  if (!h) return null;
  const next = headings.find((n) => n.line > h.line && n.level <= h.level);
  return body
    .split("\n")
    .slice(h.line + 1, next?.line)
    .join("\n")
    .replace(/^(?:[ \t]*\r?\n)+/, "")
    .trimEnd();
}
