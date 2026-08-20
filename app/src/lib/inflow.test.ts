// inflowLines is the single builder behind every inflow surface (popover
// section, tray panel section, native menu summary) — null means "hide the
// whole section", which is why the all-zeros case matters most here.

import { describe, expect, it } from "vitest";
import { inboxSourceSub, inflowLines } from "./inflow";
import type { InflowStats } from "./ipc";
import { STRINGS } from "./i18n";

const stats = (over: Partial<InflowStats> = {}): InflowStats => ({
  sessionsToday: 2,
  inboxToday: 3,
  inboxBySource: { clipper: 2, unknown: 1 },
  mcpCallsToday: 7,
  mcpTopTool: "search",
  hourlyFiles: Array(24).fill(0),
  hourlyMcp: Array(24).fill(0),
  ...over,
});

describe("inflowLines", () => {
  it("renders every line from a stats fixture, counts split out", () => {
    const lines = inflowLines(stats(), STRINGS.en);
    expect(lines).toEqual({
      header: "Today's inflow",
      sessions: "Sessions swept",
      sessionsSub: "",
      sessionsCount: "+2",
      mcp: "MCP tool calls",
      mcpSub: "top: search · since app launch",
      mcpCount: "7",
      inbox: "_inbox arrivals",
      inboxSub: "clipper 2 · unknown 1",
      inboxCount: "+3",
      inboxView: "View →",
      sparkCaption: "Last 24h · purple = sessions/inbox · blue = MCP calls",
      summary: "Today: sessions +2 · MCP 7 · inbox +3",
    });
  });

  it("builds the sessions sub from last sweep time and auto interval", () => {
    const sweepAt = new Date(2026, 7, 19, 12, 40).getTime();
    const lines = inflowLines(stats(), STRINGS.en, {
      sweepAt,
      autoImportMin: 30,
    });
    const t = new Date(sweepAt).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    expect(lines?.sessionsSub).toBe(`last sweep ${t} · auto 30 min`);
  });

  it("drops the auto hint when auto-import is off", () => {
    const lines = inflowLines(stats(), STRINGS.en, {
      sweepAt: null,
      autoImportMin: null,
    });
    expect(lines?.sessionsSub).toBe("");
  });

  it("renders zeros instead of hiding when nothing arrived today", () => {
    const lines = inflowLines(
      stats({ sessionsToday: 0, inboxToday: 0, mcpCallsToday: 0, mcpTopTool: null }),
      STRINGS.en,
    );
    // Hiding at all-zero made the panel change shape between opens — the
    // section stays, the zeros are the honest data.
    expect(lines).not.toBeNull();
    expect(lines?.sessionsCount).toBe("+0");
    expect(lines?.inboxCount).toBe("+0");
  });

  it("keeps only the since-launch caveat when there is no top tool", () => {
    const lines = inflowLines(stats({ mcpTopTool: null }), STRINGS.en);
    expect(lines?.mcpSub).toBe("since app launch");
  });

  it("leaves the inbox sub empty when nothing arrived today", () => {
    const lines = inflowLines(
      stats({ inboxToday: 0, inboxBySource: {} }),
      STRINGS.en,
    );
    expect(lines?.inboxSub).toBe("");
  });

  it("translates in Korean too (the ko/ja keys exist)", () => {
    const lines = inflowLines(stats(), STRINGS.ko);
    expect(lines?.header).toBe("오늘 들어온 것");
    expect(lines?.sessions).toBe("세션 수집");
    expect(lines?.sessionsCount).toBe("+2");
    expect(lines?.mcpCount).toBe("7회");
    expect(lines?.inboxView).toBe("보기 →");
    expect(lines?.sparkCaption).toBe(
      "최근 24시간 · 보라 = 세션/inbox · 파랑 = MCP 호출",
    );
    expect(lines?.summary).toBe("오늘: 세션 +2 · MCP 7회 · 인박스 +3");
    // The source slugs are vault data, not UI copy — only `unknown` translates.
    expect(lines?.inboxSub).toBe("clipper 2 · 출처 미표기 1");
  });
});

// The whole reason the breakdown was left out until the clipper stamped
// frontmatter: a vault holds files from before the stamping AND files dropped in
// by hand, and neither may be attributed to a writer that didn't write them.
describe("inboxSourceSub", () => {
  it("mixes tagged and untagged files without mislabeling the untagged", () => {
    expect(
      inboxSourceSub({ clipper: 3, "claude-code": 2, unknown: 4 }, STRINGS.en),
    ).toBe("unknown 4 · clipper 3 · claude-code 2");
  });

  it("shows only unknown when no file carries a source", () => {
    expect(inboxSourceSub({ unknown: 5 }, STRINGS.en)).toBe("unknown 5");
  });

  it("shows only real sources when every file carries one", () => {
    expect(inboxSourceSub({ clipper: 1, codex: 1 }, STRINGS.en)).toBe(
      "clipper 1 · codex 1",
    );
  });

  it("drops zero buckets and an absent map alike", () => {
    expect(inboxSourceSub({ clipper: 0 }, STRINGS.en)).toBe("");
    expect(inboxSourceSub({}, STRINGS.en)).toBe("");
    // Rust always sends the map, but a stale cached payload might not.
    expect(inboxSourceSub(undefined, STRINGS.en)).toBe("");
  });

  it("breaks count ties on the source name so the line is stable", () => {
    expect(inboxSourceSub({ zeta: 2, alpha: 2 }, STRINGS.en)).toBe(
      "alpha 2 · zeta 2",
    );
  });
});
