// inflowLines is the single builder behind every inflow surface (popover
// section, tray panel section, native menu summary) — null means "hide the
// whole section", which is why the all-zeros case matters most here.

import { describe, expect, it } from "vitest";
import { inflowLines } from "./inflow";
import type { InflowStats } from "./ipc";
import { STRINGS } from "./i18n";

const stats = (over: Partial<InflowStats> = {}): InflowStats => ({
  sessionsToday: 2,
  inboxToday: 3,
  mcpCallsToday: 7,
  mcpTopTool: "search",
  hourlyFiles: Array(24).fill(0),
  hourlyMcp: Array(24).fill(0),
  ...over,
});

describe("inflowLines", () => {
  it("renders every line from a stats fixture", () => {
    const lines = inflowLines(stats(), STRINGS.en);
    expect(lines).toEqual({
      header: "Today's inflow",
      sessions: "Sessions swept +2",
      mcp: "MCP tool calls 7",
      mcpSub: "top: search · since app launch",
      inbox: "_inbox arrivals +3",
      summary: "Today: sessions +2 · MCP 7 · inbox +3",
    });
  });

  it("is null when nothing arrived today, hiding the section", () => {
    expect(
      inflowLines(
        stats({ sessionsToday: 0, inboxToday: 0, mcpCallsToday: 0, mcpTopTool: null }),
        STRINGS.en,
      ),
    ).toBeNull();
  });

  it("keeps only the since-launch caveat when there is no top tool", () => {
    const lines = inflowLines(stats({ mcpTopTool: null }), STRINGS.en);
    expect(lines?.mcpSub).toBe("since app launch");
  });

  it("translates in Korean too (the ko/ja keys exist)", () => {
    const lines = inflowLines(stats(), STRINGS.ko);
    expect(lines?.header).toBe("오늘 들어온 것");
    expect(lines?.sessions).toBe("세션 수집 +2");
    expect(lines?.summary).toBe("오늘: 세션 +2 · MCP 7회 · 인박스 +3");
  });
});
