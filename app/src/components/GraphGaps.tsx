// The gaps column — promoted from a toggled overlay to the Survey's fixed left
// column, because it was the only part of this screen that ever produced an
// answer. Each row carries the three exits the old graph lacked entirely:
// open the note, ask for link suggestions, or record the topic as wanted.

import type { JSX } from "react";
import { useState } from "react";
import { stem } from "../lib/graphData";
import type { GapReport } from "../lib/graphGaps";
import type { Strings } from "../lib/i18n";

const GHOST = "ghost:";
const MAX_ROWS = 8;

export type GapAction = "open" | "link" | "want";

export interface GapGroup {
  key: string;
  label: string;
  ids: string[];
  /** Actions offered on every row of the group. */
  actions: GapAction[];
}

export function displayName(id: string): string {
  return id.startsWith(GHOST) ? id.slice(GHOST.length) : stem(id);
}

/** The buckets analyzeGaps already computes, as the column's 3–5 groups. */
export function gapGroups(report: GapReport, noBacklink: string[], t: Strings): GapGroup[] {
  const all: GapGroup[] = [
    { key: "orphans", label: t.gr_gap_orphans, ids: report.orphans, actions: ["open", "link"] },
    { key: "missing", label: t.gr_gap_missing, ids: report.missing, actions: ["want"] },
    { key: "nobacklink", label: t.gr_gap_nobacklink, ids: noBacklink, actions: ["open", "link"] },
    {
      key: "undercited",
      label: t.gr_gap_undercited,
      ids: report.underCited,
      actions: ["open", "want"],
    },
    { key: "lowconf", label: t.gr_gap_lowconf, ids: report.lowConfidence, actions: ["open", "link"] },
    { key: "islands", label: t.gr_gap_islands, ids: report.islands.flat(), actions: ["open", "link"] },
  ];
  return all.filter((g) => g.ids.length > 0);
}

export default function GraphGaps({
  t,
  groups,
  total,
  selected,
  onSelect,
  onAction,
}: {
  t: Strings;
  groups: GapGroup[];
  total: number;
  selected: string | null;
  /** Highlight the node in the canvas (row title click). */
  onSelect: (id: string) => void;
  onAction: (action: GapAction, id: string) => void;
}): JSX.Element {
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const label: Record<GapAction, string> = {
    open: t.gr_open,
    link: t.gr_act_link,
    want: t.gr_act_harvest,
  };

  return (
    <aside className="sv-panel sv-panel--gaps" aria-labelledby="sv-gaps-h">
      <div className="sv-panel__h">
        <b id="sv-gaps-h">{t.gr_gaps_title}</b>
        <span className="sp" />
        <span className="mono">{total}</span>
      </div>
      {groups.length === 0 ? (
        <p className="sv-empty">{t.gr_gap_none}</p>
      ) : (
        groups.map((g) => {
          const open = !closed[g.key];
          return (
            <div className="sv-gap" key={g.key}>
              <button
                type="button"
                className="sv-gap__h"
                aria-expanded={open}
                onClick={() => setClosed((c) => ({ ...c, [g.key]: open }))}
              >
                <span className="sv-gap__caret" aria-hidden="true">
                  {open ? "▾" : "▸"}
                </span>
                <span>{g.label}</span>
                <span className="cnt mono">{g.ids.length}</span>
              </button>
              {open ? (
                <div className="sv-gap__body">
                  {g.ids.slice(0, MAX_ROWS).map((id) => (
                    <div className={`sv-row${selected === id ? " is-sel" : ""}`} key={id}>
                      <button
                        type="button"
                        className="sv-row__name"
                        title={id}
                        onClick={() => onSelect(id)}
                      >
                        {displayName(id)}
                      </button>
                      {g.actions.map((a) => (
                        <button
                          key={a}
                          type="button"
                          className="sv-act"
                          onClick={() => onAction(a, id)}
                        >
                          {label[a]}
                        </button>
                      ))}
                    </div>
                  ))}
                  {g.ids.length > MAX_ROWS ? (
                    <p className="sv-empty">
                      +{g.ids.length - MAX_ROWS} {t.gr_gap_more}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })
      )}
    </aside>
  );
}
