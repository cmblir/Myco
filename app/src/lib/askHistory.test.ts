import { describe, expect, it } from "vitest";
import { askedAgo, matchHistory, extractWikilinks } from "./askHistory";
import type { AskRecord } from "./ipc";

const rec = (q: string, at: number, extra: Partial<AskRecord> = {}): AskRecord => ({
  at,
  q,
  a: "",
  cited: [],
  ...extra,
});

describe("matchHistory (the 기록 search)", () => {
  const log = [
    rec("트랜스포머 어텐션이 뭐야", 1, { a: "> 쿼리와 키의 내적", cited: ["attention-mechanism"] }),
    rec("주말 등산 코스", 2, { abstained: true }),
    rec("What is RLHF", 3, { a: "**[[rlhf]]**\n\n> reward model", cited: ["rlhf"] }),
  ];

  it("lists newest first when the field is empty", () => {
    expect(matchHistory(log, "  ").map((r) => r.at)).toEqual([3, 2, 1]);
  });

  it("matches every word against the question, the answer and the cited notes", () => {
    expect(matchHistory(log, "어텐션").map((r) => r.at)).toEqual([1]);
    expect(matchHistory(log, "내적").map((r) => r.at)).toEqual([1]);
    expect(matchHistory(log, "attention-mechanism").map((r) => r.at)).toEqual([1]);
    expect(matchHistory(log, "rlhf REWARD").map((r) => r.at)).toEqual([3]);
    expect(matchHistory(log, "rlhf 등산")).toEqual([]);
  });
});

describe("askedAgo", () => {
  const now = Date.UTC(2026, 9, 2, 12, 0, 0);

  it("says when in the reader's language, through Intl", () => {
    expect(askedAgo(now - 3 * 60_000, now, "ko")).toBe("3분 전");
    expect(askedAgo(now - 3 * 60_000, now, "en")).toBe("3 minutes ago");
    expect(askedAgo(now - 2 * 3_600_000, now, "ja")).toBe("2 時間前");
    expect(askedAgo(now - 86_400_000, now, "ko")).toBe("어제");
  });

  it("calls the last minute now", () => {
    expect(askedAgo(now - 20_000, now, "ko")).toBe("지금");
    expect(askedAgo(now + 5_000, now, "en")).toBe("now");
  });
});

describe("extractWikilinks", () => {
  it("keeps each [[target]] once, alias and order kept apart", () => {
    expect(extractWikilinks("[[a]] then [[B|bee]] and [[a]] and [[b]]")).toEqual(["a", "B"]);
  });
});
