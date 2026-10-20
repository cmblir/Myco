// The Ask → note loop (UX slice D1): what a quoted passage looks like on the
// Ask page and what leaves the page with it. Pure text over the retrieved
// chunks — no CodeMirror (the Ask chunk must not load the editor, see
// recallText.test.ts), no React.

import type { ScoredChunk } from "./ipc";
import { chunkSection, passageBlock } from "./recallText";

const FOOTNOTE_DEF_RE = /^[ \t]*\[\^[^\]\n]+\]:[^\n]*\n?/gm;
const FOOTNOTE_REF_RE = /\[\^[^\]\n]+\]/g;
const HEADING_RE = /^#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/gm;

/** A passage as plain paragraphs: a heading becomes a bold line (a note's
 *  `# H1` was a 44px heading inside the answer), footnote definitions and
 *  `[^n]` marks go (they point into the note, not the answer), wikilinks
 *  stay links. */
export function plainPassage(quote: string): string {
  return quote
    .replace(FOOTNOTE_DEF_RE, "")
    .replace(FOOTNOTE_REF_RE, "")
    .replace(HEADING_RE, (_m, text: string) => `**${text.replace(/\*\*/g, "").trim()}**`)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The passage for a one-line row (the source ladder): no marks at all. */
export function plainText(quote: string): string {
  return plainPassage(quote)
    .replace(/\*\*/g, "")
    .replace(/\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g, (_m, target: string, alias?: string) =>
      (alias ?? target).trim(),
    );
}

/** The answer for the clipboard: the question, then every quoted passage as
 *  the editor's quote block (passageBlock: the lines as they are in the note,
 *  `— [[stem#Section]]` under them). A passage with nothing quotable left
 *  (a heading-only chunk) is skipped. */
export function answerMarkdown(
  question: string,
  quotes: readonly { page: string; quote: string }[],
  hits: readonly Pick<ScoredChunk, "page" | "stem" | "text">[],
): string {
  const blocks = quotes.flatMap(({ page, quote }) => {
    const block = passageBlock(
      quote,
      hits.filter((h) => h.page === page),
    );
    return block ? [block] : [];
  });
  return [question, ...blocks].join("\n\n");
}

/** The passage's own lines in a quote: the `…` a page cut leaves, and the
 *  `…` quoteBody appends to a cut line, are not the note's text. */
function quoteLines(quote: string): string[] {
  return quote
    .split("\n")
    .map((l) => l.trim().replace(/…$/, "").trim())
    .filter((l) => l !== "");
}

/** The section anchor of the chunk the passage's first line came from (the
 *  index splits pages at headings), null when that chunk starts mid-section
 *  or nothing matches. Same pick as passageBlock's link. */
export function passageSection(
  quote: string,
  hits: readonly Pick<ScoredChunk, "text">[],
): string | null {
  const first = quoteLines(quote)[0];
  const hit = (first && hits.find((h) => h.text.includes(first))) || hits[0];
  return hit ? chunkSection(hit.text) : null;
}

/** Where a quoted passage sits in the note: the 1-based document line range
 *  from its first line to its last, matched by trimmed text (a line the
 *  quote cut matches by prefix). Null when the first line is gone — the note
 *  moved on since the index saw it, so there is nothing honest to light. */
export function matchLines(
  doc: string,
  quote: string,
): { from: number; to: number } | null {
  const wanted = quoteLines(quote);
  if (wanted.length === 0) return null;
  const lines = doc.split("\n").map((l) => l.trim());
  const at = (text: string, start: number): number =>
    lines.findIndex((l, i) => i >= start && (l === text || l.startsWith(text)));
  const from = at(wanted[0], 0);
  if (from < 0) return null;
  const last = wanted[wanted.length - 1];
  const to = wanted.length > 1 ? at(last, from + 1) : from;
  return { from: from + 1, to: (to < 0 ? from : to) + 1 };
}

/** Which rendered blocks a passage spans in Preview, given each block's first
 *  body line in DOM order (the renderer's `data-line`, 0-based): the block the
 *  passage starts inside of — the nearest start above it, the later block on
 *  a tie (an item over its list) — and every block that starts within
 *  `from`..`to`. Indices into `starts`, in document order: the DOM is not
 *  (footnote definitions render last but keep their source line). */
export function blocksInRange(starts: readonly number[], from: number, to: number): number[] {
  let holder = -1;
  starts.forEach((s, i) => {
    if (s <= from && (holder < 0 || s >= starts[holder])) holder = i;
  });
  return starts
    .flatMap((s, i) => (i === holder || (s >= from && s <= to) ? [i] : []))
    .sort((a, b) => starts[a] - starts[b]);
}

/** What the Ask page asks of the reader that opens next: append a block at
 *  the note's end, or show a quoted passage — scrolled to and flashed. */
export type ReaderIntent =
  | { kind: "append"; block: string }
  | { kind: "show"; section: string | null; quote: string };

// One slot, like pendingAnchor: consumed by the reader that opens `path`, or
// by whichever note opens next when no note was named (the user is picking
// one) — for a minute, so a cancelled pick never lands the block in a note
// opened for another reason days later.
const INTENT_TTL_MS = 60_000;
let pending: { path: string | null; intent: ReaderIntent; at: number } | null = null;

export function setReaderIntent(
  path: string | null,
  intent: ReaderIntent,
  now = Date.now(),
): void {
  pending = { path, intent, at: now };
}

/** The user closed the note picker without opening a note: an intent waiting
 *  for the pick (no note named) must not land in the next note opened. */
export function cancelPickIntent(): void {
  if (pending?.path === null) pending = null;
}

/** A ⌘K row ran while a pick may be waiting. The note it opened (its path) is
 *  the pick — its reader takes the block; a row that opened none (a dialog
 *  cancelled, a route that is not a note, a failure) cancels it. Awaited, so a
 *  new note's name dialog and create IPC take as long as they take. */
export async function settlePick(open: () => Promise<string | null>): Promise<void> {
  let path: string | null = null;
  try {
    path = await open();
  } finally {
    if (!path) cancelPickIntent();
  }
}

/** Take (and forget) the intent meant for `path`, if any and not expired. */
export function takeReaderIntent(path: string, now = Date.now()): ReaderIntent | null {
  if (!pending || (pending.path !== null && pending.path !== path)) return null;
  const { intent, at } = pending;
  pending = null;
  return now - at <= INTENT_TTL_MS ? intent : null;
}

// A question that leans on the one before it. Leads: the pronouns and
// connectives a follow-up opens with (Korean particles attach, so those
// match by prefix; English by whole word). A bare question word ("why",
// "how") is NOT a lead — "why does attention scale?" stands on its own —
// only a short question mark ("why?", "왜?", "이유는?") counts.
const EN_LEADS = new Set([
  "it", "its", "that", "this", "these", "those", "they", "them", "their",
  "and", "so", "then", "also", "but", "more",
]);
const EN_LEADS_2 = ["what about", "how about"];
const KO_JA_LEADS = [
  "그건", "그게", "그거", "그것", "그걸", "그런", "그럼", "그러면", "그래서", "그리고",
  "그런데", "근데", "그중", "이건", "이게", "이거", "이것", "이걸", "이런", "저건",
  "저거", "저것", "또",
  "それ", "これ", "あれ", "その", "この", "あの", "じゃあ", "では", "それで", "また",
  "もっと", "つまり",
];
const SHORT_MAX = 8;

/** True when `q` reads as a follow-up to the previous question (UX audit
 *  A2): pronoun- or connective-led, or a short question mark. */
export function isFollowUp(q: string): boolean {
  const text = q.trim();
  if (!text) return false;
  const words = text.toLowerCase().split(/\s+/);
  const head = words[0].replace(/[^\p{L}']/gu, "");
  if (EN_LEADS.has(head)) return true;
  if (EN_LEADS_2.includes(words.slice(0, 2).join(" ").replace(/[?？!.]/g, ""))) return true;
  if (KO_JA_LEADS.some((lead) => words[0].startsWith(lead))) return true;
  return text.length <= SHORT_MAX && /[?？]$/.test(text);
}

/** What a follow-up retrieves with in front of its own words: the latest
 *  question in the thread that stood on its own — "attention → why? → and
 *  then?" keeps "attention", as does widening "why?" — through `clean` (the
 *  caller drops its time phrase: a follow-up inherits the topic, not "last
 *  week"). Null when `q` stands alone or nothing earlier can be leaned on. */
export function followUpContext(
  turns: readonly { q: string; error?: string; followUp?: boolean }[],
  q: string,
  clean: (q: string) => string = (s) => s,
): string | null {
  if (!isFollowUp(q)) return null;
  // Not findLast: ES2023, past Safari on macOS 10.15 (decision Q5).
  const topic = [...turns].reverse().find((t) => !t.followUp && !t.error);
  return topic ? clean(topic.q) || topic.q : null;
}
