// A past record's text as a quote (roadmap stage 1, decision Q8): the
// chunk's own lines, verbatim, and the `note#Section` they came from. No
// CodeMirror here: the Ask page quotes with these and must not load the
// editor's chunk (lib/editorRecall.ts re-exports them for the editor).

import { quoteBody } from "./extractive";
import type { ScoredChunk } from "./ipc";
import { stripFrontmatter } from "./markdown";
import { extractHeadings } from "./outline";

/** A heading's visible text as a `[[note#…]]` anchor: `[`, `]`, `|`, `#`
 *  and `^` would end or split the link. */
function anchorOf(heading: string): string {
  return heading.replace(/[[\]|#^]/g, " ").replace(/\s+/g, " ").trim();
}

/** The heading a chunk opens with — the index splits pages at headings — as
 *  an anchor. Null when the chunk starts mid-section (a long section's
 *  later part). */
export function chunkSection(text: string): string | null {
  const first = stripFrontmatter(text).trimStart().split("\n", 1)[0];
  return anchorOf(extractHeadings(first)[0]?.text ?? "") || null;
}

/** A note's headings as anchors, each once, in order (`[[note#` completes
 *  them). */
export function noteHeadings(raw: string): string[] {
  const all = extractHeadings(stripFrontmatter(raw)).map((h) => anchorOf(h.text));
  return [...new Set(all)].filter(Boolean);
}

/** `stem#Section`, or the stem when the chunk has no heading of its own. */
export function recallTarget(hit: Pick<ScoredChunk, "stem" | "text">): string {
  const section = chunkSection(hit.text);
  return section ? `${hit.stem}#${section}` : hit.stem;
}

const LEAD_HEADING_RE = /^#{1,6}[ \t][^\n]*\n?/;
const FOOTNOTE_DEF_RE = /^[ \t]*\[\^[^\]\n]+\]:[^\n]*$/gm;
const FOOTNOTE_REF_RE = /\[\^[^\]\n]+\]/g;

/** A chunk's quotable lines: no frontmatter, no leading heading (it goes
 *  into the link) and no footnotes — a `[^src-*]` copied into another note
 *  would dangle there; the link reaches the note that defines it. "" when
 *  nothing is left (a frontmatter-only chunk).
 *  ponytail: a footnote definition's indented continuation lines stay. */
export function chunkBody(text: string): string {
  return withoutFootnotes(
    stripFrontmatter(text).trimStart().replace(LEAD_HEADING_RE, ""),
  );
}

/** The chunk's lines a quote carries: quoteBody's pick of chunkBody. */
export function recallExcerpt(
  hit: Pick<ScoredChunk, "text">,
  question = "",
): string {
  const body = chunkBody(hit.text);
  // permit base: quoteBody has no question focus yet (W-only adaptation).
  void question;
  return body ? quoteBody([body]).trim() : "";
}

function withoutFootnotes(text: string): string {
  return text
    .replace(FOOTNOTE_DEF_RE, "")
    .replace(FOOTNOTE_REF_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Ask's Insert quote: the passage an answer shows (`quote`, quoteBody over
 *  the page's chunks — it may span two), as those very lines, minus the `…`
 *  elision marks, headings and footnotes, linked to the section its first
 *  line came from. Null when nothing quotable is left. */
export function passageBlock(
  quote: string,
  hits: readonly Pick<ScoredChunk, "stem" | "text">[],
): string | null {
  const lines = stripFrontmatter(quote)
    .split("\n")
    .filter((l) => l.trim() !== "…");
  const first = lines.find((l) => /\S/.test(l))?.replace(/…$/, "");
  const hit = (first && hits.find((h) => h.text.includes(first))) || hits[0];
  const body = withoutFootnotes(
    lines.filter((l) => !/^#{1,6}[ \t]/.test(l)).join("\n"),
  );
  return hit && body ? quoteBlock(body, recallTarget(hit)) : null;
}

/** `> excerpt` (every line) and `— [[target]]` under it (decision Q2). */
export function quoteBlock(excerpt: string, target: string): string {
  const quoted = excerpt
    .split("\n")
    .map((l) => (/\S/.test(l) ? `> ${l}` : ">"))
    .join("\n");
  return `${quoted}\n— [[${target}]]`;
}
