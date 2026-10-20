import { describe, expect, it, vi } from "vitest";
import type { Adjacency } from "./ipc";
import {
  acceptAll,
  acceptSuggestion,
  appendWikilink,
  loadDismissed,
  pairKey,
  pendingLinkCount,
  suggestLinks,
  saveDismissed,
  suggestionRelativePath,
  type LinkSuggestion,
} from "./linkSuggestions";

const A = "/v/alpha.md";
const B = "/v/beta.md";
const C = "/v/gamma.md";

const adj: Adjacency = {
  forward: { [A]: [B] },
  backward: { [B]: [A] },
  unresolved: {},
  tags: {},
};

describe("suggestLinks", () => {
  it("keeps only unlinked, non-dismissed pairs, ranked by score", () => {
    const out = suggestLinks(
      adj,
      [
        { source: A, target: B, score: 0.95 }, // already linked → dropped
        { source: A, target: C, score: 0.7 },
        { source: C, target: A, score: 0.6 }, // duplicate pair → deduped
        { source: B, target: C, score: 0.8 },
      ],
      new Set(),
    );
    expect(out.map((s) => s.key)).toEqual([pairKey(B, C), pairKey(A, C)]);
    expect(out[0].score).toBeCloseTo(0.8);
  });

  it("honors dismissals and the max cap", () => {
    const dismissed = new Set([pairKey(B, C)]);
    const out = suggestLinks(
      adj,
      [
        { source: B, target: C, score: 0.9 },
        { source: A, target: C, score: 0.7 },
      ],
      dismissed,
      1,
    );
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe(pairKey(A, C));
  });

  it("reuses a full immutable snapshot and invalidates on a dismissal", () => {
    const empty: Adjacency = { forward: {}, backward: {}, unresolved: {}, tags: {} };
    const sem = [{ source: A, target: C, score: 0.9 }];
    const dismissed = new Set<string>();
    const first = suggestLinks(empty, sem, dismissed, Infinity);
    expect(suggestLinks(empty, sem, dismissed, Infinity)).toBe(first);
    expect(suggestLinks(empty, sem, new Set([pairKey(A, C)]), Infinity)).toHaveLength(0);
  });
});

describe("pendingLinkCount", () => {
  it("counts every pending pair, uncapped, minus linked and dismissed", () => {
    // 15 novel pairs against an empty adjacency — past suggestLinks' display
    // default of 12, which the count must ignore.
    const empty: Adjacency = { forward: {}, backward: {}, unresolved: {}, tags: {} };
    const sem = Array.from({ length: 15 }, (_, i) => ({
      source: `/v/a${i}.md`,
      target: `/v/b${i}.md`,
      score: 0.9,
    }));
    expect(pendingLinkCount(empty, sem, new Set())).toBe(15);
    // linked and dismissed pairs leave the count
    expect(
      pendingLinkCount(adj, [{ source: A, target: B, score: 0.95 }], new Set()),
    ).toBe(0);
    expect(
      pendingLinkCount(
        empty,
        [{ source: A, target: C, score: 0.7 }],
        new Set([pairKey(A, C)]),
      ),
    ).toBe(0);
  });
});

describe("appendWikilink", () => {
  it("creates a Related section when absent", () => {
    const out = appendWikilink("# Alpha\n\nBody.\n", "/v/beta.md");
    expect(out).toContain("## Related");
    expect(out).toContain("- [[beta]]");
  });

  it("appends under an existing Related section", () => {
    const src = "# Alpha\n\n## Related\n\n- [[gamma]]\n";
    const out = appendWikilink(src, "/v/beta.md");
    expect(out.indexOf("- [[beta]]")).toBeGreaterThan(out.indexOf("## Related"));
    expect(out).toContain("- [[gamma]]");
    // only one Related section
    expect(out.match(/## Related/g)).toHaveLength(1);
  });

  it("is a no-op when the link already exists", () => {
    const src = "# Alpha\n\nSee [[beta]].\n";
    expect(appendWikilink(src, "/v/beta.md")).toBe(src);
  });

  it("recognizes aliases and uses exact paths for duplicate filenames", () => {
    expect(appendWikilink("See [[beta|a label]].", "/v/beta.md")).toBe("See [[beta|a label]].");
    const src = "See [[wiki/one/beta|a label]].";
    const next = appendWikilink(src, "/v/wiki/two/beta.md", "/v");
    expect(next).toContain("[[wiki/two/beta|beta]]");
    expect(appendWikilink(next, "/v/wiki/two/beta.md", "/v")).toBe(next);
    const unicode = "See [[wiki/café|café]].";
    expect(appendWikilink(unicode, "/v/wiki/café.md", "/v")).toBe(unicode);
  });

  it("accepts native Windows separators and rejects raw case variants", () => {
    expect(suggestionRelativePath("C:\\vault\\wiki\\beta.md", "C:\\vault")).toBe("wiki/beta.md");
    expect(() => suggestionRelativePath("C:\\vault\\Raw\\source.md", "C:\\vault")).toThrow("not link suggestions");
  });
});

describe("acceptAll", () => {
  const mk = (n: number): LinkSuggestion[] =>
    Array.from({ length: n }, (_, i) => ({
      source: `/v/s${i}.md`,
      target: `/v/t${i}.md`,
      score: 1,
      key: `k${i}`,
    }));

  it("accepts every suggestion via one accept call each", async () => {
    const suggestions = mk(3);
    const readFile = vi.fn().mockResolvedValue({ raw: "# doc\n" });
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const onProgress = vi.fn();

    const result = await acceptAll(suggestions, { readFile, writeFile }, onProgress);

    expect(readFile).toHaveBeenCalledTimes(3);
    expect(writeFile).toHaveBeenCalledTimes(3);
    expect(result.accepted).toEqual(suggestions);
    expect(result.remaining).toEqual([]);
    expect(result.error).toBeNull();
    expect(onProgress).toHaveBeenLastCalledWith(3, 3);
  });

  it("stops at the first failure and leaves the rest as remaining", async () => {
    const suggestions = mk(4);
    const readFile = vi
      .fn()
      .mockResolvedValueOnce({ raw: "# a\n" })
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValue({ raw: "# unreached\n" });
    const writeFile = vi.fn().mockResolvedValue(undefined);

    const result = await acceptAll(suggestions, { readFile, writeFile });

    expect(result.accepted).toEqual([suggestions[0]]);
    expect(result.remaining).toEqual(suggestions.slice(1));
    expect(result.error).toBe("Error: disk full");
    // the third and fourth suggestion were never attempted
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it("reads and writes a shared source once for the whole batch", async () => {
    const suggestions = mk(100).map((s) => ({ ...s, source: A }));
    const readFile = vi.fn().mockResolvedValue({ raw: "# doc\n" });
    const writeFile = vi.fn().mockResolvedValue(null);
    const result = await acceptAll(suggestions, { readFile, writeFile });
    expect(result.accepted).toHaveLength(100);
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0][1]).toContain("[[t99]]");
  });

  it("rebuilds the append after a concurrent-write conflict", async () => {
    const readFile = vi.fn().mockResolvedValueOnce({ raw: "# original\n" })
      .mockResolvedValueOnce({ raw: "# original\n\nConcurrent edit.\n" });
    const writeFile = vi.fn().mockResolvedValue(null);
    const writeFileIfUnchanged = vi.fn().mockRejectedValueOnce(new Error("write conflict: changed"))
      .mockResolvedValue(null);
    await acceptSuggestion(mk(1)[0], { readFile, writeFile, writeFileIfUnchanged });
    expect(writeFile).not.toHaveBeenCalled();
    expect(writeFileIfUnchanged).toHaveBeenCalledTimes(2);
    expect(writeFileIfUnchanged.mock.calls[1][1]).toContain("Concurrent edit.");
    expect(writeFileIfUnchanged.mock.calls[1][2]).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps every pair for a failed shared-source group pending", async () => {
    const suggestions = mk(4).map((s, i) => ({ ...s, source: i === 3 ? B : A }));
    const readFile = vi.fn().mockResolvedValue({ raw: "# doc\n" });
    const writeFile = vi.fn().mockRejectedValue(new Error("disk full"));
    const result = await acceptAll(suggestions, { readFile, writeFile });
    expect(result.accepted).toEqual([]);
    expect(result.remaining).toEqual(suggestions);
    expect(readFile).toHaveBeenCalledTimes(1);
  });
});

describe("dismissal persistence", () => {
  it("retains a 28,189-pair dismissal across a reload without truncation", () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    const dismissed = new Set(Array.from({ length: 28_189 }, (_, i) => pairKey(
      `/synthetic-vault/wiki/p${Math.floor(i / 4)}.md`,
      `/synthetic-vault/wiki/p${(Math.floor(i / 4) + i % 4 + 1) % 8_000}.md`,
    )));
    saveDismissed(dismissed);
    const restored = loadDismissed();
    expect(restored.size).toBe(dismissed.size);
    expect([...dismissed].every((key) => restored.has(key))).toBe(true);
    vi.unstubAllGlobals();
  });
});
