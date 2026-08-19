// Shared activity panel body — the sections + rows both activity surfaces
// render: the Topbar popover (ActivityChip, live-store data) and the tray
// popover window (TrayPanel, Rust-cached TrayStatus data). Purely
// presentational: callers own the row content; this owns the row shell,
// section headers, and section separators.
//
// The separator div is unstyled inside the in-app popover (.activity-pop
// leaves it 0-height) and becomes the artifact's 1px hairline inside
// .tray-panel — one component, two skins, no props.

import type { JSX, ReactNode } from "react";
import askPng from "../assets/activity/ask.png";
import distillPng from "../assets/activity/distill.png";
import indexingPng from "../assets/activity/indexing.png";
import linkPng from "../assets/activity/link.png";
import mcpPng from "../assets/activity/mcp.png";
import stopPng from "../assets/activity/stop.png";

export type ActivityIconName =
  | "ask"
  | "distill"
  | "indexing"
  | "link"
  | "mcp"
  | "stop";

const ICON_SRC: Record<ActivityIconName, string> = {
  ask: askPng,
  distill: distillPng,
  indexing: indexingPng,
  link: linkPng,
  mcp: mcpPng,
  stop: stopPng,
};

/** The one component every activity image goes through. The PNGs bake a dark
 * ground in, so a circle mask (border-radius) hides the square on light
 * surfaces. `active` = the breathing drop-shadow glow (CSS), nothing else. */
export function ActivityIcon({
  name,
  size = 18,
  active = false,
}: {
  name: ActivityIconName;
  size?: number;
  active?: boolean;
}): JSX.Element {
  return (
    <img
      src={ICON_SRC[name]}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      className={"activity-icon" + (active ? " is-active" : "")}
    />
  );
}

/** 24-hour inflow sparkbar — pure divs, one column per local hour, files
 * stacked under MCP calls (two colors). Shared by the ActivityChip popover
 * and the tray panel so both draw the identical bar. Decorative: the counts
 * are in the rows above it, so it is hidden from assistive tech. */
export function InflowSparkbar({
  files,
  mcp,
}: {
  files: number[];
  mcp: number[];
}): JSX.Element {
  const max = Math.max(1, ...files.map((f, i) => f + (mcp[i] ?? 0)));
  return (
    <div className="inflow-spark" aria-hidden="true">
      {files.map((f, i) => {
        const m = mcp[i] ?? 0;
        return (
          <div className="inflow-spark-col" key={i}>
            <div
              className="inflow-spark-mcp"
              style={{ height: `${(m / max) * 100}%` }}
            />
            <div
              className="inflow-spark-file"
              style={{ height: `${(f / max) * 100}%` }}
            />
          </div>
        );
      })}
    </div>
  );
}

/** One inflow metric: label + inline muted sub + right-aligned mono count. */
export interface InflowRowContent {
  label: string;
  sub: string;
  count: string;
}

function inflowMain(r: InflowRowContent): ReactNode {
  return (
    <span className="inflow-line">
      {r.label}
      {r.sub ? <span className="inflow-sub">{r.sub}</span> : null}
    </span>
  );
}

/** The "Today's inflow" section rows, built ONCE for both surfaces (the
 * ActivityChip popover and the tray panel) so they match the approved
 * artifact identically: icon badge per metric, label with the sub inline
 * (muted, same line, wraps at narrow width), count in a right mono column,
 * a "View →" action on the _inbox row, and the color-key caption under the
 * sparkbar. Callers only supply the strings and the inbox navigation. */
export function buildInflowRows(p: {
  sessions: InflowRowContent;
  mcp: InflowRowContent;
  inbox: InflowRowContent;
  inboxView: string;
  onInboxView: () => void;
  sparkCaption: string;
  hourlyFiles: number[];
  hourlyMcp: number[];
}): PanelRow[] {
  const count = (c: string): ReactNode => (
    <span className="inflow-count">{c}</span>
  );
  return [
    {
      key: "sessions",
      icon: "ask",
      main: inflowMain(p.sessions),
      trailing: count(p.sessions.count),
    },
    {
      key: "mcp-calls",
      icon: "mcp",
      main: inflowMain(p.mcp),
      trailing: count(p.mcp.count),
    },
    {
      key: "inbox",
      icon: "link",
      main: inflowMain(p.inbox),
      trailing: (
        <>
          {count(p.inbox.count)}
          <span className="inflow-view">{p.inboxView}</span>
        </>
      ),
      onClick: p.onInboxView,
    },
    {
      key: "spark",
      main: (
        <span className="inflow-stack">
          <InflowSparkbar files={p.hourlyFiles} mcp={p.hourlyMcp} />
          <span className="inflow-caption">{p.sparkCaption}</span>
        </span>
      ),
    },
  ];
}

export interface PanelRow {
  key: string;
  /** Circular row icon; `leading` (e.g. a task checkbox) replaces it. */
  icon?: ActivityIconName;
  iconActive?: boolean;
  leading?: ReactNode;
  /** Content of .activity-row-main — callers compose title/sub freely. */
  main: ReactNode;
  trailing?: ReactNode;
  onClick?: () => void;
}

export interface PanelSection {
  key: string;
  /** Section header label; omitted entirely when empty. */
  header?: string;
  rows: PanelRow[];
}

function Row({ row }: { row: PanelRow }): JSX.Element {
  const content = (
    <>
      {row.leading ??
        (row.icon ? (
          <ActivityIcon name={row.icon} active={row.iconActive ?? false} />
        ) : null)}
      <span className="activity-row-main">{row.main}</span>
      {row.trailing ?? null}
    </>
  );
  return row.onClick ? (
    <button className="activity-row" onClick={row.onClick}>
      {content}
    </button>
  ) : (
    <div className="activity-row">{content}</div>
  );
}

/** Sections with zero rows vanish (header included), mirroring the native
 * menu's menu_rows: no leading/trailing/doubled separators can occur. */
export default function ActivityPanel({
  sections,
}: {
  sections: PanelSection[];
}): JSX.Element {
  const shown = sections.filter((s) => s.rows.length > 0);
  return (
    <>
      {shown.map((section, i) => (
        <div className="activity-section" key={section.key}>
          {i > 0 ? <div className="activity-sep" /> : null}
          {section.header ? (
            <div className="activity-hdr muted">{section.header}</div>
          ) : null}
          {section.rows.map((row) => (
            <Row row={row} key={row.key} />
          ))}
        </div>
      ))}
    </>
  );
}
