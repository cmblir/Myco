import { describe, expect, it } from "vitest";
import type { ScoredChunk } from "./ipc";
import {
  answerMarkdown,
  blocksInRange,
  cancelPickIntent,
  followUpContext,
  isFollowUp,
  isTopicOnlyRecall,
  matchLines,
  passageSection,
  plainPassage,
  plainText,
  setReaderIntent,
  subscribeReaderIntent,
  settlePick,
  takeReaderIntent,
} from "./askLoop";

describe("plainPassage", () => {
  it("flattens headings to bold lines and drops footnote marks", () => {
    const quote =
      "# Transformer Architecture\n\nIt is core[^src-a]. See [[attention|the note]].\n\n[^src-a]: [[source-a]]\n";
    expect(plainPassage(quote)).toBe(
      "**Transformer Architecture**\n\nIt is core. See [[attention|the note]].",
    );
  });

  it("keeps a heading's own bold marks from doubling and keeps the cut mark", () => {
    expect(plainPassage("## **Bold** idea ##\n\ntext…")).toBe("**Bold idea**\n\ntext…");
  });

  it("collapses the blank run a removed definition leaves", () => {
    expect(plainPassage("a\n\n[^1]: x\n\n[^2]: y\n\nb")).toBe("a\n\nb");
  });

  it("leaves a #tag line and code alone", () => {
    expect(plainPassage("#tag line\n\n`# not a heading`")).toBe(
      "#tag line\n\n`# not a heading`",
    );
  });
});

describe("plainText", () => {
  it("is the passage with bold marks gone and wikilinks unwrapped", () => {
    expect(plainText("# T\n\nSee [[attention|the note]] and [[bpe]][^1].\n\n[^1]: z")).toBe(
      "T\n\nSee the note and bpe.",
    );
  });
});

describe("answerMarkdown", () => {
  const hits = [
    {
      page: "wiki/attention.md",
      stem: "attention",
      text: "# Attention\n\nAttention is core[^src-a]. See [[bpe]].\n\n[^src-a]: [[source-a]]\n",
    },
    { page: "wiki/bpe.md", stem: "bpe", text: "BPE merges pairs." },
  ] as ScoredChunk[];

  it("is the question, then each passage as a quote block with its section link", () => {
    const md = answerMarkdown(
      "what is attention?",
      [
        { page: "wiki/attention.md", quote: hits[0].text },
        { page: "wiki/bpe.md", quote: "BPE merges pairs." },
      ],
      hits,
    );
    expect(md).toBe(
      [
        "what is attention?",
        "> Attention is core. See [[bpe]].\n— [[attention#Attention]]",
        "> BPE merges pairs.\n— [[bpe]]",
      ].join("\n\n"),
    );
  });

  it("skips a passage with nothing quotable left", () => {
    expect(
      answerMarkdown("q", [{ page: "wiki/attention.md", quote: "# Attention\n" }], hits),
    ).toBe("q");
  });
});

describe("reader intent", () => {
  it("is taken once, by the note it was set for", () => {
    setReaderIntent("/v/a.md", { kind: "append", block: "> x" });
    expect(takeReaderIntent("/v/b.md")).toBeNull();
    expect(takeReaderIntent("/v/a.md")).toEqual({ kind: "append", block: "> x" });
    expect(takeReaderIntent("/v/a.md")).toBeNull();
  });

  it("with no note named goes to whichever note opens next, until it expires", () => {
    setReaderIntent(null, { kind: "append", block: "> y" }, 1000);
    expect(takeReaderIntent("/v/any.md", 1000 + 59_000)).toEqual({
      kind: "append",
      block: "> y",
    });
    setReaderIntent(null, { kind: "append", block: "> z" }, 1000);
    expect(takeReaderIntent("/v/any.md", 1000 + 61_000)).toBeNull();
  });

  it("waiting for a pick is dropped when the pick is cancelled; one for a named note is not", () => {
    setReaderIntent(null, { kind: "append", block: "> y" });
    cancelPickIntent();
    expect(takeReaderIntent("/v/any.md")).toBeNull();
    setReaderIntent("/v/a.md", { kind: "show", section: null, quote: "x" });
    cancelPickIntent();
    expect(takeReaderIntent("/v/a.md")).toEqual({ kind: "show", section: null, quote: "x" });
  });
});

describe("settlePick", () => {
  it("leaves the pick to the note a palette row opens, however long its dialog takes", async () => {
    setReaderIntent(null, { kind: "append", block: "> q" });
    let named!: (path: string | null) => void;
    const settled = settlePick(() => new Promise<string | null>((r) => (named = r)));
    // The new note's name dialog is still open well after the palette closed.
    await new Promise((r) => setTimeout(r, 20));
    named("/v/wiki/new.md");
    await settled;
    expect(takeReaderIntent("/v/wiki/new.md")).toEqual({ kind: "append", block: "> q" });
  });

  it("drops the pick when the row opens no note: a cancelled dialog, a route, a failure", async () => {
    setReaderIntent(null, { kind: "append", block: "> q" });
    await settlePick(async () => null);
    expect(takeReaderIntent("/v/any.md")).toBeNull();

    setReaderIntent(null, { kind: "append", block: "> q" });
    await expect(settlePick(() => Promise.reject(new Error("no vault")))).rejects.toThrow("no vault");
    expect(takeReaderIntent("/v/any.md")).toBeNull();
  });
});

describe("matchLines", () => {
  const doc =
    "---\ntitle: A\n---\n\n# Attention\n\nAttention is core[^src-a]. See [[bpe]].\nIt scales with heads.\n\n## Cost\n\nQuadratic in length.\n";

  it("finds the quoted lines' 1-based document range, frontmatter counted", () => {
    expect(matchLines(doc, "Attention is core[^src-a]. See [[bpe]].\nIt scales with heads.")).toEqual({
      from: 7,
      to: 8,
    });
  });

  it("ends at the note's version of a line the quote cut with …", () => {
    expect(matchLines(doc, "# Attention\n\nAttention is core[^src-a]. See…")).toEqual({
      from: 5,
      to: 7,
    });
  });

  it("spans an elided passage from its first line to its last", () => {
    expect(matchLines(doc, "Attention is core[^src-a]. See [[bpe]].\n…\nQuadratic in length.")).toEqual({
      from: 7,
      to: 12,
    });
  });

  it("does not attach a later user's quote to an earlier speaker heading", () => {
    const transcript = "**User:**\nFirst request.\n\n**Assistant:**\nA reply.\n\n**User:**\nFind this later request.";
    expect(matchLines(transcript, "**User:**\nFind this later request.")).toEqual({ from: 7, to: 8 });
  });

  it("rejects changed middle or missing final lines instead of lighting an unrelated range", () => {
    expect(matchLines("Start.\nChanged fact.\nEnd.", "Start.\nOriginal fact.\nEnd.")).toBeNull();
    expect(matchLines("Start.\nChanged ending.", "Start.\nOriginal ending.")).toBeNull();
    expect(matchLines("Done later.", "Done")).toBeNull();
  });

  it("does not choose arbitrarily between repeated complete passages", () => {
    expect(matchLines("Same words.\n\nSame words.", "Same words.")).toBeNull();
  });

  it("treats original ellipses and inner whitespace literally", () => {
    expect(matchLines("Start.\nChanged fact.\nEnd.", "Start.\n…\nEnd.", true)).toBeNull();
    expect(matchLines("Done later.", "Done…", true)).toBeNull();
    expect(matchLines("Start.\n…\nEnd.", "\nStart.\n…\nEnd.\n", true)).toEqual({ from: 1, to: 3 });
    expect(matchLines("A  B", "A B", true)).toBeNull();
    expect(matchLines("같은 말.\n같은 말.", "같은 말.", true)).toBeNull();
  });

  it("is null when the note no longer holds the passage", () => {
    expect(matchLines(doc, "Something else entirely.")).toBeNull();
    expect(matchLines(doc, "")).toBeNull();
  });
});

describe("passageSection", () => {
  const hits = [
    { page: "wiki/a.md", stem: "a", text: "# Intro\n\nFirst part." },
    { page: "wiki/a.md", stem: "a", text: "## Cost\n\nQuadratic in length." },
  ];
  it("is the heading of the chunk the passage's first line came from", () => {
    expect(passageSection("First part.\n\nQuadratic in length.", hits)).toBe("Intro");
    expect(passageSection("Quadratic in length.", hits)).toBe("Cost");
  });
  it("is null for a chunk that starts mid-section, or no hit", () => {
    expect(passageSection("x", [{ text: "no heading" }])).toBeNull();
    expect(passageSection("x", [])).toBeNull();
  });
});

describe("isFollowUp", () => {
  it.each([
    "그건 왜 중요해?",
    "그래서 어떻게 됐어?",
    "이게 BPE랑 무슨 관계야?",
    "왜?",
    "이유는?",
    "why?",
    "How?",
    "And how does it scale?",
    "It was decided when?",
    "what about BPE?",
    "それはなぜ？",
    "これは何？",
    "その理由は？",
    "じゃあ次は？",
  ])("%s continues the previous question", (q) => {
    expect(isFollowUp(q)).toBe(true);
  });

  it.each([
    "attention이 뭐야?",
    "그래프 보여줘",
    "지난주에 결정한 것 정리해줘",
    "what is byte pair encoding?",
    "why does attention scale quadratically?",
    "BPE",
    "attention",
    "トークナイザーの仕組みは？",
    "",
  ])("%s stands on its own", (q) => {
    expect(isFollowUp(q)).toBe(false);
  });
});

describe("followUpContext", () => {
  it("is the previous question for a follow-up, null for a question that stands alone", () => {
    const turns = [{ q: "attention" }];
    expect(followUpContext(turns, "그건 왜 중요해?")).toBe("attention");
    expect(followUpContext(turns, "what is byte pair encoding?")).toBeNull();
    expect(followUpContext([], "why?")).toBeNull();
  });

  it("keeps the topic through a chain of follow-ups", () => {
    const turns = [{ q: "attention" }, { q: "why?", followUp: true }];
    expect(followUpContext(turns, "and then?")).toBe("attention");
    // "Widen" re-asks the follow-up itself: it still leans on the topic.
    expect(followUpContext(turns, "why?")).toBe("attention");
  });

  it("preserves the user topic after generation failed", () => {
    expect(followUpContext([{ q: "attention" }, { q: "bpe", error: "x" }], "why?")).toBe(
      "bpe",
    );
    expect(followUpContext([{ q: "bpe", error: "x" }], "why?")).toBe("bpe");
  });

  it("recognizes explicit recall of a previous question without reusing its failed answer", () => {
    const turns = [{ q: "Atlas 프로젝트에서 저장 방식을 바꾼 이유는?", error: "citation rejected" }];
    for (const question of ["직전 결정 질문에서 이야기한 발언을 찾아줘.", "전에 이야기한 그 내용 찾아줘.", "그 결정의 근거는 뭐야?"]) {
      expect(followUpContext(turns, question)).toBe(turns[0].q);
    }
    expect(followUpContext(turns, "이전 프로젝트의 저장 방식은? ")).toBeNull();
  });

  it("drops the topic's own time phrase, keeping the question when nothing is left", () => {
    const clean = (s: string): string => s.replace(/^지난주\s*/, "");
    expect(followUpContext([{ q: "지난주 attention 결정" }], "왜?", clean)).toBe("attention 결정");
    expect(followUpContext([{ q: "지난주" }], "왜?", clean)).toBe("지난주");
  });
});

describe("blocksInRange", () => {
  // The rendered blocks' first body lines, in document order: # H (0),
  // a two-line paragraph (2), a list (5) of items (5, 6), a paragraph (8).
  const starts = [0, 2, 5, 5, 6, 8];

  it("is every block that starts inside the passage", () => {
    expect(blocksInRange(starts, 2, 6)).toEqual([1, 2, 3, 4]);
  });

  it("includes the block the passage starts inside of", () => {
    expect(blocksInRange(starts, 3, 3)).toEqual([1]);
    expect(blocksInRange(starts, 7, 8)).toEqual([4, 5]);
  });

  it("is nothing for a passage before the first block, or no blocks", () => {
    expect(blocksInRange([4], 1, 2)).toEqual([]);
    expect(blocksInRange([], 0, 3)).toEqual([]);
  });

  // A footnote definition renders last (footnote_tail) but keeps its source
  // line, so the DOM's starts are not in document order.
  it("holds the passage in the block that starts nearest above it, whatever the DOM order", () => {
    // # H (0), a paragraph (2), a paragraph (6); the footnote def (4) renders last.
    expect(blocksInRange([0, 2, 6, 4], 7, 7)).toEqual([2]);
    // A tie still goes to the later block: the list item, not its list.
    expect(blocksInRange([0, 5, 5], 6, 6)).toEqual([2]);
  });

  it("lists the blocks in document order, so the first one is the one to scroll to", () => {
    expect(blocksInRange([0, 2, 8, 4], 3, 9)).toEqual([1, 3, 2]);
  });
});


describe("topic-only recall", () => {
  it.each(["전에 이야기한 그 내용 찾아줘.", "아까 말한 그거 다시 찾아줘", "그 결정 알려줘", "Find what we discussed before", "前に話した内容を見せて"])("recognizes missing subject: %s", q => {
    expect(isTopicOnlyRecall(q)).toBe(true);
    expect(isFollowUp(q)).toBe(true);
  });
  it.each(["Atlas 저장 방식에 대해 전에 이야기한 내용 찾아줘", "지난주 결정한 내용 찾아줘", "Find the Atlas deployment notes", "그 결정에서 Atlas의 설정을 알려줘"])("keeps named subjects searchable: %s", q => {
    expect(isTopicOnlyRecall(q)).toBe(false);
  });
});

it("notifies a mounted reader on same-page selections and unsubscribes cleanly", () => {
 let calls=0;
 const unsubscribe=subscribeReaderIntent(()=>{calls++;});
 setReaderIntent("/v/a.md",{kind:"show",section:null,quote:"first"});
 expect(takeReaderIntent("/v/a.md")?.kind).toBe("show");
 setReaderIntent("/v/a.md",{kind:"show",section:null,quote:"second"});
 expect(calls).toBe(2);
 expect(takeReaderIntent("/v/a.md")).toEqual({kind:"show",section:null,quote:"second"});
 unsubscribe();
 setReaderIntent("/v/a.md",{kind:"show",section:null,quote:"third"});
 expect(calls).toBe(2);
 takeReaderIntent("/v/a.md");
});
