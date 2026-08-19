// buildInflowRows is the ONE place the "Today's inflow" rows are shaped —
// both surfaces (ActivityChip popover, tray panel) render its output, so its
// structure IS the artifact parity: icon badge per metric, label + inline
// sub, right-slot count column, the _inbox "View →" action, spark caption.
// No DOM here: React elements are plain objects, inspected as data.

import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { buildInflowRows } from "./ActivityPanel";

const rowsOf = (onInboxView: () => void = vi.fn()) =>
  buildInflowRows({
    sessions: { label: "Sessions swept", sub: "last sweep 12:40", count: "+14" },
    mcp: { label: "MCP tool calls", sub: "top: search", count: "47" },
    inbox: { label: "_inbox arrivals", sub: "", count: "+3" },
    inboxView: "View →",
    onInboxView,
    sparkCaption: "Last 24h · purple = sessions/inbox · blue = MCP calls",
    hourlyFiles: Array(24).fill(0),
    hourlyMcp: Array(24).fill(0),
  });

describe("buildInflowRows", () => {
  it("gives each metric row its icon badge (ask / mcp / link)", () => {
    const [sessions, mcp, inbox] = rowsOf();
    expect(sessions.icon).toBe("ask");
    expect(mcp.icon).toBe("mcp");
    expect(inbox.icon).toBe("link");
  });

  it("puts every count in a right-slot mono column, not in the label", () => {
    const rows = rowsOf();
    const trailingCounts = rows.slice(0, 3).map((r) => {
      const t = r.trailing as ReactElement | ReactElement[];
      // The inbox trailing is a fragment: [count, view hint].
      const el = (
        Array.isArray((t as ReactElement<{ children: unknown }>).props?.children)
          ? ((t as ReactElement<{ children: ReactElement[] }>).props
              .children[0] as ReactElement)
          : (t as ReactElement)
      ) as ReactElement<{ className: string; children: string }>;
      expect(el.props.className).toBe("inflow-count");
      return el.props.children;
    });
    expect(trailingCounts).toEqual(["+14", "47", "+3"]);
  });

  it("renders the sub inline inside the label line, muted", () => {
    const [sessions] = rowsOf();
    const main = sessions.main as ReactElement<{
      className: string;
      children: [string, ReactElement<{ className: string; children: string }>];
    }>;
    expect(main.props.className).toBe("inflow-line");
    const [label, sub] = main.props.children;
    expect(label).toBe("Sessions swept");
    expect(sub.props.className).toBe("inflow-sub");
    expect(sub.props.children).toBe("last sweep 12:40");
  });

  it("makes the _inbox row a View → action", () => {
    const onView = vi.fn();
    const inbox = rowsOf(onView)[2];
    expect(inbox.onClick).toBe(onView);
    const trailing = inbox.trailing as ReactElement<{
      children: ReactElement<{ className: string; children: string }>[];
    }>;
    const view = trailing.props.children[1];
    expect(view.props.className).toBe("inflow-view");
    expect(view.props.children).toBe("View →");
  });

  it("stacks the caption under the sparkbar in the last row", () => {
    const spark = rowsOf()[3];
    const main = spark.main as ReactElement<{
      className: string;
      children: [ReactElement, ReactElement<{ children: string }>];
    }>;
    expect(main.props.className).toBe("inflow-stack");
    const caption = main.props.children[1];
    expect(caption.props.children).toBe(
      "Last 24h · purple = sessions/inbox · blue = MCP calls",
    );
  });
});
