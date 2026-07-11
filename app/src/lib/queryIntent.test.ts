import { describe, expect, it } from "vitest";
import { isActivityQuery, formatActivityAnswer } from "./queryIntent";
import type { GitCommit } from "./ipc";

describe("isActivityQuery — matches vault-activity/meta questions", () => {
  it("matches the reported bug phrasings", () => {
    expect(isActivityQuery("최근에 내가 한 일이 뭐야?")).toBe(true);
    expect(isActivityQuery("내가 최근에 한 일이 뭐야")).toBe(true);
    expect(isActivityQuery("what did I do recently?")).toBe(true);
    expect(isActivityQuery("what have I been working on")).toBe(true);
    expect(isActivityQuery("what changed recently")).toBe(true);
    expect(isActivityQuery("edit history")).toBe(true);
    expect(isActivityQuery("변경 내역 보여줘")).toBe(true);
    expect(isActivityQuery("最近何をした？")).toBe(true);
    expect(isActivityQuery("変更履歴")).toBe(true);
  });

  it("does NOT match topic queries that merely mention 'recent'", () => {
    expect(isActivityQuery("recent advances in transformers")).toBe(false);
    expect(isActivityQuery("최근 트랜스포머 연구 동향")).toBe(false);
    expect(isActivityQuery("what is attention?")).toBe(false);
    expect(isActivityQuery("어텐션이 뭐야?")).toBe(false);
    expect(isActivityQuery("summarize the scaling laws page")).toBe(false);
    expect(isActivityQuery("")).toBe(false);
  });
});

describe("formatActivityAnswer", () => {
  const commits: GitCommit[] = [
    { hash: "a1", date: "2026-07-10", subject: "ingest: transformers", created: 42, modified: 6 },
    { hash: "b2", date: "2026-07-09", subject: "fix: citations", created: 3, modified: 1 },
  ];
  it("renders a factual bullet list with dates + subjects (Korean)", () => {
    const md = formatActivityAnswer(commits, "ko");
    expect(md).toContain("git 기록");
    expect(md).toContain("2026-07-10");
    expect(md).toContain("ingest: transformers");
    expect(md).toContain("+42/~6");
  });
  it("falls back to an empty-history message", () => {
    expect(formatActivityAnswer([], "en")).toMatch(/No git history/);
    expect(formatActivityAnswer([], "ko")).toMatch(/git 기록이 없습니다/);
  });
  it("unknown lang falls back to English header", () => {
    // @ts-expect-error testing a lang outside the union
    expect(formatActivityAnswer(commits, "de")).toContain("recent vault activity");
  });
});
