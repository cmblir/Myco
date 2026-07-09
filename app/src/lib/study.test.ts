import { describe, expect, it, vi, beforeEach } from "vitest";

// chat.complete is the only external dependency; mock it so the tests exercise
// prompt→JSON parsing/validation without touching IPC or a real model.
const complete = vi.fn();
vi.mock("./chat", () => ({ complete: (...a: unknown[]) => complete(...a) }));

import { extractJsonArray, generateCards, generateQuiz } from "./study";

beforeEach(() => complete.mockReset());

describe("extractJsonArray", () => {
  it("parses a bare array", () => {
    expect(extractJsonArray('[{"a":1}]')).toEqual([{ a: 1 }]);
  });
  it("parses a ```json fenced array with surrounding prose", () => {
    const text = 'Here you go:\n```json\n[{"front":"q"}]\n```\nDone.';
    expect(extractJsonArray(text)).toEqual([{ front: "q" }]);
  });
  it("slices a balanced array out of trailing prose", () => {
    expect(extractJsonArray('[[1],[2]] trailing junk')).toEqual([[1], [2]]);
  });
  it("returns null for non-JSON", () => {
    expect(extractJsonArray("no json here")).toBeNull();
  });
});

describe("generateCards", () => {
  it("maps valid objects to new cards and drops incomplete/duplicate ones", async () => {
    complete.mockResolvedValue(
      JSON.stringify([
        { front: "What is attention?", back: "A weighted sum.", sourceRef: "[^src-1]" },
        { front: "no back", back: "" },
        { front: "What is attention?", back: "dup front" },
        { front: "What is a token?", back: "A unit of text." },
      ]),
    );
    const cards = await generateCards("/vault", "# note", 8);
    expect(cards.map((c) => c.front)).toEqual([
      "What is attention?",
      "What is a token?",
    ]);
    expect(cards[0].sourceRef).toBe("[^src-1]");
    expect(cards[0].state).toBeNull();
  });

  it("respects the count cap", async () => {
    complete.mockResolvedValue(
      JSON.stringify(
        Array.from({ length: 10 }, (_, i) => ({ front: `q${i}`, back: `a${i}` })),
      ),
    );
    expect(await generateCards("/v", "n", 3)).toHaveLength(3);
  });

  it("retries once on malformed output, then throws", async () => {
    complete.mockResolvedValue("not json");
    await expect(generateCards("/v", "n")).rejects.toThrow(/valid JSON/);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("recovers when the first reply is malformed but the retry is valid", async () => {
    complete
      .mockResolvedValueOnce("sorry, here:")
      .mockResolvedValueOnce('[{"front":"q","back":"a"}]');
    const cards = await generateCards("/v", "n");
    expect(cards).toHaveLength(1);
    expect(complete).toHaveBeenCalledTimes(2);
  });
});

describe("generateQuiz", () => {
  it("keeps well-formed questions and rejects out-of-range answers", async () => {
    complete.mockResolvedValue(
      JSON.stringify([
        {
          question: "Q1?",
          choices: ["a", "b", "c"],
          answer: 1,
          sourceRef: "[^src-2]",
          explanation: "because b",
        },
        { question: "bad answer", choices: ["a", "b"], answer: 5 },
        { question: "too few choices", choices: ["a"], answer: 0 },
      ]),
    );
    const quiz = await generateQuiz("/v", "note", 5);
    expect(quiz).toHaveLength(1);
    expect(quiz[0].answer).toBe(1);
    expect(quiz[0].choices).toHaveLength(3);
  });
});
