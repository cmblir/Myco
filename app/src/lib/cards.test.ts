import { describe, expect, it } from "vitest";
import {
  dueCards,
  gradeCard,
  nextReview,
  parseDeck,
  serializeDeck,
  todayQueue,
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

  it("keeps a new card's source on disk before its first review", () => {
    const cards: Card[] = [
      { front: "Q", back: "A", sourceRef: "[[attention#Scaling]]", state: null },
      { front: "Q2", back: "A2", sourceRef: "", state: null },
    ];
    const md = serializeDeck(cards);
    expect(parseDeck(md)).toEqual(cards);
    // Graded, the source moves into the SR trailer; no second comment line.
    const graded = gradeCard(cards[0], 3, "2026-01-01");
    const again = serializeDeck([graded]);
    expect(again.split("\n").filter((l) => l.startsWith("<!--"))).toHaveLength(1);
    expect(parseDeck(again)[0].sourceRef).toBe("[[attention#Scaling]]");
  });

  it("keeps a multi-line answer on its card's one line, source and all", () => {
    // A quote copied from a hard-wrapped note carries the note's line break.
    const card: Card = {
      front: "What does a KV cache\nkeep?",
      back: "keeps the keys and values of earlier tokens\nso they are not recomputed at every step",
      sourceRef: "[[kv-cache]]",
      state: null,
    };
    expect(parseDeck(serializeDeck([card]))).toEqual([
      {
        front: "What does a KV cache keep?",
        back: "keeps the keys and values of earlier tokens so they are not recomputed at every step",
        sourceRef: "[[kv-cache]]",
        state: null,
      },
    ]);
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

/** A card due on `due`, or a new one (never reviewed) with no date. */
const at = (front: string, due: string | null): Card => ({
  front,
  back: "a",
  sourceRef: `[[${front}]]`,
  state: due
    ? { due, stability: 3, difficulty: 5, reps: 1, lapses: 0, lastReview: "2025-12-01" }
    : null,
});

describe("todayQueue", () => {
  const today = "2026-01-10";
  const decks = [
    {
      path: "/v/cards/a.md",
      cards: [at("a-new", null), at("a-old", "2026-01-03"), at("a-later", "2026-02-01")],
    },
    { path: "/v/cards/b.md", cards: [at("b-oldest", "2026-01-01"), at("b-today", today)] },
  ];

  it("merges every deck's due cards into one queue, most overdue first", () => {
    const q = todayQueue(decks, today);
    // A new card counts as due today; equal dates keep deck order.
    expect(q.map((i) => i.card.front)).toEqual(["b-oldest", "a-old", "a-new", "b-today"]);
    expect(q.map((i) => i.deck)).toEqual([
      "/v/cards/b.md",
      "/v/cards/a.md",
      "/v/cards/a.md",
      "/v/cards/b.md",
    ]);
  });

  it("holds exactly the cards each deck counts as due", () => {
    const perDeck = decks.reduce((n, d) => n + dueCards(d.cards, today).length, 0);
    expect(todayQueue(decks, today)).toHaveLength(perDeck);
    expect(todayQueue([], today)).toEqual([]);
  });
});

describe("nextReview", () => {
  it("names the first day after today with cards due, and how many", () => {
    const decks = [
      { path: "/v/cards/a.md", cards: [at("x", "2026-01-13"), at("y", "2026-01-11")] },
      { path: "/v/cards/b.md", cards: [at("z", "2026-01-11"), at("w", "2026-01-09")] },
    ];
    expect(nextReview(decks, "2026-01-10")).toEqual({ date: "2026-01-11", count: 2 });
  });

  it("is null when nothing is scheduled after today", () => {
    const decks = [{ path: "/v/cards/a.md", cards: [at("new", null), at("old", "2026-01-01")] }];
    expect(nextReview(decks, "2026-01-10")).toBeNull();
  });
});
