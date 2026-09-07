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
//  2. A fixed encoding key, pinned in the rail's footer: size / dim / amber /
//     neutral. It must not scroll away — it is what makes the picture legible.
// Collapsible; starts collapsed on narrow viewports.

import { Fragment, useState } from "react";
import type { JSX } from "react";
import Rail, { RailGroup, RailRow } from "./Rail";
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
    <RailRow
      key={c.cm}
      title={`${c.label} · ${c.count}`}
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
      open={open}
      onToggle={() => setOpen((v) => !v)}
      footer={
        <>
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
