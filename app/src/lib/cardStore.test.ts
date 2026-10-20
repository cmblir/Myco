import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { AgentVaultSession, FileNode, StudyDeckContext } from "./ipc";
import { ipc } from "./ipc";
import { gradeCard, parseDeck, serializeDeck, type Card } from "./cards";
import { cardsFromNote } from "./extractiveCards";
import { STRINGS } from "./i18n";

// In-memory fake of the vault IPC surface cardStore touches.
const files = new Map<string, string>();
let activeOrigin: AgentVaultSession = { vaultPath: "/v", openingToken: "synthetic-study-opening" };
let snapshotId = 0;
const snapshots = new Map<string, { context: StudyDeckContext; raw: string; existed: boolean }>();
const nativeCalls: unknown[][] = [];
const logWarn = vi.fn();
const sameOrigin = (origin: AgentVaultSession): boolean =>
  origin.vaultPath === activeOrigin.vaultPath && origin.openingToken === activeOrigin.openingToken;
vi.mock("./log", () => ({ log: { warn: (...args: unknown[]) => logWarn(...args) } }));
vi.mock("./ipc", () => ({
  ipc: {
    agentVaultSession: () => Promise.resolve({ ...activeOrigin }),
    // Synthetic native adapter delegates to the original map-based IPC, so
    // the frozen generic read/write spies and all original assertions survive.
    readStudyDeck: async (path: string, origin: AgentVaultSession) => {
      nativeCalls.push(["read", path, origin]);
      if (!sameOrigin(origin)) throw new Error("Synthetic stale opening");
      let raw = "";
      try { raw = (await ipc.readFile(path)).raw; }
      catch (error) {
        if (!(error instanceof Error) || error.message !== "ENOENT" || files.has(path)) throw error;
      }
      const context = { snapshotId: `synthetic-snapshot-${++snapshotId}`, origin, path };
      const existed = files.has(path);
      snapshots.set(context.snapshotId, { context, raw, existed });
      return { context, raw, revision: existed ? "a".repeat(64) : null };
    },
    writeStudyDeck: async (context: StudyDeckContext, content: string) => {
      nativeCalls.push(["write", context, content]);
      const held = snapshots.get(context.snapshotId);
      if (!held || held.context.path !== context.path || !sameOrigin(context.origin) ||
        held.context.origin.vaultPath !== context.origin.vaultPath ||
        held.context.origin.openingToken !== context.origin.openingToken) throw new Error("Synthetic invalid snapshot");
      if (held.existed !== files.has(context.path) || (held.existed && held.raw !== files.get(context.path))) throw new Error("Synthetic CAS conflict");
      await ipc.writeFile(context.path, content);
      return { path: context.path, origin: context.origin, state: "persisted", revision: "b".repeat(64), error: null };
    },
    discardStudyDeckSnapshot: (context: StudyDeckContext) => {
      nativeCalls.push(["discard", context]);
      const held = snapshots.get(context.snapshotId);
      if (held && (held.context.path !== context.path || held.context.origin.vaultPath !== context.origin.vaultPath ||
        held.context.origin.openingToken !== context.origin.openingToken)) return Promise.reject(new Error("Synthetic foreign snapshot"));
      return Promise.resolve(snapshots.delete(context.snapshotId));
    },
    readFile: (path: string) => {
      if (!files.has(path)) return Promise.reject(new Error("ENOENT"));
      return Promise.resolve({ path, raw: files.get(path), content: "", frontmatter: null });
    },
    writeFile: (path: string, content: string) => {
      files.set(path, content);
      return Promise.resolve(null);
    },
    createFolder: (...a: unknown[]) => {
      calls.push(["createFolder", ...a]);
      return Promise.resolve("cards");
    },
    movePath: (from: string, toDir: string) => {
      calls.push(["movePath", from, toDir]);
      return Promise.resolve(`${toDir}/${from.split("/").pop()}`);
    },
  },
}));
const calls: unknown[][] = [];

import {
  addCards,
  archiveDeck,
  countedDue,
  deckFiles,
  deckNameFromPath,
  deckSlug,
  loadDeck,
  loadCountedDecks,
  saveDeck,
  saveGrade,
  summarizeDecks,
  StudyDeckError,
} from "./cardStore";

beforeEach(() => {
  files.clear();
  calls.length = 0;
  nativeCalls.length = 0;
  snapshots.clear();
  snapshotId = 0;
  activeOrigin = { vaultPath: "/v", openingToken: "synthetic-study-opening" };
  logWarn.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const card = (front: string, back = "a"): Card => ({
  front,
  back,
  sourceRef: "",
  state: null,
});

describe("deckSlug / deckNameFromPath", () => {
  it("slugifies titles", () => {
    expect(deckSlug("Transformer Architecture.md")).toBe("transformer-architecture");
    expect(deckSlug("  Q&A: notes! ")).toBe("q-a-notes");
    expect(deckSlug("")).toBe("deck");
  });
  it("extracts deck name from a path", () => {
    expect(deckNameFromPath("/v/cards/transformers.md")).toBe("transformers");
  });
});

describe("deckFiles", () => {
  it("returns only cards/*.md paths from the tree", () => {
    const tree: FileNode[] = [
      { kind: "file", name: "welcome.md", path: "/v/welcome.md" },
      {
        kind: "directory",
        name: "cards",
        path: "/v/cards",
        children: [
          { kind: "file", name: "a.md", path: "/v/cards/a.md" },
          { kind: "file", name: "notes.txt", path: "/v/cards/notes.txt" },
        ],
      },
    ];
    expect(deckFiles(tree)).toEqual(["/v/cards/a.md"]);
  });
  it("returns [] when there is no cards folder", () => {
    expect(deckFiles([{ kind: "file", name: "x.md", path: "/v/x.md" }])).toEqual([]);
  });
});

describe("addCards", () => {
  it("creates a new deck when none exists", async () => {
    const { added, path } = await addCards("/v", "deck1", [card("q1"), card("q2")]);
    expect(added).toBe(2);
    expect(path).toBe("/v/cards/deck1.md");
    expect(files.get(path)).toContain("q1 ?? a");
  });

  it("merges into an existing deck, de-duping by front", async () => {
    files.set("/v/cards/deck1.md", serializeDeck([card("q1")]));
    const { added } = await addCards("/v", "deck1", [card("q1"), card("q3")]);
    expect(added).toBe(1); // q1 is a duplicate
    expect(files.get("/v/cards/deck1.md")).toContain("q3 ?? a");
  });
});

describe("saveGrade", () => {
  // A review holds its decks for the whole session; cards made from a note
  // meanwhile must survive the next grade's write.
  it("rewrites only the graded card, keeping cards added since the session read the deck", async () => {
    files.set("/v/cards/deck1.md", serializeDeck([card("q1"), card("q2")]));
    await addCards("/v", "deck1", [card("q3")]);
    const graded = gradeCard(card("q1"), 3, "2026-10-02");
    await saveGrade("/v", "/v/cards/deck1.md", graded);
    const md = files.get("/v/cards/deck1.md") ?? "";
    expect(md).toContain("q3 ?? a");
    expect(md).toContain("q2 ?? a");
    expect(md).toContain(`q1 ?? a\n<!--SR:!${graded.state?.due}|`);
  });

  it("leaves a card deleted from disk deleted", async () => {
    files.set("/v/cards/deck1.md", serializeDeck([card("q2")]));
    await saveGrade("/v", "/v/cards/deck1.md", gradeCard(card("q1"), 3, "2026-10-02"));
    expect(files.get("/v/cards/deck1.md")).not.toContain("q1");
  });
});

describe("addCards dedupe", () => {
  it("compares the normalised front: case, spacing and markup do not make a new card", async () => {
    files.set("/v/cards/deck1.md", serializeDeck([card("What is **Beam search**?")]));
    const { added } = await addCards("/v", "deck1", [
      card("what is  beam   SEARCH?"),
      card("What is greedy decoding?"),
    ]);
    expect(added).toBe(1);
  });
});

describe("summarizeDecks", () => {
  const oneDeck: FileNode[] = [{ kind: "directory", name: "cards", path: "/v/cards", children: [
    { kind: "file", name: "deck.md", path: "/v/cards/deck.md" },
  ] }];

  it("preserves the best-effort default but propagates unreadable decks for a strict UI scan", async () => {
    expect(await summarizeDecks(oneDeck, "2026-07-09")).toEqual([]);
    await expect(summarizeDecks(oneDeck, "2026-07-09", undefined, undefined, true)).rejects.toThrow("ENOENT");
  });

  it("distinguishes a failed grounding read from a missing source in a strict scan", async () => {
    files.set("/v/cards/deck.md", serializeDeck([{ ...card("q"), sourceRef: "[[note]]" }]));
    const readNote = () => Promise.reject(new Error("Synthetic source failure"));
    await expect(summarizeDecks(oneDeck, "2026-07-09", readNote, undefined, true)).rejects.toThrow("Synthetic source failure");
    expect((await summarizeDecks(oneDeck, "2026-07-09", () => Promise.resolve(null), undefined, true))[0].ungrounded).toBe(1);
  });

  it("counts total and due (new cards are always due)", async () => {
    await saveDeck("/v", "deck1", [card("q1"), card("q2")]);
    const tree: FileNode[] = [
      {
        kind: "directory",
        name: "cards",
        path: "/v/cards",
        children: [{ kind: "file", name: "deck1.md", path: "/v/cards/deck1.md" }],
      },
    ];
    const summaries = await summarizeDecks(tree, "2026-07-09");
    expect(summaries).toEqual([
      { name: "deck1", path: "/v/cards/deck1.md", total: 2, due: 2, ungrounded: 2 },
    ]);
  });

  it("counts the cards with no source note, or a back the note does not contain", async () => {
    const note = "# Beam\n\n**Beam search** keeps the few most likely partial sequences.\n";
    await saveDeck("/v", "beam", [
      { front: "q1", back: "keeps the few most likely partial sequences", sourceRef: "[[beam]]", state: null },
      { front: "q2", back: "A command-line tool for flashcards.", sourceRef: "[[beam]]", state: null },
      { front: "q3", back: "keeps the few", sourceRef: "[[gone]]", state: null },
      { front: "q4", back: "keeps the few", sourceRef: "[^src-1]", state: null },
      { front: "q5", back: "keeps the few", sourceRef: "", state: null },
    ]);
    const tree: FileNode[] = [
      {
        kind: "directory",
        name: "cards",
        path: "/v/cards",
        children: [{ kind: "file", name: "beam.md", path: "/v/cards/beam.md" }],
      },
    ];
    const reads: string[] = [];
    const readNote = (stem: string) => {
      reads.push(stem);
      return Promise.resolve(stem === "beam" ? note : null);
    };
    const [d] = await summarizeDecks(tree, "2026-07-09", readNote);
    expect(d.total).toBe(5);
    expect(d.ungrounded).toBe(4);
    // Each source note is read once per refresh, however many cards cite it.
    expect(reads).toEqual(["beam", "gone"]);
  });
});

describe("summarizeDecks, cards cited to a raw source", () => {
  it("grounds a [^src-*] card whose back a note citing that source quotes", async () => {
    const citing = "# Beam\n\n**Beam search** keeps the few most likely partial sequences.[^src-1]\n";
    await saveDeck("/v", "old", [
      { front: "q1", back: "keeps the few most likely partial sequences", sourceRef: "[^src-1]", state: null },
      { front: "q2", back: "A command-line tool for flashcards.", sourceRef: "[^src-1]", state: null },
      { front: "q3", back: "keeps the few", sourceRef: "[^src-2]", state: null },
    ]);
    const tree: FileNode[] = [
      {
        kind: "directory",
        name: "cards",
        path: "/v/cards",
        children: [{ kind: "file", name: "old.md", path: "/v/cards/old.md" }],
      },
    ];
    const asked: string[] = [];
    const readCiting = (ref: string) => {
      asked.push(ref);
      return Promise.resolve(ref === "[^src-1]" ? ["# Other\n\nNothing here.[^src-1]\n", citing] : []);
    };
    const [d] = await summarizeDecks(tree, "2026-07-09", undefined, readCiting);
    expect(d.ungrounded).toBe(2);
    // Each source is looked up once per refresh, however many cards cite it.
    expect(asked).toEqual(["[^src-1]", "[^src-2]"]);
  });
});

describe("summarizeDecks, notes named with wikilink syntax", () => {
  it("counts the note's own cards as grounded, new or reviewed", async () => {
    const md = "# T\n\nA lead paragraph with a **bold term** that is long enough.\n\n## Types\n\nThe section body sits under its heading here.\n";
    for (const stem of ["C# basics", "[논문] 트랜스포머", "Q|A"]) {
      files.clear();
      const cards = cardsFromNote(md, stem, STRINGS.en);
      // A review moves the source into the SR trailer, which splits on "|".
      cards[0] = gradeCard(cards[0], 3, "2026-07-09");
      await saveDeck("/v", "d", cards);
      const tree: FileNode[] = [
        {
          kind: "directory",
          name: "cards",
          path: "/v/cards",
          children: [{ kind: "file", name: "d.md", path: "/v/cards/d.md" }],
        },
      ];
      const readNote = (s: string) => Promise.resolve(s === stem ? md : null);
      const [d] = await summarizeDecks(tree, "2026-07-09", readNote);
      expect(d.total, stem).toBe(cards.length);
      expect(d.ungrounded, stem).toBe(0);
    }
  });
});

describe("countedDue", () => {
  it("drops a deck whose every card is ungrounded from the due counts", () => {
    const d = { name: "d", path: "/v/cards/d.md", total: 3, due: 3 };
    expect(countedDue({ ...d, ungrounded: 3 })).toBe(0);
    expect(countedDue({ ...d, ungrounded: 1 })).toBe(3);
    expect(countedDue({ ...d, ungrounded: 0 })).toBe(3);
  });
});

describe("loadCountedDecks", () => {
  it("loads every deck Home counts and leaves out an all-ungrounded one", async () => {
    await saveDeck("/v", "a", [card("qa")]);
    await saveDeck("/v", "junk", [card("qj")]);
    await saveDeck("/v", "later", [card("ql")]);
    const sum = (name: string, due: number, ungrounded: number) => ({
      name,
      path: `/v/cards/${name}.md`,
      total: 1,
      due,
      ungrounded,
    });
    // A deck with nothing due today still loads: it holds the next review.
    const loaded = await loadCountedDecks([
      sum("a", 1, 0),
      sum("junk", 0, 1),
      sum("later", 0, 0),
      sum("gone", 1, 0),
    ]);
    expect(loaded.map((d) => d.path)).toEqual(["/v/cards/a.md", "/v/cards/later.md"]);
    expect(loaded[0].cards.map((c) => c.front)).toEqual(["qa"]);
  });
});

describe("archiveDeck", () => {
  it("moves the deck into cards/archive/, creating the folder", async () => {
    const to = await archiveDeck("/v", "/v/cards/2026-07-12.md");
    expect(to).toBe("/v/cards/archive/2026-07-12.md");
    expect(calls).toEqual([
      ["createFolder", "/v/cards", "archive"],
      ["movePath", "/v/cards/2026-07-12.md", "/v/cards/archive"],
    ]);
  });
});

describe("Deck read failures, byte preservation and overlapping updates", () => {
  const path = "/v/cards/preserved.md";
  const prefix = "# Human study heading\r\n\r\n<!-- Keep this human comment exactly. -->\r\n\r\n";
  const existing = { ...card("existing question", "existing answer"), sourceRef: "[[synthetic-source]]" };
  const existingBlock = "existing question ?? existing answer\r\n<!--src:[[synthetic-source]]-->\r\n";
  const untouchedBlock = "keep   original spacing ?? keep   literal answer\r\n<!--src:[[untouched-source]]-->\r\n";
  const suffix = "\r\n## Human notes\r\n\r\n```custom-block\r\n{\"synthetic\":\"unknown block must survive\"}\r\n```\r\n<!-- Unknown trailer: preserve verbatim. -->\r\n";
  const original = prefix + existingBlock + "\r\n" + untouchedBlock + suffix;

  it("refuses an unreadable existing deck without treating it as a missing deck or overwriting it", async () => {
    files.set(path, original);
    vi.spyOn(ipc, "readFile").mockRejectedValueOnce(new Error("EACCES: synthetic unreadable deck"));
    const write = vi.spyOn(ipc, "writeFile");
    const result = await addCards("/v", "preserved", [card("incoming question")])
      .then(() => ({ rejected: false }), () => ({ rejected: true }));
    expect(result.rejected).toBe(true);
    expect(write).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(files.get(path)).toBe(original);
  });

  it("preserves existing human and unknown bytes and CRLF when appending cards", async () => {
    files.set(path, original);
    const result = await addCards("/v", "preserved", [card("incoming question", "incoming answer")]);
    const written = files.get(path) ?? "";
    expect(result).toEqual({ path, added: 1 });
    expect(written).toContain(prefix);
    expect(written).toContain(existingBlock);
    expect(written).toContain(untouchedBlock);
    expect(written).toContain(suffix);
    expect(written.replace(/\r\n/g, "")).not.toContain("\n");
    expect(parseDeck(written).map((entry) => entry.front)).toEqual([
      "existing question", "keep   original spacing", "incoming question",
    ]);
  });

  it("preserves all ungraded human and unknown bytes and CRLF while updating only the graded card", async () => {
    files.set(path, original);
    const graded = gradeCard(existing, 3, "2026-10-11");
    await saveGrade("/v", path, graded);
    const written = files.get(path) ?? "";
    expect(written).toContain(prefix);
    expect(written).toContain(untouchedBlock);
    expect(written).toContain(suffix);
    expect(written).toContain(serializeDeck([graded]).replace(/\n/g, "\r\n"));
    expect(written.replace(/\r\n/g, "")).not.toContain("\n");
    const parsed = parseDeck(written);
    expect(parsed).toHaveLength(2);
    // The documented deck format persists FSRS numeric fields to four decimals.
    expect(parsed.find((entry) => entry.front === existing.front)).toEqual(parseDeck(serializeDeck([graded]))[0]);
  });

  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((finish) => { resolve = finish; });
    return { promise, resolve };
  }

  function holdFirstWrite() {
    const entered = deferred();
    const release = deferred();
    const write = ipc.writeFile;
    let isFirst = true;
    vi.spyOn(ipc, "writeFile").mockImplementation(async (target, content) => {
      if (isFirst) {
        isFirst = false;
        entered.resolve();
        await release.promise;
      }
      return write(target, content);
    });
    return { entered: entered.promise, release: release.resolve };
  }

  it("retains both additions when a second add starts while the first deck write is pending", async () => {
    files.set(path, serializeDeck([existing]));
    const held = holdFirstWrite();
    const first = addCards("/v", "preserved", [card("first incoming")]);
    await held.entered;
    // The second operation starts before the first write reaches the backing
    // map. Releasing immediately also lets a future serialized writer proceed.
    const second = addCards("/v", "preserved", [card("second incoming")]);
    held.release();
    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.added)).toEqual([1, 1]);
    expect(parseDeck(files.get(path) ?? "").map((entry) => entry.front).sort()).toEqual([
      "existing question", "first incoming", "second incoming",
    ]);
  });

  it("retains the added card and grade when grading starts while an add write is pending", async () => {
    files.set(path, serializeDeck([existing]));
    const graded = gradeCard(existing, 3, "2026-10-11");
    const held = holdFirstWrite();
    const addition = addCards("/v", "preserved", [card("incoming during review")]);
    await held.entered;
    const grading = saveGrade("/v", path, graded);
    held.release();
    const [result] = await Promise.all([addition, grading]);
    expect(result.added).toBe(1);
    const parsed = parseDeck(files.get(path) ?? "");
    expect(parsed.map((entry) => entry.front).sort()).toEqual([
      "existing question", "incoming during review",
    ]);
    expect(parsed.find((entry) => entry.front === existing.front)).toEqual(parseDeck(serializeDeck([graded]))[0]);
  });
});

describe("Native Study deck snapshot and caller preconditions", () => {
  const path = "/v/cards/native.md";
  const original = { ...card("Synthetic question", "Synthetic answer"), sourceRef: "[[synthetic-source]]" };

  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((finish) => { resolve = finish; });
    return { promise, resolve };
  }

  it("uses the captured native snapshot and receipt without creating a generic folder", async () => {
    await addCards("/v", "native", [original]);
    const [read, write, discard] = nativeCalls;
    expect(read).toEqual(["read", path, activeOrigin]);
    expect(write[0]).toBe("write");
    expect(discard).toEqual(["discard", write[1]]);
    expect(calls).toEqual([]);
    expect(snapshots.size).toBe(0);
  });

  it("refuses to overwrite an existing file through saveDeck, including an empty existing deck", async () => {
    files.set(path, "");
    const write = vi.spyOn(ipc, "writeFile");
    await expect(saveDeck("/v", "native", [original])).rejects.toMatchObject({ code: "existing" });
    expect(files.get(path)).toBe("");
    expect(write).not.toHaveBeenCalled();
    expect(snapshots.size).toBe(0);
  });

  it("discards the exact snapshot after a duplicate addition without writing", async () => {
    const raw = "# Human heading\n\n" + serializeDeck([original]);
    files.set(path, raw);
    const write = vi.spyOn(ipc, "writeFile");
    expect(await addCards("/v", "native", [original])).toEqual({ path, added: 0 });
    expect(nativeCalls.map((call) => call[0])).toEqual(["read", "discard"]);
    expect(write).not.toHaveBeenCalled();
    expect(files.get(path)).toBe(raw);
    expect(snapshots.size).toBe(0);
  });

  it("returns false and does not recreate a deleted reviewed card", async () => {
    files.set(path, "# Only a human heading remains\n");
    const write = vi.spyOn(ipc, "writeFile");
    expect(await saveGrade("/v", path, gradeCard(original, 3, "2026-10-11"), original)).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(nativeCalls.map((call) => call[0])).toEqual(["read", "discard"]);
    expect(snapshots.size).toBe(0);
  });

  it.each([
    { ...original, back: "Human changed answer" },
    { ...original, sourceRef: "[[human-changed-source]]" },
    gradeCard(original, 1, "2026-10-10"),
  ])("does not save a grade over a changed source card: %j", async (changed) => {
    const raw = serializeDeck([changed]);
    files.set(path, raw);
    const write = vi.spyOn(ipc, "writeFile");
    await expect(saveGrade("/v", path, gradeCard(original, 3, "2026-10-11"), original)).rejects.toThrow("changed");
    expect(write).not.toHaveBeenCalled();
    expect(files.get(path)).toBe(raw);
    expect(snapshots.size).toBe(0);
  });

  it("reads only real card blocks and leaves fenced, frontmatter and human comment examples out of the review deck", async () => {
    files.set(path, "---\nexample: Example question ?? Example answer\n---\n" +
      "```markdown\nExample question ?? Example answer\n```\n" +
      "<!--\nComment question ?? Comment answer\n-->\n" + serializeDeck([original]));
    expect(await loadDeck(path)).toEqual([original]);
  });

  it("refuses a captured opening belonging to another vault without reading or writing", async () => {
    activeOrigin = { vaultPath: "/other-vault", openingToken: "synthetic-other-opening" };
    const read = vi.spyOn(ipc, "readFile");
    const write = vi.spyOn(ipc, "writeFile");
    await expect(addCards("/v", "native", [original])).rejects.toMatchObject({ code: "origin" });
    expect(nativeCalls).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("does not fall back to generic deck IO when the native snapshot command is unavailable", async () => {
    vi.spyOn(ipc, "readStudyDeck").mockRejectedValueOnce(new Error("Synthetic native capability unavailable"));
    const read = vi.spyOn(ipc, "readFile");
    const write = vi.spyOn(ipc, "writeFile");
    await expect(addCards("/v", "native", [original])).rejects.toMatchObject({ code: "read" });
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("never recaptures the opening of a queued mutation after the previous mutation completes", async () => {
    const entered = deferred();
    const release = deferred();
    const discard = ipc.discardStudyDeckSnapshot;
    vi.spyOn(ipc, "discardStudyDeckSnapshot").mockImplementationOnce(async (context) => {
      entered.resolve();
      await release.promise;
      return discard(context);
    });
    const first = addCards("/v", "native", [original]);
    await entered.promise;
    const capture = vi.spyOn(ipc, "agentVaultSession");
    const second = addCards("/v", "native", [card("Queued under old opening")]);
    const secondOutcome = second.catch((error: unknown) => error);
    await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());
    activeOrigin = { ...activeOrigin, openingToken: "synthetic-reopened-study" };
    release.resolve();
    await first;
    expect(await secondOutcome).toBeInstanceOf(StudyDeckError);
    expect(await secondOutcome).toMatchObject({ code: "read" });
    expect(capture).toHaveBeenCalledOnce();
    expect(nativeCalls.filter((call) => call[0] === "read").map((call) => call[2])).toEqual([
      { vaultPath: "/v", openingToken: "synthetic-study-opening" },
      { vaultPath: "/v", openingToken: "synthetic-study-opening" },
    ]);
    expect(nativeCalls.filter((call) => call[0] === "write")).toHaveLength(1);
    expect(files.get(path)).not.toContain("Queued under old opening");
    await addCards("/v", "native", [card("New opening card")]);
    expect(files.get(path)).toContain("New opening card");
  });

  it("does not claim a partial publication as an addition success and preserves the retained file", async () => {
    const write = ipc.writeStudyDeck;
    vi.spyOn(ipc, "writeStudyDeck").mockImplementationOnce(async (context, content) => ({
      ...await write(context, content), state: "partial" as const, revision: null, error: "Synthetic receipt incomplete",
    }));
    const genericWrite = vi.spyOn(ipc, "writeFile");
    await expect(addCards("/v", "native", [original])).rejects.toMatchObject({ code: "partial" });
    expect(files.get(path)).toContain(original.front);
    expect(genericWrite).toHaveBeenCalledOnce();
    expect(snapshots.size).toBe(0);
  });

  it.each(["path", "origin", "revision"] as const)("refuses a persisted receipt with mismatched %s", async (field) => {
    const write = ipc.writeStudyDeck;
    vi.spyOn(ipc, "writeStudyDeck").mockImplementationOnce(async (context, content) => {
      const receipt = await write(context, content);
      if (field === "path") return { ...receipt, path: "/other/cards/native.md" };
      if (field === "origin") return { ...receipt, origin: { ...receipt.origin, openingToken: "different" } };
      return { ...receipt, revision: "not-a-revision" };
    });
    await expect(addCards("/v", "native", [original])).rejects.toMatchObject({ code: "snapshot" });
    expect(snapshots.size).toBe(0);
  });

  it("cleans up a known malformed snapshot rather than treating its nonempty raw as true absence", async () => {
    files.set(path, serializeDeck([original]));
    const read = ipc.readStudyDeck;
    vi.spyOn(ipc, "readStudyDeck").mockImplementationOnce(async (target, origin) => ({
      ...await read(target, origin), revision: null,
    }));
    const write = vi.spyOn(ipc, "writeFile");
    await expect(addCards("/v", "native", [card("Incoming")])).rejects.toMatchObject({ code: "snapshot" });
    expect(write).not.toHaveBeenCalled();
    expect(snapshots.size).toBe(0);
  });

  it("reports snapshot cleanup failure after a no-op without exposing its private error detail", async () => {
    files.set(path, serializeDeck([original]));
    vi.spyOn(ipc, "discardStudyDeckSnapshot").mockRejectedValueOnce(new Error("Synthetic private cleanup detail"));
    const error = await addCards("/v", "native", [original]).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "cleanup" });
    expect(String(error)).not.toContain("Synthetic private");
    expect(logWarn).toHaveBeenCalledWith("study.deck_snapshot_cleanup_unconfirmed");
  });

  it("preserves the write failure if exact snapshot cleanup also fails", async () => {
    vi.spyOn(ipc, "writeStudyDeck").mockRejectedValueOnce(new Error("Synthetic private write detail"));
    vi.spyOn(ipc, "discardStudyDeckSnapshot").mockRejectedValueOnce(new Error("Synthetic private cleanup detail"));
    const error = await addCards("/v", "native", [original]).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "write" });
    expect(String(error)).not.toContain("Synthetic private");
    expect(logWarn).toHaveBeenCalledWith("study.deck_snapshot_cleanup_unconfirmed");
  });

  it("allows an idempotent false discard acknowledgement for an already removed snapshot", async () => {
    files.set(path, serializeDeck([original]));
    vi.spyOn(ipc, "discardStudyDeckSnapshot").mockImplementationOnce((context) => {
      snapshots.delete(context.snapshotId);
      return Promise.resolve(false);
    });
    expect(await addCards("/v", "native", [original])).toEqual({ path, added: 0 });
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("releases the per-deck queue after a failure so the next captured mutation can save", async () => {
    vi.spyOn(ipc, "writeStudyDeck").mockRejectedValueOnce(new Error("Synthetic first write refusal"));
    const first = addCards("/v", "native", [card("Refused first card")]);
    const firstOutcome = first.catch((failure: unknown) => failure);
    const second = addCards("/v", "native", [original]);
    expect(await firstOutcome).toMatchObject({ code: "write" });
    expect(await second).toEqual({ path, added: 1 });
    expect(readDeckFronts()).toEqual([original.front]);
    expect(snapshots.size).toBe(0);
  });

  function readDeckFronts(): string[] {
    return parseDeck(files.get(path) ?? "").map((entry) => entry.front);
  }
});
