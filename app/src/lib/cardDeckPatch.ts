import { parseDeck, serializeDeck, type Card } from "./cards";
import { normalise } from "./extractiveCards";

interface DeckLine { start: number; end: number; text: string; eol: string }
interface CardBlock { line: DeckLine; trailer?: DeckLine; card: Card }

function linesOf(raw: string): DeckLine[] {
  const lines: DeckLine[] = [];
  for (let start = 0; start < raw.length;) {
    const newline = raw.indexOf("\n", start);
    const end = newline < 0 ? raw.length : newline + 1;
    const segment = raw.slice(start, end);
    const eol = segment.endsWith("\r\n") ? "\r\n" : segment.endsWith("\n") ? "\n" : "";
    lines.push({ start, end, text: segment.slice(0, segment.length - eol.length), eol });
    start = end;
  }
  return lines;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Reject fields that could create another line or escape a metadata comment. */
function validateCard(card: Card): void {
  if (!card || [card.front, card.back, card.sourceRef].some((field) =>
    typeof field !== "string" || /[\r\n\0]|<!--|-->/.test(field)) ||
    !card.front.trim() || !card.back.trim() || card.front.includes(" ?? ")) {
    throw new Error("Invalid Study card fields");
  }
  const state = card.state;
  if (state !== null && (!state || !validDate(state.due) || !validDate(state.lastReview) ||
    !Number.isFinite(state.stability) || state.stability <= 0 ||
    !Number.isFinite(state.difficulty) || state.difficulty < 1 || state.difficulty > 10 ||
    !Number.isInteger(state.reps) || state.reps < 0 || !Number.isInteger(state.lapses) || state.lapses < 0)) {
    throw new Error("Invalid Study card state");
  }
}

function cardBlocks(raw: string): CardBlock[] {
  const lines = linesOf(raw);
  const blocks: CardBlock[] = [];
  let frontmatter = lines[0]?.text.replace(/^\uFEFF/, "") === "---";
  let fence: { marker: string; length: number } | undefined;
  let comment = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (frontmatter) {
      if (index > 0 && /^(---|\.\.\.)\s*$/.test(line.text)) frontmatter = false;
      continue;
    }
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.text);
    if (fence) {
      if (marker && marker[1][0] === fence.marker && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      continue;
    }
    if (marker) { fence = { marker: marker[1][0], length: marker[1].length }; continue; }
    if (comment || line.text.includes("<!--")) {
      comment = line.text.includes("-->")
        ? line.text.lastIndexOf("<!--") > line.text.lastIndexOf("-->") : true;
      continue;
    }
    if (!line.text.includes(" ?? ")) continue;
    const next = lines[index + 1];
    const trailer = next && /^<!--(?:SR:!.+|src:.+)-->\s*$/.test(next.text.trim()) ? next : undefined;
    const parsed = parseDeck(line.text + (trailer ? `\n${trailer.text}` : ""));
    if (parsed.length !== 1) continue;
    if (trailer?.text.trim().startsWith("<!--SR:!") && parsed[0].state === null) throw new Error("Invalid Study card state");
    validateCard(parsed[0]);
    blocks.push({ line, trailer, card: parsed[0] });
    if (trailer) index++;
  }
  if (frontmatter || fence || comment) throw new Error("Study deck layout is incomplete");
  return blocks;
}

function lineEnding(raw: string): string {
  return linesOf(raw).find((line) => line.eol)?.eol ?? "\n";
}

/** Read cards from editable Markdown blocks, excluding examples and metadata. */
export function readDeckCards(raw: string): Card[] {
  return cardBlocks(raw).map((block) => block.card);
}

/** Append new cards without reserializing any existing document bytes. */
export function appendDeckCards(raw: string, incoming: Card[]): { content: string; added: number } {
  const seen = new Set(readDeckCards(raw).map((card) => normalise(card.front)));
  const additions: Card[] = [];
  for (const card of incoming) {
    validateCard(card);
    const key = normalise(card.front);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    additions.push(card);
  }
  if (!additions.length) return { content: raw, added: 0 };
  const eol = lineEnding(raw);
  const separator = !raw || raw.endsWith(eol + eol) ? "" : raw.endsWith(eol) ? eol : eol + eol;
  return { content: raw + separator + serializeDeck(additions).replace(/\n/g, eol), added: additions.length };
}

function sameCard(left: Card, right: Card): boolean {
  return left.front === right.front && left.back === right.back && left.sourceRef === right.sourceRef &&
    (left.state === null ? right.state === null : right.state !== null &&
      left.state.due === right.state.due && left.state.lastReview === right.state.lastReview &&
      left.state.stability === right.state.stability && left.state.difficulty === right.state.difficulty &&
      left.state.reps === right.state.reps && left.state.lapses === right.state.lapses);
}

/** Patch only a recognized card's metadata; a removed card is never recreated. */
export function patchDeckGrade(raw: string, graded: Card, expected?: Card): { content: string; updated: boolean } {
  validateCard(graded);
  if (!graded.state) throw new Error("Study grade has no state");
  if (expected) validateCard(expected);
  const matches = cardBlocks(raw).filter((block) => block.card.front === graded.front);
  if (!matches.length) return { content: raw, updated: false };
  if (matches.length !== 1) throw new Error("Study card identity is ambiguous");
  const block = matches[0];
  if (block.card.back !== graded.back || block.card.sourceRef !== graded.sourceRef ||
    (expected && !sameCard(block.card, expected))) throw new Error("Study card changed before grading");
  const trailer = serializeDeck([graded]).split("\n")[1];
  if (block.trailer) {
    return {
      content: raw.slice(0, block.trailer.start) + trailer + block.trailer.eol + raw.slice(block.trailer.end),
      updated: true,
    };
  }
  const eol = block.line.eol || lineEnding(raw);
  return {
    content: raw.slice(0, block.line.end) + (block.line.eol ? "" : eol) + trailer + eol + raw.slice(block.line.end),
    updated: true,
  };
}
