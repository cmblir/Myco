import { describe, expect, it } from "vitest";
import {
  isActivityQuery,
  isVaultFilesQuery,
  formatActivityAnswer,
  formatRecentFilesAnswer,
} from "./queryIntent";
import type { GitCommit } from "./ipc";
import { queryDateRange } from "./timeQuery";

describe("isVaultFilesQuery — explicit metadata evidence only", () => {
  it.each([
    "어제 수정한 파일", "오늘 추가된 노트", "최근에 만든 파일 목록",
    "노트 변경 내역", "어제 작성한 md 파일", "git commit history",
    "what files did I add yesterday", "which notes changed today",
    "show me my newest notes", "最近追加したファイル", "ノートの変更履歴",
  ])("allows metadata for %s", (q) => expect(isVaultFilesQuery(q)).toBe(true));

  it.each([
    "어제한 일", "오늘 뭐했지", "what did I do yesterday",
    "파일 시스템은 어떻게 작동해?", "recent advances in transformers",
    "서로 연결되는 아이디어가 있어?",
  ])("does not infer file metadata from %s", (q) => expect(isVaultFilesQuery(q)).toBe(false));
});

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

  it("filters the requested local day before the display cap", () => {
    const entries: [string, number][] = Array.from({ length: 16 }, (_, i) => [
      `/v/wiki/today-${i}.md`, secs(new Date(2026, 7, 4, 8, 0)),
    ]);
    entries.push(["/v/wiki/yesterday.md", secs(new Date(2026, 7, 3, 23, 30))]);
    const out = formatRecentFilesAnswer(entries, "ko", NOW, 1, {
      range: { start: "2026-08-03", end: "2026-08-03" }, vaultRoot: "/v",
    });
    expect(out).toContain("2026-08-03");
    expect(out).toContain("**어제**");
    expect(out).toContain("[[wiki/yesterday|yesterday]]");
    expect(out).not.toContain("today-");
    expect(out).not.toContain("**오늘**");
  });

  it("keeps each different path with the same basename and skips outside roots", () => {
    const out = formatRecentFilesAnswer([
      ["/v/wiki/a/shared.md", NOW / 1000], ["/v/wiki/b/shared.md", NOW / 1000],
      ["/vault-other/shared.md", NOW / 1000], ["/v/../outside.md", NOW / 1000],
    ], "en", NOW, 15, { vaultRoot: "/v/" });
    expect(out).toContain("[[wiki/a/shared|shared]]");
    expect(out).toContain("[[wiki/b/shared|shared]]");
    expect(out).not.toContain("[[shared]]");
    expect(out).not.toContain("vault-other");
    expect(out).not.toContain("outside");
    expect(out.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(2);
  });

  it("honors wiki, sessions and pages scope without hiding distinct eligible sources", () => {
    const entries: [string, number][] = ["wiki/a.md", "wiki/maps/a.md", "daily/2026-08-04.md", "sessions/2026-08/a.md", "raw/conversations/codex/a.md", "raw/other.md"]
      .map((path) => [`/v/${path}`, NOW / 1000]);
    const scoped = (scope: "wiki" | "sessions" | "all" | "pages") => formatRecentFilesAnswer(entries, "en", NOW, 15, { vaultRoot: "/v", scope });
    expect(scoped("wiki")).toContain("daily/2026-08-04");
    expect(scoped("wiki")).not.toContain("sessions/");
    expect(scoped("wiki")).not.toContain("raw/");
    expect(scoped("sessions").split("\n").filter((line) => line.startsWith("- "))).toHaveLength(1);
    expect(scoped("sessions")).toContain("sessions/2026-08/a");
    expect(scoped("pages")).toContain("wiki/maps/a");
    expect(scoped("pages")).not.toContain("daily/");
    expect(scoped("all")).toContain("raw/conversations/codex/a");
    expect(scoped("all")).not.toContain("raw/other");
  });

  it.each(["ko", "en", "ja"] as const)("uses honest localized range-empty copy (%s)", (lang) => {
    const out = formatRecentFilesAnswer([["/v/wiki/a.md", NOW / 1000]], lang, NOW, 15, {
      range: { start: "2026-08-03", end: "2026-08-03" }, vaultRoot: "/v",
    });
    expect(out).toContain("2026-08-03");
    expect(out).not.toContain("[[");
    expect(out).toMatch(/없습니다|No markdown files were modified|変更されたマークダウンファイルはありません/);
  });

  it("uses local next-midnight bounds across both DST transitions", () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      for (const [day, hours] of [["2026-03-08", 23], ["2026-11-01", 25]] as const) {
        const range = queryDateRange({ start: day, end: day });
        expect(range.endEpoch - range.startEpoch).toBe(hours * 3600);
        const out = formatRecentFilesAnswer([
          ["/v/wiki/start.md", range.startEpoch], ["/v/wiki/last.md", range.endEpoch - 1],
          ["/v/wiki/before.md", range.startEpoch - 1], ["/v/wiki/next.md", range.endEpoch],
        ], "en", range.endEpoch * 1000, 15, { range, vaultRoot: "/v" });
        expect(out).toContain("[[wiki/start|start]]");
        expect(out).toContain("[[wiki/last|last]]");
        expect(out).not.toContain("before");
        expect(out).not.toContain("next");
        expect(out.match(/\*\*yesterday\*\*/g)).toHaveLength(2);
      }
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
  });

  it("does not label a future date as today or an unknown mtime as an event", () => {
    const out = formatRecentFilesAnswer([
      ["/v/wiki/future.md", secs(new Date(2026, 7, 5, 8, 0))],
      ["/v/wiki/unknown.md", 0], ["/v/wiki/invalid.md", Number.NaN],
    ], "en", NOW, 15, { vaultRoot: "/v" });
    expect(out).toContain("**2026-08-05**");
    expect(out).not.toContain("**today**");
    expect(out).not.toContain("unknown");
    expect(out).not.toContain("invalid");
  });

  it("requires a captured root before applying source scope to absolute entries", () => {
    expect(() => formatRecentFilesAnswer([["/v/sessions/2026-08/a.md", NOW / 1000]], "en", NOW, 15, { scope: "wiki" }))
      .toThrow("vaultRoot is required for scoped recent files");
  });
});
