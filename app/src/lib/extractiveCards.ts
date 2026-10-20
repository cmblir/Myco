// Study cards built only from a note's own words (spec 2026-09-29, Part 1).
// The small model wrote cards about "this tool" instead of the note, so the
// default path asks no model at all: every front and back is the note's text,
// verbatim after markup is dropped, except the i18n frames around a title or
// heading. Pure — the caller does the IO.
//
// Cards are stored as plain text (wikilinks shown by their display text,
// citations and emphasis marks dropped): one card is one line of a deck file,
// and a dangling `[^src-x]` or `[[a|b]]` there would read as noise.

import type Token from "markdown-it/lib/token.mjs";
import type { Card } from "./cards";
import { quoteBody } from "./extractive";
import type { Strings } from "./i18n";
import { markdownRenderer, stripFrontmatter } from "./markdown";
import type { QuizQuestion } from "./study";

/** Stands in for the removed term on a cloze front. */
export const BLANK = "＿＿＿";
/** Between the term and the full sentence on a cloze back. */
export const CLOZE_SEP = " — ";

export type CardFrames = Pick<Strings, "st_def_front" | "st_section_front">;

const MAX_BACK = 280;
const MAX_CLOZE = 6;
const MIN_SENTENCE = 30;
const MAX_SENTENCE = 240;
const MIN_LEAD = 20;
const MAX_TERM = 60;

/** The comparison form the quote checks use: markup, citations, emphasis and
 *  case dropped, whitespace collapsed, NFC. Applied to both sides, so a card's
 *  plain text and the note's raw markdown meet in the middle. */
export function normalise(s: string): string {
  return s
    .normalize("NFC")
    .replace(/\[\^[^\]\s]+\]/g, "")
    .replace(/!?\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
    .replace(/!?\[\[([^\]]*)\]\]/g, "$1")
    .replace(/\[([^[\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~\\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// ponytail: the last few notes' normalised text, dropped whole when full. A
// deck summary checks every card against one note (or the few that cite one
// source), so this makes it one normalisation per note instead of per card.
const haystacks = new Map<string, string[]>();
/** The note as it reads (the text cards are built from: entities decoded,
 *  images, comments and autolink brackets gone) and as it is written (code
 *  blocks and all, for a model's quote), both normalised. */
function haystack(md: string): string[] {
  let h = haystacks.get(md);
  if (h === undefined) {
    if (haystacks.size >= 8) haystacks.clear();
    const shown = parse(md).inlines.map((i) => i.text).join(" ");
    h = [normalise(shown), normalise(md)];
    haystacks.set(md, h);
  }
  return h;
}

/** Whether `text` occurs in the note `md` (see normalise). Empty never does. */
export function isQuoted(text: string, md: string): boolean {
  const want = normalise(text);
  return want.length > 0 && haystack(md).some((h) => h.includes(want));
}

export interface Span {
  start: number;
  end: number;
}

interface Inline {
  text: string;
  terms: Span[];
}

/** An inline token's visible text, and where its bold / wikilinked terms sit. */
function inlineText(children: readonly Token[] | null): Inline {
  let text = "";
  const terms: Span[] = [];
  let bold = -1;
  for (const c of children ?? []) {
    if (c.type === "text" || c.type === "code_inline") text += c.content;
    else if (c.type === "softbreak" || c.type === "hardbreak") text += " ";
    else if (c.type === "wikilink") {
      terms.push({ start: text.length, end: text.length + c.content.length });
      text += c.content;
    } else if (c.type === "strong_open") bold = text.length;
    else if (c.type === "strong_close" && bold >= 0) {
      terms.push({ start: bold, end: text.length });
      bold = -1;
    }
    // footnote_ref, images, html, link/em marks: no words of their own.
  }
  return {
    text,
    terms: terms.sort((a, b) => a.start - b.start || b.end - a.end),
  };
}

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Sentence spans of `text`: a run of . ! ? 。 ending before whitespace or the
 *  end ("4.8" and "e.g" mid-word do not end one). */
function sentences(text: string): Span[] {
  const out: Span[] = [];
  let start = 0;
  for (const m of text.matchAll(/[.!?。！？]+["')\]」』]*(?=\s|$)/g)) {
    const end = (m.index ?? 0) + m[0].length;
    out.push({ start, end });
    start = end;
  }
  if (start < text.length) out.push({ start, end: text.length });
  return out
    .map(({ start: s, end: e }) => {
      while (s < e && /\s/.test(text[s])) s++;
      return { start: s, end: e };
    })
    .filter((s) => s.end > s.start);
}

/** At most MAX_BACK characters of `text`, cut after a whole sentence, marked
 *  with "…" when cut; a first sentence past the limit gets quoteBody's cut. */
function clip(text: string): string {
  const t = collapse(text);
  if (t.length <= MAX_BACK) return t;
  let end = 0;
  for (const s of sentences(t)) {
    if (s.end > MAX_BACK) break;
    end = s.end;
  }
  return end > 0 ? `${t.slice(0, end)}…` : quoteBody([t], MAX_BACK);
}

interface Para extends Inline {
  /** The H2 it sits under; "" for the lead. */
  section: string;
}

interface Parsed {
  title: string | null;
  paras: Para[];
  /** Every inline run outside the footnote block (lists and tables too). */
  inlines: Inline[];
}

function parse(md: string): Parsed {
  const tokens = markdownRenderer.parse(stripFrontmatter(md), {});
  let title: string | null = null;
  let section = "";
  let footnotes = 0;
  const paras: Para[] = [];
  const inlines: Inline[] = [];
  tokens.forEach((tk, i) => {
    if (tk.type === "footnote_block_open") footnotes++;
    else if (tk.type === "footnote_block_close") footnotes--;
    if (footnotes > 0) return;
    if (tk.type === "inline") inlines.push(inlineText(tk.children));
    else if (tk.type === "heading_open") {
      const text = collapse(inlineText(tokens[i + 1]?.children ?? null).text);
      if (tk.tag === "h1" && title === null) title = text;
      else if (tk.tag === "h2") section = text;
    } else if (tk.type === "paragraph_open" && tk.level === 0) {
      // Top level only: a list item's or a quote's paragraph sits deeper.
      const inl = inlineText(tokens[i + 1]?.children ?? null);
      if (collapse(inl.text)) paras.push({ ...inl, section });
    }
  });
  return { title, paras, inlines };
}

/** `[[stem]]` or `[[stem#Heading]]`. In a heading, `|`, `#` and brackets
 *  would end the link early, so they become spaces — the heading still
 *  matches, since anchors compare by slug. The stem is the note's file name
 *  and must stay as it is; parseSourceRef splits at the last `|`, then the
 *  last `#`, so a stem holding either gets an explicit (empty) heading or
 *  alias after it: `[[C# basics#]]`, `[[Q|A|]]`. */
export function noteRef(stem: string, heading = ""): string {
  const anchor = heading.replace(/[|#[\]]/g, " ").trim();
  const head = anchor || stem.includes("#") ? `#${anchor}` : "";
  return `[[${stem}${head}${stem.includes("|") ? "|" : ""}]]`;
}

const card = (front: string, back: string, sourceRef: string): Card => ({
  front,
  back,
  sourceRef,
  state: null,
});

/** Definition, heading and cloze cards for one note (spec Part 1). */
export function cardsFromNote(
  md: string,
  stem: string,
  frames: CardFrames,
): Card[] {
  const { title: h1, paras } = parse(md);
  const title = h1 || stem;
  const out: Card[] = [];

  const lead = paras.find((p) => p.section === "");
  if (lead && collapse(lead.text).length >= MIN_LEAD) {
    out.push(
      card(
        frames.st_def_front.replace("{title}", title),
        clip(lead.text),
        noteRef(stem),
      ),
    );
  }

  const seenSection = new Set<string>();
  for (const p of paras) {
    if (!p.section || seenSection.has(p.section)) continue;
    seenSection.add(p.section);
    const front = frames.st_section_front
      .replace("{title}", title)
      .replace("{heading}", p.section);
    out.push(card(front, clip(p.text), noteRef(stem, p.section)));
  }

  const usedTerms = new Set<string>();
  let clozes = 0;
  for (const p of paras) {
    for (const s of sentences(p.text)) {
      if (clozes >= MAX_CLOZE) break;
      const sentence = collapse(p.text.slice(s.start, s.end));
      if (sentence.length < MIN_SENTENCE || sentence.length > MAX_SENTENCE)
        continue;
      if (sentence.includes(" ?? ")) continue;
      const t = p.terms.find((x) => {
        if (x.start < s.start || x.end > s.end) return false;
        const term = collapse(p.text.slice(x.start, x.end));
        return (
          term.length >= 2 &&
          term.length <= MAX_TERM &&
          term.length < sentence.length * 0.8 &&
          !term.includes(CLOZE_SEP) &&
          !usedTerms.has(normalise(term))
        );
      });
      if (!t) continue;
      const term = collapse(p.text.slice(t.start, t.end));
      usedTerms.add(normalise(term));
      const front = collapse(
        p.text.slice(s.start, t.start) + BLANK + p.text.slice(t.end, s.end),
      );
      out.push(
        card(front, `${term}${CLOZE_SEP}${sentence}`, noteRef(stem, p.section)),
      );
      clozes++;
    }
  }

  const seen = new Set<string>();
  return out.filter((c) => {
    const key = normalise(c.front);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** S41: the cloze cards one quoted line yields (dailyNote.quoteLine's form:
 *  the selected words, then the `[^src-*]` citing the raw original). Only
 *  clozes — a line has no title to define and no heading — and each is cited
 *  to the original, so it is grounded by whatever note quotes the line. */
export function clozeCardsFromQuote(line: string): Card[] {
  const split = splitCite(line);
  if (!split) return [];
  const { words, cite } = split;
  const noFrames = { st_def_front: "", st_section_front: "" };
  return cardsFromNote(words, "", noFrames)
    .filter((c) => clozeParts(c) !== null)
    .map((c) => ({ ...c, sourceRef: cite }));
}

/** A quote line's words and its trailing `[^src-*]`. The citation has no
 *  definition here, so the parser would read it as text and join it to a
 *  sentence with no final stop; it belongs in sourceRef only. */
function splitCite(line: string): { words: string; cite: string } | null {
  const match = /\[\^src-[^\]\s]+\]\s*$/.exec(line);
  if (!match) return null;
  return { words: line.slice(0, match.index).trimEnd(), cite: match[0].trim() };
}

/** One sentence of a quote line and the words in it the owner may blank. */
export interface ClozePick {
  sentence: string;
  words: Span[];
  sourceRef: string;
}

/** Default 9 (spec 2026-10-04): when a quoted line has no bold or wikilinked
 *  term, each of its sentences with the words that could be the blank —
 *  punctuation outside, a word kept whole (a Korean particle stays on it). */
export function clozePicks(line: string): ClozePick[] {
  const split = splitCite(line);
  if (!split) return [];
  return parse(split.words).inlines.flatMap(({ text }) =>
    sentences(text).flatMap((s) => {
      const sentence = collapse(text.slice(s.start, s.end));
      if (sentence.length > MAX_SENTENCE || sentence.includes(" ?? ")) return [];
      const words = [
        ...sentence.matchAll(/[\p{L}\p{N}](?:[\p{L}\p{N}\p{M}'’._-]*[\p{L}\p{N}\p{M}])?/gu),
      ]
        .map((m) => ({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }))
        .filter((w) => w.end - w.start >= 2 && w.end - w.start < sentence.length * 0.8);
      return words.length > 0 ? [{ sentence, words, sourceRef: split.cite }] : [];
    }),
  );
}

/** The cloze card for the word the owner picked in `pick`. */
export function pickedCloze(pick: ClozePick, word: Span): Card {
  const { sentence } = pick;
  const term = sentence.slice(word.start, word.end);
  const front = sentence.slice(0, word.start) + BLANK + sentence.slice(word.end);
  return card(front, `${term}${CLOZE_SEP}${sentence}`, pick.sourceRef);
}

/** Every bold and wikilinked term in the note, first spelling kept — the
 *  quiz's distractor pool (a wikilink names a neighbouring note). */
export function termsOf(md: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const { text, terms } of parse(md).inlines) {
    for (const t of terms) {
      const term = collapse(text.slice(t.start, t.end));
      const key = normalise(term);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(term);
    }
  }
  return out;
}

/** A cloze card's removed term and full sentence; null for any other card. */
export function clozeParts(c: Card): { term: string; sentence: string } | null {
  if (!c.front.includes(BLANK)) return null;
  const at = c.back.indexOf(CLOZE_SEP);
  if (at <= 0) return null;
  const term = c.back.slice(0, at);
  const sentence = c.back.slice(at + CLOZE_SEP.length);
  return c.front.replace(BLANK, term) === sentence ? { term, sentence } : null;
}

function shuffle<T>(xs: T[], rand: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Multiple-choice questions from a deck's cloze cards (spec Part 1): the
 *  removed term is the answer, other terms from the deck and `pool` are the
 *  distractors, the full sentence is the explanation. A card with fewer than
 *  two distractors is skipped. No model call. */
export function quizFromCards(
  cards: Card[],
  pool: string[],
  rand: () => number = Math.random,
  count = 5,
): QuizQuestion[] {
  const cloze = cards.flatMap((c) => {
    const parts = clozeParts(c);
    return parts ? [{ c, ...parts }] : [];
  });
  const terms = [...cloze.map((x) => x.term), ...pool];
  const out: QuizQuestion[] = [];
  for (const { c, term, sentence } of shuffle(cloze, rand)) {
    if (out.length >= count) break;
    const seen = new Set([normalise(term)]);
    const wrong: string[] = [];
    for (const d of shuffle(terms, rand)) {
      const key = normalise(d);
      // A term the sentence already shows can't be its blank; a repeat is no choice.
      if (!key || seen.has(key) || normalise(c.front).includes(key)) continue;
      seen.add(key);
      wrong.push(d);
      if (wrong.length === 3) break;
    }
    if (wrong.length < 2) continue;
    const choices = shuffle([term, ...wrong], rand);
    out.push({
      question: c.front,
      choices,
      answer: choices.indexOf(term),
      sourceRef: c.sourceRef,
      explanation: sentence,
    });
  }
  return out;
}

/** `[[stem]]` / `[[stem#Heading]]` / `[[stem|shown]]` → its parts; null for
 *  anything else (a `[^src-*]` citation names a raw source, not a note).
 *  Splits at the last `|` and `#`, as noteRef writes them, so a note named
 *  "C# basics" or "[논문] 트랜스포머" is found again. */
export function parseSourceRef(
  sourceRef: string,
): { stem: string; heading: string } | null {
  const inner = /^\[\[(.+)\]\]$/.exec(sourceRef.trim())?.[1];
  if (!inner || inner.includes("[[") || inner.includes("]]")) return null;
  const bar = inner.lastIndexOf("|");
  const target = bar < 0 ? inner : inner.slice(0, bar);
  const hash = target.lastIndexOf("#");
  const stem = (hash < 0 ? target : target.slice(0, hash)).trim();
  const heading = hash < 0 ? "" : target.slice(hash + 1).trim();
  return stem ? { stem, heading } : null;
}

/** A `[^src-*]` citation: it names a raw source, which vault notes cite. */
export function isCitation(sourceRef: string): boolean {
  return /^\[\^src-[^\]\s]+\]$/.test(sourceRef.trim());
}

/** Spec Part 2: a card is grounded when every part of its back (a cloze back
 *  is term + sentence) occurs in `note`, and its source names that note or a
 *  raw source that note cites. `note` is null when there is none or it is
 *  gone; which note to pass for a source is the caller's lookup. */
export function isGrounded(c: Card, note: string | null): boolean {
  const src = c.sourceRef.trim();
  if (!note) return false;
  if (!parseSourceRef(src) && !(isCitation(src) && note.includes(src))) return false;
  return c.back
    .replace(/…$/, "")
    .split(CLOZE_SEP)
    .every((part) => isQuoted(part, note));
}
