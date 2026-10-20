// Flashcard model + on-disk format for Feature 3 (study artifacts).
//
// Cards live as plain markdown in `cards/<deck>.md`, one card per block using the
// Obsidian `spaced-repetition` inline syntax `front ?? back`, with FSRS state in
// an HTML-comment trailer the plugin (and git/shell) ignore:
//
//   What is attention? ?? A weighted sum over value vectors.
//   <!--SR:!2026-01-08|4.1|5.2|2|0|2026-01-01|[^src-3]-->
//
// The trailer is `!<due>|<stability>|<difficulty>|<reps>|<lapses>|<lastReview>|<src>`.
// A card with no trailer is new (never reviewed); a new card with a source keeps
// it in `<!--src:[[stem#Heading]]-->` until its first review writes the trailer.
// Keeping cards as markdown means no lock-in — Obsidian/git see the same files
// and review state round-trips.

import type { CardState, Grade } from "./fsrs";
import { initState, isDue, nextState } from "./fsrs";

export interface Card {
  front: string;
  back: string;
  /** Source citation copied from the page, e.g. "[^src-3]" or "[[stem]]". */
  sourceRef: string;
  /** FSRS scheduling state; null until the card's first review. */
  state: CardState | null;
}

const SEP = " ?? ";
const SR = /^<!--SR:!(.+)-->\s*$/;
const SRC = /^<!--src:(.+)-->\s*$/;

function serializeState(s: CardState, src: string): string {
  return `<!--SR:!${s.due}|${s.stability.toFixed(4)}|${s.difficulty.toFixed(4)}|${s.reps}|${s.lapses}|${s.lastReview}|${src}-->`;
}

/** Parse a `<!--SR:...-->` trailer into (state, sourceRef). */
function parseState(line: string): { state: CardState; src: string } | null {
  const m = SR.exec(line.trim());
  if (!m) return null;
  const p = m[1].split("|");
  if (p.length < 6) return null;
  // The source is last and may hold "|" itself (`[[Q|A|]]`, an alias).
  const [due, stab, diff, reps, lapses, last, ...src] = p;
  return {
    state: {
      due,
      stability: Number(stab),
      difficulty: Number(diff),
      reps: Number(reps),
      lapses: Number(lapses),
      lastReview: last,
    },
    src: src.join("|"),
  };
}

/** Parse a `cards/<deck>.md` file into cards. Lenient: skips malformed blocks. */
export function parseDeck(md: string): Card[] {
  const lines = md.split("\n");
  const cards: Card[] = [];
  for (let i = 0; i < lines.length; i++) {
    const idx = lines[i].indexOf(SEP);
    if (idx < 0) continue;
    const front = lines[i].slice(0, idx).trim();
    const back = lines[i].slice(idx + SEP.length).trim();
    if (!front || !back) continue;
    let state: CardState | null = null;
    let sourceRef = "";
    const next = lines[i + 1];
    if (next) {
      const parsed = parseState(next);
      const src = SRC.exec(next.trim());
      if (parsed) {
        state = parsed.state;
        sourceRef = parsed.src;
        i++; // consume the trailer line
      } else if (src) {
        sourceRef = src[1];
        i++;
      }
    }
    cards.push({ front, back, sourceRef, state });
  }
  return cards;
}

/** A card is one line of the deck file: a line break inside a side (a quote
 *  from a hard-wrapped note) would end the card there and orphan its source. */
const line = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Serialize cards back to `cards/<deck>.md`. */
export function serializeDeck(cards: Card[]): string {
  const blocks = cards.map((c) => {
    const head = `${line(c.front)}${SEP}${line(c.back)}`;
    if (c.state) return `${head}\n${serializeState(c.state, c.sourceRef)}`;
    return c.sourceRef ? `${head}\n<!--src:${c.sourceRef}-->` : head;
  });
  return blocks.join("\n\n") + (blocks.length ? "\n" : "");
}

/** Cards due for review on `today` (new cards are always due). */
export function dueCards(cards: Card[], today: string): Card[] {
  return cards.filter((c) => c.state === null || isDue(c.state, today));
}

/** One deck file's path and its cards. */
export interface DeckCards {
  path: string;
  cards: Card[];
}

/** A card in a review session, with the deck file it is saved back to. */
export interface QueuedCard {
  deck: string;
  card: Card;
}

/** Today's review across decks (UX S34): every deck's due cards in one queue,
 *  most overdue first. A new card counts as due today; equal dates keep deck
 *  order, so it is the same set Home counts (sum of dueCards per deck). */
export function todayQueue(decks: DeckCards[], today: string): QueuedCard[] {
  const due = (c: Card): string => c.state?.due ?? today;
  return decks
    .flatMap((d) => dueCards(d.cards, today).map((card) => ({ deck: d.path, card })))
    .sort((a, b) => due(a.card).localeCompare(due(b.card)));
}

/** The first day after `today` that has cards due, and how many — the end
 *  screen's "next review: tomorrow, 3 cards". Null when none is scheduled. */
export function nextReview(
  decks: DeckCards[],
  today: string,
): { date: string; count: number } | null {
  const later = decks
    .flatMap((d) => d.cards)
    .flatMap((c) => (c.state && c.state.due > today ? [c.state.due] : []));
  if (later.length === 0) return null;
  const date = later.reduce((a, b) => (b < a ? b : a));
  return { date, count: later.filter((d) => d === date).length };
}

/** Apply a review grade, returning a new card with advanced FSRS state. */
export function gradeCard(card: Card, grade: Grade, today: string): Card {
  const state = card.state
    ? nextState(card.state, grade, today)
    : initState(grade, today);
  return { ...card, state };
}
