import { describe, expect, it, vi, beforeEach } from "vitest";
import type { FileNode } from "./ipc";
import { serializeDeck, type Card } from "./cards";

// In-memory fake of the vault IPC surface cardStore touches.
const files = new Map<string, string>();
vi.mock("./ipc", () => ({
  ipc: {
    readFile: (path: string) => {
      if (!files.has(path)) return Promise.reject(new Error("ENOENT"));
      return Promise.resolve({ path, raw: files.get(path), content: "", frontmatter: null });
    },
    writeFile: (path: string, content: string) => {
      files.set(path, content);
      return Promise.resolve(null);
    },
    createFolder: () => Promise.resolve("cards"),
  },
}));

import {
  addCards,
  deckFiles,
  deckNameFromPath,
  deckSlug,
  saveDeck,
  summarizeDecks,
} from "./cardStore";

beforeEach(() => files.clear());

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

describe("summarizeDecks", () => {
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
      { name: "deck1", path: "/v/cards/deck1.md", total: 2, due: 2 },
    ]);
  });
});
