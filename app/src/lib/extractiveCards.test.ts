import { describe, expect, it, vi } from "vitest";
import {
  BLANK,
  CLOZE_SEP,
  cardsFromNote,
  clozeCardsFromQuote,
  clozePicks,
  clozeParts,
  isGrounded,
  isQuoted,
  parseSourceRef,
  pickedCloze,
  quizFromCards,
  termsOf,
} from "./extractiveCards";
import type { Card } from "./cards";

// Synthetic fixtures shaped like the vault's concept pages: frontmatter, an H1,
// a cited lead with bold and wikilinked terms, H2 sections, lists, footnotes.
const CONCEPT = `---
title: "Beam Search"
type: technique
---

# Beam Search

**Beam search** keeps the few most likely partial sequences at every decoding step instead of only the single best one.[^src-decoding] It sits between [[greedy-decoding|greedy decoding]] and an exhaustive search over every sequence.

## Beam width

The beam width sets how many candidates survive each step; a wider beam explores more but costs more compute.[^src-decoding] Very wide beams often return short, generic outputs, a failure mode linked to [[length-normalization]].

- widths of 4 to 10 are common in **practice today**
- [[nucleus-sampling]]

## Related

- [[greedy-decoding]]
- [[nucleus-sampling]]

[^src-decoding]: [[source-decoding-notes]]
`;

const KOREAN = `# 양자화

**양자화**는 모델 가중치를 더 적은 비트로 표현해 메모리와 연산량을 줄이는 기법이다.[^src-q]
대표적으로 [[int8]]과 [[int4]] 형식이 쓰인다.

## 정확도 손실

비트 수를 줄일수록 표현할 수 있는 값의 범위가 좁아져 **정확도**가 떨어질 수 있다.[^src-q]

[^src-q]: [[source-quant]]
`;

const NOTHING = `# Scratch

- item one with [[a-link]]
- item two

\`\`\`js
const text = "**bold** inside code is not a card";
\`\`\`

| a | b |
|---|---|
| 1 | 2 |
`;

const FRAMES = {
  st_def_front: "What is {title}?",
  st_section_front: "{title} › {heading}",
};

/** The quoted parts of a card side: frames, the blank and the cut mark are
 *  not the note's words, everything else must be. */
function quotedParts(side: string): string[] {
  return side
    .replace(/…$/, "")
    .split(BLANK)
    .flatMap((p) => p.split(CLOZE_SEP))
    .map((p) => p.trim())
    .filter(Boolean);
}

describe("isQuoted", () => {
  it("matches through markup, citations, case and line breaks", () => {
    expect(isQuoted("It sits between greedy decoding and", CONCEPT)).toBe(true);
    expect(isQuoted("beam SEARCH keeps the few", CONCEPT)).toBe(true);
    expect(isQuoted("줄이는 기법이다. 대표적으로 int8과", KOREAN)).toBe(true);
  });
  it("rejects text the note does not contain", () => {
    expect(isQuoted("Beam search is a command-line tool", CONCEPT)).toBe(false);
    expect(isQuoted("", CONCEPT)).toBe(false);
    expect(isQuoted("   ", CONCEPT)).toBe(false);
  });
});

describe("isQuoted over one note's many parts", () => {
  // A deck summary checks every card of a deck against the same note; each
  // check used to re-normalise the whole note (528 ms for one 32-card deck).
  it("normalises the note once, not once per part", () => {
    const md = `# Long\n\n${"A sentence of the long note that repeats. ".repeat(1000)}\n`;
    const spy = vi.spyOn(String.prototype, "normalize");
    try {
      for (let i = 0; i < 20; i++) isQuoted(`sentence of the long note ${i}`, md);
      const ofNote = spy.mock.contexts.filter((s) => String(s).length > 10_000);
      expect(ofNote.length).toBeLessThanOrEqual(2);
    } finally {
      spy.mockRestore();
    }
  });
  it("answers for the right note when two notes alternate", () => {
    const a = "The alpha note says one thing.";
    const b = "The beta note says another.";
    for (let i = 0; i < 2; i++) {
      expect(isQuoted("alpha note", a)).toBe(true);
      expect(isQuoted("alpha note", b)).toBe(false);
      expect(isQuoted("beta note", b)).toBe(true);
      expect(isQuoted("beta note", a)).toBe(false);
    }
  });
});

describe("cardsFromNote", () => {
  it("builds every front and back from the note's own words", () => {
    for (const [md, stem] of [
      [CONCEPT, "beam-search"],
      [KOREAN, "양자화"],
    ] as const) {
      const cards = cardsFromNote(md, stem, FRAMES);
      expect(cards.length).toBeGreaterThan(0);
      for (const c of cards) {
        const front = c.front.includes(BLANK) ? c.front : "";
        for (const part of [...quotedParts(front), ...quotedParts(c.back)]) {
          expect(isQuoted(part, md), `${stem}: "${part}"`).toBe(true);
        }
        expect(c.state).toBeNull();
        expect(c.front).not.toContain(" ?? ");
        expect(c.back).not.toContain("\n");
      }
    }
  });

  it("makes a definition card from the lead, framed by the i18n template only", () => {
    const [def] = cardsFromNote(CONCEPT, "beam-search", FRAMES);
    expect(def.front).toBe("What is Beam Search?");
    expect(def.back).toBe(
      "Beam search keeps the few most likely partial sequences at every decoding step instead of only the single best one. It sits between greedy decoding and an exhaustive search over every sequence.",
    );
    expect(def.sourceRef).toBe("[[beam-search]]");
  });

  it("makes a heading card per H2 with prose under it, sourced at the heading", () => {
    const cards = cardsFromNote(CONCEPT, "beam-search", FRAMES);
    const sections = cards.filter((c) => c.front.startsWith("Beam Search › "));
    expect(sections.map((c) => c.front)).toEqual(["Beam Search › Beam width"]);
    expect(sections[0].sourceRef).toBe("[[beam-search#Beam width]]");
    expect(sections[0].back.startsWith("The beam width sets how many")).toBe(
      true,
    );
  });

  it("makes cloze cards from sentences with a bold or wikilinked term", () => {
    const cloze = cardsFromNote(CONCEPT, "beam-search", FRAMES).filter((c) =>
      c.front.includes(BLANK),
    );
    expect(cloze.map((c) => c.front)).toEqual([
      `${BLANK} keeps the few most likely partial sequences at every decoding step instead of only the single best one.`,
      `It sits between ${BLANK} and an exhaustive search over every sequence.`,
      `Very wide beams often return short, generic outputs, a failure mode linked to ${BLANK}.`,
    ]);
    expect(cloze[1].back).toBe(
      `greedy decoding${CLOZE_SEP}It sits between greedy decoding and an exhaustive search over every sequence.`,
    );
    expect(cloze[2].sourceRef).toBe("[[beam-search#Beam width]]");
  });

  it("skips short sentences, lists, code and tables", () => {
    const cloze = cardsFromNote(KOREAN, "양자화", FRAMES).filter((c) =>
      c.front.includes(BLANK),
    );
    // "대표적으로 int8과 int4 형식이 쓰인다." is under 30 characters.
    expect(cloze.map((c) => c.back.split(CLOZE_SEP)[0])).toEqual([
      "양자화",
      "정확도",
    ]);
    expect(cardsFromNote(NOTHING, "scratch", FRAMES)).toEqual([]);
  });

  it("caps cloze cards at six per note, one per term, in document order", () => {
    const lines = Array.from(
      { length: 9 },
      (_, i) =>
        `The [[term-${i}]] appears in sentence number ${i}, long enough to count.`,
    );
    // term-0 again, second: a second card for it would push term-5 out.
    lines.splice(
      1,
      0,
      "Again the [[term-0]] shows up in a sentence of its own.",
    );
    const md = `# Many\n\n${lines.join(" ")}\n`;
    const cloze = cardsFromNote(md, "many", FRAMES).filter((c) =>
      c.front.includes(BLANK),
    );
    expect(cloze.map((c) => c.back.split(CLOZE_SEP)[0])).toEqual([
      "term-0",
      "term-1",
      "term-2",
      "term-3",
      "term-4",
      "term-5",
    ]);
  });

  it("cuts a long back to at most 280 characters on a sentence boundary", () => {
    const sentence = "Each sentence in this paragraph is about fifty chars. ";
    const md = `# Long\n\n${sentence.repeat(12)}\n`;
    const [def] = cardsFromNote(md, "long", FRAMES);
    expect(def.back.length).toBeLessThanOrEqual(281);
    expect(def.back.endsWith(".…")).toBe(true);
    expect(isQuoted(def.back.replace(/…$/, ""), md)).toBe(true);
  });

  it("falls back to the stem when the note has no H1", () => {
    const [def] = cardsFromNote(
      "A lead paragraph that is long enough.\n",
      "loose-note",
      FRAMES,
    );
    expect(def.front).toBe("What is loose-note?");
  });
});

describe("termsOf", () => {
  it("lists bold and wikilinked terms, lists included, footnotes and code not", () => {
    expect(termsOf(CONCEPT)).toEqual([
      "Beam search",
      "greedy decoding",
      "length-normalization",
      "practice today",
      "nucleus-sampling",
      "greedy-decoding",
    ]);
    expect(termsOf(NOTHING)).toEqual(["a-link"]);
  });
});

describe("quizFromCards", () => {
  const cloze = (term: string, sentence: string): Card => ({
    front: sentence.replace(term, BLANK),
    back: `${term}${CLOZE_SEP}${sentence}`,
    sourceRef: "[[beam-search]]",
    state: null,
  });
  const deck: Card[] = [
    cloze(
      "Beam search",
      "Beam search keeps the few most likely partial sequences.",
    ),
    cloze(
      "greedy decoding",
      "It sits between greedy decoding and an exhaustive search.",
    ),
    {
      front: "What is Beam Search?",
      back: "A lead.",
      sourceRef: "[[beam-search]]",
      state: null,
    },
  ];
  // Deterministic "random": always the first remaining pick.
  const first = () => 0;

  it("asks each cloze card with its removed term as the right answer", () => {
    const quiz = quizFromCards(
      deck,
      ["nucleus sampling", "length normalization"],
      first,
    );
    expect(quiz).toHaveLength(2);
    for (const q of quiz) {
      const card = deck.find((c) => c.front === q.question)!;
      expect(q.choices[q.answer]).toBe(card.back.split(CLOZE_SEP)[0]);
      expect(q.explanation).toBe(card.back.split(CLOZE_SEP)[1]);
      expect(q.sourceRef).toBe("[[beam-search]]");
      expect(new Set(q.choices.map((c) => c.toLowerCase())).size).toBe(
        q.choices.length,
      );
    }
  });

  it("draws distractors from the deck's other terms and the pool, never the answer", () => {
    const quiz = quizFromCards(
      deck,
      ["BEAM SEARCH", "nucleus sampling"],
      first,
    );
    const q = quiz.find((x) => x.question.startsWith(BLANK))!;
    const wrong = q.choices.filter((_, i) => i !== q.answer);
    expect(wrong.sort()).toEqual(["greedy decoding", "nucleus sampling"]);
  });

  it("skips a question with fewer than two distractors", () => {
    expect(quizFromCards(deck, [], first)).toEqual([]);
    expect(quizFromCards([deck[0]], ["one other"], first)).toEqual([]);
  });
});

describe("isGrounded", () => {
  const note = CONCEPT;
  const card = (back: string, sourceRef = "[[beam-search]]"): Card => ({
    front: "Q",
    back,
    sourceRef,
    state: null,
  });

  it("needs a note source and a back the note contains", () => {
    expect(
      isGrounded(
        card("It sits between greedy decoding and an exhaustive search"),
        note,
      ),
    ).toBe(true);
    expect(
      isGrounded(
        card(`greedy decoding${CLOZE_SEP}It sits between greedy decoding and`),
        note,
      ),
    ).toBe(true);
    expect(
      isGrounded(
        card(
          "The beam width sets how many candidates survive each step; a wider…",
        ),
        note,
      ),
    ).toBe(true);
    // A raw source the note cites: the note's words stand behind the card.
    expect(
      isGrounded(
        card("It sits between greedy decoding", "[^src-decoding]"),
        note,
      ),
    ).toBe(true);
  });

  it("flags no source, a source the note does not cite, a missing note and a paraphrase", () => {
    expect(isGrounded(card("It sits between greedy decoding", ""), note)).toBe(
      false,
    );
    expect(
      isGrounded(
        card("It sits between greedy decoding", "[^src-other]"),
        note,
      ),
    ).toBe(false);
    expect(isGrounded(card("It sits between greedy decoding"), null)).toBe(
      false,
    );
    expect(
      isGrounded(
        card("It's a command-line tool for generating flashcards."),
        note,
      ),
    ).toBe(false);
  });
});

describe("isGrounded on the note a card was made from", () => {
  // Card text is what the note shows (markdown-it tokens); each of these
  // notes' raw markdown spells some of it differently.
  const notes: Record<string, string> = {
    "interval then link":
      "# Calibration\n\n**Calibration** means predicted scores in [0, 1) match observed frequencies. See the [original paper](https://example.org/p) for the reliability diagram.\n",
    entity: "# Acme\n\n**Acme** sold its phone lines to AT&amp;T in the spring of that year.\n",
    image: "# Acme\n\n**Acme** draws its whole flow ![flow](assets/flow.png) on one page for new staff.\n",
    autolink: "# Acme\n\n**Acme** publishes the spec at <https://example.com/spec> for every reader.\n",
    comment: "# Acme\n\n**Acme** was founded in a garage <!-- todo: cite --> by two engineers.\n",
  };
  it.each(Object.entries(notes))("grounds every card of a note with: %s", (_, md) => {
    const cards = cardsFromNote(md, "acme", FRAMES);
    expect(cards.length).toBeGreaterThan(1);
    for (const c of cards) expect(isGrounded(c, md), c.back).toBe(true);
  });
});

describe("parseSourceRef", () => {
  it("reads the note and heading a card links back to", () => {
    expect(parseSourceRef("[[beam-search#Beam width]]")).toEqual({
      stem: "beam-search",
      heading: "Beam width",
    });
    expect(parseSourceRef("[[양자화]]")).toEqual({ stem: "양자화", heading: "" });
    expect(parseSourceRef("[[a|shown]]")).toEqual({ stem: "a", heading: "" });
  });
  it("finds the note again whatever its file name holds", () => {
    // sanitizeNoteName allows # | [ ] in a note name; each is wikilink syntax.
    const md = "# T\n\nA lead paragraph with a **bold term** that is long enough.\n\n## Types\n\nThe section body sits under its heading here.\n";
    for (const stem of ["C# basics", "[논문] 트랜스포머", "Paper [2023]", "Q|A", "a#b|c"]) {
      const cards = cardsFromNote(md, stem, FRAMES);
      expect(cards.length).toBeGreaterThan(2);
      for (const c of cards) {
        expect(parseSourceRef(c.sourceRef)?.stem, c.sourceRef).toBe(stem);
      }
      const types = cards.find((c) => c.front.endsWith("Types"))!;
      expect(parseSourceRef(types.sourceRef)?.heading).toBe("Types");
    }
  });
  it("names no note for a citation, prose or nothing", () => {
    expect(parseSourceRef("[^src-decoding]")).toBeNull();
    expect(parseSourceRef("see [[a]]")).toBeNull();
    expect(parseSourceRef("[[a]] and [[b]]")).toBeNull();
    expect(parseSourceRef("")).toBeNull();
  });
});

describe("clozeCardsFromQuote", () => {
  // The line a selection in a raw/ original becomes (dailyNote.quoteLine, S41).
  const line =
    "**Beam search** keeps the few most likely partial sequences at every step. [^src-decoding]";

  it("makes a cloze card from the quoted line, cited to the original", () => {
    const cards = clozeCardsFromQuote(line);
    expect(cards).toHaveLength(1);
    const [c] = cards;
    expect(c.front).toBe(`${BLANK} keeps the few most likely partial sequences at every step.`);
    expect(clozeParts(c)?.term).toBe("Beam search");
    expect(c.sourceRef).toBe("[^src-decoding]");
  });

  it("is grounded once the line sits in today's note", () => {
    const daily = `# 2026-10-03\n\n- ${line}\n`;
    for (const c of clozeCardsFromQuote(line)) expect(isGrounded(c, daily)).toBe(true);
  });

  it("makes one card per term, no definition card", () => {
    const two =
      "**Beam search** sits between [[greedy-decoding|greedy decoding]] and exhaustive search. A wider beam explores more of the space at each step, said **the paper**. [^src-decoding]";
    const cards = clozeCardsFromQuote(two);
    expect(cards.map((c) => clozeParts(c)?.term)).toEqual(["Beam search", "the paper"]);
    expect(cards.every((c) => c.front.includes(BLANK))).toBe(true);
  });

  it("makes nothing without a term to blank or a citation", () => {
    expect(clozeCardsFromQuote("Plain prose with no marked term in it at all. [^src-a]")).toEqual([]);
    expect(clozeCardsFromQuote("**Beam search** keeps the few most likely partial sequences.")).toEqual([]);
    expect(clozeCardsFromQuote("")).toEqual([]);
  });

  it("keeps the citation out of the card when the selection has no final stop", () => {
    // A list item, heading or fragment ends without punctuation; the citation
    // must not be read as the end of that sentence.
    for (const l of [
      "**Beam search** keeps the few most likely partial sequences at each step [^src-decoding]",
      "**트랜스포머**는 순환 구조 없이 어텐션만으로 단어의 관계를 계산한다 [^src-ko-clip]",
    ]) {
      const cards = clozeCardsFromQuote(l);
      expect(cards).toHaveLength(1);
      expect(cards[0].front).not.toContain("[^src-");
      expect(cards[0].back).not.toContain("[^src-");
      expect(cards[0].sourceRef).toMatch(/^\[\^src-/);
    }
  });
});

describe("clozePicks (default 9: the owner picks the word to blank)", () => {
  const line = "Beam search keeps the few most likely partial sequences. [^src-decoding]";

  it("offers each word of a sentence that has no marked term", () => {
    const [pick] = clozePicks(line);
    expect(pick.sentence).toBe("Beam search keeps the few most likely partial sequences.");
    expect(pick.sourceRef).toBe("[^src-decoding]");
    const words = pick.words.map((w) => pick.sentence.slice(w.start, w.end));
    // Punctuation stays out of a word; one-letter words are no blank.
    expect(words).toEqual(["Beam", "search", "keeps", "the", "few", "most", "likely", "partial", "sequences"]);
  });

  it("makes a grounded cloze from the picked word", () => {
    const [pick] = clozePicks(line);
    const c = pickedCloze(pick, pick.words[6]);
    expect(c.front).toBe(`Beam search keeps the few most ${BLANK} partial sequences.`);
    expect(clozeParts(c)).toEqual({ term: "likely", sentence: pick.sentence });
    expect(c.sourceRef).toBe("[^src-decoding]");
    expect(isGrounded(c, `# 2026-10-03\n\n- ${line}\n`)).toBe(true);
  });

  it("keeps a Korean word whole, particle and all", () => {
    const [pick] = clozePicks("트랜스포머는 어텐션만으로 단어의 관계를 계산한다 [^src-ko]");
    expect(pick.words.map((w) => pick.sentence.slice(w.start, w.end))).toEqual([
      "트랜스포머는",
      "어텐션만으로",
      "단어의",
      "관계를",
      "계산한다",
    ]);
  });

  it("splits sentences and skips one with too few words to blank", () => {
    const picks = clozePicks("Done. Greedy decoding takes the top token each step. [^src-a]");
    expect(picks.map((p) => p.sentence)).toEqual(["Greedy decoding takes the top token each step."]);
  });

  it("offers nothing without a citation", () => {
    expect(clozePicks("Beam search keeps the few most likely partial sequences.")).toEqual([]);
    expect(clozePicks("")).toEqual([]);
  });
});
