import { describe, expect, it } from "vitest";
import {
  dueCards,
  gradeCard,
  parseDeck,
  serializeDeck,
  type Card,
} from "./cards";

describe("cards", () => {
  it("parses a new card (no trailer) and one with FSRS state", () => {
    const md = [
      "What is attention? ?? A weighted sum over values.",
      "",
      "What is a token? ?? A unit of text.",
      "<!--SR:!2026-01-08|4.1000|5.2000|2|0|2026-01-01|[^src-3]-->",
    ].join("\n");
    const cards = parseDeck(md);
    expect(cards).toHaveLength(2);
    expect(cards[0].state).toBeNull();
    expect(cards[0].front).toBe("What is attention?");
    expect(cards[1].state?.reps).toBe(2);
    expect(cards[1].sourceRef).toBe("[^src-3]");
    expect(cards[1].state?.due).toBe("2026-01-08");
  });

  it("round-trips serialize → parse", () => {
    const cards: Card[] = [
      { front: "Q1", back: "A1", sourceRef: "", state: null },
      {
        front: "Q2",
        back: "A2",
        sourceRef: "[^src-1]",
        state: {
          due: "2026-02-01",
          stability: 3.5,
          difficulty: 6,
          reps: 3,
          lapses: 1,
          lastReview: "2026-01-20",
        },
      },
    ];
    const back = parseDeck(serializeDeck(cards));
    expect(back).toHaveLength(2);
    expect(back[0].state).toBeNull();
    expect(back[1].sourceRef).toBe("[^src-1]");
    expect(back[1].state?.reps).toBe(3);
    expect(back[1].state?.due).toBe("2026-02-01");
  });

  it("dueCards: new cards always due; scheduled cards respect due date", () => {
    const cards: Card[] = [
      { front: "new", back: "x", sourceRef: "", state: null },
      {
        front: "future",
        back: "y",
        sourceRef: "",
        state: {
          due: "2026-06-01",
          stability: 10,
          difficulty: 5,
          reps: 5,
          lapses: 0,
          lastReview: "2026-05-01",
        },
      },
    ];
    const due = dueCards(cards, "2026-01-15");
    expect(due.map((c) => c.front)).toEqual(["new"]);
  });

  it("gradeCard: initializes new state then advances it", () => {
    const c: Card = { front: "q", back: "a", sourceRef: "", state: null };
    const g1 = gradeCard(c, 3, "2026-01-01");
    expect(g1.state?.reps).toBe(1);
    const g2 = gradeCard(g1, 3, g1.state!.due);
    expect(g2.state?.reps).toBe(2);
  });
});
