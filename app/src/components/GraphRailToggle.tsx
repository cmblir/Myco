// Folding a Survey rail away and back: the chevron in the rail's head, and the
// thin tab left on the stage's edge while the rail is folded. Both carry
// `data-rail-toggle` so the page can hand focus from one to the other when the
// control that had it unmounts.

import type { JSX } from "react";
import { Icon } from "../lib/icons";
import type { GraphRail } from "../lib/graphRails";
import type { Strings } from "../lib/i18n";
import { IconButton } from "./ui";

const KEY: Record<GraphRail, string> = { gaps: "[", legend: "]" };

function railName(t: Strings, rail: GraphRail): string {
  return rail === "gaps" ? t.gr_gaps_title : t.gr_legend;
}

/** The chevron in a rail's head. Points at the edge the rail folds into. */
export function RailFold({
  t,
  rail,
  onFold,
}: {
  t: Strings;
  rail: GraphRail;
  onFold: () => void;
}): JSX.Element {
  const label = t.gr_rail_fold.replace("{name}", railName(t, rail));
  return (
    <IconButton
      className="u-rail__headbtn"
      data-rail-toggle={rail}
      aria-expanded={true}
      aria-label={label}
      title={`${label} (${KEY[rail]})`}
      onClick={onFold}
    >
      <Icon name={rail === "gaps" ? "chevL" : "chevR"} size={13} />
    </IconButton>
  );
}

/** A folded rail: its icon and count on the stage's edge; a click unfolds it. */
export function RailTab({
  t,
  rail,
  count,
  onOpen,
}: {
  t: Strings;
  rail: GraphRail;
  count: number;
  onOpen: () => void;
}): JSX.Element {
  const label = t.gr_rail_open.replace("{name}", railName(t, rail));
  return (
    <button
      type="button"
      className={`graph-railtab graph-railtab--${rail}`}
      data-rail-toggle={rail}
      aria-expanded={false}
      aria-label={`${label} · ${count}`}
      title={`${label} (${KEY[rail]})`}
      onClick={onOpen}
    >
      <Icon name={rail === "gaps" ? "link" : "info"} size={14} />
      <span className="graph-railtab__count">{count}</span>
    </button>
  );
}
