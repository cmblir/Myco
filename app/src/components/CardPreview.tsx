// "Make cards" preview (spec 2026-09-29 Part 1): the proposed cards with a
// checkbox each, in the app's confirm dialog. Cards the deck already holds
// (same normalised front) are shown but cannot be picked again. A quoted
// sentence with no marked term gets a word picker instead (default 9).

import { useState } from "react";
import type { JSX } from "react";
import type { Card } from "../lib/cards";
import { normalise, pickedCloze, type ClozePick } from "../lib/extractiveCards";
import type { Strings } from "../lib/i18n";
import { confirmAction } from "../stores/dialogStore";
import { Check } from "./ui";

export interface ProposedCard {
  card: Card;
  /** Drafted by the opt-in model path (already quote-checked). */
  ai?: boolean;
}

function PreviewList({
  t,
  items,
  dupes,
  picked,
}: {
  t: Strings;
  items: ProposedCard[];
  dupes: ReadonlySet<number>;
  picked: Set<number>;
}): JSX.Element {
  // The dialog owns the body as a ReactNode made once; the picked set is read
  // back after it closes, and this state only repaints the checkboxes.
  const [, repaint] = useState(0);
  return (
    <ul className="card-preview">
      {items.map(({ card, ai }, i) => (
        <li key={i} className={dupes.has(i) ? "is-dupe" : undefined}>
          <Check
            checked={picked.has(i)}
            disabled={dupes.has(i)}
            label={card.front}
            onChange={(on) => {
              if (on) picked.add(i);
              else picked.delete(i);
              repaint((n) => n + 1);
            }}
          />
          <p className="card-preview__back">{card.back}</p>
          {dupes.has(i) || ai ? (
            <p className="card-preview__tags">
              {dupes.has(i) ? <span>{t.rd_cards_dupe}</span> : null}
              {ai ? <span>{t.rd_cards_ai_tag}</span> : null}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** Ask which proposed cards to keep. Resolves to the picked cards, [] when
 *  every one is already in the deck (no dialog), "none" when Save was pressed
 *  with every box unchecked, null on cancel. */
export async function previewCards(
  t: Strings,
  items: ProposedCard[],
  existing: Card[],
  deckFile: string,
): Promise<Card[] | "none" | null> {
  const have = new Set(existing.map((c) => normalise(c.front)));
  const dupes = new Set(
    items.flatMap((it, i) => (have.has(normalise(it.card.front)) ? [i] : [])),
  );
  if (dupes.size === items.length) return [];
  const picked = new Set(items.map((_, i) => i).filter((i) => !dupes.has(i)));
  const ok = await confirmAction({
    title: t.rd_cards_preview_title,
    message: t.rd_cards_preview_msg.replace("{deck}", deckFile),
    confirmLabel: t.rd_cards_save,
    body: <PreviewList t={t} items={items} dupes={dupes} picked={picked} />,
  });
  const cards = items.filter((_, i) => picked.has(i)).map((it) => it.card);
  if (!ok) return null;
  return cards.length > 0 ? cards : "none";
}

function WordPicker({
  t,
  picks,
  choice,
}: {
  t: Strings;
  picks: ClozePick[];
  choice: { card: Card | null };
}): JSX.Element {
  // As in PreviewList: the dialog body is made once, so the choice lives in
  // an object read back after it closes; this state only repaints.
  const [at, setAt] = useState<string | null>(null);
  return (
    <div className="cloze-pick">
      {picks.map((pick, pi) => {
        const parts: (string | JSX.Element)[] = [];
        let from = 0;
        pick.words.forEach((w, wi) => {
          const key = `${pi}:${wi}`;
          parts.push(pick.sentence.slice(from, w.start));
          parts.push(
            <button
              key={key}
              type="button"
              className="cloze-pick__word"
              aria-pressed={at === key}
              onClick={() => {
                choice.card = pickedCloze(pick, w);
                setAt(key);
              }}
            >
              {pick.sentence.slice(w.start, w.end)}
            </button>,
          );
          from = w.end;
        });
        parts.push(pick.sentence.slice(from));
        return (
          <p key={pi} className="cloze-pick__sentence">
            {parts}
          </p>
        );
      })}
      <p className="cloze-pick__front" aria-live="polite">
        <span>{t.rd_quote_pick_front}</span>
        {choice.card ? choice.card.front : t.rd_quote_pick_empty}
      </p>
    </div>
  );
}

/** Ask which word of a quoted sentence the card blanks (default 9). Resolves
 *  like previewCards: the one card, [] when the deck already has it, "none"
 *  when Save was pressed with no word picked, null on cancel. */
export async function pickCloze(
  t: Strings,
  picks: ClozePick[],
  existing: Card[],
  deckFile: string,
): Promise<Card[] | "none" | null> {
  const choice: { card: Card | null } = { card: null };
  const ok = await confirmAction({
    title: t.rd_quote_pick_title,
    message: t.rd_quote_pick_msg.replace("{deck}", deckFile),
    confirmLabel: t.rd_cards_save,
    body: <WordPicker t={t} picks={picks} choice={choice} />,
  });
  if (!ok) return null;
  const { card } = choice;
  if (!card) return "none";
  const have = existing.some((c) => normalise(c.front) === normalise(card.front));
  return have ? [] : [card];
}
