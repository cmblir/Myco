// In-canvas legend for the 3D graph — the "no unexplained encodings" rule from
// the calm-cosmic-web spec. Bottom-left overlay with two parts:
//  1. A two-level galaxy → cluster tree. A galaxy header is a top-level folder
//     (name + total count + base swatch) and collapses/expands its cluster rows.
//     Each cluster row (indented) is a coloured sub-group — a sub-folder or a
//     Louvain topic; clicking it ISOLATES that cluster (non-members sink to the
//     faint context layer) and clicking again releases. The biggest galaxy is
//     expanded by default so a many-topic vault doesn't flood the corner.
//     In non-folder (Louvain) mode the clusters render flat (no header).
//  2. A fixed encoding key: size / dim / amber / neutral.
// Collapsible; starts collapsed on narrow viewports.

import { Fragment, useState } from "react";
import type { JSX } from "react";
import type { LegendCluster, LegendGalaxy } from "../lib/graphData";
import type { Strings } from "../lib/i18n";

export default function GraphLegend({
  t,
  galaxies,
  isolated,
  onIsolate,
}: {
  t: Strings;
  galaxies: LegendGalaxy[];
  /** Currently isolated cluster (community) id, or null. */
  isolated: number | null;
  /** Toggle isolation (null releases). */
  onIsolate: (cm: number | null) => void;
}): JSX.Element | null {
  const [open, setOpen] = useState(
    () => typeof window === "undefined" || window.innerWidth >= 768,
  );
  // Explicit per-galaxy expand overrides; the effective state defaults to "only
  // the biggest galaxy (index 0) open" until the user clicks a header.
  const [override, setOverride] = useState<Map<number, boolean>>(
    () => new Map(),
  );
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
    <li key={c.cm}>
      <button
        type="button"
        className={
          "graph-legend__swatch" +
          (isolated === c.cm ? " is-active" : "") +
          (isolated != null && isolated !== c.cm ? " is-dimmed" : "")
        }
        title={`${c.label} · ${c.count}`}
        onClick={() => onIsolate(isolated === c.cm ? null : c.cm)}
      >
        <span className="graph-legend__dot" style={{ background: c.color }} />
        <span className="graph-legend__name">{c.label}</span>
        <span className="muted">{c.count}</span>
      </button>
    </li>
  );

  const moreRow = (g: number, more: number): JSX.Element | null =>
    more > 0 ? (
      <li key={`more-${g}`} className="graph-legend__more muted">
        {(t.gr_more ?? "+{n} more").replace("{n}", String(more))}
      </li>
    ) : null;

  return (
    <div className="graph-legend" role="region" aria-label={t.gr_legend}>
      <button
        type="button"
        className="graph-legend__head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {t.gr_legend} <span className="muted">{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <>
          <ul className="graph-legend__galaxies">
            {galaxies.map((gx, idx) =>
              gx.g < 0 ? (
                // Louvain / non-folder mode: flat cluster list, no header.
                <Fragment key="flat">
                  {gx.clusters.map(clusterRow)}
                  {moreRow(gx.g, gx.more)}
                </Fragment>
              ) : (
                <li key={`gx-${gx.g}`} className="graph-legend__galaxy">
                  <button
                    type="button"
                    className="graph-legend__galaxy-head"
                    onClick={() => toggle(gx.g, idx)}
                    aria-expanded={effectiveOpen(gx.g, idx)}
                    title={`${gx.label} · ${gx.count}`}
                  >
                    <span
                      className="graph-legend__dot"
                      style={{ background: gx.color }}
                    />
                    <span className="graph-legend__name">{gx.label}</span>
                    <span className="muted">{gx.count}</span>
                    <span className="muted graph-legend__caret">
                      {effectiveOpen(gx.g, idx) ? "▾" : "▸"}
                    </span>
                  </button>
                  {effectiveOpen(gx.g, idx) ? (
                    <ul className="graph-legend__clusters">
                      {gx.clusters.map(clusterRow)}
                      {moreRow(gx.g, gx.more)}
                    </ul>
                  ) : null}
                </li>
              ),
            )}
          </ul>
          <div className="graph-legend__key">
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
          </div>
        </>
      ) : null}
    </div>
  );
}
