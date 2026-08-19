// "Today's inflow" line builder — one place turns InflowStats into the
// translated strings both surfaces show: the ActivityChip popover renders
// them live, trayStatus.ts bakes them into the tray payload (tray panel
// section + the native menu's one-line summary).
//
// The MCP counter is in-memory on the Rust side, so its number only reaches
// back to app launch — the sub-line carries that caveat instead of the row
// pretending to know the full day (the smaller honest option; no persistence).

import type { InflowStats } from "./ipc";
import type { Strings } from "./i18n";

export interface InflowLines {
  header: string;
  sessions: string;
  mcp: string;
  /** Top tool + the "since app launch" caveat for the MCP counter. */
  mcpSub: string;
  inbox: string;
  /** One-liner for the native tray menu. */
  summary: string;
}

/** Translated lines for the inflow section, or null when nothing arrived
 * today — callers hide the whole section (and the menu row) on null. */
export function inflowLines(s: InflowStats, t: Strings): InflowLines | null {
  if (s.sessionsToday + s.inboxToday + s.mcpCallsToday === 0) return null;
  const top = s.mcpTopTool
    ? (t.tb_inflow_mcp_top ?? "top: {tool}").replace("{tool}", s.mcpTopTool)
    : "";
  const since = t.tb_inflow_since_launch ?? "since app launch";
  return {
    header: t.tb_inflow_header ?? "Today's inflow",
    sessions: (t.tb_inflow_sessions ?? "Sessions swept +{n}").replace(
      "{n}",
      String(s.sessionsToday),
    ),
    mcp: (t.tb_inflow_mcp ?? "MCP tool calls {n}").replace(
      "{n}",
      String(s.mcpCallsToday),
    ),
    mcpSub: top ? `${top} · ${since}` : since,
    inbox: (t.tb_inflow_inbox ?? "_inbox arrivals +{n}").replace(
      "{n}",
      String(s.inboxToday),
    ),
    summary: (t.tb_inflow_summary ?? "Today: sessions +{s} · MCP {m} · inbox +{i}")
      .replace("{s}", String(s.sessionsToday))
      .replace("{m}", String(s.mcpCallsToday))
      .replace("{i}", String(s.inboxToday)),
  };
}
