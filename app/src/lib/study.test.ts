import { describe, expect, it, vi, beforeEach } from "vitest";

// Parsing tests mock complete; binding tests run the real entry point with
// synthetic IPC replies, without native authority or an actual model.
const complete = vi.fn();
vi.mock("./chat", () => ({ complete: (...a: unknown[]) => complete(...a) }));
const agentVaultSession = vi.fn();
const captureModelRole = vi.fn();
const localChatStatus = vi.fn();
const localQuery = vi.fn();
const chatComplete = vi.fn();
const embeddingsStatus = vi.fn();
const semanticSearch = vi.fn();
const readVaultContext = vi.fn();
vi.mock("./ipc", () => ({
  ipc: {
    agentVaultSession: (...a: unknown[]) => agentVaultSession(...a),
    captureModelRole: (...a: unknown[]) => captureModelRole(...a),
    localChatStatus: (...a: unknown[]) => localChatStatus(...a),
    localQuery: (...a: unknown[]) => localQuery(...a),
    chatComplete: (...a: unknown[]) => chatComplete(...a),
    embeddingsStatus: (...a: unknown[]) => embeddingsStatus(...a),
    semanticSearch: (...a: unknown[]) => semanticSearch(...a),
    readVaultContext: (...a: unknown[]) => readVaultContext(...a),
  },
}));
import { roleFixture } from "./modelRoles.testSupport";
import type * as ChatModule from "./chat";

import {
  extractJsonArray,
  generateCards,
  generateQuiz,
  generateQuotedCards,
  generateQuotedQuiz,
} from "./study";
import { parseSourceRef } from "./extractiveCards";

const origin = { vaultPath: "/v", openingToken: "synthetic-study-opening" };
const snapshot = roleFixture("study", undefined, undefined, origin);

beforeEach(() => {
  complete.mockReset();
  agentVaultSession.mockReset().mockResolvedValue(origin);
  captureModelRole.mockReset().mockResolvedValue(snapshot);
  localChatStatus.mockReset().mockResolvedValue({ state: "ready" });
  localQuery.mockReset();
  chatComplete.mockReset();
  embeddingsStatus
    .mockReset()
    .mockResolvedValue({ indexed_pages: 0, model: "" });
  semanticSearch
    .mockReset()
    .mockResolvedValue({ hits: [], below_floor: [], floor: 0.42 });
  readVaultContext.mockReset().mockResolvedValue("unselected synthetic note");
});

describe("extractJsonArray", () => {
  it("parses a bare array", () => {
    expect(extractJsonArray('[{"a":1}]')).toEqual([{ a: 1 }]);
  });
  it("parses a ```json fenced array with surrounding prose", () => {
    const text = 'Here you go:\n```json\n[{"front":"q"}]\n```\nDone.';
    expect(extractJsonArray(text)).toEqual([{ front: "q" }]);
  });
  it("slices a balanced array out of trailing prose", () => {
    expect(extractJsonArray("[[1],[2]] trailing junk")).toEqual([[1], [2]]);
  });
  it("returns null for non-JSON", () => {
    expect(extractJsonArray("no json here")).toBeNull();
  });
});

describe("generateCards", () => {
  it("captures one native Study grant and retains the supplied note across repair", async () => {
    complete
      .mockResolvedValueOnce("not JSON")
      .mockResolvedValueOnce(
        '[{"front":"Synthetic question","back":"Selected fact"}]',
      );
    await generateCards("/v", "selected synthetic note");
    expect(agentVaultSession).toHaveBeenCalledTimes(1);
    expect(captureModelRole).toHaveBeenCalledTimes(1);
    expect(captureModelRole).toHaveBeenCalledWith(
      origin,
      "study",
      "foreground",
    );
    for (const [args] of complete.mock.calls as [ChatModule.CompleteArgs][]) {
      expect(args.origin).toBe(origin);
      expect(args.roleSnapshot).toBe(snapshot);
      expect(args.paths).toEqual([]);
      expect(args.messages[1].content).toContain("selected synthetic note");
    }
    expect(complete.mock.calls[0][0].messages).toEqual(
      complete.mock.calls[1][0].messages,
    );
  });

  it.each([
    { ...origin, vaultPath: "/other-synthetic" },
    { ...origin, openingToken: "" },
  ])(
    "refuses an invalid opening before selecting a model or generating",
    async (invalidOrigin) => {
      agentVaultSession.mockResolvedValue(invalidOrigin);
      await expect(
        generateCards("/v", "selected synthetic note"),
      ).rejects.toThrow("active vault changed");
      expect(captureModelRole).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
    },
  );

  it("surfaces a rejected Study admission without attempting generation", async () => {
    captureModelRole.mockRejectedValue(new Error("role_selection_unavailable"));
    await expect(
      generateCards("/v", "selected synthetic note"),
    ).rejects.toThrow("role_selection_unavailable");
    expect(complete).not.toHaveBeenCalled();
  });

  it("uses real complete without admitting a new route or extra sources on retry", async () => {
    const realChat = await vi.importActual<typeof ChatModule>("./chat");
    complete.mockImplementation(realChat.complete);
    localQuery
      .mockImplementationOnce(async () => {
        agentVaultSession.mockResolvedValue({
          ...origin,
          openingToken: "new-opening",
        });
        captureModelRole.mockResolvedValue(
          roleFixture("study", "openai", "unselected-external", origin),
        );
        return "not JSON";
      })
      .mockResolvedValueOnce(
        '[{"front":"Synthetic question","back":"Selected fact"}]',
      );
    await generateCards("/v", "selected synthetic note");
    expect(agentVaultSession).toHaveBeenCalledTimes(1);
    expect(captureModelRole).toHaveBeenCalledTimes(1);
    expect(localQuery).toHaveBeenCalledTimes(2);
    for (const call of localQuery.mock.calls) {
      expect(call[2]).toBe(origin);
      expect(call[3]).toBe(snapshot);
      expect(call[0]).toContain("selected synthetic note");
      expect(call[0]).not.toContain("unselected synthetic note");
    }
    expect(embeddingsStatus).not.toHaveBeenCalled();
    expect(semanticSearch).not.toHaveBeenCalled();
    expect(readVaultContext).not.toHaveBeenCalled();
    expect(chatComplete).not.toHaveBeenCalled();
  });

  it.each(["vault_session_stale", "role_snapshot_revoked"])(
    "fails on %s without admitting another repair route",
    async (failure) => {
      const realChat = await vi.importActual<typeof ChatModule>("./chat");
      complete.mockImplementation(realChat.complete);
      localQuery
        .mockResolvedValueOnce("not JSON")
        .mockRejectedValueOnce(new Error(failure));
      await expect(
        generateCards("/v", "selected synthetic note"),
      ).rejects.toThrow(failure);
      expect(agentVaultSession).toHaveBeenCalledTimes(1);
      expect(captureModelRole).toHaveBeenCalledTimes(1);
      expect(localQuery.mock.calls[1][2]).toBe(origin);
      expect(localQuery.mock.calls[1][3]).toBe(snapshot);
      expect(chatComplete).not.toHaveBeenCalled();
    },
  );

  it("maps valid objects to new cards and drops incomplete/duplicate ones", async () => {
    const vaultOrigin = { ...origin, vaultPath: "/vault" };
    agentVaultSession.mockResolvedValue(vaultOrigin);
    captureModelRole.mockResolvedValue(
      roleFixture("study", undefined, undefined, vaultOrigin),
    );
    complete.mockResolvedValue(
      JSON.stringify([
        {
          front: "What is attention?",
          back: "A weighted sum.",
          sourceRef: "[^src-1]",
        },
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
        Array.from({ length: 10 }, (_, i) => ({
          front: `q${i}`,
          back: `a${i}`,
        })),
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
  it("reuses the Study snapshot and source packet for quiz format repair", async () => {
    complete
      .mockResolvedValueOnce("not JSON")
      .mockResolvedValueOnce(
        '[{"question":"Q?","choices":["a","b"],"answer":0}]',
      );
    await generateQuiz("/v", "selected synthetic quiz note");
    expect(agentVaultSession).toHaveBeenCalledTimes(1);
    expect(captureModelRole).toHaveBeenCalledOnce();
    expect(captureModelRole).toHaveBeenCalledWith(
      origin,
      "study",
      "foreground",
    );
    const [first, second] = complete.mock.calls.map(
      ([args]) => args as ChatModule.CompleteArgs,
    );
    expect(second.origin).toBe(first.origin);
    expect(second.roleSnapshot).toBe(first.roleSnapshot);
    expect(second.paths).toBe(first.paths);
    expect(second.messages).toEqual(first.messages);
  });

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

// Spec 2026-09-29: the model path is opt-in, and even then a card survives
// only when its answer occurs verbatim in the note.
describe("generateQuotedCards", () => {
  const NOTE =
    "# Beam\n\n**Beam search** keeps the few most likely partial sequences.[^src-1]\n";
  it("drops cards whose back the note does not contain and sources the rest at the note", async () => {
    complete.mockResolvedValue(
      JSON.stringify([
        {
          front: "What does beam search keep?",
          back: "the few most likely partial sequences",
          sourceRef: "[^src-1]",
        },
        {
          front: "What is this tool?",
          back: "A command-line tool for generating flashcards.",
        },
      ]),
    );
    const cards = await generateQuotedCards("/v", NOTE, "beam");
    expect(cards).toEqual([
      {
        front: "What does beam search keep?",
        back: "the few most likely partial sequences",
        sourceRef: "[[beam]]",
        state: null,
      },
    ]);
  });

  it("sources a card at a note whose name holds wikilink syntax", async () => {
    complete.mockResolvedValue(
      JSON.stringify([
        {
          front: "What does it keep?",
          back: "the few most likely partial sequences",
        },
      ]),
    );
    const [card] = await generateQuotedCards("/v", NOTE, "C# basics");
    expect(parseSourceRef(card.sourceRef)?.stem).toBe("C# basics");
  });

  it("previews a quote that crosses the note's line break as the one line it is saved as", async () => {
    const wrapped =
      "# KV\n\nThe cache keeps the keys and values of earlier tokens\nso they are not recomputed at every step.\n";
    complete.mockResolvedValue(
      JSON.stringify([
        {
          front: "What does a KV cache keep?",
          back: "keeps the keys and values of earlier tokens\nso they are not recomputed at every step",
        },
      ]),
    );
    const [card] = await generateQuotedCards("/v", wrapped, "kv-cache");
    expect(card.back).toBe(
      "keeps the keys and values of earlier tokens so they are not recomputed at every step",
    );
  });
});

describe("generateQuotedQuiz", () => {
  it("drops questions whose explanation is not quoted from the source", async () => {
    complete.mockResolvedValue(
      JSON.stringify([
        {
          question: "Q1?",
          choices: ["a", "b"],
          answer: 0,
          explanation: "keeps the few most likely",
        },
        {
          question: "Q2?",
          choices: ["a", "b"],
          answer: 1,
          explanation: "invented reason",
        },
      ]),
    );
    const quiz = await generateQuotedQuiz(
      "/v",
      "Beam search keeps the few most likely sequences.",
    );
    expect(quiz.map((q) => q.question)).toEqual(["Q1?"]);
  });
});
