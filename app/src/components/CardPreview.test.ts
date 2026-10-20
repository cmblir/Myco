// Make cards' preview decides what Save means; the dialog itself is the
// shared confirm host, so it is stood in for here (node env, no DOM).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

const confirmAction = vi.fn();
vi.mock("../stores/dialogStore", () => ({
  confirmAction: (opts: unknown) => confirmAction(opts),
}));

import { pickCloze, previewCards, type ProposedCard } from "./CardPreview";
import { clozePicks, pickedCloze } from "../lib/extractiveCards";
import { STRINGS } from "../lib/i18n";

const items: ProposedCard[] = ["q1", "q2"].map((front) => ({
  card: { front, back: "b", sourceRef: "[[n]]", state: null },
}));
type Body = ReactElement<{ picked: Set<number> }>;

beforeEach(() => {
  confirmAction.mockReset();
});

describe("previewCards", () => {
  it("tells Save with every card unchecked apart from Cancel", async () => {
    // Unchecking every box empties the picked set the body holds.
    confirmAction.mockImplementation(({ body }: { body: Body }) => {
      body.props.picked.clear();
      return Promise.resolve(true);
    });
    expect(await previewCards(STRINGS.en, items, [], "cards/n.md")).toBe("none");

    confirmAction.mockResolvedValue(false);
    expect(await previewCards(STRINGS.en, items, [], "cards/n.md")).toBeNull();
  });

  it("saves the checked cards", async () => {
    confirmAction.mockImplementation(({ body }: { body: Body }) => {
      body.props.picked.delete(0);
      return Promise.resolve(true);
    });
    expect(await previewCards(STRINGS.en, items, [], "cards/n.md")).toEqual([items[1].card]);
  });
});

describe("pickCloze", () => {
  const picks = clozePicks("Beam search keeps the few most likely partial sequences. [^src-d]");
  const likely = pickedCloze(picks[0], picks[0].words[6]);
  type PickBody = ReactElement<{ choice: { card: unknown } }>;
  const pickWord = (card: unknown) =>
    confirmAction.mockImplementation(({ body }: { body: PickBody }) => {
      body.props.choice.card = card;
      return Promise.resolve(true);
    });

  it("saves the cloze for the picked word", async () => {
    pickWord(likely);
    expect(await pickCloze(STRINGS.en, picks, [], "cards/d.md")).toEqual([likely]);
  });

  it("tells Save with no word picked apart from Cancel", async () => {
    pickWord(null);
    expect(await pickCloze(STRINGS.en, picks, [], "cards/d.md")).toBe("none");
    confirmAction.mockResolvedValue(false);
    expect(await pickCloze(STRINGS.en, picks, [], "cards/d.md")).toBeNull();
  });

  it("returns nothing new when the deck already has that card", async () => {
    pickWord(likely);
    expect(await pickCloze(STRINGS.en, picks, [likely], "cards/d.md")).toEqual([]);
  });
});
