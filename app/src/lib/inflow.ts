// "Today's inflow" line builder — one place turns InflowStats into the
// translated strings both surfaces show: the ActivityChip popover renders
// them live, trayStatus.ts bakes them into the tray payload (tray panel
// section + the native menu's one-line summary). Per the approved artifact,
// each metric is split label / muted sub / right-aligned count, so the
// surfaces can lay them out as columns instead of one run-on string.
//
// The MCP counter is in-memory on the Rust side, so its number only reaches
// back to app launch — the sub-line carries that caveat instead of the row
// pretending to know the full day (the smaller honest option; no persistence).

import type { InflowStats } from "./ipc";
import type { Strings } from "./i18n";

export interface InflowLines {
  header: string;
  /** Row labels (count-free) — the counts live in their own right column. */
  sessions: string;
  sessionsSub: string;
  sessionsCount: string;
  mcp: string;
  /** Top tool + the "since app launch" caveat for the MCP counter. */
  mcpSub: string;
  mcpCount: string;
  inbox: string;
  /** Per-source split of today's arrivals ("clipper 3 · unknown 1"). */
  inboxSub: string;
  inboxCount: string;
  /** "View →" action label on the _inbox row. */
  inboxView: string;
  /** Color-key caption under the sparkbar. */
  sparkCaption: string;
  /** One-liner for the native tray menu. */
  summary: string;
}

/** Context the stats themselves don't carry, for the sessions sub-line. */
export interface InflowExtras {
  /** When the last session sweep finished (ms epoch); null before one runs. */
  sweepAt: number | null;
  /** Auto-import interval in minutes; null (or 0) when the toggle is off. */
  autoImportMin: number | null;
}

/** The `_inbox` row's sub-line: today's arrivals split by the writer that
 * stamped them, biggest bucket first ("clipper 3 · claude-code 1").
 *
 * Derived from frontmatter only. A file that declares no `source` arrives here
 * under the `unknown` key and is shown as such — the split would be a lie if
 * every unstamped doc (anything written before the writers stamped one, plus
 * whatever the user dropped into the folder by hand) were folded into the
 * writer that happens to be busiest. Source slugs are the vault's own data, not
 * UI copy, so only `unknown` is translated. Empty string when nothing arrived. */
export function inboxSourceSub(
  bySource: Record<string, number> | undefined,
  t: Strings,
): string {
  const entries = Object.entries(bySource ?? {}).filter(([, n]) => n > 0);
  if (entries.length === 0) return "";
  const unknown = t.tb_inflow_source_unknown ?? "unknown";
  return entries
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, n]) => `${key === "unknown" ? unknown : key} ${n}`)
    .join(" · ");
}

/** Translated lines for the inflow section. Always returns lines — zeros
 * included: hiding at all-zero made the panel's shape change between opens
 * (right after launch vs later in the day), which read as broken. Callers
 * hide the section only when they have NO stats at all (no probe yet). */
export function inflowLines(
  s: InflowStats,
  t: Strings,
  extras?: InflowExtras,
): InflowLines {
  // All-zero used to hide the whole section — which made the panel's shape
  // change between opens (booted-just-now vs later in the day) and read as
  // broken. Zeros are honest data; the section always renders.
  const top = s.mcpTopTool
    ? (t.tb_inflow_mcp_top ?? "top: {tool}").replace("{tool}", s.mcpTopTool)
    : "";
  const since = t.tb_inflow_since_launch ?? "since app launch";
  const sweep =
    extras?.sweepAt != null
      ? (t.tb_inflow_last_sweep ?? "last sweep {t}").replace(
          "{t}",
          new Date(extras.sweepAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          }),
        )
      : "";
  const auto = extras?.autoImportMin
    ? (t.tb_inflow_auto ?? "auto {m} min").replace(
        "{m}",
        String(extras.autoImportMin),
      )
    : "";
  return {
    header: t.tb_inflow_header ?? "Today's inflow",
    sessions: t.tb_inflow_sessions ?? "Sessions swept",
    sessionsSub: [sweep, auto].filter(Boolean).join(" · "),
    sessionsCount: `+${s.sessionsToday}`,
    mcp: t.tb_inflow_mcp ?? "MCP tool calls",
    mcpSub: top ? `${top} · ${since}` : since,
    mcpCount: (t.tb_inflow_mcp_count ?? "{n}").replace(
      "{n}",
      String(s.mcpCallsToday),
    ),
    inbox: t.tb_inflow_inbox ?? "_inbox arrivals",
    inboxSub: inboxSourceSub(s.inboxBySource, t),
    inboxCount: `+${s.inboxToday}`,
    inboxView: t.tb_inflow_view ?? "View →",
    sparkCaption:
      t.tb_inflow_spark_caption ??
      "Last 24h · purple = sessions/inbox · blue = MCP calls",
    summary: (t.tb_inflow_summary ?? "Today: sessions +{s} · MCP {m} · inbox +{i}")
      .replace("{s}", String(s.sessionsToday))
      .replace("{m}", String(s.mcpCallsToday))
      .replace("{i}", String(s.inboxToday)),
  };
}
