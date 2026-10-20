// The gaps column — promoted from a toggled overlay to the Survey's left
// rail, because it was the only part of this screen that ever produced an
// answer. Each row carries the three exits the old graph lacked entirely:
// open the note, ask for link suggestions, or record the topic as wanted.
//
// It is a shared <Rail> — the same part the reader's rail and the graph's
// legend are built from — so its buckets are RailGroups and its rows RailRows.

import { useState } from "react";
import type { Dispatch, JSX, SetStateAction } from "react";
import { Button, Sheet, useMediaQuery } from "./ui";
import Rail, { RailGroup, RailRow } from "./Rail";
import { RailFold } from "./GraphRailToggle";
import { displayName, listedName } from "../lib/displayName";
import { stem } from "../lib/graphData";
import type { ClusterBridge, GapReport } from "../lib/graphGaps";
import type { Strings } from "../lib/i18n";
import type { NodeMeta } from "../lib/ipc";

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

/** A gap row's page stem (a ghost's is its unresolved link text). */
export function gapStem(id: string): string {
  return id.startsWith(GHOST) ? id.slice(GHOST.length) : stem(id);
}

/** The buckets analyzeGaps already computes, as the column's 3–5 groups. */
export function gapGroups(report: GapReport, noBacklink: string[], t: Strings): GapGroup[] {
  const all: GapGroup[] = [
    { key: "orphans", label: t.gr_gap_orphans, ids: report.orphans, actions: ["open", "link", "want"] },
    { key: "missing", label: t.gr_gap_missing, ids: report.missing, actions: ["want"] },
    { key: "nobacklink", label: t.gr_gap_nobacklink, ids: noBacklink, actions: ["open", "link", "want"] },
    {
      key: "undercited",
      label: t.gr_gap_undercited,
      ids: report.underCited,
      actions: ["open", "want"],
    },
    { key: "lowconf", label: t.gr_gap_lowconf, ids: report.lowConfidence, actions: ["open", "link", "want"] },
    { key: "islands", label: t.gr_gap_islands, ids: report.islands.flat(), actions: ["open", "link"] },
  ];
  return all.filter((g) => g.ids.length > 0);
}

const BRIDGES = "bridges";

export default function GraphGaps({
  t,
  groups,
  total,
  bridges = [],
  onAskBridge,
  selected,
  onSelect,
  onAction,
  meta,
  onTidy,
  onFold,
  closed,
  setClosed,
}: {
  t: Strings;
  groups: GapGroup[];
  total: number;
  /** Adjacency meta, for the readable title of an opaque session page. */
  meta?: Record<string, NodeMeta>;
  /** Open the Tidy sheet (정리) from the rail's head. */
  onTidy?: () => void;
  /** Fold the rail to its edge tab (the head's chevron). */
  onFold?: () => void;
  /** Collapsed groups by key. The page holds them: a fold unmounts the rail
   * and they must come back with it. */
  closed: Record<string, boolean>;
  setClosed: Dispatch<SetStateAction<Record<string, boolean>>>;
  /** Cluster pairs that read as semantically close but are structurally
   * unlinked. Only computed under the "무엇이 뭉쳐 있나" question. */
  bridges?: ClusterBridge[];
  /** Route the bridge to Ask as a drafted research question. */
  onAskBridge?: (b: ClusterBridge) => void;
  selected: string | null;
  /** Highlight the node in the canvas (row title click). */
  onSelect: (id: string) => void;
  onAction: (action: GapAction, id: string) => void;
}): JSX.Element {
  // A finger (UX S53): three buttons beside a name clipped the third and hid
  // the name at 216px, so each row carries one ⋯ that opens its actions in
  // the shared sheet. A mouse keeps the three.
  const touch = useMediaQuery("(any-pointer: coarse)");
  const [rowMenu, setRowMenu] = useState<{ id: string; name: string; actions: GapAction[] } | null>(null);
  const toggle = (key: string): void =>
    setClosed((c) => ({ ...c, [key]: !c[key] }));
  // Short labels here, full ones in the button title: three full-sentence
  // buttons overflowed the rail and covered the note name.
  const label: Record<GapAction, string> = {
    open: t.gr_act_open_s,
    link: t.gr_act_link_s,
    want: t.gr_act_want_s,
  };
  const title: Record<GapAction, string> = {
    open: t.gr_open,
    link: t.gr_act_link,
    want: t.gr_act_harvest,
  };

  return (
    <Rail
      title={t.gr_gaps_title}
      count={total}
      action={
        <>
          {onTidy ? (
            <Button variant="quiet" className="u-rail__headbtn" title={t.tidy_btn_title} onClick={onTidy}>
              {t.tidy_btn}
            </Button>
          ) : null}
          {onFold ? <RailFold t={t} rail="gaps" onFold={onFold} /> : null}
        </>
      }
    >
      {bridges.length > 0 ? (
        <RailGroup
          label={t.gr_gap_bridges}
          count={bridges.length}
          open={!closed[BRIDGES]}
          onToggle={() => toggle(BRIDGES)}
        >
          {bridges.map((b) => (
            <RailRow
              key={`${b.a}:${b.b}`}
              title={`${b.aHub} ↔ ${b.bHub}`}
              onClick={() => onSelect(b.pairs[0]?.source ?? b.aHub)}
              actions={
                onAskBridge ? (
                  <Button
                    variant="quiet"
                    title={t.gr_gap_ask}
                    onClick={() => onAskBridge(b)}
                  >
                    {t.gr_act_link_s}
                  </Button>
                ) : undefined
              }
            >
              {displayName(gapStem(b.aHub))} ↔ {displayName(gapStem(b.bHub))}
            </RailRow>
          ))}
        </RailGroup>
      ) : null}
      {groups.length === 0 && bridges.length === 0 ? (
        <p>{t.gr_gap_none}</p>
      ) : (
        groups.map((g) => (
          <RailGroup
            key={g.key}
            label={g.label}
            count={g.ids.length}
            open={!closed[g.key]}
            onToggle={() => toggle(g.key)}
          >
            {g.ids.slice(0, MAX_ROWS).map((id) => (
              <RailRow
                key={id}
                title={id}
                active={selected === id}
                onClick={() => onSelect(id)}
                actions={touch ? (
                  <Button
                    variant="quiet"
                    tabIndex={-1}
                    aria-label={t.sb_row_menu.replace("{name}", listedName(gapStem(id), meta?.[id]?.title))}
                    aria-haspopup="dialog"
                    onClick={() =>
                      setRowMenu({ id, name: listedName(gapStem(id), meta?.[id]?.title), actions: g.actions })
                    }
                  >
                    ⋯
                  </Button>
                ) : g.actions.map((a) => (
                  <Button
                    key={a}
                    variant="quiet"
                    // One Tab stop per row (UX S44): the keyboard takes the
                    // name, and the inspector Enter opens has these exits.
                    tabIndex={-1}
                    title={title[a]}
                    onClick={() => onAction(a, id)}
                  >
                    {label[a]}
                  </Button>
                ))}
              >
                {listedName(gapStem(id), meta?.[id]?.title)}
              </RailRow>
            ))}
            {g.ids.length > MAX_ROWS ? (
              <p>{t.gr_more.replace("{n}", String(g.ids.length - MAX_ROWS))}</p>
            ) : null}
          </RailGroup>
        ))
      )}
      {rowMenu ? (
        <Sheet title={rowMenu.name} closeLabel={t.ui_close} onClose={() => setRowMenu(null)}>
          <ul className="myco-menu" role="menu">
            {rowMenu.actions.map((a) => (
              <li key={a} role="none">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setRowMenu(null);
                    onAction(a, rowMenu.id);
                  }}
                >
                  {title[a]}
                </button>
              </li>
            ))}
          </ul>
        </Sheet>
      ) : null}
    </Rail>
  );
}
