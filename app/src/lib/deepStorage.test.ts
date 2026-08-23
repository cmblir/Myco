import { describe, expect, it } from "vitest";
import { pickDeepStorage } from "./deepStorage";
import type { ScoredChunk } from "./ipc";

const chunk = (over: Partial<ScoredChunk> = {}): ScoredChunk => ({
  page: "sessions/2026-08-01.md",
  stem: "2026-08-01",
  section: 0,
  text: "session notes",
  score: 0.9,
  similarity: 0.7,
  ...over,
});

const none = new Set<string>();

describe("pickDeepStorage", () => {
  it("picks the cold-tier hit even when a wiki hit has higher similarity", () => {
    const pick = pickDeepStorage(
      [
        chunk({ page: "wiki/bpe.md", stem: "bpe", similarity: 0.9 }),
        chunk({ similarity: 0.7 }),
      ],
      none,
    );
    expect(pick).toEqual({
      page: "sessions/2026-08-01.md",
      stem: "2026-08-01",
      similarity: 0.7,
    });
  });

  it("keeps the highest-similarity cold hit among several", () => {
    const pick = pickDeepStorage(
      [
        chunk({ similarity: 0.6 }),
        chunk({ page: "raw/paper.md", stem: "paper", similarity: 0.8 }),
      ],
      none,
    );
    expect(pick?.page).toBe("raw/paper.md");
  });

  it("excludes pages the answer already cites", () => {
    const cited = new Set(["sessions/2026-08-01.md"]);
    expect(pickDeepStorage([chunk({})], cited)).toBeNull();
  });

  it("returns null when nothing clears the similarity floor", () => {
    expect(pickDeepStorage([chunk({ similarity: 0.54 })], none)).toBeNull();
  });

  it("skips lexical-only hits with no similarity", () => {
    expect(pickDeepStorage([chunk({ similarity: null })], none)).toBeNull();
  });
});
