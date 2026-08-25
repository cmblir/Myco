// Category and project tokens on a task line. A category is an ordinary
// Obsidian `#tag`, a project an ordinary `[[wikilink]]` — both live in the
// task's text and survive every writer untouched (taskLine.ts treats them as
// title). These helpers only lift them out for display as chips and put them
// back when the composer builds a line; nothing here is storage.

/** `#tag` — letters/digits/underscore/hyphen, Korean included; stops before
 *  punctuation so `#dev.` reads as `#dev`. A lone `#` is not a tag. */
const TAG_RE = /#([\p{L}\p{N}_-]+)/gu;
const LINK_RE = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;

/** Tags on the line, without `#`, in order, deduped. */
export function extractTags(text: string): string[] {
  return [...new Set([...text.matchAll(TAG_RE)].map((m) => m[1]))];
}

/** Wikilink targets on the line, display alias dropped, in order, deduped. */
export function extractLinks(text: string): string[] {
  return [...new Set([...text.matchAll(LINK_RE)].map((m) => m[1].trim()))];
}

/** The text with tags and links removed, for a title that shows them as
 *  chips instead. Whitespace collapsed the same way parseTaskMeta does. */
export function stripTokens(text: string): string {
  return text
    .replace(LINK_RE, "")
    .replace(TAG_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Compose the written title: text, then `#tags`, then `[[links]]` — deduped
 *  against tokens already present in `text`, so a tag typed inline and picked
 *  as a chip is written once. */
export function composeTitle(
  text: string,
  tags: string[],
  links: string[],
): string {
  const haveTags = new Set(extractTags(text));
  const haveLinks = new Set(extractLinks(text));
  const parts = [
    text.trim(),
    ...tags.filter((t) => t && !haveTags.has(t)).map((t) => `#${t}`),
    ...links.filter((l) => l && !haveLinks.has(l)).map((l) => `[[${l}]]`),
  ];
  return parts.filter(Boolean).join(" ");
}
