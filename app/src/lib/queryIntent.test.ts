import { describe, expect, it } from "vitest";
import {
  isActivityQuery,
  formatActivityAnswer,
  formatRecentFilesAnswer,
} from "./queryIntent";
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

describe("formatRecentFilesAnswer — answers from file metadata, not page content", () => {
  // Timestamps are built in LOCAL time so these hold in any timezone: the
  // answer's "today"/"yesterday" is the user's calendar day, not UTC's.
  const secs = (d: Date): number => Math.floor(d.getTime() / 1000);
  const NOW = new Date(2026, 7, 4, 9, 0).getTime(); // 2026-08-04 09:00 local

  it("lists newest first as working wikilinks, older ones by date", () => {
    const out = formatRecentFilesAnswer(
      [
        ["/v/wiki/older.md", secs(new Date(2026, 6, 30, 10, 0))],
        ["/v/wiki/newest.md", secs(new Date(2026, 7, 4, 8, 0))],
      ],
      "en",
      NOW,
    );
    expect(out.indexOf("[[newest]]")).toBeLessThan(out.indexOf("[[older]]"));
    expect(out).toContain("2026-07-30");
  });

  it("says today/yesterday by CALENDAR day, not elapsed hours", () => {
    // 23:30 the previous local day is "yesterday" even though it is barely an
    // hour ago — an elapsed-hours bucket would call it "today".
    const out = formatRecentFilesAnswer(
      [["/v/wiki/late.md", secs(new Date(2026, 7, 3, 23, 30))]],
      "en",
      new Date(2026, 7, 4, 0, 30).getTime(),
    );
    expect(out).toMatch(/yesterday/);
  });

  it("dates older files in the user's timezone, not UTC", () => {
    // A file written late on the 30th local time must not read as the 29th
    // just because UTC had not rolled over yet.
    const out = formatRecentFilesAnswer(
      [["/v/wiki/late.md", secs(new Date(2026, 6, 30, 23, 30))]],
      "en",
      NOW,
    );
    expect(out).toContain("2026-07-30");
  });

  it("honours the caller's language", () => {
    const out = formatRecentFilesAnswer(
      [["/v/wiki/a.md", secs(new Date(2026, 7, 4, 8, 0))]],
      "ko",
      NOW,
    );
    expect(out).toContain("최근에 바뀐 노트");
    expect(out).toContain("오늘");
  });

  it("says so plainly when the vault has no markdown at all", () => {
    expect(formatRecentFilesAnswer([], "ko", NOW)).toContain("아직 마크다운 파일이 없습니다");
  });

  it("caps the list so a big vault does not dump every file", () => {
    const many: [string, number][] = Array.from({ length: 40 }, (_, i) => [
      `/v/wiki/p${i}.md`,
      secs(new Date(2026, 7, 4, 8, 0)) - i,
    ]);
    const rows = formatRecentFilesAnswer(many, "en", NOW).split("\n").filter((l) => l.startsWith("- "));
    expect(rows).toHaveLength(15);
  });
});
