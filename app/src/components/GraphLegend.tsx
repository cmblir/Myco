// The graph's legend — the "no unexplained encodings" rule from the
// calm-cosmic-web spec. It used to float INSIDE the canvas with its own dark
// palette, its own radius and its own 11px label treatment, covering the very
// picture it explains; it is now a shared <Rail>, the same part the reader's
// rail and the gaps column are built from, standing beside the stage.
//
// Two parts:
//  1. A two-level galaxy → cluster tree. A galaxy is a top-level folder (name
//     + total count + base swatch) and collapses/expands its cluster rows.
//     Each cluster row is a coloured sub-group — a sub-folder or a Louvain
//     topic; clicking it ISOLATES that cluster (non-members sink to the faint
//     context layer) and clicking again releases. The biggest galaxy is
//     expanded by default so a many-topic vault doesn't flood the rail. In
//     non-folder (Louvain) mode the clusters render flat (no header).
//  2. The encoding key, pinned in the rail's footer. Its first line is what
//     the ACTIVE question changed (graphEncoding.ts: colour / ring / dim per
//     question) — the four questions draw four different pictures on the same
//     coordinates, and a key that read the same under all of them explained
//     none. Under it the base rows that hold whatever the question: size /
//     dim / amber / neutral. It must not scroll away — it is what makes the
//     picture legible. Its last row is 자세히: the graph's counts (drawn
//     nodes, first-run sample, excluded sessions) that used to be a paragraph
//     above the picture (UX S14).
// The head's chevron folds the whole rail to an edge tab (PageGraph owns that
// state, per device); it replaced a head toggle that only emptied the rail and
// kept its column.

import { Fragment } from "react";
import type { Dispatch, JSX, SetStateAction } from "react";
import Rail, { RailGroup, RailRow } from "./Rail";
import { RailFold } from "./GraphRailToggle";
import type { LegendCluster, LegendGalaxy } from "../lib/graphData";
import type { Question } from "../lib/graphEncoding";
import type { GraphSettings } from "../lib/graphSettings";
import type { Strings } from "../lib/i18n";

export interface LegendKeyState {
  question: Question;
  layout: GraphSettings["layout"];
  /** neighbours: a note is selected, so hop brightness is actually applied. */
  hasSubject: boolean;
  /** Open-in-graph is still landing on a note, so one is on its way. */
  arriving?: boolean;
}

/**
 * The lines that explain the active encoding, before the fixed key rows: the
 * question's own, plus the chronicle's time axis when that layout is on.
 */
export function legendKey(t: Strings, s: LegendKeyState): string[] {
  const lines: string[] = [];
  if (s.question === "neighbors" && !s.hasSubject && !s.arriving) lines.push(t.gr_q_pick);
  else lines.push(t[`gr_enc_${s.question}`]);
  if (s.layout === "strata") lines.push(t.gr_enc_strata);
  return lines;
}

/** How many topics the legend names: the listed clusters plus the capped rest. */
export function legendCount(galaxies: LegendGalaxy[]): number {
  return galaxies.reduce((n, g) => n + g.clusters.length + g.more, 0);
}

export default function GraphLegend({
  t,
  galaxies,
  isolated,
  onIsolate,
  encoding,
  onFold,
  override,
  setOverride,
  details,
}: {
  t: Strings;
  galaxies: LegendGalaxy[];
  /** Currently isolated cluster (community) id, or null. */
  isolated: number | null;
  /** Toggle isolation (null releases). */
  onIsolate: (cm: number | null) => void;
  encoding: LegendKeyState;
  /** Fold the rail to its edge tab (the head's chevron). */
  onFold?: () => void;
  /** Explicit expand overrides by galaxy id. The page holds them: a fold
   * unmounts the rail and they must come back with it. */
  override: Map<number, boolean>;
  setOverride: Dispatch<SetStateAction<Map<number, boolean>>>;
  /** The graph's counts, one line each, folded under 자세히. */
  details?: string[];
}): JSX.Element | null {
  // The effective state defaults to "only the biggest galaxy (index 0) open"
  // until the user clicks a header.
  const effectiveOpen = (g: number, idx: number): boolean => {
    const o = override.get(g);
    return o != null ? o : idx === 0;
  };
  const toggle = (g: number, idx: number): void => {
    setOverride((m) => {
      const next = new Map(m);
      next.set(g, !effectiveOpen(g, idx));
      return next;
    });
  };

  if (galaxies.length === 0) return null;

  const clusterRow = (c: LegendCluster): JSX.Element => (
    <RailRow
      key={c.cm}
      title={`${c.hub} · ${c.count}`}
      active={isolated === c.cm}
      className={isolated != null && isolated !== c.cm ? "is-dimmed" : undefined}
      onClick={() => onIsolate(isolated === c.cm ? null : c.cm)}
    >
      <span className="u-rail__dot" style={{ background: c.color }} />
      <span className="u-rail__name">{c.label}</span>
      <span className="u-rail__count">{c.count}</span>
    </RailRow>
  );

  const moreRow = (g: number, more: number): JSX.Element | null =>
    more > 0 ? (
      <p key={`more-${g}`}>
        {(t.gr_more ?? "+{n} more").replace("{n}", String(more))}
      </p>
    ) : null;

  return (
    <Rail
      title={t.gr_legend}
      count={legendCount(galaxies)}
      action={onFold ? <RailFold t={t} rail="legend" onFold={onFold} /> : undefined}
      footer={
        <>
          {legendKey(t, encoding).map((line) => (
            <div key={line} className="graph-legend__question">
              {line}
            </div>
          ))}
          <div>● {t.gr_key_size ?? "size = links"}</div>
          <div>◐ {t.gr_key_dim ?? "faint = low confidence"}</div>
          <div>
            <span style={{ color: "#ff9e3d" }}>●</span>{" "}
            {t.gr_key_amber ?? "amber = disputed"}
          </div>
          <div>
            <span style={{ color: "#9aa6c2" }}>●</span>{" "}
            {t.gr_key_neutral ?? "grey = unclassified"}
          </div>
          {details?.length ? (
            <details className="graph-legend__details">
              <summary>{t.gr_details}</summary>
              {details.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </details>
          ) : null}
        </>
      }
    >
      {galaxies.map((gx, idx) =>
        gx.g < 0 ? (
          // Louvain / non-folder mode: flat cluster list, no header.
          <Fragment key="flat">
            {gx.clusters.map(clusterRow)}
            {moreRow(gx.g, gx.more)}
          </Fragment>
        ) : (
          <RailGroup
            key={`gx-${gx.g}`}
            label={gx.label}
            count={gx.count}
            title={`${gx.label} · ${gx.count}`}
            lead={
              <span className="u-rail__dot" style={{ background: gx.color }} />
            }
            open={effectiveOpen(gx.g, idx)}
            onToggle={() => toggle(gx.g, idx)}
          >
            {gx.clusters.map(clusterRow)}
            {moreRow(gx.g, gx.more)}
          </RailGroup>
        ),
      )}
    </Rail>
  );
}
